import test from 'node:test';
import assert from 'node:assert/strict';
import {p0Harness,syntheticUser,dispatch,denyExternalIO} from './p0RecoveryHarness.js';
import {frozenWorker,frozenA} from './p0FrozenSources.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
const {invoke}=await frozenWorker();
const runPath='/internal/briefing/run',discoveryPath='/internal/briefing/continuation';
function signed(f,path,body,{requestId=JSON.parse(body).requestId??'synthetic-discovery-0001',timestamp=String(Date.now()),secret=f.environment.BRIEFING_TRIGGER_SECRET}={}){
 return {method:'POST',body,headers:{'content-type':'application/json','x-briefing-request-id':requestId,'x-briefing-timestamp':timestamp,
  'x-briefing-signature':signTriggerRequest({timestamp,requestId,method:'POST',path,body},secret)}};
}
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
function query(f,patch={}){return canonical({releaseSha:f.environment.PHASE4_RELEASE_SHA,executionMode:'OFF',triggerSource:'cloudflare',configProof:f.workerEnvironment.BRIEFING_CONFIG_PROOF,scope:'sync',...patch});}
const rows=async(f,table)=>(await f.db.raw.execute('SELECT * FROM '+table+' ORDER BY 1,2')).rows;

test('immutable A actually rejects the deployed-source Worker continuation contract before SYNC (synthetic 404 only)',async t=>{
 denyExternalIO(t);t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 const a=await frozenA(t);let run=0;
 const handler=a.webhook.createWebhookHandler({secret:'synthetic-only',processUpdate:()=>{throw Error('UNEXPECTED_UPDATE');},briefingEndpoint:()=>{run++;throw Error('UNEXPECTED_RUN');}});
 const calls=[];
 await assert.rejects(invoke({BRIEFING_ENDPOINT_URL:'https://synthetic.invalid'+runPath,BRIEFING_TRIGGER_SECRET:'synthetic-secret-more-than-32-bytes',
  BRIEFING_RELEASE_SHA:'9a8c951deee42ad9f6fd9c5828edad44f246d5f7',BRIEFING_CONFIG_PROOF:'a'.repeat(64),BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'sync'},
  {fetchImpl:async(url,init)=>{const r=await dispatch(handler,url,init);calls.push({path:new URL(url).pathname,status:r.status});return r;}}),e=>e.category==='continuation_discovery_failed');
 assert.deepEqual(calls,[{path:discoveryPath,status:404}]);assert.equal(run,0);
});

test('actual recovery entry: signed Discovery → OFF SYNC → durable Morning Evaluation and original Claim',async t=>{
 const f=await p0Harness(t);await f.start();
 const result=await invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker});
 assert.equal(result.ok,true);
 assert.equal(f.calls[0].path,'/internal/briefing/continuation');
 assert.equal(f.calls[0].result.state,'NONE');
 const sync=f.calls.find(c=>c.path==='/internal/briefing/run');
 assert.equal(sync.status,200);assert.equal(sync.result.syncComplete,true);assert.equal(sync.result.drainAuthorized,false);
 const evaluation=await f.db.getBriefingEvaluation(syntheticUser,'daily');
 assert.equal(evaluation?.outcome,'SENT');assert.equal(evaluation?.targetHealthDate,f.day);
 assert.equal((await f.db.getClaim(syntheticUser,'daily',f.day))?.deliveryState,'DELIVERED');
 assert.ok(f.counts.whoop>0);assert.ok(f.counts.telegram>0);assert.equal(f.counts.ddl,0);assert.equal(f.counts.unknown,0);
 assert.equal(f.runtime.server.listening,false);
 const originalClaim=await rows(f,'report_claims'),originalReceipts=await rows(f,'phase4_execution_work_receipts'),counts={...f.counts};
 assert.ok(originalReceipts.length>0);
 // Lose the HTTP ACK after durable success, restart the actual entry and replay
 // the exact original transport bytes with a fresh valid transport timestamp.
 await f.restart();
 const replay=await f.fetchWorker('https://synthetic.invalid'+runPath,signed(f,runPath,sync.body));
 assert.equal(replay.status,200);assert.equal((await replay.json()).syncComplete,true);
 assert.deepEqual(await rows(f,'report_claims'),originalClaim);assert.deepEqual(await rows(f,'phase4_execution_work_receipts'),originalReceipts);
 assert.equal(f.counts.telegram,counts.telegram);assert.equal(f.counts.whoop,counts.whoop);
});

