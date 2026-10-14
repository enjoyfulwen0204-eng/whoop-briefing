import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {stage6CapacityStatus} from '../src/stage6CapacityRuntime.js';import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
import {verifyShortProof} from './stage6ShortProof.mjs';import {verifyCurrentRuntimeProof} from './stage6RuntimeCurrentProof.mjs';import {linuxMetrics} from './stage6LinuxMetrics.mjs';
test('real monitored continuation with Linux cgroup resources and external 115ms Hrana provider',async t=>{
 const metrics=linuxMetrics();t.after(()=>{console.log('LINUX_FINAL_METRICS '+JSON.stringify(metrics.snapshot()));metrics.close();});
 const physicalFetch=globalThis.fetch;
 const fetch=async r=>{assert.equal(new URL(r.url).hostname,'isolated.invalid');return physicalFetch('http://fixture:8080/v2/pipeline',{method:'POST',body:await r.text(),headers:{'content-type':'application/json'},signal:r.signal});};
 let db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});t.after(()=>db.close());
 const env={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const request=(phase,extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(env),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env,runningReleaseSha(env)),...extra});
 const options={db,keys:fixtureKeys,environment:env,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'}};
 const syncReq=request('SYNC'),sync=await runExecutionPhase({...options,request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0})}});assert.equal(sync.body.drainAuthorized,true);
 const fresh=async()=>{await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});options.db=db;};
 const legs=Number(process.env.LINUX_LEGS??2);assert.ok(legs>=1&&legs<=12);
 for(let n=1;n<=legs;n++){
  const oldOperations=(await db.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key),req=request('STAGE6_DRAIN',{syncRequestId:syncReq.requestId,handoff:sync.body.handoff}),before=(await physicalFetch('http://fixture:8080/counts')).json();
  const counts=(await before).counts,at=performance.now(),result=await runExecutionPhase({...options,request:req}),after=await(await physicalFetch('http://fixture:8080/counts')).json();
  console.log('LINUX_MONITORED_LEG '+JSON.stringify({leg:n,result,elapsedMs:performance.now()-at,http:after.counts.httpRequests-counts.httpRequests,sql:after.counts.sqlStatements-counts.sqlStatements,capacity:stage6CapacityStatus(),scopes:receiverScopeStatistics(),metrics:metrics.snapshot(),providerEvidence:after.evidence}));
  assert.equal(result.body.ok,true);assert.ok(result.body.result.itemsProcessed||result.body.result.unitsCommitted||result.body.result.jobsCompleted);
  await fresh();console.log('LINUX_DURABLE_PROOF '+JSON.stringify(await verifyShortProof({get db(){return db;},fresh},{domainOnly:true})));
  console.log('LINUX_CURRENT_PROOF '+JSON.stringify(await verifyCurrentRuntimeProof(db,req.requestId,oldOperations)));
  assert.deepEqual(await runExecutionPhase({...options,request:req}),result);assert.equal(stage6CapacityStatus().active,false);
 }
});
