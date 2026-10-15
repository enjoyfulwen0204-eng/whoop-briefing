import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {stage6CapacityStatus} from '../src/stage6CapacityRuntime.js';import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';import {linuxMetrics} from './stage6LinuxMetrics.mjs';import {morningNow,morningRecords} from './stage6LinuxMorningFixture.mjs';import {fakeCoach} from './fakes.js';
import {createWebhookServer} from '../src/bot/webhook.js';import {createRouter} from '../src/bot/router.js';import {createUpdateProcessor} from '../src/bot/updateProcessor.js';import {createSendReply} from '../src/bot/index.js';import {createBriefingEndpoint} from '../src/briefingEndpoint.js';import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {verifyShortProof} from './stage6ShortProof.mjs';import {verifyCurrentRuntimeProof} from './stage6RuntimeCurrentProof.mjs';
import {fork} from 'node:child_process';import {syntheticRecords} from './stage6ServiceReadyFixture.mjs';
import {createDrainChildSupervisor} from '../src/drainChildSupervisor.js';
test('service-ready physical DB requires actual finalized SYNC before controlled DRAIN',async t=>{
 const metrics=linuxMetrics(),networkFetch=globalThis.fetch;let realProviderRequests=0;
 globalThis.fetch=async()=>{realProviderRequests++;throw Error('REAL_PROVIDER_FORBIDDEN');};
 const dbFor=path=>createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{assert.equal(new URL(r.url).hostname,'isolated.invalid');return networkFetch('http://fixture:8080'+path,{method:'POST',headers:{'x-synthetic-role':path.startsWith('/morning')?'service-parent':'drain-parent'},body:await r.text(),signal:r.signal});}});
 let stageDb=dbFor('/v2/pipeline');const morningDb=dbFor('/morning/v2/pipeline');
 const retained=process.env.LINUX_RETAINED_SERVICE==='1'?await(await networkFetch('http://fixture:8080/qualification/resume')).json():null;
 const environment={PHASE4_RELEASE_SHA:runningReleaseSha(),PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow'};
 const retainedPermit=(await stageDb.raw.execute("SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component='phase4_beta_pilot_permit_v1'")).rows[0];
 if(retainedPermit)environment.PHASE4_BETA_PILOT_START_AT=new Date(JSON.parse(retainedPermit.last_detail).startAt).toISOString();
 const env={timezone:'Asia/Taipei',dryRun:false,maxUserConcurrency:1,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:morningNow.toISOString()};
 const request=(phase,extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(environment),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,runningReleaseSha(environment)),...extra});
 const stageOptions={db:stageDb,keys:fixtureKeys,environment,env};
 const successor=process.env.LINUX_FRESH_SUCCESSOR==='1';assert.ok(!successor||retained);
 let handoff,resumeRequest;
 if(process.env.LINUX_SERVICE_RESUME_ID){assert.match(process.env.LINUX_SERVICE_RESUME_ID,/^p4s1_[a-zA-Z0-9_-]{10,122}$/);const row=(await stageDb.raw.execute({sql:"SELECT canonical_request_json FROM phase4_executions WHERE execution_id=? AND phase='SYNC' AND release_sha=?",args:[process.env.LINUX_SERVICE_RESUME_ID,runningReleaseSha()]})).rows[0];assert.ok(row);resumeRequest=JSON.parse(row.canonical_request_json);assert.equal(resumeRequest.configProof,request('SYNC').configProof);}
 const handoffRequest=resumeRequest??request('SYNC',{requestId:'p4s1_'+randomUUID(),triggerSource:'cloudflare'});
 const data=morningRecords(),sends=[],webhookSends=[],modelCounts=new Map();
 const deps={makeWhoop:({userId})=>{const data=syntheticRecords(userId),fetchData=name=>async()=>{assert.equal(morningDb.processingTransactionActive(),false);return structuredClone(data[name]);};return {getAccessToken:async()=>'synthetic',sleeps:fetchData('sleeps'),recoveries:fetchData('recoveries'),cycles:fetchData('cycles'),workouts:fetchData('workouts'),bodyMeasurement:fetchData('body'),apiGet:async path=>({records:structuredClone(data[{'/activity/sleep':'sleeps','/recovery':'recoveries','/cycle':'cycles','/activity/workout':'workouts'}[path]]),next_token:null})};},makeCoach:({userId})=>{const c=fakeCoach(),plan=c.narrativePlan;c.narrativePlan=async(...args)=>{modelCounts.set(userId,(modelCounts.get(userId)??0)+1);await new Promise(r=>setTimeout(r,3000));return plan(...args);};return c;},makeTelegram:({chatId})=>({send:async text=>{assert.equal(morningDb.processingTransactionActive(),false);assert.ok(text);sends.push(chatId);assert.equal(sends.filter(x=>x===chatId).length,1);return {messageId:9000+sends.length};},notifyError:async()=>false}),guardian:async()=>null};
 const secret='synthetic-linux-concurrent-briefing-secret-32',webhookSecret='synthetic-linux-telegram-secret';
 const router=createRouter({db:morningDb,coachFor:()=>({ask:async()=>{throw Error('HELP_MUST_NOT_USE_MODEL');}}),now:()=>new Date()});
 const processor=createUpdateProcessor({db:morningDb,resolveUser:id=>morningDb.resolveUserByChatId(id),handleMessage:({text,chatId,user})=>router.handle({text,chatId,user}),handleUnlinked:async()=>null,sendReply:createSendReply({db:morningDb,api:{sendMessage:async(chatId,text)=>{assert.equal(chatId,'1002');assert.ok(text);webhookSends.push(chatId);return {message_id:77,date:1791676800,chat:{id:1002,type:'private'}};}}}),workerId:'linux-synthetic',now:()=>new Date()});
 const endpoint=createBriefingEndpoint({secret,environment,runPhase:({request,body})=>runExecutionPhase({request,body,db:morningDb,keys:fixtureKeys,environment,env,deps,now:morningNow})});
 const server=createWebhookServer({processUpdate:processor.processUpdate,secret:webhookSecret,briefingEndpoint:endpoint});await new Promise(r=>server.listen(8081,'0.0.0.0',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await stageDb.close();await morningDb.close();globalThis.fetch=networkFetch;console.log('LINUX_CONCURRENT_FINAL '+JSON.stringify({metrics:metrics.snapshot(),scopes:receiverScopeStatistics(),realProviderRequests}));metrics.close();});
 if(successor){const stale=await runExecutionPhase({request:retained.syncRequest,body:canonicalPhaseRequest(retained.syncRequest),db:morningDb,keys:fixtureKeys,environment,env,deps,now:morningNow}).then(()=>null,e=>e.code);assert.equal(stale,'EXECUTION_STALE_REQUEST');}
 let syncRequest=handoffRequest,body=canonicalPhaseRequest(syncRequest);const path='/internal/briefing/run';
 assert.equal(syncRequest.configProof,configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,runningReleaseSha(environment)));
 const sendSync=()=>{const timestamp=String(Date.now());return networkFetch('http://127.0.0.1:8081'+path,{method:'POST',body,headers:{'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':syncRequest.requestId,'x-briefing-signature':signTriggerRequest({timestamp,requestId:syncRequest.requestId,method:'POST',path,body},secret)}}).then(async r=>({status:r.status,body:await r.json()}));};
 const update={update_id:successor?994:retained?992:991,message:{message_id:successor?994:retained?992:991,chat:{id:1002,type:'private'},from:{id:1002,is_bot:false},text:'/help',date:Math.floor(Date.now()/1000)}},sendWebhook=()=>networkFetch('http://127.0.0.1:8081/telegram/webhook',{method:'POST',body:JSON.stringify(update),headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':webhookSecret}}).then(async r=>({status:r.status,body:await r.json()}));
 const initialHealthAt=performance.now(),initialHealth=await networkFetch('http://127.0.0.1:8081/health');const initialHealthMs=performance.now()-initialHealthAt;assert.equal(initialHealth.status,200);
 await networkFetch('http://fixture:8080/probe/start',{method:'POST'});
 const startingClaims=(await morningDb.raw.execute("SELECT user_id,delivery_state,delivery_attempts FROM report_claims WHERE report_type='daily' AND local_date='2026-10-11'")).rows,expectedNewSends=4-startingClaims.filter(c=>c.delivery_state==='DELIVERED').length;
 const retainedPhysicalCheckpoint=startingClaims.length>0;
 const oldOperations=(await stageDb.raw.execute('SELECT operation_key FROM phase4_operation_receipts')).rows.map(r=>r.operation_key);
 let childScopes,childCapacity,childMetrics;
 // No fabricated NO_NEW_DATA handoff: this is the real four-tenant service.
 const firstSyncAt=performance.now();let firstSync;const firstLegs=[];
 for(let leg=1;leg<=4;leg++){firstSync=await sendSync();firstLegs.push(firstSync);console.log('SERVICE_READY_SYNC_LEG '+JSON.stringify({leg,response:firstSync,elapsedMs:performance.now()-firstSyncAt}));if(firstSync.status!==202)break;if(!firstSync.body.result?.resumable)break;const wait=firstSync.body.result.retryAfterMs??0;assert.ok(wait<=15000);if(wait)await new Promise(r=>setTimeout(r,wait));}
 console.log('SERVICE_READY_FOCUSED '+JSON.stringify({phase:'SYNC_TERMINAL_GATE',firstSync,firstLegs,sends,modelCounts:[...modelCounts],provider:await(await networkFetch('http://fixture:8080/counts')).json()}));
 assert.equal(firstSync.status,200,'actual SYNC must finalize before expensive DRAIN qualification');assert.equal(firstSync.body.syncComplete,true);assert.equal(firstSync.body.drainAuthorized,true);handoff=firstSync;
 assert.deepEqual(await sendSync(),firstSync,'final SYNC replay must be immutable');
 syncRequest=request('SYNC',{requestId:'p4s1_'+randomUUID(),triggerSource:'cloudflare'});body=canonicalPhaseRequest(syncRequest);
 const overlapTransactionIndex=(await(await networkFetch('http://fixture:8080/counts')).json()).transactions.length,overlapStartedAt=Date.now();

 const drainRequest=request('STAGE6_DRAIN',{syncRequestId:handoffRequest.requestId,handoff:handoff.body.handoff});
 const supervisor=createDrainChildSupervisor({...stageOptions,userId:'a',childUrl:new URL('./stage6ManagedDrainChild.mjs',import.meta.url),childPayload:()=>({environment,env}),spawn:(...args)=>{const child=fork(...args);child.on('message',p=>{if(p.type==='result'){childScopes=p.scopes;childCapacity=p.capacity;childMetrics=p.metrics;}});return child;}});
 t.after(()=>supervisor.close());
 const isolatedDrain=()=>supervisor.runPhase({request:drainRequest});
 const syncAt=performance.now(),syncPromise=sendSync(),webhookPromise=sendWebhook(),drainAt=performance.now(),drain=await isolatedDrain().catch(e=>({status:503,body:{ok:false,error:e.code??e.name}})),drainMs=performance.now()-drainAt;
 const webhook=await webhookPromise,retry=await sendWebhook();let sync=await syncPromise;const syncRuns=[sync];
 // A supported 202 is a bounded continuation, not an immutable replay or
 // success. Resume the exact request without changing any clock, lease,
 // budget, grant counter or phase state, then test immutable final replay.
 for(let n=0;sync.status===202&&sync.body.result.resumable===true&&sync.body.result.retryAfterMs===0&&n<4;n++){
  sync=await sendSync();syncRuns.push(sync);console.log('LINUX_SYNC_CONTINUATION '+JSON.stringify({leg:syncRuns.length,response:sync}));
 }
 const syncMs=performance.now()-syncAt,syncReplay=sync.status===200?await sendSync():null;
 // A concurrent generation change may legitimately suppress a stale reply.
 // A new request after settlement must still deliver once and replay once.
 const concurrentDelivery=(await morningDb.raw.execute({sql:'SELECT delivery_state,delivery_attempts FROM telegram_operations WHERE update_id=?',args:[update.update_id]})).rows[0];
 const concurrentSends=webhookSends.length;assert.ok(concurrentSends<=1);
 if(!concurrentSends)assert.equal(concurrentDelivery?.delivery_state,'NOT_REQUIRED');
 update.update_id++;update.message.message_id++;const freshWebhook=await sendWebhook(),freshWebhookReplay=await sendWebhook();
 await networkFetch('http://fixture:8080/probe/stop',{method:'POST'});
 const provider=await(await networkFetch('http://fixture:8080/counts')).json(),claims=(await morningDb.raw.execute("SELECT user_id,delivery_state,delivery_attempts FROM report_claims WHERE report_type='daily' AND local_date='2026-10-11' ORDER BY user_id")).rows;
 const actualDrainEndAt=Date.now(),overlapWindows=provider.transactions.slice(overlapTransactionIndex).filter(tx=>tx.startedAt<actualDrainEndAt&&tx.finishedAt>overlapStartedAt&&tx.statements.some(s=>s.operation==='SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION'));
 console.log('LINUX_OVERLAP_SCOPE '+JSON.stringify({overlapStartedAt,actualDrainEndAt,newSyncRequestId:syncRequest.requestId,canonicalSyncWindowsDuringOverlap:overlapWindows.length,qualification:overlapWindows.length?'CANONICAL_WRITERS_OBSERVED':'CONTROL_AND_THROTTLED_TRAFFIC_ONLY',morning:'FIRST_SYNC_DELIVERY_THEN_SAME_DAY_EXACTLY_ONCE_SUPPRESSION'}));
 console.log('LINUX_CONCURRENT_OUTCOME '+JSON.stringify({synthetic:true,independentDatabases:false,sharedPhysicalDatabase:true,startingClaims,expectedNewSends,retainedPhysicalCheckpoint,overlapStartedAt,overlapTransactionIndex,retainedFixture:Boolean(retained),legitimateSuccessor:successor,originalRequestPreserved:retained?.syncRequest?.requestId,drainIsolation:process.env.LINUX_DRAIN_ISOLATION??'same-process',childScopes,childCapacity,childMetrics,initialHealthMs,syncMs,sync,syncRuns,drainMs,drain,webhook,retry,concurrentDelivery,freshWebhook,freshWebhookReplay,syncReplay,sends,webhookSends,claims,modelCounts:[...modelCounts],provider,capacity:stage6CapacityStatus(),metrics:metrics.snapshot(),scopes:receiverScopeStatistics(),realProviderRequests}));
 // Resource gates remain real assertions; diagnostic success is never a
 // capacity PASS when the DRAIN deadline or ordinary service response fails.
 assert.equal(drain.body.ok,true,'DRAIN must finish genuine bounded work');assert.ok(drain.body.result.itemsProcessed||drain.body.result.unitsCommitted||drain.body.result.jobsCompleted);
 const fresh=async()=>{await stageDb.close();stageDb=dbFor('/v2/pipeline');stageOptions.db=stageDb;};await fresh();
 // The retained checkpoint deliberately includes interrupted producers. Verify
 // this settled request directly, preserving their original unfinalized state.
 console.log('LINUX_CONCURRENT_CURRENT_PROOF '+JSON.stringify(await verifyCurrentRuntimeProof(stageDb,drainRequest.requestId,oldOperations)));assert.deepEqual(await runExecutionPhase({...stageOptions,request:drainRequest}),drain);
 if(childScopes){assert.equal(childScopes.liveScopes,0);assert.equal(childScopes.liveReceivers,0);assert.equal(childScopes.activeCallbacks,0);}
 assert.ok(metrics.snapshot().cgroupPeak<=metrics.snapshot().limits.memoryMax*.85,'15% whole-cgroup memory headroom required');assert.equal(metrics.snapshot().memoryEvents.oom_kill,0);
 assert.ok(provider.probes.length>3);assert.ok(provider.probes.every(p=>p.status===200&&p.elapsedMs<2000),'ordinary health response must remain below the declared 2s qualification bound');
 assert.deepEqual(syncReplay,sync);assert.equal(sync.status,200);assert.equal(sync.body.syncComplete,true);assert.equal(sends.length,expectedNewSends);assert.equal(claims.length,4);assert.ok(claims.every(c=>c.delivery_state==='DELIVERED'&&c.delivery_attempts===1));assert.equal(webhook.status,200);assert.equal(retry.status,200);assert.equal(freshWebhook.status,200);assert.equal(freshWebhookReplay.status,200);assert.equal(webhookSends.length,concurrentSends+1);assert.equal(realProviderRequests,0);
 assert.equal(provider.evidence.some(e=>e.event==='transaction_timeout'||e.code==='SQLITE_BUSY'||e.code==='SQLITE_BUSY_SNAPSHOT'),false);
 assert.equal(provider.transactionTraceEnabled,true,'qualification requires actual transaction traces');
 const windowTransactions=provider.morningTransactions.filter(tx=>tx.statements.some(s=>s.verb==='INSERT'&&['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts','whoop_body_measurements'].includes(s.table)));
 assert.ok(retained||retainedPhysicalCheckpoint||windowTransactions.length>=20,'fresh workload must measure all five canonical resources for four users');
 const syncWindows=windowTransactions.filter(tx=>tx.statements.some(s=>s.operation==='SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION'));
 assert.ok(retained||retainedPhysicalCheckpoint||syncWindows.length>=20,'fresh workload must record the actual five-resource SYNC commit windows');
 console.log('LINUX_WINDOW_TIMING_SCOPE '+JSON.stringify({scope:retainedPhysicalCheckpoint?'RETAINED_PHYSICAL_DB_NOT_A_FRESH_CANONICAL_CAPACITY_PASS':syncWindows.length?'NEW_SYNC_WINDOWS_MEASURED':'RETAINED_NO_NEW_SYNC_TIMING_PASS',syncWindows:syncWindows.length,allCanonicalWindows:windowTransactions.length}));
 assert.ok(windowTransactions.every(tx=>tx.outcome==='COMMITTED'&&tx.finishedAt-tx.startedAt<5000),'all canonical transactions must preserve the unchanged modeled 5s limit');
 assert.ok(syncWindows.every(tx=>tx.finishedAt-tx.startedAt<=4000),'actual sync.commitWindow transactions must retain the 4s measured target');
});
