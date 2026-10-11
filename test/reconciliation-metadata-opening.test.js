import test from 'node:test';import assert from 'node:assert/strict';
import {createClient} from '@libsql/client/sqlite3';
import {fixture,request,claim,fixtureKeys} from './v32ReviewFixture.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {withSyncOwnership} from '../src/syncOwnership.js';
import {createReconciler} from '../src/reconcile.js';

async function setup(t,budgetMs=10000){
 const {db,transport,url}=await fixture(t);await db.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'1001'});await db.getCapabilities('alice');
 const c=await claim(db,request()),budget=createExecutionBudget({budgetMs}),other=createClient({url});t.after(()=>{budget.close();other.close();});
 const context={claim:c,keys:fixtureKeys,pending:new Set(),authority:budget},admittedAnchor=new Date();let providers=0;
 const run=({ownerId='synthetic-owner',whoop,resource='sleep',options,windowAnchor=admittedAnchor}={})=>withExecutionBudget(budget,()=>withDurableExecution(context,()=>withSyncOwnership({db,userId:'alice',budget},()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId,windowNow:windowAnchor,maxPagesPerRun:1,whoop:whoop??{apiGet:async()=>{providers++;assert.equal(db.processingTransactionActive(),false);return {records:[],next_token:null};}}}).reconcileResource(resource,options))));
 return {db,transport,other,budget,context,run,get providers(){return providers;},state:()=>db.getReconciliationState('alice','sleep'),runs:()=>db.recentReconciliationRuns('alice',{limit:20})};
}
function interruptAfterOpeningAck(f){
 const transaction=f.db.transaction;let stop=true;
 f.db.transaction=async(fn,options)=>{const root=!f.db.processingTransactionActive(),result=await transaction(fn,options);
  if(root&&stop){stop=false;throw Error('SYNTHETIC_POST_ACK_INTERRUPTION');}return result;
 };
}
test('fixed opening order shares one actual transaction and acknowledges run/pending before zero provider work enters it',async t=>{
 const f=await setup(t),order=[];let openingHttp;
 for(const name of ['claimReconciliation','getReconciliationState','openReconciliationRun','openPendingWindow']){
  const original=f.db[name];f.db[name]=async(...args)=>{order.push(name);assert.equal(f.db.processingTransactionActive(),true);return original(...args);};
 }
 const transaction=f.db.transaction;f.db.transaction=async(fn,options)=>{const root=!f.db.processingTransactionActive(),before=f.transport.counts.httpRequests,result=await transaction(fn,options);
  if(root&&openingHttp===undefined)openingHttp=f.transport.counts.httpRequests-before;return result;};
 const result=await f.run({whoop:{apiGet:async()=>{assert.equal(f.db.processingTransactionActive(),false);
  assert.equal((await f.other.execute("SELECT count(*) n FROM whoop_reconciliation_runs WHERE user_id='alice' AND finished_at IS NULL")).rows[0].n,1);
  assert.ok((await f.other.execute("SELECT continuation_from FROM whoop_reconciliation_state WHERE user_id='alice' AND resource='sleep'")).rows[0].continuation_from);return {records:[],next_token:null};}}});
 assert.equal(result.result,'SUCCESS');assert.deepEqual(order.slice(0,4),['claimReconciliation','getReconciliationState','openReconciliationRun','openPendingWindow']);
 assert.ok(openingHttp<23);console.log('ORDERED_OPENING_ACTUAL_HTTP '+JSON.stringify({openingHttp,originalClaimStateRunCapturePendingHttp:23,syntheticLocalOnly:true}));
 const receipts=(await f.db.raw.execute({sql:'SELECT result_json FROM phase4_execution_work_receipts WHERE execution_id=?',args:[f.context.claim.executionId]})).rows;
 assert.ok(receipts.some(row=>Number.isSafeInteger(JSON.parse(row.result_json??'null'))&&JSON.parse(row.result_json)>0),'opening receipt is only an acknowledged numeric run ID');
});
test('busy grant records no run; old false receipt cannot clone authority but a distinct admitted cycle may acquire a fresh grant',async t=>{
 const f=await setup(t);await f.db.claimReconciliation({userId:'alice',resource:'sleep',owner:'successor',leaseMs:60000,lifecycleGeneration:1});
 assert.equal((await f.run()).result,'SKIPPED');assert.equal((await f.runs()).length,0);assert.equal(f.providers,0);
 await f.other.execute("UPDATE whoop_reconciliation_state SET owner=NULL,lease_expires_at=NULL WHERE user_id='alice' AND resource='sleep'");
 assert.equal((await f.run()).result,'SKIPPED');assert.equal((await f.state()).owner,null);assert.equal((await f.runs()).length,0);
 assert.equal((await f.run({windowAnchor:new Date(Date.now()+60000)})).result,'SUCCESS');assert.equal(f.providers,1);assert.equal((await f.runs()).length,1);
});
for(const boundary of ['state','pending'])test(`actual SQL fault at ${boundary} rolls back the unacknowledged opening chain without a run/lease/receipt or provider retry`,async t=>{
 const f=await setup(t),name=boundary==='state'?'getReconciliationState':'openPendingWindow',original=f.db[name];let once=true;
 f.db[name]=async(...args)=>{if(once){once=false;await f.db.raw.execute('SELECT * FROM synthetic_missing_opening_table');}return original(...args);};
 await assert.rejects(f.run(),error=>error.code==='SQLITE_ERROR');assert.equal(f.providers,0);assert.equal((await f.runs()).length,0);assert.equal(await f.state(),null);
 assert.equal((await f.db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[f.context.claim.executionId]})).rows[0].n,0);
});
for(const attack of ['expiry','takeover'])test(`false pending ${attack} preserves its acknowledged diagnostic run and only the original FENCED closure truth`,async t=>{
 const f=await setup(t),pending=f.db.openPendingWindow;
 f.db.openPendingWindow=async(...args)=>{await f.db.raw.execute({sql:'UPDATE whoop_reconciliation_state SET owner=?,lease_expires_at=? WHERE user_id=? AND resource=?',args:[attack==='takeover'?'successor':'synthetic-owner',attack==='takeover'?new Date(Date.now()+60000).toISOString():'1970-01-01T00:00:00Z','alice','sleep']});return pending(...args);};
 const result=await f.run();assert.equal(result.result,'FENCED');assert.equal(f.providers,0);const state=await f.state(),runs=await f.runs();
 assert.equal(state.windowWatermark,null);assert.equal(state.continuationFrom,null);assert.equal(runs.length,1);assert.equal(runs[0].owner,'synthetic-owner');assert.equal(runs[0].result,'FENCED');assert.ok(runs[0].finishedAt);
 assert.equal(state.owner,attack==='takeover'?'successor':'synthetic-owner');assert.equal(state.consecutiveFailures,0);
});
test('input-fenced opening retains the acknowledged diagnostic run, opens no pending window and makes zero provider calls',async t=>{
 const f=await setup(t);await f.other.execute("UPDATE users SET timezone='UTC' WHERE id='alice'");const result=await f.run();
 assert.equal(result.result,'FENCED');assert.equal(f.providers,0);const state=await f.state(),runs=await f.runs();assert.equal(state.continuationFrom,null);assert.equal(state.windowWatermark,null);assert.equal(state.consecutiveFailures,0);
 assert.equal(runs.length,1);assert.equal(runs[0].result,'FENCED');assert.ok(runs[0].finishedAt);
});
test('original fresh input proof fences authorization changed between capture and pending before any provider request',async t=>{
 const f=await setup(t),pending=f.db.openPendingWindow;
 f.db.openPendingWindow=async(...args)=>{await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'");return pending(...args);};
 const result=await f.run();assert.equal(result.result,'FENCED');assert.equal(f.providers,0);assert.equal((await f.state()).windowWatermark,null);assert.equal((await f.runs())[0].result,'FENCED');
});
test('original sync runtime ownership fence rejects loss between ordered opening operations and rolls back every opening effect',async t=>{
 const f=await setup(t),pending=f.db.openPendingWindow;
 f.db.openPendingWindow=async(...args)=>{await f.db.raw.execute("UPDATE resource_locks SET owner='successor' WHERE name='phase4:sync:alice'");return pending(...args);};
 await assert.rejects(f.run(),error=>error.code==='SYNC_OWNER_FENCED');assert.equal(f.providers,0);assert.equal((await f.runs()).length,0);assert.equal(await f.state(),null);
});
test('opening COMMIT ACK loss preserves one durable run and pending grant, stays indeterminate and never repeats opening/provider callbacks',async t=>{
 const f=await setup(t);let opens=0;const open=f.db.openReconciliationRun;f.db.openReconciliationRun=async(...args)=>{opens++;return open(...args);};
 f.transport.arm({matchSql:/INSERT INTO whoop_reconciliation_runs/,loseAcknowledgement:true});
 await assert.rejects(f.run(),error=>error.code==='COMMIT_INDETERMINATE');assert.equal(f.context.indeterminate,true);assert.equal(f.providers,0);assert.equal(opens,1);
 const state=await f.state(),runs=await f.runs();assert.equal(state.owner,'synthetic-owner');assert.ok(state.continuationFrom);assert.equal(state.windowWatermark,null);assert.equal(runs.length,1);assert.equal(runs[0].finishedAt,null);
 await assert.rejects(f.run(),error=>error.code==='COMMIT_INDETERMINATE');assert.equal(opens,1);assert.equal(f.providers,0);assert.equal(f.transport.evidence.filter(x=>x.event==='commit_durable').length,1);
});
for(const stop of ['cancel','deadline'])test(`actual submitted opening COMMIT ${stop} preserves reconcilable metadata and starts no provider work`,async t=>{
 const f=await setup(t,stop==='deadline'?1000:10000);f.transport.arm({matchSql:/INSERT INTO whoop_reconciliation_runs/,before:async()=>{
  if(stop==='cancel')f.budget.cancel();else await new Promise(resolve=>setTimeout(resolve,f.budget.remainingMs()+5));
 }});await assert.rejects(f.run(),error=>error.code===(stop==='cancel'?'SYNC_CANCELLED':'SYNC_TIMEOUT'));
 const limit=Date.now()+2000;while(!f.transport.evidence.some(x=>x.event==='commit_durable')&&Date.now()<limit)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.transport.evidence.some(x=>x.event==='commit_durable'));assert.equal(f.context.indeterminate,true);assert.equal(f.providers,0);assert.ok((await f.state()).continuationFrom);assert.equal((await f.runs())[0].finishedAt,null);
});
test('cancel before pending submission rolls back every unacknowledged opening effect',async t=>{
 const f=await setup(t),pending=f.db.openPendingWindow;f.db.openPendingWindow=async(...args)=>{f.budget.cancel();return pending(...args);};
 await assert.rejects(f.run(),error=>error.code==='SYNC_CANCELLED');assert.equal(f.providers,0);assert.equal(await f.state(),null);assert.equal((await f.runs()).length,0);
});
test('ACKed opening replay uses only the exact current live grant/run and never reopens either metadata operation',async t=>{
 const f=await setup(t);let claims=0,opens=0,pendings=0;
 for(const [name,count] of [['claimReconciliation',()=>claims++],['openReconciliationRun',()=>opens++],['openPendingWindow',()=>pendings++]]){const original=f.db[name];f.db[name]=async(...args)=>{count();return original(...args);};}
 interruptAfterOpeningAck(f);await assert.rejects(f.run(),/SYNTHETIC_POST_ACK_INTERRUPTION/);assert.equal(f.providers,0);const originalRun=(await f.runs())[0];
 const result=await f.run();assert.equal(result.result,'SUCCESS');assert.equal(result.window.from.toISOString(),originalRun.windowFrom);assert.equal(result.window.to.toISOString(),originalRun.windowTo);
 assert.deepEqual([claims,opens,pendings],[1,1,1]);assert.equal(f.providers,1);assert.equal((await f.runs()).length,1);
 assert.equal((await f.run()).result,'SKIPPED');assert.deepEqual([claims,opens,pendings],[1,1,1]);assert.equal(f.providers,1);
 assert.equal((await f.run({options:{explicitWindow:{from:new Date(Date.now()-86400000),to:new Date()}}})).result,'SUCCESS');assert.deepEqual([claims,opens,pendings],[2,2,1]);assert.equal(f.providers,2);
});
for(const attack of ['takeover','missing-run','mode-change'])test(`ACKed opening replay after ${attack} cannot use an old receipt as fresh grant or start provider work`,async t=>{
 const f=await setup(t);interruptAfterOpeningAck(f);await assert.rejects(f.run(),/SYNTHETIC_POST_ACK_INTERRUPTION/);
 if(attack==='takeover')await f.other.execute("UPDATE whoop_reconciliation_state SET owner='successor',lease_expires_at='2999-01-01T00:00:00Z' WHERE user_id='alice' AND resource='sleep'");
 else if(attack==='missing-run')await f.other.execute("DELETE FROM whoop_reconciliation_runs WHERE user_id='alice'");
 else await f.other.execute("UPDATE whoop_reconciliation_runs SET mode='deep_slice' WHERE user_id='alice'");
 assert.equal((await f.run()).result,'SKIPPED');assert.equal(f.providers,0);assert.equal((await f.state()).windowWatermark,null);if(attack==='takeover')assert.equal((await f.state()).owner,'successor');
});
test('actual authorization/source binding change after opening ACK fences the captured fragment before the first provider/effect',async t=>{
 const f=await setup(t),transaction=f.db.transaction;let change=true;
 f.db.transaction=async(fn,options)=>{const root=!f.db.processingTransactionActive(),result=await transaction(fn,options);
  if(root&&change){change=false;await f.other.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1,whoop_user_id='synthetic-new-subject' WHERE user_id='alice'");}return result;
 };
 const result=await f.run();assert.equal(result.result,'FENCED');assert.equal(f.providers,0);assert.equal((await f.state()).windowWatermark,null);assert.equal((await f.runs())[0].result,'FENCED');
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});
for(const attack of ['lifecycle','resource-takeover','sync-takeover'])test(`actual ${attack} after opening ACK starts zero provider work and cannot advance old health effects`,async t=>{
 const f=await setup(t),transaction=f.db.transaction;let change=true;
 f.db.transaction=async(fn,options)=>{const root=!f.db.processingTransactionActive(),result=await transaction(fn,options);
  if(root&&change){change=false;
   if(attack==='lifecycle')await f.other.execute("UPDATE users SET status='PAUSED',lifecycle_generation=lifecycle_generation+1 WHERE id='alice'");
   else if(attack==='resource-takeover')await f.other.execute("UPDATE whoop_reconciliation_state SET owner='successor',lease_expires_at='2999-01-01T00:00:00Z' WHERE user_id='alice' AND resource='sleep'");
   else await f.other.execute("UPDATE resource_locks SET owner='successor' WHERE name='phase4:sync:alice'");
  }return result;
 };
 if(attack==='sync-takeover')await assert.rejects(f.run(),error=>error.code==='SYNC_OWNER_FENCED');else assert.equal((await f.run()).result,'FENCED');
 assert.equal(f.providers,0);assert.equal((await f.state()).windowWatermark,null);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
 if(attack==='resource-takeover')assert.equal((await f.state()).owner,'successor');
 if(attack==='sync-takeover')assert.equal((await f.other.execute("SELECT owner FROM resource_locks WHERE name='phase4:sync:alice'")).rows[0].owner,'successor');
});
test('immutable explicit metadata binds actual operations despite caller object mutation during ordered claim',async t=>{
 const f=await setup(t),from=new Date(Date.now()-2*86400000),to=new Date(Date.now()-86400000),explicitWindow={from,to},original=f.db.claimReconciliation;let query;
 f.db.claimReconciliation=async(...args)=>{const result=await original(...args);explicitWindow.from=new Date(0);to.setTime(0);return result;};
 const result=await f.run({options:{explicitWindow},whoop:{apiGet:async(_path,q)=>{query=q;return {records:[],next_token:null};}}});
 assert.equal(result.result,'SUCCESS');assert.equal(query.start,from.toISOString());assert.equal(query.end,result.window.to.toISOString());assert.notEqual(query.end,new Date(0).toISOString());assert.equal((await f.runs())[0].windowTo,query.end);assert.equal((await f.state()).windowWatermark,null);
});
