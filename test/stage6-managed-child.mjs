import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {createDrainChildSupervisor,liveDrainGroupMembers} from '../src/drainChildSupervisor.js';
import {linuxMetrics} from './stage6LinuxMetrics.mjs';import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
import {verifyCurrentRuntimeProof} from './stage6RuntimeCurrentProof.mjs';
import {createOperationReceipts} from '../src/phase4OperationReceipts.js';
test('managed Linux child commits under original grants and retires preparation/publication cancellation',async t=>{
 const metrics=linuxMetrics(),physicalFetch=fetch;let db;
 const fresh=async()=>{await db?.close();db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{assert.equal(new URL(r.url).hostname,'isolated.invalid');return physicalFetch('http://fixture:8080/v2/pipeline',{method:'POST',body:await r.text(),signal:r.signal});}});};await fresh();
 const environment={PHASE4_RELEASE_SHA:runningReleaseSha(),PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow'};
 const retainedPermit=(await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component='phase4_beta_pilot_permit_v1'")).rows[0];
 if(retainedPermit)environment.PHASE4_BETA_PILOT_START_AT=new Date(JSON.parse(retainedPermit.last_detail).startAt).toISOString();
 const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'synthetic',telegramChatId:'synthetic'};
 const request=(phase,extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment),...extra});
 const syncRequest=request('SYNC'),sync=await runExecutionPhase({request:syncRequest,db,keys:fixtureKeys,environment,env,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0})}});assert.equal(sync.body.drainAuthorized,true);
 let supervisor; t.after(async()=>{await supervisor?.close();await db.close();console.log('MANAGED_CHILD_FINAL '+JSON.stringify({metrics:metrics.snapshot(),scopes:receiverScopeStatistics()}));metrics.close();});
 const old=(await db.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key);
 const req=request('STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});let pid;
 supervisor=createDrainChildSupervisor({db,keys:fixtureKeys,userId:'a',environment,env,childUrl:new URL('./stage6ManagedDrainChild.mjs',import.meta.url),childPayload:()=>({environment,env}),onBoundary:(stage,{child})=>{pid=child.pid;console.log('MANAGED_CHILD_STAGE '+stage);}});
 const result=await supervisor.runPhase({request:req});console.log('MANAGED_CHILD_NORMAL '+JSON.stringify(result));assert.equal(result.status,200);assert.ok(result.body.result.itemsProcessed||result.body.result.unitsCommitted||result.body.result.jobsCompleted);assert.deepEqual(liveDrainGroupMembers(pid),[]);
 await supervisor.close();await fresh();console.log('MANAGED_CHILD_CURRENT '+JSON.stringify(await verifyCurrentRuntimeProof(db,req.requestId,old)));
 const state=(await db.raw.execute("SELECT u.timezone,u.lifecycle_generation,coalesce(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,c.input_generation,c.algorithm_set_version FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0];
 const context={userId:'a',executionMode:'SHADOW',timezone:state.timezone,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,sourceGeneration:state.source_generation,purgeGeneration:state.purge_generation,inputGeneration:state.input_generation,algorithmSetVersion:state.algorithm_set_version};
 const verifier=createOperationReceipts({client:db.raw,keys:fixtureKeys,schemaVersion:32}),receipts=(await db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW'")).rows;
 for(const row of receipts){verifier.authenticate(context,row);assert.throws(()=>verifier.authenticate(context,{...row,receipt_hmac:'0'.repeat(64)}));assert.throws(()=>verifier.authenticate({...context,userId:'peer'},row));}
 console.log('MANAGED_CHILD_INTEGRITY '+JSON.stringify({authenticatedReceipts:receipts.length,tamperingRejected:true,crossTenantRejected:true}));
 assert.deepEqual(await runExecutionPhase({request:req,db,keys:fixtureKeys,environment,env}),result);
 for(const boundary of ['PREPARATION','CALCULATION','PUBLICATION','COMMIT_ACK']){
  const before=(await db.raw.execute("SELECT job_kind,completed_generation,full_scan_cursor FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
  const cancelled=request('STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});let childPid,at;
  supervisor=createDrainChildSupervisor({db,keys:fixtureKeys,userId:'a',environment,env,childUrl:new URL('./stage6ManagedDrainChild.mjs',import.meta.url),childPayload:()=>({environment,env}),onBoundary:(stage,{child})=>{if(stage===boundary){at=performance.now();childPid=child.pid;child.disconnect();}}});
  const response=await supervisor.runPhase({request:cancelled});console.log('MANAGED_CHILD_CANCEL '+JSON.stringify({boundary,response,shutdownMs:performance.now()-at}));assert.ok([202,503].includes(response.status));assert.ok(childPid);assert.deepEqual(liveDrainGroupMembers(childPid),[]);
  const after=(await db.raw.execute("SELECT job_kind,completed_generation,full_scan_cursor FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
  if(boundary!=='COMMIT_ACK')assert.deepEqual(after,before);
  else{
   assert.notDeepEqual(after,before,'named publication ACK requires a real cursor commit');
   const operations=(await db.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key);
   const replay=await runExecutionPhase({request:cancelled,db,keys:fixtureKeys,environment,env});console.log('MANAGED_CHILD_AFTER_COMMIT_REPLAY '+JSON.stringify(replay));
   assert.equal(replay.status,200);assert.equal(replay.body.result.settlementState,'FINALIZED_SUCCESS');
   assert.deepEqual(await runExecutionPhase({request:cancelled,db,keys:fixtureKeys,environment,env}),replay);
   const repeated=(await db.raw.execute("SELECT deterministic_run_key,count(*) n FROM evidence_runs WHERE user_id='a' GROUP BY deterministic_run_key HAVING count(*)>1")).rows;assert.deepEqual(repeated,[]);
   const retained=(await db.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key);assert.ok(operations.every(key=>retained.includes(key)));
  }
  assert.ok(performance.now()-at<(boundary==='COMMIT_ACK'?45000:7500));await supervisor.close();
 }
 assert.equal((await db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'phase4:drain-parent:%'")).rows[0].n,0);
});
