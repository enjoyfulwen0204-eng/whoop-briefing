import {requireUserId} from './userContext.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {databaseNowMs,withDurableExecution} from './phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {AsyncLocalStorage} from 'node:async_hooks';

const COMPONENT='phase4_beta_pilot_permit_v1', HASH=/^[a-f0-9]{64}$/;
export const PILOT_DURATION_MS=24*60*60_000;
export const PILOT_MAX_ATTEMPTS=48;
export const PILOT_OPERATIONAL_MICRO_USD=400_000;
const UNIT_KEYS=['rowsRead','rowsWritten','storageBytes','bytesSynced','microUsd'];
const issuedGrants=new WeakMap(),submittedGrants=new WeakSet(),attemptScope=new AsyncLocalStorage();
const closureScope=new AsyncLocalStorage();
export const closingBetaPilotPermit=db=>Boolean(db?.raw)&&closureScope.getStore()===db.raw;
const fail=()=>{throw Object.assign(Error('BETA_PILOT_DENIED'),{code:'BETA_PILOT_DENIED'});};
export function requireBetaPilotGrant(grant,userId=grant?.userId,client){
 if(!grant||!issuedGrants.has(grant)||userId!==grant.userId||(client&&issuedGrants.get(grant)!==client))fail();grant.assertTime();return grant;
}
export async function withBetaPilotAttempt(grant,userId,work){
 try{requireBetaPilotGrant(grant,userId);}catch(error){if(issuedGrants.has(grant))await grant.settleInvalidation();throw error;}
 if(submittedGrants.has(grant)||typeof work!=='function')fail();
 submittedGrants.add(grant);await grant.assert();
 return attemptScope.run(grant,work);
}
export function requireCurrentBetaPilotAttempt(userId,client){return requireBetaPilotGrant(attemptScope.getStore(),userId,client);}

/** No provider/query bound has been qualified. A flag, meter, claimed price or
 * operator-supplied JSON must not manufacture this authority. Adding a bound
 * requires an exact new independently reviewed code candidate and evidence. */
export function reviewedPilotReservation(){return null;}

export function betaPilotConfiguration(environment={}) {
 const names=['ID','USER_ID','START_AT','CONSENT_SHA256','COST_BOUND_ID'];
 const values=names.map(name=>environment[`PHASE4_BETA_PILOT_${name}`]??'');
 if(values.every(value=>value===''))return null;
 const [id,userId,startAt,consentSha256,costBoundId]=values;
 const start=Date.parse(startAt);
 if(!HASH.test(id)||typeof userId!=='string'||userId!==requireUserId(userId,'betaPilot')
   ||!HASH.test(consentSha256)||!HASH.test(costBoundId)||!Number.isSafeInteger(start)
   ||new Date(start).toISOString()!==startAt||!Number.isSafeInteger(start+PILOT_DURATION_MS))fail();
 return Object.freeze({id,userId,startAt:start,endAt:start+PILOT_DURATION_MS,consentSha256,costBoundId,maxAttempts:PILOT_MAX_ATTEMPTS});
}

export function validatePilotReservation(reservation) {
 if(!reservation||!HASH.test(reservation.evidenceSha256)||!HASH.test(reservation.id)
   ||!reservation.perAttempt||!reservation.maximum
   ||Object.keys(reservation.perAttempt).length!==UNIT_KEYS.length||Object.keys(reservation.maximum).length!==UNIT_KEYS.length)fail();
 for(const key of UNIT_KEYS) {
  const unit=reservation.perAttempt[key],maximum=reservation.maximum[key];
  if(!Number.isSafeInteger(unit)||unit<0||!Number.isSafeInteger(maximum)||maximum<unit)fail();
 }
 if(reservation.perAttempt.microUsd<1||reservation.maximum.microUsd>PILOT_OPERATIONAL_MICRO_USD)fail();
 return reservation;
}

