import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {runExecutionPhase}=await mod('src/phase4Execution.js');
const {configurationProof}=await mod('src/phase4ExecutionStore.js');
const {runningReleaseSha}=await mod('src/phase4Release.js');
const {publicBetaConfiguration}=await mod('src/publicBetaConfig.js');
const {OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js');
const {requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
const {createPublicBetaRuntime,authorizePublicBetaRuntime}=await mod('src/publicBeta.js');
const {createPhase4Foundation}=await mod('src/phase4Foundation.js');
const {verifyV27RouteSource}=await mod('src/phase4ReceiptRouting.js');
const {bodySha256}=await mod('src/briefingTriggerAuth.js');
const {healthSourceVersion}=await mod('src/phase4SourceVersion.js');
test('Journal seventh unit through DOMAIN and USER cursor across fresh managed115ms continuations',async t=>{
 const f=await residualFixture(t,{http:true});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha);
 const request=phase=>({requestId:randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase});
 const common=()=>({db:f.db,keys:fixtureKeys,environment,env:{dryRun:false}}),syncReq=request('SYNC');
 const sync=await runExecutionPhase({...common(),request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);
 const initialJobs=await f.jobs(),computation=(await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0];
 const journal=[...(await f.db.raw.execute("SELECT privacy_artifact_id FROM journal_events WHERE user_id='a' AND fact_status='ACTIVE' ORDER BY privacy_artifact_id COLLATE BINARY")).rows];assert.equal(journal.length,7);
 let firstSourceCommitted=false,domainCommitted=false,userAdvanced=false,bodyReference,domainSnapshot;
 for(let leg=1;leg<=11;leg++){
  await f.fresh();const selected=(await f.db.raw.execute("SELECT job_kind FROM phase4_jobs WHERE user_id='a' ORDER BY updated_at,job_kind LIMIT 1")).rows[0].job_kind;
  f.setLatency(leg>2?115:0);const before=structuredClone(f.transport.counts),started=performance.now();
  const req={...request('STAGE6_DRAIN'),syncRequestId:syncReq.requestId,handoff:sync.body.handoff};
  const runtime={phase4Stage6:{drain:async args=>{
   const pilotGrant=requireCurrentBetaPilotAttempt('a',f.db.raw),admission=await f.db.admitRuntime();
   const worker=(await createPublicBetaRuntime({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})})).phase4Stage6;
   return worker.drain(args);
  }}};
  const result=await runExecutionPhase({...common(),request:req,deps:{runtime}});
  const evidence={leg,latencyMs:leg>2?115:0,wholeMs:performance.now()-started,httpRequests:f.transport.counts.httpRequests-before.httpRequests,outcome:result.body.result?.outcome,settlement:result.body.result?.settlementState,items:result.body.result?.itemsProcessed,units:result.body.result?.unitsCommitted??0,failedJobs:result.body.result?.jobsFailed,stopReason:result.body.result?.stopReason};
  f.setLatency(0);evidence.jobs=await f.jobs();evidence.counts=await f.counts();console.log('RESIDUAL_COLD_BOUNDARY '+JSON.stringify(evidence));
  assert.equal(evidence.settlement,'FINALIZED_SUCCESS');assert.equal(evidence.failedJobs,0);
  if(leg>2)assert.ok(evidence.wholeMs<45000,'whole managed continuation including admission and settlement');
  assert.ok(evidence.jobs.every(j=>j.state==='PENDING'&&j.lease_owner===null&&j.attempt===0));
  if(leg<=2)assert.equal(evidence.items,6);
  for(const j of evidence.jobs){const original=initialJobs.find(x=>x.job_kind===j.job_kind);assert.equal(j.requested_generation,original.requested_generation);assert.equal(j.scope_revision,original.scope_revision);}
  if(leg===2)for(const j of evidence.jobs){assert.equal(j.completed_generation,0);assert.equal(j.full_scan_cursor,JSON.stringify(['JOURNAL_FACT',journal[5].privacy_artifact_id]));}
  if(leg>2&&evidence.counts.body>0&&!firstSourceCommitted){
   firstSourceCommitted=true;assert.ok(evidence.wholeMs<45000,'cold USER body commit must fit whole45s including admission and settlement');
   const job=evidence.jobs.find(x=>x.job_kind===selected);assert.equal(job.full_scan_cursor,JSON.stringify(['JOURNAL_FACT',journal[6].privacy_artifact_id]));
   const rows=[...(await f.db.raw.execute('SELECT * FROM body_energy_results')).rows];assert.equal(rows.length,1);const body=rows[0];
   assert.equal(body.user_id,'a');assert.equal(body.execution_mode,'SHADOW');assert.equal(body.input_generation,job.requested_generation);assert.equal(body.quality_state,'LIMITED');assert.ok(Number.isFinite(body.value));
   const domain=[...(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='BODY_ENERGY_COMPUTE'")).rows];assert.equal(domain.length,1);verifyV27RouteSource(fixtureKeys,domain[0]);
   const execution=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[req.requestId]})).rows[0];assert.equal(execution.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(execution.result_json),execution.result_digest);
   const step=fixtureKeys.lookup(['phase4-logical-work-v1','stage6.body-source',['a','SHADOW',selected,job.requested_generation,job.scope_revision,['USER','a',JSON.stringify(['USER','a']),computation.updated_at]]]);
   const key=fixtureKeys.lookup(['execution-work-step-v2',execution.identity_digest,execution.scope_key,['named',step]]);
   const ack=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?',args:[req.requestId,key]})).rows[0];assert.ok(ack);assert.equal(ack.step_key,key);assert.equal(ack.request_digest,execution.identity_digest);assert.equal(ack.scope_key,execution.scope_key);assert.equal(ack.generation,execution.generation);assert.ok(ack.committed_at<=execution.finalized_at&&execution.finalized_at<execution.deadline_at);
   const producers=[...(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_producers WHERE producing_execution_id=?',args:[req.requestId]})).rows];assert.equal(producers.length,1);const p=producers[0];assert.equal(p.user_id,'a');assert.equal(p.execution_mode,'SHADOW');assert.equal(p.input_generation,body.input_generation);assert.equal(p.execution_seq,execution.execution_seq);assert.equal(p.producing_generation,execution.generation);assert.equal(p.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',body.input_generation,req.requestId,p.execution_seq,p.producing_generation]));
   const admission=await f.db.admitRuntime(),stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,admission});await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{const actual=await stores.readArtifact(context,'body_energy_results',{result_id:body.result_id});assert.equal(actual.row.result_hash,body.result_hash);bodyReference={source_type:actual.ref.type,source_id:actual.ref.id,source_mode:actual.ref.executionMode,source_version:healthSourceVersion(actual.row),as_of:null};});
   console.log('COLD_BODY_COMMIT_PROOF '+JSON.stringify({exactSeventhCursor:true,generationPreserved:true,quality:body.quality_state,bodyReceiptVerified:true,namedSourceAck:true,producerVerified:true,resultDigestVerified:true,beforeDeadline:true,jobComplete:false,domainCommitted:false}));
  }

  const metricDomains=[...(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW' AND operation_kind='analyzeMetric'")).rows];
  if(metricDomains.length){
   assert.equal(metricDomains.length,1);
   for(const row of metricDomains){
    verifyV27RouteSource(fixtureKeys,row);
    const decoded=JSON.parse(row.request_json),r=decoded.request;
    assert.equal(r.metricKey,'body_energy');assert.equal(r.windowFamily,'STAGE6_CURRENT_BODY_ENERGY');assert.equal(r.refresh,true);
    assert.deepEqual(r.currentSource,bodyReference);assert.equal(row.input_generation,initialJobs[0].requested_generation);
    await assertNamedAck(f,'domain.operation',['a','SHADOW',row.input_generation,'analyzeMetric',row.operation_key]);
   }
   if(domainSnapshot)assert.deepEqual(metricDomains,domainSnapshot,'fresh continuation replays immutable DOMAIN rather than replacing it');
   domainSnapshot=structuredClone(metricDomains);
   const execution=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[req.requestId]})).rows[0];
   assert.equal(execution.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(execution.result_json),execution.result_digest);
   domainCommitted=true;
   userAdvanced=evidence.jobs.some(j=>j.full_scan_cursor&&j.full_scan_cursor>=JSON.stringify(['USER','a']));
   if(userAdvanced){
    const job=evidence.jobs.find(j=>j.full_scan_cursor===JSON.stringify(['USER','a']));assert.ok(job);
    await assertNamedAck(f,'stage6.checkpoint',['a','SHADOW',job.job_kind,job.requested_generation,job.scope_revision,[JSON.stringify(['USER','a'])]],req.requestId);
    await f.fresh();assert.deepEqual(await f.jobs(),evidence.jobs,'checkpoint survives connection restart');
    const beforeReplay=await f.counts(),replay=await runExecutionPhase({...common(),request:req,deps:{runtime:{phase4Stage6:{drain:()=>{throw Error('FINALIZED_REPLAY_RERAN_WORK');}}}}});
    assert.equal(replay.body.result.settlementState,'FINALIZED_SUCCESS');assert.deepEqual(await f.jobs(),evidence.jobs);assert.deepEqual(await f.counts(),beforeReplay);
    console.log('CONTINUATION_CHAIN_COMPLETE '+JSON.stringify({leg,domainCount:metricDomains.length,userAdvanced,domainCommitted,jobCompleted:false}));break;}
  }
 }
 assert.equal(domainCommitted,true,'current DOMAIN must finalize within admitted bounded continuations');
 assert.equal(userAdvanced,true,'one actual job cursor must advance beyond Journal through original USER work');
 assert.equal(firstSourceCommitted,true,'seventh Journal followed by a fresh continuation must commit real current-generation Body source work');
 console.log('ISOLATED_BOUNDARY_ONLY '+JSON.stringify({production:false,sourceCounts:f.sourceCounts,firstSourceCommitted}));
});