test('missing source: full Discovery/SYNC persists WAITING instead of fabricating a morning report',async t=>{
 const f=await p0Harness(t,{source:'missing-sleep'});await f.start();
 const result=await invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker});
 assert.equal(result.ok,true,'completed synchronization is separate from report readiness');
 const evaluation=await f.db.getBriefingEvaluation(syntheticUser,'daily');
 assert.equal(evaluation?.outcome,'WAITING_FOR_SLEEP');
 assert.equal(await f.db.getClaim(syntheticUser,'daily',f.day),null);
 assert.equal(f.counts.telegram,0);assert.equal(f.counts.ddl,0);
});

for(const [source,outcome,reason] of [['missing-recovery','WAITING_FOR_RECOVERY','recovery_missing'],['stale','MISSED','sleep_too_old']])
test('actual SYNC preserves honest source readiness: '+source,async t=>{
 const f=await p0Harness(t,{source});await f.start();await invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker});
 const evaluation=await f.db.getBriefingEvaluation(syntheticUser,'daily');
 assert.equal(evaluation?.outcome,outcome);assert.equal(evaluation?.reason,reason);
 assert.equal(await f.db.getClaim(syntheticUser,'daily',f.day),null);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM report_runs WHERE status='SENT'")).rows[0].n,0);
});

test('release, proof, HMAC, timestamp, scope and original request identity reject before business execution',async t=>{
 const f=await p0Harness(t);await f.start();
 for(const [patch,status] of [[{releaseSha:'9a8c951deee42ad9f6fd9c5828edad44f246d5f7'},403],[{configProof:'0'.repeat(64)},409],[{executionMode:'SHADOW'},409],[{scope:'stage6-shadow',executionMode:'SHADOW'},503]]){
  const body=query(f,patch),r=await f.fetchWorker('https://synthetic.invalid'+discoveryPath,signed(f,discoveryPath,body));assert.equal(r.status,status);
 }
 const body=query(f);
 for(const override of [{secret:'synthetic-wrong-secret-32-bytes-only'},{timestamp:String(Date.now()-600000)}])assert.equal((await f.fetchWorker('https://synthetic.invalid'+discoveryPath,signed(f,discoveryPath,body,override))).status,401);
 const phase=canonical({requestId:'p4s1_synthetic_identity_sync',releaseSha:f.environment.PHASE4_RELEASE_SHA,executionMode:'OFF',triggerSource:'cloudflare',configProof:f.workerEnvironment.BRIEFING_CONFIG_PROOF,phase:'SYNC'});
 assert.equal((await f.fetchWorker('https://synthetic.invalid'+runPath,signed(f,runPath,phase,{requestId:'p4s1_different_identity_sync'}))).status,400);
 assert.equal(f.counts.whoop,0);assert.equal(f.counts.telegram,0);assert.equal((await rows(f,'phase4_executions')).length,0);
});

test('strict v33 entry rejects both retired indexes; offline retirement admits; old A recreates them; candidate never does',async t=>{
 const f=await p0Harness(t,{retired:true});
 await assert.rejects(f.start(),/UNEXPECTED_SCHEMA_OBJECT|retired_index_present/);assert.equal(f.runtime,undefined);
 for(const name of ['idx_insight_subject','idx_insight_active'])await f.db.raw.execute('DROP INDEX '+name);
 await f.start();assert.equal(f.runtime.db.requireRuntimeAdmission(await f.runtime.db.admitRuntime()),33);
 const body=query(f);assert.equal((await f.fetchWorker('https://synthetic.invalid'+discoveryPath,signed(f,discoveryPath,body))).status,200);
 assert.equal(f.counts.ddl,0);assert.equal(f.counts.whoop,0);
 // Exact immutable A migration, only on this synthetic local FILE. The
 // skipped=true branch still iterates legacy CREATE statements at schema 33.
 const a=await frozenA(t);const result=await a.migrations.runMigrations(f.db.raw);
 assert.equal(result.skipped,true);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('idx_insight_subject','idx_insight_active')")).rows[0].n,2);
 assert.equal((await f.fetchWorker('https://synthetic.invalid'+discoveryPath,signed(f,discoveryPath,body))).status,503);
 assert.equal(f.counts.whoop,0);assert.equal(f.counts.telegram,0);
});

