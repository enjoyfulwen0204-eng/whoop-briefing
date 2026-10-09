import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../src/db.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {createSync,isSyncDue} from '../src/sync.js';
import {WHOOP_SYNC} from '../src/config.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {randomUUID} from 'node:crypto';

const now=new Date('2026-10-09T00:00:00Z');
const fresh=(user='alice')=>WHOOP_SYNC.RESOURCES.map(resource=>({user_id:user,resource,backfill_complete:1,last_success_at:now.toISOString()}));

test('batch observation preserves per-resource due, absent-state and backfill rules',async()=>{
 let rows=fresh(),reads=0;
 const db={getAllSyncState:async uid=>{assert.equal(uid,'alice');reads++;return rows;},getSyncState:async()=>{throw Error('unexpected individual observation');}};
 assert.equal(await isSyncDue({db,userId:'alice',now}),false);
 assert.equal(reads,1);
 for(const resource of WHOOP_SYNC.RESOURCES){
  rows=fresh().filter(r=>r.resource!==resource);
  assert.equal(await isSyncDue({db,userId:'alice',now}),true,'missing resource cannot prove complete sync');
  rows=fresh().map(r=>r.resource===resource?{...r,backfill_complete:0}:r);
  assert.equal(await isSyncDue({db,userId:'alice',now}),true,'unfinished backfill remains due');
  rows=fresh().map(r=>r.resource===resource?{...r,last_success_at:'2026-10-08T22:59:59Z'}:r);
  assert.equal(await isSyncDue({db,userId:'alice',now}),true,'expired success remains due');
 }
});

for(const rows of [null,[null],fresh('bob'),[...fresh(),fresh()[0]],fresh().map(r=>({...r,last_success_at:'invalid'}))])
 test('an invalid, cross-tenant or unavailable snapshot cannot prove throttling: '+JSON.stringify(rows),async()=>{
  assert.equal(await isSyncDue({db:{getAllSyncState:async()=>rows},userId:'alice',now}),true);
 });

test('failed batch and individual reads never produce required-resource success',async()=>{
 let fetched=0;
 const db={getAllSyncState:async()=>{throw Error('synthetic unavailable read');},getSyncState:async()=>{throw Error('synthetic unavailable read');},saveSyncState:async()=>{}};
 assert.equal(await isSyncDue({db,userId:'alice',now}),true);
 const result=await createSync({db,userId:'alice',now,expectedLifecycleGeneration:LIFECYCLE_UNFENCED,whoop:{sleeps:async()=>{fetched++;return [];}}}).syncAll();
 assert.equal(result.complete,false);assert.equal(result.outcome,'REQUIRED_RESOURCE_FAILED');assert.equal(fetched,0);
});

test('protected HTTP snapshot reduces repeated transactions without crossing tenant/redaction/lifecycle fences',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-sync-snapshot-')),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();
 const transport=hranaTransport(url);let calls=0;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{calls++;return transport.fetch(request);}});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 await db.admitRuntime();
 for(const id of ['alice','bob']){
  await db.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});
  for(const resource of WHOOP_SYNC.RESOURCES)await db.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:now.toISOString()},{now});
 }
 calls=0;
 const expected=await Promise.all(WHOOP_SYNC.RESOURCES.map(resource=>db.getSyncState('alice',resource)));
 const individualCalls=calls;assert.equal(expected.length,5);
 calls=0;assert.equal(await isSyncDue({db,userId:'alice',now}),false);const batchedCalls=calls;
 assert.ok(batchedCalls*3<individualCalls,`protected HTTP round trips: batch ${batchedCalls}, individual ${individualCalls}`);
 let providerCalls=0;
 const result=await createSync({db,userId:'alice',expectedLifecycleGeneration:1,now,whoop:{sleeps:async()=>{providerCalls++;throw Error('unexpected provider call');}}}).syncAll();
 assert.equal(result.complete,true);assert.equal(result.outcome,'NO_NEW_DATA_SUCCESS');assert.equal(providerCalls,0);
 assert.equal(result.resources.filter(r=>r.status==='throttled').length,5);
 await db.raw.execute("UPDATE whoop_sync_state SET content_state='REDACTED' WHERE user_id='alice' AND resource='sleep'");
 assert.equal(await isSyncDue({db,userId:'alice',now}),true,'redacted state cannot borrow another tenant success');
 assert.equal(await isSyncDue({db,userId:'bob',now}),false,'other tenant remains independent');
 await db.raw.execute("UPDATE users SET status='DISABLED' WHERE id='bob'");
 assert.equal(await isSyncDue({db,userId:'bob',now}),true,'inactive authority cannot prove throttling');
 console.log(JSON.stringify({measurement:'sync_state_http_round_trips',individualCalls,batchedCalls,resourceCount:5}));
});

test('three-user v32 HTTP phase settles honest throttled sync under transport latency',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-sync-latency-')),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();
 const transport=hranaTransport(url);let calls=0,delay=0;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  calls++;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return transport.fetch(request);
 }});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 await db.admitRuntime();
 for(const [i,id] of ['alice','bob','lan'].entries()){
  await db.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});await db.linkTelegram({userId:id,chatId:String(1001+i)});
  await db.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(2001+i)});
  await db.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
  for(const resource of WHOOP_SYNC.RESOURCES)await db.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:now.toISOString()},{now});
 }
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},releaseSha=runningReleaseSha();
 const request={releaseSha,requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 let providerCalls=0,sends=0;
 const deps={makeWhoop:()=>({getAccessToken:async()=>'synthetic',sleeps:async()=>{providerCalls++;throw Error('unexpected provider call');}}),
  makeTelegram:()=>({send:async text=>{assert.match(text,/Select language|Choose language|語言|ngôn ngữ/i);sends++;return {messageId:sends};},notifyError:async()=>false}),
  makeReconciler:()=>({reconcileAll:async()=>[]}),guardian:async()=>null,drainWebhook:async()=>({}),
 };
 const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
 calls=0;delay=Number(process.env.PHASE4_FIXTURE_LATENCY_MS??10);
 assert.ok(Number.isSafeInteger(delay)&&delay>=0&&delay<=500);const started=performance.now();
 const result=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.syncComplete,true);assert.equal(result.body.result.users,3);
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.drainAuthorized,false);assert.equal(providerCalls,0);assert.equal(sends,3);
 const beforeReplay=calls;assert.deepEqual(await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now}),result);
 assert.equal(sends,3,'phase replay cannot duplicate locale prompt or ordinary delivery');
 const duplicates=(await db.raw.execute('SELECT COUNT(*) n FROM (SELECT execution_id,step_key FROM phase4_execution_work_receipts GROUP BY execution_id,step_key HAVING COUNT(*)>1)')).rows[0].n;
 assert.equal(duplicates,0);
 console.log(JSON.stringify({measurement:'three_user_http_sync',users:3,latencyPerRequestMs:delay,elapsedMs:performance.now()-started,workRequests:beforeReplay,replayRequests:calls-beforeReplay}));
});
