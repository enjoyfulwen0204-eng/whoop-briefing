import {createExecutionBudget} from './executionBudget.js';
import {currentDurableExecution,workStepKey} from './phase4ExecutionContext.js';
import {workStepOptions} from './phase4WorkStep.js';
import {canonicalJson} from './phase4EntityStore.js';
import {reconcileExecution,requireSyncHandoff,HANDOFF_TTL_MS,EXECUTION_WORK_MAX_AGE_MS} from './phase4ExecutionStore.js';
import {configurationProof} from './phase4ExecutionStore.js';
import {publicBetaConfiguration} from './publicBetaConfig.js';
import {runningReleaseSha} from './phase4Release.js';
import {summarizeSync} from './syncResult.js';
const fail=(code='STAGE8_FINALIZED_SYNC_REQUIRED')=>{throw Object.assign(Error(code),{code});};
const sign=(keys,value)=>keys.lookup(['stage8-post-sync-metadata-v1',canonicalJson(value)]);
const keyFor=(keys,id,uid)=>'stage8:sync-subject:'+keys.lookup(['stage8-sync-subject-v1',id,uid]);
async function snapshot(db,keys,uid){
 const row=(await db.raw.execute({sql:`SELECT u.status,u.timezone,u.lifecycle_generation,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count,o.state,o.enrollment_revision,COALESCE(n.preference_version,0) preference_version
  FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id
  JOIN user_onboarding o ON o.user_id=u.id LEFT JOIN user_notification_preferences n ON n.user_id=u.id WHERE u.id=?`,args:[uid]})).rows[0];
 if(!row||row.status!=='ACTIVE'||row.state!=='READY'||row.auth_generation<1||row.pending_purge_count!==0)fail();
 return keys.lookup(['stage8-sync-subject-scope-v1',uid,canonicalJson({...row})]);
}
/** Only the actual per-subject canonical SYNC path calls this inside its original
 * execution. A global success summary is insufficient. State holds only opaque
 * keyed metadata, never health content. Its named receipt commits atomically. */
export async function recordStage8SyncSubject({db,userId,sync}){
 const e=currentDurableExecution();if(!e||e.claim.request.phase!=='SYNC'||!summarizeSync(sync?.resources??sync).complete)fail();
 const {keys,claim}=e,id=claim.executionId,scope=await snapshot(db,keys,userId),
  options=workStepOptions('stage8.sync-subject',[id,userId,scope],{discardResult:true});
 return db.transaction(async()=>{
  if(await snapshot(db,keys,userId)!==scope)fail();
  const value={parent:id,identity:claim.identity,scope,generation:claim.generation,receipt:workStepKey(e,['named',options.workStep])};
  await db.setState(keyFor(keys,id,userId),canonicalJson({...value,hmac:sign(keys,value)}));
 },options);
}
/** Separate LIVE authority consumes an unchanged OFF/SHADOW SYNC prerequisite.
 * Existing handoff mode/pilot policy is never promoted. One bounded leg per call;
 * a durable signed ordinal makes restart/retry reuse the exact original request. */
