import {createClient} from '@libsql/client';
import {STAGE8_PRODUCTION_HOST} from './stage8-migration-safety.mjs';

const contexts=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=`libsql://${STAGE8_PRODUCTION_HOST}`,origin=`https://${STAGE8_PRODUCTION_HOST}`;
function details(context){const held=contexts.get(context);if(!held)fail('STAGE8_MAINTENANCE_CONTEXT_REQUIRED');return held;}
function grant(value,deadlineAt){
 if(!value||value.deadlineAt!==deadlineAt||!Number.isSafeInteger(value.remainingMs)||value.remainingMs<=0||!(value.signal instanceof AbortSignal))fail('STAGE8_MAINTENANCE_BOUNDARY_REQUIRED');
 return value;
}
export function assertStage8Maintenance(context){
 if(context===undefined)return;
 const held=details(context);if(Date.now()>=held.deadlineAt||held.signal.aborted)fail('STAGE8_MAINTENANCE_DEADLINE_REACHED');
}
export function stage8MaintenanceExpired(context){
 if(context===undefined)return false;const held=details(context);return Date.now()>=held.deadlineAt||held.signal.aborted;
}
export function stage8MaintenanceTiming(context){
 const held=details(context);return {originalDeadlineAt:held.deadlineAt,deadlineReached:Date.now()>=held.deadlineAt,aborted:held.signal.aborted};
}
/** Optional restriction only: the original signed31-minute Production permit
 * remains mandatory. No client, SQL, credentials or alternate timer is accepted. */
export async function withStage8Maintenance(windowContext,phase,operation){
 if(windowContext===undefined)return operation(undefined);
 if(!windowContext||Object.getPrototypeOf(windowContext)!==Object.prototype)fail('STAGE8_MAINTENANCE_CONTEXT_REQUIRED');
 const descriptors=Object.getOwnPropertyDescriptors(windowContext),expected=['kind','phase','deadlineAt','assertBeforeMutation','dispatchMutation'];
 if(Reflect.ownKeys(descriptors).length!==expected.length||Reflect.ownKeys(descriptors).some(name=>!expected.includes(name))
  ||Object.values(descriptors).some(value=>!Object.hasOwn(value,'value'))||windowContext.kind!=='BOUNDED_WINDOW_CONTEXT_V1'||windowContext.phase!==phase
  ||!Number.isSafeInteger(windowContext.deadlineAt)||typeof windowContext.assertBeforeMutation!=='function'||typeof windowContext.dispatchMutation!=='function')fail('STAGE8_MAINTENANCE_CONTEXT_REQUIRED');
 const deadlineAt=windowContext.deadlineAt;let entered=false;
 return windowContext.dispatchMutation({prepare:async()=>undefined,dispatch:input=>{
  if(entered)fail('STAGE8_MAINTENANCE_BOUNDARY_REUSED');entered=true;grant(input,deadlineAt);
  const remaining=Math.min(input.remainingMs,deadlineAt-Date.now());if(remaining<=0)fail('STAGE8_MAINTENANCE_DEADLINE_REACHED');
  const context=Object.freeze({});contexts.set(context,{windowContext,deadlineAt,signal:AbortSignal.any([input.signal,AbortSignal.timeout(remaining)])});
  assertStage8Maintenance(context);return operation(context);
 }});
}
/** All final awaitable authority/evidence checks belong to prepare. Dispatch
 * is called synchronously after the original journal's awaited boundary check. */
export async function dispatchStage8MaintenanceMutation(context,{prepare,dispatch}){
 if(context===undefined)return dispatch(await prepare());
 const held=details(context);let prepared,ready=false,used=false;
 return held.windowContext.dispatchMutation({prepare:async()=>{
  assertStage8Maintenance(context);prepared=await prepare();assertStage8Maintenance(context);ready=true;return undefined;
 },dispatch:input=>{
  grant(input,held.deadlineAt);if(!ready||used)fail('STAGE8_MAINTENANCE_BOUNDARY_REQUIRED');used=true;
  held.signal=AbortSignal.any([held.signal,input.signal]);assertStage8Maintenance(context);
  // No await between this absolute-deadline/signal check and actual batch().
  return dispatch(prepared);
 }});
}
export function stage8MaintenanceOperation(context,maximumMs){
 assertStage8Maintenance(context);const held=context===undefined?null:details(context),remainingMs=Math.min(maximumMs,held?held.deadlineAt-Date.now():maximumMs);
 if(!Number.isSafeInteger(remainingMs)||remainingMs<=0)fail('STAGE8_MAINTENANCE_DEADLINE_REACHED');
 return {remainingMs,signal:AbortSignal.any([AbortSignal.timeout(remainingMs),...(held?[held.signal]:[])])};
}
export async function stage8MaintenanceFetch(context,input,options={},timeoutMs=30000){
 assertStage8Maintenance(context);
 const signals=[AbortSignal.timeout(timeoutMs),...(options.signal?[options.signal]:[]),...(input instanceof Request?[input.signal]:[])];
 if(context!==undefined)signals.push(details(context).signal);
 const signal=AbortSignal.any(signals);
 if(signal.aborted)fail('STAGE8_MAINTENANCE_DEADLINE_REACHED');
 return fetch(input,{...options,redirect:'error',signal});
}
/** The installed canonical HTTP driver owns encoding, queues and transactions.
 * Its custom transport checks the original boundary again at EVERY actual
 * fetch, including requests queued inside libSQL after batch() was invoked. */
export function stage8MaintenanceClientOptions(environment,context){
 if(![canonical,canonical+'/'].includes(environment.TURSO_DATABASE_URL)||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('STAGE8_PRODUCTION_TARGET_MISMATCH');
 const options={url:canonical,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number'};
 if(context!==undefined){details(context);options.fetch=(input,init)=>{
  if(new URL(typeof input==='string'?input:input.url).origin!==origin)fail('STAGE8_PRODUCTION_TARGET_MISMATCH');
  return stage8MaintenanceFetch(context,input,init);
 };}
 return options;
}
const readonlyStatement=statement=>{
 const sql=typeof statement==='string'?statement:statement?.sql;
 if(typeof sql!=='string'||sql.includes(';')||!(/^(SELECT)\b/i.test(sql.trim())||/^PRAGMA\s+(?:integrity_check|foreign_key_check|(?:table_info|index_info|index_list|foreign_key_list)\s*\([a-zA-Z0-9_"' ]+\))\s*$/i.test(sql.trim())))fail('STAGE8_MAINTENANCE_READ_ONLY_REQUIRED');
};
/** Expired/uncertain issued work permits this diagnostic only. It carries no
 * mutation context, has short per-request timeout, cannot reopen, and does not
 * turn an expired window into another mutation window. */
export function stage8MaintenanceDiagnosticClient(environment){
 const options=stage8MaintenanceClientOptions(environment,undefined);
 options.fetch=(input,init)=>{
  if(new URL(typeof input==='string'?input:input.url).origin!==origin)fail('STAGE8_PRODUCTION_TARGET_MISMATCH');
  return stage8MaintenanceFetch(undefined,input,init);
 };
 const client=createClient(options);
 return Object.freeze({execute(statement,args){readonlyStatement(statement);return client.execute(statement,args);},
  batch(statements,mode){if(mode!=='read')fail('STAGE8_MAINTENANCE_READ_ONLY_REQUIRED');statements.forEach(readonlyStatement);return client.batch(statements,mode);},close:()=>client.close()});
}
