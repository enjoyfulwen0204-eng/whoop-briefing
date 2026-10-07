import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,claimPhaseRequest,readPhaseProgress} from '../src/phase4ExecutionStore.js';
import {createSync} from '../src/sync.js';import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';import {signTriggerRequest,BRIEFING_TRIGGER} from '../src/briefingTriggerAuth.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-split-')),db=createDb({url:`file:${join(dir,'isolated.db')}`});t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();return db;}
const makeRequest=(phase='SYNC',source='manual',extra={})=>({requestId:randomUUID(),phase,triggerSource:source,executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
const run=(db,request,deps={},extra={})=>runExecutionPhase({db,request,env,keys:fixtureKeys,environment,deps,...extra});
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0});
const fakeRuntime=(calls,outcome='PARTIAL')=>({phase4Stage6:{drain:async r=>{calls.push(r);await r.onProgress?.({event:'discovery_start'});
 await r.onProgress?.({event:'discovery_complete',jobsConsidered:3});await r.onProgress?.({event:'drain_start',jobsConsidered:3});
 return {outcome,jobsConsidered:3,itemsAttempted:6,processedItems:6,completedJobs:0,remainingJobs:6};}}});

test('RC2 failed-resource reproduction is closed in actual runner, HTTP outcome and handoff authorization',async t=>{
 const db=await fixture(t);await db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const resources=await createSync({db:{getSyncState:async()=>null,saveSyncState:async()=>{}},whoop:{sleeps:async()=>{throw new Error('required sleep failed');}},
  userId:'synthetic',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED}).syncAll({force:true,resources:['sleep']});
 assert.equal(resources[0].status,'failed');assert.equal(resources.outcome,'REQUIRED_RESOURCE_FAILED');
 db.listSchedulableUsers=async()=>[{id:'synthetic'}];db.listPendingOnboarding=async()=>[];
 const request=makeRequest(),response=await run(db,request,{runUser:async()=>({sync:resources,errors:[],skipped:null}),guardian:async()=>null,drainWebhook:async()=>({})});
 assert.equal(response.status,424);assert.equal(response.body.ok,false);assert.equal(response.body.result.failed,1);
 assert.equal(response.body.result.outcome,'REQUIRED_RESOURCE_FAILED');assert.equal(response.body.drainAuthorized,false);assert.equal(response.body.handoff,undefined);
});
test('incomplete bootstrap synchronization cannot authorize drain even when ordinary scheduled users succeed',async t=>{
 const db=await fixture(t);
 const response=await run(db,makeRequest(),{guardian:async()=>null,drainWebhook:async()=>({}),resumeOnboarding:async({deps})=>{
   await deps.onSyncResults([{resource:'sleep',status:'failed'},{resource:'recovery',status:'ok'}]);
   return [{userId:'synthetic',result:'RETRY'}];
 }});
 assert.equal(response.status,424);assert.equal(response.body.result.outcome,'REQUIRED_RESOURCE_FAILED');
 assert.equal(response.body.syncComplete,false);assert.equal(response.body.drainAuthorized,false);
});
for(const source of ['manual','github','cloudflare'])test(`distinct sync and drain identities execute, retries cache, source ${source} remains bound`,async t=>{
 const db=await fixture(t),calls=[],request=makeRequest('SYNC',source);let syncs=0;
 const deps={runBriefing:async()=>{syncs++;return success();},runtime:fakeRuntime(calls)};
 const sync=await run(db,request,deps);assert.equal(sync.body.syncComplete,true);assert.match(sync.body.handoff,/^[a-f0-9]{64}$/);
 assert.deepEqual(await run(db,request,deps),sync);assert.equal(syncs,1);assert.equal(calls.length,0);
 const drain=makeRequest('STAGE6_DRAIN',source,{syncRequestId:request.requestId,handoff:sync.body.handoff});
 const response=await run(db,drain,deps,{now:new Date(source==='cloudflare'?'2026-10-07T01:00:00Z':'2026-10-07T12:00:00Z')});assert.equal(response.status,200);assert.equal(response.body.phase,'STAGE6_DRAIN');
 assert.equal(calls.length,1);assert.equal(calls[0].triggerSource,source);assert.equal(syncs,1);
 assert.deepEqual(await run(db,drain,deps),response);assert.equal(calls.length,1);
 const heartbeat=await readPhaseProgress(db,'STAGE6_DRAIN',source);assert.equal(heartbeat.state,'PARTIAL');assert.equal(heartbeat.complete.itemsProcessed,6);
 await assert.rejects(()=>run(db,{...drain,requestId:request.requestId},deps),/SYNC_HANDOFF_REQUIRED|REQUEST_ID_CONFLICT/);
 await assert.rejects(()=>run(db,{...drain,requestId:randomUUID(),triggerSource:source==='manual'?'github':'manual'},deps),/HANDOFF_REJECTED/);
});
test('pending and completed durable request IDs reject conflicting authenticated bodies',async t=>{
 const db=await fixture(t),request=makeRequest(),body=JSON.stringify(request);
 const claim=await claimPhaseRequest(db,request,body);assert.ok(claim.owner);
 await assert.rejects(()=>claimPhaseRequest(db,request,body),/REQUEST_PENDING/);
 await assert.rejects(()=>claimPhaseRequest(db,{...request,configProof:'a'.repeat(64)},JSON.stringify({...request,configProof:'a'.repeat(64)})),/REQUEST_ID_CONFLICT/);
});
test('overall deadline returns TIMEOUT, leaves no success handoff, and fences late post-fetch writes',async t=>{
 const db=await fixture(t);await db.createUser({id:'synthetic',displayName:'Initial',timezone:'Asia/Taipei',status:'ACTIVE'});
 let late;const request=makeRequest();
 const response=await run(db,request,{runBriefing:async()=>{await new Promise(r=>setTimeout(r,100));try{await db.raw.execute("UPDATE users SET display_name='Late' WHERE id='synthetic'");late='wrote';}catch(e){late=e.code;}return success();}},{budgetMs:30});
 assert.equal(response.status,504);assert.equal(response.body.syncComplete,false);assert.equal(response.body.handoff,undefined);
 await new Promise(r=>setTimeout(r,120));assert.equal(late,'SYNC_TIMEOUT');assert.equal((await db.getUser('synthetic')).displayName,'Initial');
 const progress=await readPhaseProgress(db,'SYNC','manual');assert.equal(progress.state,'TIMEOUT');
});
test('cancellation is typed and malformed phases fail before admission',async t=>{
 const db=await fixture(t);let admissions=0;const admit=db.admitRuntime;db.admitRuntime=async(...args)=>{admissions++;return admit(...args);};
 await assert.rejects(()=>run(db,makeRequest('UNKNOWN')),/PHASE_INVALID/);assert.equal(admissions,0);
 const controller=new AbortController();
 const pending=run(db,makeRequest(),{runBriefing:async()=>{controller.abort();return success();}},{signal:controller.signal});
 const response=await pending;assert.equal(response.body.result.outcome,'CANCELLED');assert.equal(response.body.drainAuthorized,false);
});
test('caller-constructed facade cannot bypass capability checks with a fake admission method',async t=>{
 const db=await fixture(t),forged={...db,admitRuntime:async()=>Object.freeze({}),requireRuntimeAdmission:()=>31};let called=false;
 await assert.rejects(()=>run(forged,makeRequest(),{runBriefing:async()=>{called=true;return success();}}),/ADMISSION_REQUIRED/);
 assert.equal(called,false);
 const {runBriefing}=await import('../src/index.js');
 const result=await runBriefing({deps:{db:forged,env,keepConnectionOpen:true,runtimeAdmission:{},guardian:async()=>null}});
 assert.ok(result.errors.length>0);assert.notEqual(result.syncComplete,true);
});
test('signed endpoint rejects unsigned phase substitution and conflicting concurrent/completed cache requests',async()=>{
 const secret='synthetic-secret-32-bytes-minimum-only',at=Date.now();let calls=0,release;
 const endpoint=createBriefingEndpoint({secret,now:()=>at,runPhase:async({request})=>{calls++;await new Promise(r=>release=r);return {status:200,body:{ok:true,phase:request.phase,source:'cloudflare'}};}});
 const value=makeRequest('SYNC','cloudflare'),body=JSON.stringify(value);
 const signed=payload=>{const text=JSON.stringify(payload),args={timestamp:String(at),requestId:payload.requestId,method:'POST',path:BRIEFING_TRIGGER.PATH,body:text};
  return [{url:args.path,method:'POST',headers:{'content-type':'application/json','x-briefing-timestamp':args.timestamp,'x-briefing-request-id':args.requestId,'x-briefing-signature':signTriggerRequest(args,secret)}},text];};
 const [req]=signed(value),pending=endpoint(req,body);await new Promise(r=>setImmediate(r));
 const substituted={...value,phase:'STAGE6_DRAIN',syncRequestId:randomUUID(),handoff:'a'.repeat(64)};
 assert.equal((await endpoint(req,JSON.stringify(substituted))).status,401);
 assert.equal((await endpoint(...signed(substituted))).status,409);assert.equal(calls,1);
 release();assert.equal((await pending).status,200);assert.equal((await endpoint(...signed(substituted))).status,409);
 assert.equal((await endpoint(...signed(value))).status,200);assert.equal(calls,1);
});