export function createStage8PostSync({db,keys,producer,eligible,enabled,environment,userIds=[]}){
 if(!Array.isArray(userIds)||userIds.length>100||new Set(userIds).size!==userIds.length||userIds.some(id=>typeof id!=='string'||!id||id.length>128))fail();
 const cohort=Object.freeze([...userIds]),exhausted=new Map();let resuming=false;
 async function run({executionId,userId}={}){
  if(currentDurableExecution()||!enabled()||!eligible(userId)||typeof executionId!=='string'||executionId.length>128)fail();
  const row=(await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[executionId]})).rows[0];
  if(!row||row.phase!=='SYNC'||row.state!=='FINALIZED_SUCCESS'||row.release_sha!==runningReleaseSha(environment)
   ||row.config_proof!==configurationProof(keys,publicBetaConfiguration(environment),environment,row.release_sha)
   ||row.execution_mode!==(publicBetaConfiguration(environment).runtime==='on'?'SHADOW':'OFF')
   ||row.finalized_at>Date.now()||Date.now()-row.finalized_at>HANDOFF_TTL_MS||Date.now()-row.created_at>=EXECUTION_WORK_MAX_AGE_MS)fail();
  const request=JSON.parse(row.canonical_request_json),original=await reconcileExecution(db,request,row.identity_digest);
  if(original.state!=='FINALIZED_SUCCESS')fail();
  const handoff=keys.lookup(['phase4-sync-handoff-v3',row.execution_id,row.identity_digest,row.release_sha,row.trigger_source,row.execution_mode,row.config_proof,row.result_digest,row.finalized_at]);
  await requireSyncHandoff(db,{...request,phase:'STAGE6_DRAIN',requestId:keys.lookup(['stage8-sync-consumer-v1',executionId,userId]),syncRequestId:executionId,handoff},keys);
  const raw=await db.getState(keyFor(keys,executionId,userId));if(!raw||raw.length>2048)fail();
  const {hmac,...value}=JSON.parse(raw);
  if(hmac!==sign(keys,value)||value.parent!==executionId||value.identity!==row.identity_digest||value.generation>row.generation)fail();
  const receipt=(await db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[value.receipt]})).rows[0];
  if(!receipt||receipt.execution_id!==executionId||receipt.request_digest!==row.identity_digest||receipt.scope_key!==row.scope_key||receipt.generation!==value.generation||receipt.committed_at>row.finalized_at)fail();
  const progressKey='stage8:sync-progress:'+keys.lookup(['stage8-sync-progress-v1',executionId,userId,value.scope]),
   lock='stage8:live-subject:'+keys.lookup(['stage8-live-subject-lock-v1',userId]),owner=await db.acquireLock(lock,{ttlMs:60000});
  if(!owner)return {status:'BUSY'};
  const check=async()=>{
   if(!enabled()||!eligible(userId)||Date.now()-row.created_at>=EXECUTION_WORK_MAX_AGE_MS||await snapshot(db,keys,userId)!==value.scope||!await db.holdsLock(lock,owner))fail();
   const current=(await db.raw.execute({sql:'SELECT state,result_digest,generation FROM phase4_executions WHERE execution_id=?',args:[executionId]})).rows[0];
   if(current?.state!=='FINALIZED_SUCCESS'||current.result_digest!==row.result_digest||current.generation!==row.generation)fail();
  };
  try{
   await check();const saved=await db.getState(progressKey);let ordinal=0,done=false;
   if(saved){const {hmac,...p}=JSON.parse(saved);if(hmac!==sign(keys,{progressKey,...p})||!Number.isSafeInteger(p.ordinal)||p.ordinal<0||p.ordinal>=64||typeof p.done!=='boolean')fail();ordinal=p.ordinal;done=p.done;}
   const requestId=keys.lookup(['stage8-finalized-sync-live-leg-v1',executionId,row.result_digest,userId,value.scope,ordinal]);
   const result=await db.withRuntimeFence(check,()=>producer.run({userId,requestId}));await check();
   const complete=result.publication.status==='CURRENT',next={ordinal:complete||done?ordinal:ordinal+1,done:complete};if(next.ordinal>=64)fail('STAGE8_POST_SYNC_ORDINAL_EXHAUSTED');
   await db.transaction(async()=>{await check();await db.setState(progressKey,canonicalJson({...next,hmac:sign(keys,{progressKey,...next})}));await check();});
   return {status:complete?'CURRENT':'ANALYSIS_UPDATING',replayed:result.replayed,continuation:!complete,executionId:result.executionId};
  }finally{await db.releaseLock(lock,owner);}
 }
 // Discovery is bounded metadata, never a replacement producer authority.
 // Every selected parent still enters run() and its original fresh fences.
 async function candidate(){
  const budget=createExecutionBudget({budgetMs:5000});
  try{return await budget.run(async()=>{
   const at=Date.now(),release=runningReleaseSha(environment),configuration=publicBetaConfiguration(environment),
    proof=configurationProof(keys,configuration,environment,release),mode=configuration.runtime==='on'?'SHADOW':'OFF';
   const rows=(await db.raw.execute({sql:`SELECT execution_id,identity_digest,generation,result_digest,created_at FROM phase4_executions
    WHERE phase='SYNC' AND state='FINALIZED_SUCCESS' AND release_sha=? AND config_proof=? AND execution_mode=?
    AND created_at>? AND created_at<=? AND finalized_at<=? AND finalized_at>=?
    ORDER BY created_at DESC,execution_id DESC LIMIT 64`,args:[release,proof,mode,at-EXECUTION_WORK_MAX_AGE_MS,at,at,at-HANDOFF_TTL_MS]})).rows;
   for(const [id,expiry] of exhausted)if(expiry<=at)exhausted.delete(id);
   for(const userId of cohort){
    budget.assert();if(!enabled()||!eligible(userId))continue;
    const scope=await snapshot(db,keys,userId);
    for(const row of rows){
     budget.assert();const id=JSON.stringify([row.execution_id,userId]);if(exhausted.has(id))continue;
     const raw=await db.getState(keyFor(keys,row.execution_id,userId));if(!raw)continue;if(raw.length>2048)fail();
     let value,hmac;try{({hmac,...value}=JSON.parse(raw));}catch{fail();}
     if(hmac!==sign(keys,value)||value.parent!==row.execution_id||value.identity!==row.identity_digest
      ||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation>row.generation)fail();
     if(value.scope!==scope)continue;
     const progressKey='stage8:sync-progress:'+keys.lookup(['stage8-sync-progress-v1',row.execution_id,userId,value.scope]),saved=await db.getState(progressKey);
     if(saved){
      if(saved.length>2048)fail();let p,seal;try{({hmac:seal,...p}=JSON.parse(saved));}catch{fail();}
      if(seal!==sign(keys,{progressKey,...p})||!Number.isSafeInteger(p.ordinal)||p.ordinal<0||p.ordinal>=64||typeof p.done!=='boolean')fail();
      if(p.done)continue;
     }
     budget.assert();return {executionId:row.execution_id,userId,id,expiresAt:row.created_at+EXECUTION_WORK_MAX_AGE_MS};
    }
   }
   return null;
  });}finally{budget.close();}
 }
 async function resume(){
  if(currentDurableExecution())fail();if(!enabled())return {status:'DISABLED',invoked:0};if(resuming)return {status:'BUSY',invoked:0};
  resuming=true;try{
   const selected=await candidate();if(!selected)return {status:'IDLE',invoked:0};
   if(!enabled()||!eligible(selected.userId))fail();
   try{return {...await run({executionId:selected.executionId,userId:selected.userId}),invoked:1};}
   catch(error){if(error.code!=='STAGE8_POST_SYNC_ORDINAL_EXHAUSTED')throw error;
    // The original last ordinal has a finalized immutable response. Restart
    // may replay it once; no new ordinal, parent, grant or TTL is created.
    if(exhausted.size>=64)exhausted.delete(exhausted.keys().next().value);
    exhausted.set(selected.id,selected.expiresAt);return {status:'EXHAUSTED',invoked:1};}
  }finally{resuming=false;}
 }
 return Object.freeze({run,resume});
}