/** Global coordination only: strict counters/timestamps/keyed opaque digests.
 * No user ID, health facts, provider token or arbitrary narrative is persisted.
 * The single fixed component deliberately cannot be reset by a new permit ID,
 * release, retry or process restart. No DELETE/reset/refund operation exists. */
export function createBetaPilotPermit({db,keys,config,reservation}={}) {
 requirePhase4Keys(keys);validatePilotReservation(reservation);
 if(!config||!HASH.test(config.id)||!HASH.test(config.consentSha256)||config.userId!==requireUserId(config.userId,'betaPilot')
   ||!Number.isSafeInteger(config.startAt)||config.endAt-config.startAt!==PILOT_DURATION_MS||config.maxAttempts!==PILOT_MAX_ATTEMPTS
   ||reservation.id!==config.costBoundId||!db?.raw||typeof db.transaction!=='function')fail();
 // The file seam is exclusively a local fixture. Every remote composition,
 // including callers of exported lower-level worker factories, uses the same
 // reviewed qualification; generic JSON cannot grant remote pilot authority.
 if(db.raw.protocol!=='file'&&reservation!==reviewedPilotReservation(config.costBoundId))fail();
 const fingerprint=keys.lookup(['beta-pilot-v1',config,reservation]);
 const seal=state=>keys.lookup(['beta-pilot-state-v1',state]);
 const decode=row=>{
  try {
   const record=JSON.parse(row.last_detail),{signature,...state}=record;
   if(Object.keys(state).length!==8||state.version!==1||state.fingerprint!==fingerprint
     ||state.startAt!==config.startAt||state.endAt!==config.endAt
     ||!Number.isSafeInteger(state.lifecycleGeneration)||state.lifecycleGeneration<1
     ||!Number.isSafeInteger(state.attempts)||state.attempts<0||state.attempts>config.maxAttempts
     ||!Number.isSafeInteger(state.lastObservedAt)||state.lastObservedAt<config.startAt||typeof state.closed!=='boolean'
     ||signature!==seal(state))fail();
   return state;
  }catch{fail();}
 };
 const read=async client=>(await client.execute({sql:'SELECT last_detail FROM system_heartbeats WHERE scope=\'global\' AND component=?',args:[COMPONENT]})).rows[0]??null;
 const observe=async client=>(await client.execute({sql:`SELECT ${databaseNowMs} observed_at,
  (SELECT u.lifecycle_generation FROM users u JOIN user_onboarding o ON o.user_id=u.id
   WHERE u.id=? AND u.status='ACTIVE' AND o.state='READY') lifecycle_generation`,args:[config.userId]})).rows[0];
 let latestObservedAt=config.startAt;
 const eligible=(row,state)=>Number.isSafeInteger(row?.observed_at)&&row.observed_at>=Math.max(config.startAt,latestObservedAt)&&row.observed_at<config.endAt
  &&Number.isSafeInteger(row.lifecycle_generation)&&row.lifecycle_generation>0
  &&(!state||!state.closed&&row.lifecycle_generation===state.lifecycleGeneration&&row.observed_at>=state.lastObservedAt);
 const write=async(row,state,observedAt)=>{
  const json=JSON.stringify({...state,signature:seal(state)}),at=new Date(observedAt).toISOString();
  const changed=row?await db.raw.execute({sql:`UPDATE system_heartbeats SET last_detail=?,updated_at=?
    WHERE scope='global' AND component=? AND last_detail=?`,args:[json,at,COMPONENT,row.last_detail]}):
   await db.raw.execute({sql:`INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at)
    VALUES('global',?,?,?,?) ON CONFLICT(scope,component) DO NOTHING`,args:[COMPONENT,at,json,at]});
  if(changed.rowsAffected!==1)fail();
 };
 let locallyClosed=false,closurePromise,closureQueued=false,invalidObservedAt;
 // Negative-only control metadata. Do not place closure in the failing work
 // transaction: its rollback would erase the denial. Processing completion
 // releases the root writer before awaiting this separate bounded CAS.
 const persistClosure=()=>{
  if(closurePromise)return closurePromise;
  closurePromise=(async()=>{
   const cleanup=createExecutionBudget({budgetMs:5000});
   // This is control cleanup after work completion, not a synthetic durable
   // business execution. Clearing that context also lets an idle file receiver
   // re-admit after definite contention without treating closure as in-flight work.
   try{return await closureScope.run(db.raw,()=>withDurableExecution(undefined,()=>
    withExecutionBudget(cleanup,()=>cleanup.run(()=>db.transaction(async()=>{
     const row=await read(db.raw);if(!row)fail();const state=decode(row);
     if(!state.closed)await write(row,{...state,closed:true,lastObservedAt:Math.max(state.lastObservedAt,invalidObservedAt??state.lastObservedAt)},Date.now());
    })))));}
   finally{cleanup.close();}
  })();
  // Synchronous authority checks cannot await. Keep the rejected promise
  // observable by settleInvalidation(), never turn it into a success proof.
  closurePromise.catch(()=>{});return closurePromise;
 };
 const invalidate=observedAt=>{
  locallyClosed=true;
  if(Number.isSafeInteger(observedAt))invalidObservedAt=Math.max(invalidObservedAt??observedAt,observedAt,latestObservedAt);
  if(db.processingTransactionActive?.()){
   if(!closureQueued){closureQueued=true;db.afterProcessingCompletion(()=>persistClosure());}
   return;
  }
  return persistClosure();
 };
 const assert=async client=>{
  if(closingBetaPilotPermit(db))return;
  const row=await read(client??db.raw);if(!row)fail();const state=decode(row);
  const current=await observe(client??db.raw);
  if(locallyClosed||!eligible(current,state)){await invalidate(current?.observed_at);fail();}
  latestObservedAt=Math.max(latestObservedAt,current.observed_at,state.lastObservedAt);return state;
 };
 return Object.freeze({
  userId:config.userId,
  async reserve(){
   const result=await db.transaction(async()=>{
    const row=await read(db.raw),current=await observe(db.raw),previous=row?decode(row):null;
    if(locallyClosed||!eligible(current,previous)){
     if(previous&&!previous.closed)await write(row,{...previous,closed:true,lastObservedAt:Math.max(previous.lastObservedAt,current.observed_at)},current.observed_at);
     return null;
    }
    latestObservedAt=Math.max(latestObservedAt,current.observed_at);
    const stateBefore=previous??{version:1,fingerprint,startAt:config.startAt,endAt:config.endAt,lifecycleGeneration:current.lifecycle_generation,attempts:0,lastObservedAt:current.observed_at,closed:false};
    if(stateBefore.attempts>=config.maxAttempts)return null;
    const attempts=stateBefore.attempts+1;
    for(const key of UNIT_KEYS)if(!Number.isSafeInteger(attempts*reservation.perAttempt[key])||attempts*reservation.perAttempt[key]>reservation.maximum[key])return null;
    await write(row,{...stateBefore,attempts,lastObservedAt:current.observed_at},current.observed_at);
    // COMMIT uncertainty never refunds this reservation. A fresh invocation
    // must reserve again before submission, including retries/continuations.
    const deadline=performance.now()+Math.max(0,config.endAt-current.observed_at);
    const assertTime=()=>{if(closingBetaPilotPermit(db))return;if(locallyClosed||performance.now()>=deadline){invalidate(config.endAt);fail();}};
    const grant=Object.freeze({userId:config.userId,attempt:attempts,assertTime,
     settleInvalidation:()=>locallyClosed?persistClosure():undefined,
     assert:async client=>{if(performance.now()>=deadline){await invalidate(config.endAt);fail();}return assert(client);}});
    issuedGrants.set(grant,db.raw);return grant;
   });
   if(!result)fail();return result;
  },
  assert,
 });
}