async function assertNamedAck(f,kind,facts,expectedExecution){
 const step=fixtureKeys.lookup(['phase4-logical-work-v1',kind,facts]);
 const producers=[...(await f.db.raw.execute("SELECT * FROM phase4_execution_producers WHERE user_id='a' AND execution_mode='SHADOW'")).rows];let found=false;
 for(const p of producers){
  if(expectedExecution&&p.producing_execution_id!==expectedExecution)continue;
  const e=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[p.producing_execution_id]})).rows[0];
  const key=fixtureKeys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',step]]);
  const a=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?',args:[e.execution_id,key]})).rows[0];if(!a)continue;
  assert.equal(e.phase,'STAGE6_DRAIN');assert.equal(e.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(e.result_json),e.result_digest);
  assert.equal(a.step_key,key);assert.equal(a.request_digest,e.identity_digest);assert.equal(a.scope_key,e.scope_key);assert.equal(a.generation,p.producing_generation);
  assert.equal(p.execution_seq,e.execution_seq);assert.equal(p.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',p.input_generation,e.execution_id,p.execution_seq,p.producing_generation]));
  assert.ok(a.committed_at<=e.finalized_at&&e.finalized_at<=e.deadline_at);found=true;
 }
 assert.ok(found,'original named '+kind+' ACK and finalized producing execution');
}