test('shared runner rejects a substituted request/body before cached sync can satisfy a drain phase',async t=>{
 const db=await fixture(t),request=makeRequest(),sync=await run(db,request,{runBriefing:success});
 const another=makeRequest(),other=await run(db,another,{runBriefing:success});
 const drain=makeRequest('STAGE6_DRAIN','manual',{requestId:request.requestId,syncRequestId:another.requestId,handoff:other.body.handoff});
 await assert.rejects(()=>run(db,drain,{}, {body:JSON.stringify(request)}),/BODY_MISMATCH/);
 assert.equal(sync.body.phase,'SYNC');
});
test('durable phase health distinguishes never entered, discovery only, bounded zero progress and completed work without storing narrative',async t=>{
 const db=await fixture(t);const {recordPhaseEvent}=await import('../src/phase4ExecutionStore.js');
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','manual')).state,'NOT_ENTERED');
 const identity='b'.repeat(64);
 await recordPhaseEvent(db,{phase:'STAGE6_DRAIN',source:'manual',event:'start',outcome:'PENDING',identity,healthValue:999,userId:'private-name'});
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','manual')).state,'STARTED');
 await recordPhaseEvent(db,{phase:'STAGE6_DRAIN',source:'manual',event:'discovery_complete',outcome:'PENDING',identity,jobsConsidered:0});
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','manual')).state,'DISCOVERY_ONLY');
 const rows=(await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component LIKE 'phase4_stage6_drain:%'")).rows;
 assert.ok(rows.every(r=>!r.last_detail.includes('private-name')&&!r.last_detail.includes('healthValue')));
 await assert.rejects(()=>recordPhaseEvent(db,{phase:'STAGE6_DRAIN',source:'manual',event:'complete',outcome:'my health is private'}),/OUTCOME_INVALID/);
 await assert.rejects(()=>recordPhaseEvent(db,{phase:'STAGE6_DRAIN',source:'manual',event:'complete',outcome:'PARTIAL',itemsProcessed:0.5}),/COUNT_INVALID/);
});
