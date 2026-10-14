import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof,reconcileExecution} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {linuxMetrics} from './stage6LinuxMetrics.mjs';import {verifyShortProof} from './stage6ShortProof.mjs';import {verifyCurrentRuntimeProof} from './stage6RuntimeCurrentProof.mjs';import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
test('Linux real process SIGKILL after original publication and original-deadline replay',async t=>{
 assert.ok(['crash','resume'].includes(process.env.LINUX_RECOVERY));const metrics=linuxMetrics(),networkFetch=globalThis.fetch;
 const fetch=async r=>{assert.equal(new URL(r.url).hostname,'isolated.invalid');return networkFetch('http://fixture:8080/v2/pipeline',{method:'POST',body:await r.text(),signal:r.signal});};
 let db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});t.after(async()=>{await db.close();console.log('LINUX_RECOVERY_METRICS '+JSON.stringify({metrics:metrics.snapshot(),scopes:receiverScopeStatistics()}));metrics.close();});
 let env={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const request=(phase,extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(env),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env,runningReleaseSha(env)),...extra});
 const options={db,keys:fixtureKeys,environment:env,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'}};
 if(process.env.LINUX_RECOVERY==='crash'){
  const syncReq=request('SYNC'),sync=await runExecutionPhase({...options,request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0})}});assert.equal(sync.body.drainAuthorized,true);
  const req=request('STAGE6_DRAIN',{syncRequestId:syncReq.requestId,handoff:sync.body.handoff}),oldOperations=(await db.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key);
  await writeFile('/qualification/crash-request.json',JSON.stringify({synthetic:true,req,env,oldOperations}));
  console.log('LINUX_CRASH_ARMED '+JSON.stringify({executionId:req.requestId,metrics:metrics.snapshot()}));
  const response=await runExecutionPhase({...options,request:req});assert.fail('External SIGKILL must precede any publication ACK or response: '+response.status);
 }
 const stored=JSON.parse(await readFile('/qualification/crash-request.json','utf8'));assert.equal(stored.synthetic,true);assert.equal(stored.req.releaseSha,runningReleaseSha(stored.env));env=stored.env;options.environment=env;
 const before=(await db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n;assert.equal(before,19);
 const state=await reconcileExecution(db,stored.req);assert.equal(state.state,'WORK_COMMITTED_UNFINALIZED');assert.ok(state.receipts.length>0);
 const owner=(await db.raw.execute({sql:'SELECT deadline_at FROM phase4_executions WHERE execution_id=?',args:[stored.req.requestId]})).rows[0];console.log('LINUX_ORIGINAL_DEADLINE_WAIT '+JSON.stringify({ms:Math.max(0,owner.deadline_at-Date.now()),reconciliation:state.state}));
 while(Date.now()<=owner.deadline_at)await new Promise(r=>setTimeout(r,Math.min(30000,owner.deadline_at-Date.now()+50)));
 const at=performance.now(),result=await runExecutionPhase({...options,request:stored.req});assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');
 const fresh=async()=>{await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});options.db=db;};await fresh();
 const proof=await verifyShortProof({get db(){return db;},fresh},{domainOnly:true}),current=await verifyCurrentRuntimeProof(db,stored.req.requestId,stored.oldOperations);assert.equal(proof.signedOperationReceipts,before);assert.deepEqual(await runExecutionPhase({...options,request:stored.req}),result);
 const permit=JSON.parse((await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail);assert.equal(permit.attempts,1);
 await writeFile('/qualification/recovery-proof.json',JSON.stringify({synthetic:true,result,recoveryMs:performance.now()-at,proof,current,permitAttempts:permit.attempts,metrics:metrics.snapshot()},null,2));console.log('LINUX_RECOVERY_SUCCESS '+JSON.stringify({outcome:result.body.result.outcome,settlement:result.body.result.settlementState,receipts:proof.signedOperationReceipts,producers:proof.finalizedProducerHmacs,work:proof.workReceipts,permitAttempts:permit.attempts}));
});
