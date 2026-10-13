import test from 'node:test';import assert from 'node:assert/strict';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js');
const {request,claim}=await mod('test/v32ReviewFixture.js');
const {commitPhaseWork,finalizePhaseWork,configurationProof}=await mod('src/phase4ExecutionStore.js');
const {withDurableExecution}=await mod('src/phase4ExecutionContext.js');
const {createExecutionBudget,withExecutionBudget}=await mod('src/executionBudget.js');
const {runExecutionPhase}=await mod('src/phase4Execution.js');
const {runningReleaseSha}=await mod('src/phase4Release.js');
const {publicBetaConfiguration}=await mod('src/publicBetaConfig.js');
const {OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js');
const {requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
test('profile exact retained USER successor over installed Hrana at115ms',async t=>{
 const f=await residualFixture(t),syncReq=request(),syncOwner=await claim(f.db,syncReq),authority={assert(){}};
 await commitPhaseWork(f.db,syncReq,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS',durationMs:0},authority);
 const sync=await finalizePhaseWork(f.db,syncReq,syncOwner,fixtureKeys,authority);
 for(let n=0;n<60;n++){
  await f.fresh();const admission=await f.db.admitRuntime(),worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const req=request({phase:'STAGE6_DRAIN',syncRequestId:syncReq.requestId,handoff:sync.handoff}),owner=await claim(f.db,req),budget=createExecutionBudget({budgetMs:45000}),a={assert:()=>budget.assert()};
  try{const result=await withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority:a,presentationClock:()=>new Date()},()=>withExecutionBudget(budget,()=>budget.run(()=>worker.drain({triggerSource:'manual',userId:'a',budget:{maxItems:1,maxItemsPerTenant:1}}))));
   assert.equal(result.failedJobs,0);await commitPhaseWork(f.db,req,owner,{outcome:result.outcome,durationMs:result.elapsedMs},a);await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);
  }finally{budget.close()}
  const jobs=await f.jobs();if(jobs.every(j=>j.full_scan_cursor===JSON.stringify(['USER','a']))&&(!process.env.RAW_AFTER_AUTH||Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n)>1))break;
 }
 assert.ok((await f.jobs()).every(j=>j.full_scan_cursor===JSON.stringify(['USER','a'])));
 await f.toHttp();const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),makeReq=phase=>({requestId:crypto.randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase});
 const common=()=>({db:f.db,keys:fixtureKeys,environment,env:{dryRun:false}}),sr=makeReq('SYNC'),s=await runExecutionPhase({...common(),request:sr,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
 const observations=[],profiles=[];let origin,ready;
 for(let leg=1;leg<=Number(process.env.RAW_PROFILE_LEGS??(process.env.RAW_AFTER_AUTH?2:7));leg++){
 await f.fresh();observations.length=0;ready=undefined;
 f.setLatency(115);f.startTrace();const before=structuredClone(f.transport.counts),startedAtMs=Date.now();origin=performance.now();
 const req={...makeReq('STAGE6_DRAIN'),syncRequestId:sr.requestId,handoff:s.body.handoff},runtime={phase4Stage6:{drain:async args=>{const pilotGrant=requireCurrentBetaPilotAttempt('a',f.db.raw),admission=await f.db.admitRuntime(),worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});ready=performance.now()-origin;return worker.drain({...args,budget:{maxItems:1,maxItemsPerTenant:1}})}}};
 const result=await runExecutionPhase({...common(),request:req,deps:{runtime}}),wholeMs=performance.now()-origin,timeline=f.stopTrace();f.setLatency(0);
 const profile={leg,wholeMs,startedAtMs,timeline,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements,ready,observations,result:result.body.result,jobs:await f.jobs(),counts:await f.counts()};profiles.push(profile);
 console.log('RAW_PROFILE '+JSON.stringify(profile));
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.jobsFailed,0);
 assert.ok((result.body.result.unitsCommitted??0)>0||(result.body.result.itemsProcessed??0)>0,'each raw continuation must commit durable progress');
 }

 const raw=(await f.db.raw.execute("SELECT * FROM evidence_runs WHERE subject_key='cycle_strain'")).rows[0];
 if(raw?.state==='COMPLETED'){
  const manifest=JSON.parse(raw.input_manifest_json),scope=manifest.request_scope;
  const context={userId:'a',executionMode:'SHADOW',inputGeneration:scope.input,sourceGeneration:scope.source,
    lifecycleGeneration:scope.lifecycle,authGeneration:scope.auth,purgeGeneration:scope.purge,
    algorithmSetVersion:scope.algorithm,timezone:scope.timezone},
    plan={runKey:raw.deterministic_run_key,inputHash:raw.input_manifest_hash,
      itemKey:fixtureKeys.lookup(['phase4-evidence-item-v1',raw.deterministic_run_key,'baseline-deviation'])};
  const {metricUnitFacts}=await mod('src/phase4MetricUnitReceipt.js'),{bodySha256}=await mod('src/briefingTriggerAuth.js');
  const producers=(await f.db.raw.execute({sql:"SELECT p.*,e.* FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id='a' AND p.execution_mode='SHADOW' AND p.input_generation=?",args:[scope.input]})).rows;
  const units=Number(process.env.RAW_PROFILE_LEGS??7)>=5?['RUN_START','RUN_COMPLETE','ITEM','AUTHORITY']:['RUN_START','RUN_COMPLETE'];
  const verifiedUnits=[];
  for(const kind of units){
    const step=fixtureKeys.lookup(['phase4-logical-work-v1','stage6.metric-preparation-unit',metricUnitFacts(context,plan,kind)]);let found=false;
    for(const e of producers){const key=fixtureKeys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',step]]),
      ack=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?',args:[e.execution_id,key]})).rows[0];
      if(!ack)continue;found=true;assert.equal(e.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(e.result_json),e.result_digest);
      assert.equal(e.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',scope.input,e.execution_id,e.execution_seq,e.producing_generation]));
      assert.equal(ack.generation,e.producing_generation);assert.equal(ack.scope_key,e.scope_key);assert.equal(ack.request_digest,e.identity_digest);assert.equal(ack.step_key,key);
      assert.ok(ack.committed_at<=e.finalized_at&&e.finalized_at<=e.deadline_at);
      const profile=profiles.find(value=>value.result.identity===e.identity_digest);
      if(profile){const namedAckAtMs=ack.committed_at-profile.startedAtMs,commit=profile.timeline.find(event=>event.event==='request_end'&&event.kinds.includes('COMMIT')&&event.atMs>=namedAckAtMs);
       assert.ok(commit,'actual Hrana COMMIT ACK after named '+kind+' receipt');
       const workerCommitMs=commit.atMs-profile.ready;assert.ok(workerCommitMs<30000,'raw '+kind+' commit within effective worker deadline');
       verifiedUnits.push({unit:kind,executionSeq:e.execution_seq,receiptKey:ack.receipt_key,producerExecutionId:e.execution_id,committedAt:ack.committed_at,finalizedAt:e.finalized_at,deadlineAt:e.deadline_at,namedAckAtMs,commitAckAtMs:commit.atMs,workerCommitMs});}
    }assert.ok(found,'exact durable raw '+kind+' ACK');
  }
  const before=await f.counts();await f.fresh();assert.deepEqual(await f.counts(),before);
  console.log('RAW_DURABLE_ACK_PROOF '+JSON.stringify({units,verifiedUnits,namedAck:true,producerHmac:true,finalized:true,sourceGeneration:scope.source,inputGeneration:scope.input,fullRun:raw.run_id,immutableInputHash:plan.inputHash,restartCountsUnchanged:true,production:false}));
 }

});
