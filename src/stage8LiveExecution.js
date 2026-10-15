import {randomUUID} from 'node:crypto';
import {bodySha256} from './briefingTriggerAuth.js';
import {canonicalJson} from './phase4EntityStore.js';
import {withDurableExecution,databaseNowMs,requireSettledOperation} from './phase4ExecutionContext.js';
import {liveProducerConfiguration,registerLiveExecution,liveScopeDigest} from './stage8LiveProducerAuthority.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const safeResult=value=>Object.fromEntries(Object.entries(value).filter(([key,v])=>
 ['outcome','itemsProcessed','jobsCompleted','jobsFailed','remainingJobs','unitsCommitted','alertSourceDigest'].includes(key)
 &&(key==='alertSourceDigest'?typeof v==='string'&&/^[a-f0-9]{64}$/.test(v):key==='outcome'?['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','FAILED'].includes(v):Number.isSafeInteger(v)&&v>=0)));
/** Closed server runner. Work is bound once by composition; callers supply no
 * output, receipts, SQL, result flags, source manifests or delivery transport. */
export function createStage8LiveExecutionRunner({db,keys,capability,capture,assertContext,work}){
 if(typeof capture!=='function'||typeof assertContext!=='function'||typeof work!=='function')fail('STAGE8_LIVE_RUNNER_REQUIRED');
 liveProducerConfiguration(capability,db.raw,keys);
 return async function run({userId,requestId=randomUUID()}={}){
  const g=liveProducerConfiguration(capability,db.raw,keys,userId),ctx=await capture(userId);
  if(ctx.userId!==userId||ctx.executionMode!=='LIVE'||![ctx.inputGeneration,ctx.sourceGeneration,ctx.lifecycleGeneration,ctx.authGeneration,ctx.purgeGeneration].every(v=>Number.isSafeInteger(v)&&v>=0))fail('STAGE8_LIVE_CAPTURE_REQUIRED');
  const tenantScope=liveScopeDigest(keys,ctx);
  if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{8,128}$/.test(requestId))fail('STAGE8_LIVE_REQUEST_INVALID');
  const request=Object.freeze({requestId,phase:'STAGE6_DRAIN',releaseSha:g.releaseSha,executionMode:'LIVE',triggerSource:'manual',configProof:g.configProof,contract:'stage8-live-producer-v1',tenantScope});
  const canonical=canonicalJson(request),identity=bodySha256(canonical),scopeKey=bodySha256(JSON.stringify(['phase4-execution-scope-v1','STAGE6_DRAIN','LIVE',g.configProof]));
  const owner=randomUUID(),at=Date.now();let claim;
  const authority=Object.freeze({assert(){liveProducerConfiguration(capability,db.raw,keys,userId);}});
  const prior=await db.transaction(async()=>{
   authority.assert();await assertContext(ctx);const row=(await db.raw.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[requestId]})).rows[0];
   if(row){
    if(row.canonical_request_json!==canonical||row.identity_digest!==identity||row.scope_key!==scopeKey)fail('STAGE8_LIVE_REQUEST_CONFLICT');
    if(['FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(row.state))return row;
    if(!['ESTABLISHED','WORK_COMMITTED'].includes(row.state)||row.lease_until>Date.now())fail('STAGE8_LIVE_REQUEST_PENDING');
    await db.raw.execute({sql:`UPDATE stage8_live_executions SET owner=?,generation=generation+1,lease_until=?,deadline_at=?,updated_at=? WHERE execution_id=? AND state=? AND generation=? AND lease_until<=${databaseNowMs}`,args:[owner,at+60000,at+45000,at,requestId,row.state,row.generation]});
    const updated=(await db.raw.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[requestId]})).rows[0];
    if(updated.owner!==owner)fail('REQUEST_OWNER_FENCED');
    claim=Object.freeze({executionId:requestId,request,identity,scopeKey,owner,generation:updated.generation});return updated;
   }
   await db.raw.execute({sql:`INSERT INTO stage8_live_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,'STAGE6_DRAIN',?,'LIVE','manual',?,?,1,?,?,'ESTABLISHED',?,?)`,args:[requestId,identity,scopeKey,canonical,g.releaseSha,g.configProof,owner,at+60000,at+45000,at,at]});
   claim=Object.freeze({executionId:requestId,request,identity,scopeKey,owner,generation:1});return null;
  });
  if(['FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(prior?.state))return Object.freeze({replayed:true,executionId:requestId,result:verifyLiveExecutionResult(keys,prior)});
  let result=prior?.state==='WORK_COMMITTED'?verifyLiveExecutionResult(keys,prior):null;
  if(!result){
   let output;
   if(prior?.state==='ESTABLISHED'){
    // Recover only the actual committed units. This never fabricates scope
    // completion or reruns a lease grant under an old named work identity.
    const count=(await db.raw.execute({sql:'SELECT count(*) n FROM stage8_live_execution_work_receipts WHERE execution_id=?',args:[requestId]})).rows[0].n;
    output={outcome:count?'PARTIAL':'NO_WORK'};
   }else{
    const execution={claim,keys,pending:new Set(),authority};registerLiveExecution(capability,execution,db.raw,keys,userId,ctx);
    output=await withDurableExecution(execution,async()=>{const value=await work(userId,ctx);requireSettledOperation();return value;});
   }
   result={version:2,identity,releaseSha:g.releaseSha,phase:'STAGE6_DRAIN',source:'manual',executionMode:'LIVE',configProof:g.configProof,...safeResult(output)};
   result.signature=keys.lookup(['stage8-live-execution-result-v1',request.tenantScope,canonicalJson(result)]);
   if(!result.outcome)fail('STAGE8_LIVE_RESULT_INVALID');
   const json=canonicalJson(result);await db.transaction(async()=>{
    authority.assert();await assertContext(ctx);const changed=await db.raw.execute({sql:`UPDATE stage8_live_executions SET state='WORK_COMMITTED',result_json=?,result_digest=?,work_committed_at=?,updated_at=? WHERE execution_id=? AND owner=? AND generation=? AND state='ESTABLISHED' AND deadline_at>${databaseNowMs} AND lease_until>${databaseNowMs}`,args:[json,bodySha256(json),Date.now(),Date.now(),requestId,owner,claim.generation]});
    if(changed.rowsAffected!==1)fail('REQUEST_OWNER_FENCED');
   });
  }
  await db.transaction(async()=>{
   authority.assert();await assertContext(ctx);const changed=await db.raw.execute({sql:`UPDATE stage8_live_executions SET state=?,finalized_at=?,updated_at=? WHERE execution_id=? AND owner=? AND generation=? AND state='WORK_COMMITTED' AND deadline_at>${databaseNowMs} AND lease_until>${databaseNowMs}`,args:[result.outcome==='FAILED'?'FINALIZED_FAILURE':'FINALIZED_SUCCESS',Date.now(),Date.now(),requestId,owner,claim.generation]});
   if(changed.rowsAffected!==1)fail('REQUEST_OWNER_FENCED');
  });
  return Object.freeze({replayed:false,recovered:Boolean(prior),executionId:requestId,result:Object.freeze(result)});
 };
}

export function verifyLiveExecutionResult(keys,row){
 if(typeof row.result_json!=='string'||bodySha256(row.result_json)!==row.result_digest)fail('STAGE8_LIVE_RESULT_INTEGRITY');
 let result,request;try{result=JSON.parse(row.result_json);request=JSON.parse(row.canonical_request_json);}catch{fail('STAGE8_LIVE_RESULT_INTEGRITY');}
 const {signature,...payload}=result;
 if(request.contract!=='stage8-live-producer-v1'||bodySha256(canonicalJson(request))!==row.identity_digest
  ||signature!==keys.lookup(['stage8-live-execution-result-v1',request.tenantScope,canonicalJson(payload)])
  ||result.identity!==row.identity_digest||result.releaseSha!==row.release_sha||result.configProof!==row.config_proof
  ||result.phase!==row.phase||result.source!==row.trigger_source||result.executionMode!=='LIVE'||row.execution_mode!=='LIVE')fail('STAGE8_LIVE_RESULT_INTEGRITY');
 return Object.freeze(result);
}
