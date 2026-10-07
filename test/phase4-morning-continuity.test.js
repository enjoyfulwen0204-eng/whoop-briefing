import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {typedSyncResult} from '../src/syncResult.js';
import {WHOOP_SYNC} from '../src/config.js';
import {staticDataSource} from '../src/dataSource.js';
import {fakeCoach} from './fakes.js';
import {makeDataset} from './fixtures.js';
import {runDaily} from '../src/daily.js';

const now=new Date('2026-10-07T00:00:00Z');
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'synthetic',telegramChatId:'synthetic',
 whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic'};
for(const runtime of ['off','on'])test(`scheduled SYNC morning brief survives runtime ${runtime}/presentation OFF; retry/date dedupe; drain emits no ordinary brief`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-morning-')),db=createDb({url:`file:${join(dir,'isolated.db')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();
 await db.createUser({id:'legacy',displayName:'Lan',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.setLocale('legacy','vi');await db.linkTelegram({userId:'legacy',chatId:'1001'});
 await db.saveTokens('legacy',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'});
 await db.saveSyncState('legacy','sleep',{backfillComplete:true});await db.saveCapabilities('legacy',[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:runtime,PHASE4_PUBLIC_BETA_MODE:'off'},config=publicBetaConfiguration(environment);
 const request=(phase='SYNC',extra={})=>({requestId:randomUUID(),phase,triggerSource:'cloudflare',executionMode:runtime==='on'?'SHADOW':'OFF',configProof:configurationProof(fixtureKeys,config,environment),...extra});
 const payloads=[],dataset=makeDataset({now,withNaps:false});let syncCalls=0,drains=0,authorizationNotices=0;
 const deps={
  makeTelegram:({chatId})=>({send:async text=>{payloads.push({chatId,text});return {messageId:payloads.length};},notifyError:async()=>{authorizationNotices++;return true;},sendTyping:async()=>true}),
  makeWhoop:()=>({getAccessToken:async()=>'synthetic'}),makeSource:()=>staticDataSource(dataset),makeCoach:()=>fakeCoach(),
  makeSync:()=>({syncAll:async()=>{syncCalls++;return typedSyncResult(WHOOP_SYNC.RESOURCES.map(resource=>({resource,status:'ok',incremental:{fetched:0,written:0},backfill:{complete:true,written:0}})));}}),
  daily:runDaily,weekly:async()=>null,proactive:async()=>null,reap:async()=>null,predictionCycle:async()=>null,healthspan:async()=>null,
  makeReconciler:()=>({reconcileAll:async()=>[]}),guardian:async()=>null,drainWebhook:async()=>({}),
 };
 const run=r=>runExecutionPhase({request:r,db,keys:fixtureKeys,env,environment,deps,now});
 const first=request(),started=performance.now(),result=await run(first);assert.equal(result.status,200,JSON.stringify(result));
 console.log(JSON.stringify({measurement:'ordinary_brief_sync',runtime,users:1,elapsedMs:performance.now()-started}));
 assert.equal(result.body.syncComplete,true);assert.equal(payloads.length,1);assert.equal(payloads[0].chatId,'1001');
 assert.match(payloads[0].text,/Lan/);assert.doesNotMatch(payloads[0].text,/Beta|Body Energy|Kelvin/);
 assert.deepEqual(await run(first),result);assert.equal(payloads.length,1);assert.equal(syncCalls,1);
 const second=await run(request());assert.equal(second.body.syncComplete,true);assert.equal(payloads.length,1,'a new SYNC retry cannot duplicate user/date report');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM report_runs WHERE user_id='legacy' AND report_type='daily' AND status='SENT'")).rows[0].n,1);
 if(runtime==='on'){
  deps.runtime={phase4Stage6:{drain:async()=>{drains++;return {outcome:'NO_WORK',completion:'COMPLETE',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0,stopReason:'QUEUE_COMPLETE'};}}};
  const beforeSync=syncCalls,drain=await run(request('STAGE6_DRAIN',{syncRequestId:first.requestId,handoff:result.body.handoff}));
  assert.equal(drain.status,200);assert.equal(drains,1);assert.equal(syncCalls,beforeSync);assert.equal(payloads.length,1);
 }else{assert.equal(result.body.drainAuthorized,false);assert.equal(drains,0);}
 for(const [code,outcome,status] of [['WHOOP_MAINTENANCE_DEADLINE','TIMEOUT',504],['SYNC_CANCELLED','CANCELLED',499]]) {
  deps.makeWhoop=()=>({getAccessToken:async()=>{throw Object.assign(new Error('synthetic transport interruption'),{code});}});
  const failed=await run(request());assert.equal(failed.status,status);assert.equal(failed.body.result.outcome,outcome);
  assert.equal(failed.body.drainAuthorized,false);assert.equal(failed.body.handoff,undefined);
 }
 assert.equal(authorizationNotices,0,'a token transport deadline/cancellation must not emit an authorization-broken notice');
 assert.equal(payloads.length,1);
});
