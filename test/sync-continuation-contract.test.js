import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {runExecutionPhase,discoverExecutionContinuation} from '../src/phase4Execution.js';
import {invoke} from '../cloudflare/briefing-scheduler/worker.js';
import {canonicalPhaseRequest,configurationProof,claimPhaseRequest,readExecution,yieldSyncPhase,commitPhaseWork} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {currentDurableExecution,withDurableExecution,prepareExecutionReceipt,appendPreparedExecutionReceipt,readWorkStep} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget} from '../src/executionBudget.js';
import {discoverPhaseContinuation} from '../src/phase4Continuation.js';
import {createSync} from '../src/sync.js';
import {createWhoopClient} from '../src/whoop.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {summarizeFastReconciliation,automaticFastReconciliationDue} from '../src/index.js';
import {createReconciler} from '../src/reconcile.js';

const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'sync'};
const request=()=>({releaseSha:runningReleaseSha(),requestId:`p4s1_${randomUUID()}`,phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)});
const run=(db,r,deps,extra={})=>runExecutionPhase({request:r,body:canonicalPhaseRequest(r),db,keys:fixtureKeys,environment,env:{dryRun:true},deps,...extra});
const discovery=(db,r)=>discoverPhaseContinuation({query:{releaseSha:r.releaseSha,executionMode:r.executionMode,triggerSource:r.triggerSource,configProof:r.configProof,scope:'sync'},db,keys:fixtureKeys,releaseSha:r.releaseSha,mode:r.executionMode,configProof:r.configProof,scope:'sync'});
const context=(claim,authority)=>({claim,keys:fixtureKeys,pending:new Set(),authority});
async function seedUser(db){
 await db.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'synthetic'});
 await db.saveCapabilities('alice',[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 await db.saveSyncState('alice','sleep',{backfillComplete:true,lastSuccessAt:new Date(Date.now()-3*3600000).toISOString()});
}
function defer(){currentDurableExecution().syncYieldRequested=true;return {syncComplete:false,syncOutcome:'PARTIAL',syncYieldSafe:true,users:1,failed:1};}
test('authenticated same canonical SYNC resumes completed window receipts with anchored calendar and null result until finalization',async t=>{
 const {db}=await deliveryFixture(t);await seedUser(db);const r=request();let calls=0,legs=0,dates=[];
 const deps={runBriefing:async({now})=>{
  legs++;dates.push(now.getTime());
  const synced=await createSync({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,now,whoop:{sleeps:async()=>{
   assert.equal(db.processingTransactionActive(),false);calls++;return [{id:'synthetic-sleep',start:new Date(now.getTime()-8*3600000).toISOString(),end:new Date(now.getTime()-3600000).toISOString(),nap:false,timezone_offset:'+08:00',score_state:'SCORED'}];
  }}}).syncAll({force:true,resources:['sleep']});
  assert.equal(synced.resources[0].status,'ok');assert.equal(synced.resources[0].incremental.fetched,1);
  return legs<3?defer():{syncComplete:true,syncOutcome:'COMPLETE_SUCCESS',users:1};
 }};
 const secret='synthetic-sync-continuation-secret-32bytes',endpoint=createBriefingEndpoint({secret,environment,runPhase:()=>run(db,r,deps)}),body=canonicalPhaseRequest(r);
 const send=(bodyText=body,headerId=r.requestId)=>{const timestamp=String(Date.now()),path='/internal/briefing/run';return endpoint({method:'POST',url:path,headers:{'content-type':'application/json','x-briefing-request-id':headerId,'x-briefing-timestamp':timestamp,'x-briefing-signature':signTriggerRequest({timestamp,requestId:headerId,method:'POST',path,body:bodyText},secret)}},bodyText);};
 let receipts;
 for(let i=0;i<2;i++){
  const reply=await send();assert.equal(reply.status,202,JSON.stringify(reply));assert.equal(reply.body.result.outcome,'PARTIAL');assert.equal(reply.body.syncComplete,false);assert.equal(reply.body.drainAuthorized,false);assert.equal(reply.body.handoff,undefined);
  const row=await readExecution(db,r.requestId);assert.equal(row.state,'ESTABLISHED');assert.equal(row.generation,i+1);assert.equal(row.result_json,null);assert.equal(row.result_digest,null);assert.equal(row.work_committed_at,null);assert.ok(row.lease_until<Date.now());assert.ok(row.deadline_at<Date.now());
  const current=(await db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
  if(receipts)assert.deepEqual(current,receipts);else receipts=current;
  assert.equal((await discovery(db,r)).body.requestBody,body);assert.equal((await discovery(db,r)).body.state,'INCOMPLETE_RESUMABLE');
 }
 assert.ok(receipts.length>=2);const final=await send();assert.equal(final.status,200);assert.equal(final.body.syncComplete,true);assert.equal(calls,1,'committed effect/count windows really replay even forced due');
 assert.deepEqual(dates,[dates[0],dates[0],dates[0]]);assert.equal((await readExecution(db,r.requestId)).created_at,dates[0]);
 assert.deepEqual(await send(),final);assert.equal(legs,3,'final replay performs no business work');
 assert.equal((await send(canonicalPhaseRequest({...r,configProof:'b'.repeat(64)}))).status,409);assert.equal((await send(body,randomUUID())).status,400);
 assert.equal((await discovery(db,r)).body.state,'NONE');assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,32);
});
test('ordinary legacy incomplete SYNC is never discovered, and new stale context permits legitimate future cycle',async t=>{
 const {db}=await deliveryFixture(t),r=request(),legacy={...r,requestId:randomUUID()};
 const original=Date.now;
 try{Date.now=()=>original()-900001;await claimPhaseRequest(db,legacy,canonicalPhaseRequest(legacy));}finally{Date.now=original;}
 assert.equal((await discovery(db,r)).body.state,'NONE');
 let claim;try{Date.now=()=>original()-900001;claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r),{serializeScope:true});}finally{Date.now=original;}
 assert.equal((await discovery(db,r)).body.state,'NONE');await assert.rejects(()=>claimPhaseRequest(db,r,canonicalPhaseRequest(r),{maxWorkAgeMs:900000}),/EXECUTION_STALE_REQUEST/);
 const future=request();assert.equal((await claimPhaseRequest(db,future,canonicalPhaseRequest(future),{serializeScope:true})).generation,1);
 assert.equal(claim.generation,1);
});
test('expired predecessor cannot tighten successor generation and pending operations cannot deliberately yield',async t=>{
 const {db}=await deliveryFixture(t),r=request(),old=await claimPhaseRequest(db,r,canonicalPhaseRequest(r)),authority=createExecutionBudget({budgetMs:5000});t.after(()=>authority.close());
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=0,deadline_at=0 WHERE execution_id=?',args:[r.requestId]});
 const next=await claimPhaseRequest(db,r,canonicalPhaseRequest(r)),before=await readExecution(db,r.requestId);
 await assert.rejects(()=>withDurableExecution({...context(old,authority),receipts:false},()=>yieldSyncPhase(db,old,authority)),/REQUEST_OWNER_FENCED/);assert.deepEqual(await readExecution(db,r.requestId),before);
 await assert.rejects(()=>withDurableExecution({...context(next,authority),receipts:false,pending:new Set([{}])},()=>yieldSyncPhase(db,next,authority)),/COMMIT_INDETERMINATE/);assert.deepEqual(await readExecution(db,r.requestId),before);
});
test('lost yield acknowledgement is uncertain and next fresh claim reconciles rather than pretending completion',async t=>{
 const {db,transport}=await deliveryFixture(t),r=request();transport.arm({matchSql:/SET lease_until=MIN\(lease_until/,loseAcknowledgement:true});
 const first=await run(db,r,{runBriefing:async()=>defer()});assert.equal(first.status,503);assert.equal(first.body.result.outcome,'COMMIT_INDETERMINATE');assert.equal(first.body.syncComplete,false);
 const row=await readExecution(db,r.requestId);assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.result_digest,null);
 let newWork=0;const next=await run(db,r,{runBriefing:async()=>{newWork++;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};}});assert.equal(next.status,200);assert.equal(newWork,1);assert.equal((await readExecution(db,r.requestId)).generation,2);
});
test('cancellation during deliberate-yield COMMIT never becomes known PARTIAL or authorizes handoff',async t=>{
 const {db,transport}=await deliveryFixture(t),r=request(),controller=new AbortController();transport.arm({matchSql:/SET lease_until=MIN\(lease_until/,before:async()=>controller.abort()});
 const reply=await run(db,r,{runBriefing:async()=>defer()},{signal:controller.signal});assert.notEqual(reply.status,202);assert.ok(['CANCELLED','COMMIT_INDETERMINATE'].includes(reply.body.result.outcome));assert.equal(reply.body.syncComplete,false);assert.equal(reply.body.handoff,undefined);
 assert.equal((await readExecution(db,r.requestId)).result_json,null);
});
test('receipt preparation cannot escape owning transaction or be reused in a later lifetime',async t=>{
 const {db}=await deliveryFixture(t),r=request(),claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r)),authority=createExecutionBudget({budgetMs:5000});t.after(()=>authority.close());let token;
 await withDurableExecution(context(claim,authority),()=>db.transaction(async()=>{token=await prepareExecutionReceipt(db.raw,{step:['escape'],result:1,explicit:true});},{readOnly:true}));
 await assert.rejects(()=>withDurableExecution(context(claim,authority),()=>db.transaction(()=>appendPreparedExecutionReceipt(db.raw,token),{workStep:'other'})),/EXECUTION_RECEIPT_CORRUPT/);
 assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,0);
});
test('late-leg tokens use actual fresh clock rather than original logical calendar',async t=>{
 const {db}=await deliveryFixture(t);await seedUser(db);const r=request();
 const reply=await run(db,r,{runBriefing:async()=>defer()});assert.equal(reply.status,202);
 await db.raw.execute("UPDATE user_whoop_tokens SET access_token_expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='alice'");let refresh=0;
 const second=await run(db,r,{runBriefing:async({now})=>{
  assert.ok(now.getTime()<Date.now());
  const client=createWhoopClient({db,userId:'alice',expectedLifecycleGeneration:1,clientId:'synthetic',clientSecret:'synthetic',fetchImpl:async()=>{assert.equal(db.processingTransactionActive(),false);refresh++;return new Response(JSON.stringify({access_token:'fresh-synthetic',refresh_token:'fresh-synthetic',expires_in:3600}));}});
  assert.equal(await client.getAccessToken(),'fresh-synthetic');return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};
 }});assert.equal(second.status,200);assert.equal(refresh,1);
});
test('fresh DB expiry still fences receipt replay, and failed ordered batch rolls back data and receipts',async t=>{
 const {db}=await deliveryFixture(t),r=request(),claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r)),authority=createExecutionBudget({budgetMs:5000});t.after(()=>authority.close());
 await assert.rejects(()=>withDurableExecution(context(claim,authority),()=>db.transaction(()=>db.raw.batch([
  "INSERT INTO telegram_state(key,value,updated_at) VALUES('batch_partial','1','2026-10-11')",
  'INSERT INTO synthetic_absent_table VALUES(1)',
 ]),{workStep:'failed-batch'})));
 assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key='batch_partial'")).rows[0].n,0);assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,0);
 await withDurableExecution(context(claim,authority),()=>db.transaction(()=>db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('committed','1','2026-10-11')"),{workStep:'committed',discardResult:true}));
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=0,deadline_at=0 WHERE execution_id=?',args:[r.requestId]});
 await assert.rejects(()=>withDurableExecution(context(claim,authority),()=>db.transaction(()=>readWorkStep(db.raw,['named','committed']),{readOnly:true})),/REQUEST_OWNER_FENCED/);
 assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
});
for(const change of ['timezone','source'])test(`${change} change between legs cannot borrow obsolete committed window receipts`,async t=>{
 const {db}=await deliveryFixture(t);await seedUser(db);const r=request();let legs=0,calls=0;
 const deps={runBriefing:async({now})=>{
  legs++;const sync=await createSync({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,now,whoop:{sleeps:async()=>{calls++;return [];}}}).syncAll({force:true,resources:['sleep']});
  if(legs===1)return defer();return {syncComplete:sync.resources[0]?.status==='ok',syncOutcome:sync.resources[0]?.status==='ok'?'NO_NEW_DATA_SUCCESS':sync.outcome};
 }};
 assert.equal((await run(db,r,deps)).status,202);const old=(await db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
 await db.raw.execute(change==='timezone'?"UPDATE users SET timezone='UTC' WHERE id='alice'":"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1,whoop_user_id='new-synthetic' WHERE user_id='alice'");
 const second=await run(db,r,deps);
 if(change==='timezone'){assert.equal(second.status,424);assert.equal(second.body.result.outcome,'AUTH_FAILED');assert.equal(calls,1);}else {assert.equal(second.status,200);assert.equal(calls,2);}
 const all=(await db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
 for(const row of old)assert.deepEqual(all.find(r=>r.receipt_key===row.receipt_key),row,'old immutable receipts remain intact');
});
test('soft-yield flag cannot turn an actual elapsed work deadline into known PARTIAL',async t=>{
 const {db}=await deliveryFixture(t),r=request();
 const result=await run(db,r,{runBriefing:async()=>{await new Promise(resolve=>setTimeout(resolve,200));return defer();}},{budgetMs:60});
 assert.notEqual(result.body.result.outcome,'PARTIAL');assert.equal(result.body.result.outcome,'TIMEOUT');assert.equal(result.body.syncComplete,false);assert.equal(result.body.handoff,undefined);
 assert.equal((await readExecution(db,r.requestId)).result_json,null);
});
test('real Worker signs three legs against actual authenticated route, discovery and admitted v32 claims',async t=>{
 const {db}=await deliveryFixture(t),r=request(),secret='synthetic-integrated-worker-secret-32bytes';let legs=0;const posts=[];
 const endpoint=createBriefingEndpoint({secret,environment,
  discoverContinuation:options=>discoverExecutionContinuation({...options,db,keys:fixtureKeys,environment}),
  runPhase:options=>runExecutionPhase({...options,db,keys:fixtureKeys,environment,env:{dryRun:true},deps:{runBriefing:async()=>{
   legs++;await db.transaction(async()=>{await db.raw.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[`leg-${legs}`,'1','2026-10-11']});return 1;},{workStep:`leg-${legs}`});
   return legs<3?defer():{syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};
  }}})});
 const outcome=await invoke({BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret,BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_RELEASE_SHA:r.releaseSha,BRIEFING_CONFIG_PROOF:r.configProof,BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'sync'},
  {sleep:async()=>{},fetchImpl:async(url,options)=>{
   const path=new URL(url).pathname,parsed=JSON.parse(options.body);posts.push({path,body:options.body,nonce:options.headers['x-briefing-request-id']});
   if(path.endsWith('/run'))assert.equal(parsed.requestId,options.headers['x-briefing-request-id']);
   const reply=await endpoint({url:path,method:options.method,headers:options.headers},options.body);return new Response(JSON.stringify(reply.body),{status:reply.status});
  }});
 assert.equal(outcome.ok,true);assert.equal(outcome.attempt,3);assert.equal(outcome.phase,'SYNC');assert.equal(outcome.drain,'DISABLED');assert.equal(legs,3);
 const runs=posts.filter(p=>p.path.endsWith('/run'));assert.equal(runs.length,3);assert.ok(runs[0].nonce.startsWith('p4s1_'));assert.ok(runs.every(p=>p.body===runs[0].body&&p.nonce===runs[0].nonce));
 const row=await readExecution(db,runs[0].nonce);assert.equal(row.generation,3);assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,3);
});
test('required current-parent FAST failure remains unfinished during backoff on later legs',async t=>{
 const {db}=await deliveryFixture(t);await seedUser(db);const r=request();let calls=0,legs=0;
 const deps={runBriefing:async({now})=>{
  legs++;const plan=await automaticFastReconciliationDue({db,userId:'alice',now,resources:['body_measurement']});assert.equal(plan.due,true);
  const results=await createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,windowNow:now,whoop:{bodyMeasurement:async()=>{calls++;throw Error('synthetic-provider-failure');}}}).reconcileAll({resources:plan.dueResources,includeDeep:false});
  assert.equal(summarizeFastReconciliation(plan,results).complete,false);assert.equal(results[0].result,legs===1?'FAILED':'SKIPPED');if(legs>1)assert.equal(results[0].reason,'backoff');
  return {...defer(),syncYieldSafe:false};
 }};
 const result=await run(db,r,deps);assert.equal(result.status,207);assert.equal(result.body.syncComplete,false);assert.equal(result.body.handoff,undefined);assert.equal(result.body.result.resumable,undefined);assert.equal(result.body.result.yieldReason,undefined);
 assert.equal(calls,1);const row=await readExecution(db,r.requestId);assert.equal(row.state,'FINALIZED_FAILURE');assert.equal((await run(db,r,deps)).status,207);assert.equal(legs,1,'actual failure is never retried as budget yield');
});
test('precommitted immutable SYNC result is only finalized on resume without business replay or mutation',async t=>{
 const {db}=await deliveryFixture(t),r=request(),claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r)),authority=createExecutionBudget({budgetMs:5000});t.after(()=>authority.close());
 await withDurableExecution({...context(claim,authority),receipts:false},()=>commitPhaseWork(db,r,claim,{outcome:'NO_NEW_DATA_SUCCESS',users:0},authority));
 const before=await readExecution(db,r.requestId);assert.equal((await discovery(db,r)).body.state,'WORK_COMMITTED_UNFINALIZED');
 const reply=await run(db,r,{runBriefing:async()=>{throw Error('immutable-work-must-not-repeat');}});assert.equal(reply.status,200);
 const after=await readExecution(db,r.requestId);assert.equal(after.state,'FINALIZED_SUCCESS');assert.equal(after.result_json,before.result_json);assert.equal(after.result_digest,before.result_digest);assert.equal(after.work_committed_at,before.work_committed_at);
});
test('unknown failed FAST settlement is freshly reconciled and its backoff never becomes full completion',async t=>{
 const {db,transport}=await deliveryFixture(t);await seedUser(db);const r=request();let calls=0,legs=0;
 transport.arm({matchSql:/last_failure_at\s*=/,loseAcknowledgement:true});
 const deps={runBriefing:async({now})=>{
  legs++;const plan=await automaticFastReconciliationDue({db,userId:'alice',now,resources:['body_measurement']});assert.equal(plan.due,true);
  const results=await createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,windowNow:now,whoop:{bodyMeasurement:async()=>{calls++;throw Error('synthetic-provider-failure');}}}).reconcileAll({resources:plan.dueResources,includeDeep:false});
  assert.equal(results[0].reason,'backoff');assert.equal(summarizeFastReconciliation(plan,results).complete,false);return {...defer(),syncYieldSafe:false};
 }};
 const first=await run(db,r,deps);assert.equal(first.status,503);assert.equal(first.body.result.outcome,'COMMIT_INDETERMINATE');
 const state=await db.getReconciliationState('alice','body_measurement');assert.equal(state.consecutiveFailures,1);assert.equal(state.continuationFrom,null);assert.ok(Date.parse(state.nextAttemptAt)>Date.now());
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=0,deadline_at=0 WHERE execution_id=?',args:[r.requestId]});
 const resumed=await run(db,r,deps);assert.equal(resumed.status,207);assert.equal(resumed.body.syncComplete,false);assert.equal(resumed.body.result.yieldReason,undefined);assert.equal(calls,1);assert.equal(legs,2);
});
test('required due FAST partial, failed, busy or omitted resources cannot prove full completion',()=>{
 const plan={due:true,dueResources:['sleep','recovery']},success={resource:'sleep',scope:'recent',result:'SUCCESS'};
 for(const result of [[],[success],[success,{resource:'recovery',scope:'recent',result:'PARTIAL'}],[success,{resource:'recovery',scope:'recent',result:'SKIPPED',reason:'claim_busy'}]])assert.equal(summarizeFastReconciliation(plan,result).complete,false);
 assert.equal(summarizeFastReconciliation(plan,[success,{resource:'recovery',scope:'recent',result:'SKIPPED',reason:'not_due'}]).complete,true);
});
