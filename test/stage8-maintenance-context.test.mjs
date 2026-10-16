import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {withStage8Maintenance,dispatchStage8MaintenanceMutation,stage8MaintenanceFetch,stage8MaintenanceClientOptions,stage8MaintenanceDiagnosticClient} from '../scripts/stage8-maintenance-context.mjs';
import {main} from '../scripts/stage8-production-migrate.mjs';

const host='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io',environment={TURSO_DATABASE_URL:'libsql://'+host,TURSO_AUTH_TOKEN:'synthetic-only'};
function syntheticContext({deadlineAt,controller=new AbortController(),afterPrepare=()=>{}}){
 let boundaries=0;
 return Object.freeze({kind:'BOUNDED_WINDOW_CONTEXT_V1',phase:'MIGRATE_35',deadlineAt,assertBeforeMutation:async()=>undefined,
  async dispatchMutation({prepare,dispatch}){const prepared=await prepare();boundaries++;afterPrepare(boundaries);return dispatch({prepared,deadlineAt,remainingMs:Math.max(1,deadlineAt-Date.now()),signal:controller.signal});}});
}
test('deadline crossed in final awaited guard dispatches zero mutation calls',async t=>{
 const original=Date.now(),deadlineAt=original+1000;let at=original,calls=0;t.mock.method(Date,'now',()=>at);
 const raw=syntheticContext({deadlineAt,afterPrepare:n=>{if(n===2)at=deadlineAt;}});
 await assert.rejects(withStage8Maintenance(raw,'MIGRATE_35',context=>dispatchStage8MaintenanceMutation(context,{prepare:async()=>({}),dispatch:()=>{calls++;}})),/DEADLINE_REACHED/);
 assert.equal(calls,0);
});
test('actual canonical libSQL driver cannot send a queued write after original deadline',async t=>{
 const original=Date.now(),deadlineAt=original+1000;let at=original,calls=0;t.mock.method(Date,'now',()=>at);
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('REMOTE_WRITE_FORBIDDEN');});
 await assert.rejects(withStage8Maintenance(syntheticContext({deadlineAt}),'MIGRATE_35',async context=>{
  const client=createClient(stage8MaintenanceClientOptions(environment,context));
  try{const pending=client.batch(['CREATE TABLE synthetic_forbidden(x)'],'write');at=deadlineAt;await pending;}finally{client.close();}
 }),/DEADLINE_REACHED/);assert.equal(calls,0);
});
test('original AbortSignal reaches actual fetch and cancels pending I/O without promise-race cancellation',async t=>{
 const controller=new AbortController(),deadlineAt=Date.now()+10000;let observed=false;
 t.mock.method(globalThis,'fetch',(input,{signal})=>new Promise((resolve,reject)=>{observed=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});queueMicrotask(()=>controller.abort(Error('SYNTHETIC_ORIGINAL_ABORT')));}));
 await assert.rejects(withStage8Maintenance(syntheticContext({deadlineAt,controller}),'MIGRATE_35',context=>stage8MaintenanceFetch(context,'https://'+host+'/v2/pipeline')),/SYNTHETIC_ORIGINAL_ABORT/);assert.equal(observed,true);
});
test('canonical transport rejects rebased hosts and diagnostic client rejects mutation APIs',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
 await withStage8Maintenance(syntheticContext({deadlineAt:Date.now()+10000}),'MIGRATE_35',async context=>{
  const options=stage8MaintenanceClientOptions(environment,context);
  assert.throws(()=>options.fetch(new Request('https://attacker.invalid/v2/pipeline')),/TARGET_MISMATCH/);
 });
 const diagnostic=stage8MaintenanceDiagnosticClient(environment);try{
  assert.throws(()=>diagnostic.execute('DELETE FROM users'),/READ_ONLY_REQUIRED/);
  assert.throws(()=>diagnostic.execute('PRAGMA writable_schema=ON'),/READ_ONLY_REQUIRED/);
  assert.throws(()=>diagnostic.execute('SELECT 1; DELETE FROM users'),/READ_ONLY_REQUIRED/);
  assert.throws(()=>diagnostic.batch(['SELECT 1'],'write'),/READ_ONLY_REQUIRED/);
 }finally{diagnostic.close();}assert.equal(calls,0);
});
test('bounded apply rejects source34 and target34 before any provider or file access',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
 for(const [from,to] of [['34','35'],['33','34']])await assert.rejects(main(['--apply','--expected-commit','a'.repeat(40),'--source-commit','b'.repeat(40),'--inventory-file','must-not-read','--observation-file','must-not-read','--from-version',from,'--target-version',to],{},syntheticContext({deadlineAt:Date.now()+10000})),/BOUNDED_ATOMIC33_TO35_REQUIRED/);
 assert.equal(calls,0);
});