for(const state of ['DELIVERY_STARTED','AMBIGUOUS','DELIVERED'])test('actual runner preserves original old-lifecycle '+state+' Claim without a second report',async t=>{
 const f=await p0Harness(t);const key={userId:syntheticUser,reportType:'daily',localDateKey:f.day};
 const claim=await f.db.claimReport({...key,ttlMs:60000,expectedLifecycleGeneration:1});
 await f.db.authorizeReportDelivery({...key,owner:claim.owner,expectedLifecycleGeneration:1});
 if(state==='AMBIGUOUS')await f.db.markClaimAmbiguous({...key,owner:claim.owner});
 if(state==='DELIVERED')await f.db.markClaimSent({...key,owner:claim.owner,messageId:940001});
 // Only the synthetic original claim belongs to a prior lifecycle. The current
 // user/token/link stay eligible so rejection must come from the claim fence.
 await f.db.raw.execute('UPDATE report_claims SET lifecycle_generation=0');
 const original=await rows(f,'report_claims');await f.start();
 if(state==='DELIVERED')await invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker});
 else {
  await assert.rejects(invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker}),e=>e.category==='sync_incomplete');
  const sync=f.calls.find(c=>c.path===runPath);assert.equal(sync.result.ok,false);assert.equal(sync.result.syncComplete,false);
 }
 assert.deepEqual(await rows(f,'report_claims'),original);assert.equal(f.counts.telegram,0);
 assert.ok(f.counts.whoop>0);
});

test('actual provider failure cannot become a successful SYNC or fabricated SENT evaluation',async t=>{
 const f=await p0Harness(t,{source:'failure'});await f.start();
 await assert.rejects(invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker,sleep:async()=>{throw Error('BOUNDED_FAILURE_NO_RETRY');}}));
 const sync=f.calls.find(c=>c.path===runPath);assert.ok(sync);assert.equal(sync.result.ok,false);assert.equal(sync.result.syncComplete,false);
 assert.notEqual((await f.db.getBriefingEvaluation(syntheticUser,'daily'))?.outcome,'SENT');
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM report_runs WHERE status='SENT'")).rows[0].n,0);
});

test('synthetic Telegram lost ACK stays AMBIGUOUS through a fresh Worker invocation and runtime restart',async t=>{
 const f=await p0Harness(t,{send:'lost-ack'});await f.start();
 await assert.rejects(invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker}),e=>e.category==='sync_incomplete');
 assert.equal((await f.db.getClaim(syntheticUser,'daily',f.day))?.deliveryState,'AMBIGUOUS');
 assert.equal(f.counts.telegram,1);const original=await rows(f,'report_claims');
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM report_runs WHERE status='SENT'")).rows[0].n,0);
 await f.restart();
 await assert.rejects(invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker}),e=>e.category==='sync_incomplete');
 assert.equal(f.counts.telegram,1);assert.deepEqual(await rows(f,'report_claims'),original);
});

test('candidate local admission closure rejects new work and drains without clearing durable state',async t=>{
 const f=await p0Harness(t);await f.start();await invoke(f.workerEnvironment,{fetchImpl:f.fetchWorker});
 const original=await rows(f,'report_claims'),receipts=await rows(f,'phase4_execution_work_receipts');
 f.runtime.closeAdmission('synthetic_p0_maintenance_01');
 await f.runtime.waitForDrained({signal:AbortSignal.timeout(2000)});
 const before={...f.counts},body=query(f),r=await f.fetchWorker('https://synthetic.invalid'+discoveryPath,signed(f,discoveryPath,body));
 assert.equal(r.status,503);assert.deepEqual(f.counts,before);
 assert.equal(f.runtime.status().localWorkDrained,true);
 assert.deepEqual(await rows(f,'report_claims'),original);assert.deepEqual(await rows(f,'phase4_execution_work_receipts'),receipts);
});

test('recovery release refuses missing or weak scheduler configuration before database access',async t=>{
 const f=await p0Harness(t),original={...f.environment};
 for(const patch of [{BRIEFING_TRIGGER_SECRET:undefined},{BRIEFING_TRIGGER_SECRET:'weak'},
  {WHOOP_CLIENT_ID:undefined},{WHOOP_CLIENT_SECRET:undefined},{TELEGRAM_CHAT_ID:undefined}]){
  Object.assign(f.environment,original,patch);
  for(const [key,value] of Object.entries(f.environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await assert.rejects(f.start(),/RECOVERY_SCHEDULER_CONFIGURATION_REQUIRED/);
  assert.equal(f.counts.db,0);assert.equal(f.runtime,undefined);
 }
});
