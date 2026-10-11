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
 const context={claim:c,keys:fixtureKeys,pending:new Set(),authority:budget};let providers=0;
 const run=({ownerId='synthetic-owner',whoop,resource='sleep',options,maxPagesPerRun=1}={})=>withExecutionBudget(budget,()=>withDurableExecution(context,()=>withSyncOwnership({db,userId:'alice',budget},()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId,maxPagesPerRun,whoop:whoop??{apiGet:async()=>{providers++;assert.equal(db.processingTransactionActive(),false);return {records:[],next_token:null};}}}).reconcileResource(resource,options))));
 return {db,transport,other,budget,context,run,get providers(){return providers;},
  state:resource=>db.getReconciliationState('alice',resource??'sleep'),runs:()=>db.recentReconciliationRuns('alice',{limit:20})};
}
test('actual ordered settlement/close acknowledges one successful watermark and original complete run fields; same-owner retry cannot reacquire a consumed grant',async t=>{
 const f=await setup(t);let closes=0;const close=f.db.closeReconciliationRun;
 f.db.closeReconciliationRun=async(...args)=>{closes++;assert.equal(f.db.processingTransactionActive(),true);return close(...args);};
 const result=await f.run();assert.equal(result.result,'SUCCESS');assert.equal(result.pages,1);assert.equal(result.fetched,0);
 const state=await f.state(),runs=await f.runs();assert.equal(state.owner,null);assert.equal(state.continuationFrom,null);assert.ok(state.lastSuccessAt);assert.ok(state.windowWatermark);
 assert.equal(runs.length,1);assert.equal(runs[0].result,'SUCCESS');assert.ok(runs[0].finishedAt);assert.equal(runs[0].pages,1);assert.equal(runs[0].fetched,0);assert.equal(runs[0].written,0);assert.equal(runs[0].errorClass,null);
 assert.equal((await f.run()).result,'SKIPPED');assert.equal(f.providers,1);assert.equal(closes,1);assert.equal((await f.runs()).length,1);
});
test('a definite close fault after successful settlement rolls back its watermark before the original FAILED/backoff/closed-run path',async t=>{
 const f=await setup(t),close=f.db.closeReconciliationRun;let calls=0,observedUncommitted=false;
 f.db.closeReconciliationRun=async(...args)=>{
  if(++calls===1){assert.equal(f.db.processingTransactionActive(),true);
   observedUncommitted=Boolean((await f.db.raw.execute("SELECT window_watermark FROM whoop_reconciliation_state WHERE user_id='alice' AND resource='sleep'")).rows[0].window_watermark);
   assert.equal((await f.other.execute("SELECT window_watermark FROM whoop_reconciliation_state WHERE user_id='alice' AND resource='sleep'")).rows[0].window_watermark,null);
   throw Object.assign(Error('SYNTHETIC_CLOSE_REJECTED'),{code:'SQLITE_ERROR'});
  }return close(...args);
 };
 const result=await f.run();assert.equal(observedUncommitted,true);assert.equal(result.result,'FAILED');assert.equal(result.errorClass,'db');assert.equal(result.retryable,true);
 const state=await f.state(),runs=await f.runs();assert.equal(state.windowWatermark,null);assert.equal(state.lastSuccessAt,null);assert.equal(state.consecutiveFailures,1);assert.ok(state.nextAttemptAt);assert.ok(state.continuationFrom);assert.equal(state.owner,null);
 assert.equal(runs[0].result,'FAILED');assert.equal(runs[0].errorClass,'db');assert.equal(runs[0].retryable,true);assert.equal(f.providers,1);
});
test('repeated failed closure cannot fabricate success watermark, run finish, or a successful atomic receipt',async t=>{
 const f=await setup(t);f.db.closeReconciliationRun=async()=>{throw Object.assign(Error('SYNTHETIC_CLOSE_ALWAYS_REJECTED'),{code:'SQLITE_ERROR'});};
 await assert.rejects(f.run(),error=>error.code==='SQLITE_ERROR');
 const state=await f.state(),runs=await f.runs();assert.equal(state.windowWatermark,null);assert.equal(state.lastSuccessAt,null);assert.equal(runs[0].result,null);assert.equal(runs[0].finishedAt,null);assert.equal(f.providers,1);
});
test('a missing actual run row makes close false and cannot advance success watermark',async t=>{
 const f=await setup(t);
 await assert.rejects(f.run({whoop:{apiGet:async()=>{await f.other.execute("DELETE FROM whoop_reconciliation_runs WHERE user_id='alice'");return {records:[],next_token:null};}}}),/reconcile_run_closure_lost/);
 const state=await f.state();assert.equal(state.windowWatermark,null);assert.equal(state.lastSuccessAt,null);assert.equal((await f.runs()).length,0);
});
test('actual durable settlement-close COMMIT ACK loss preserves both truths, marks indeterminate, and never calls close/provider again',async t=>{
 const f=await setup(t),close=f.db.closeReconciliationRun;let closes=0;
 f.db.closeReconciliationRun=async(...args)=>{closes++;return close(...args);};
 f.transport.arm({matchSql:/UPDATE whoop_reconciliation_runs/,loseAcknowledgement:true});
 await assert.rejects(f.run(),error=>error.code==='COMMIT_INDETERMINATE');assert.equal(f.context.indeterminate,true);assert.equal(closes,1);assert.equal(f.providers,1);
 const state=await f.state(),runs=await f.runs();assert.ok(state.windowWatermark);assert.ok(state.lastSuccessAt);assert.equal(state.owner,null);assert.equal(runs[0].result,'SUCCESS');assert.ok(runs[0].finishedAt);
 assert.equal(f.transport.evidence.filter(x=>x.event==='commit_durable').length,1);
 const receipts=(await f.db.raw.execute({sql:'SELECT result_json FROM phase4_execution_work_receipts WHERE execution_id=?',args:[f.context.claim.executionId]})).rows;assert.ok(receipts.some(x=>x.result_json==='true'));
});
for(const stop of ['cancel','deadline'])test(`actual submitted ordered metadata COMMIT ${stop} preserves reconcilable watermark and closed run without callback replay`,async t=>{
 const f=await setup(t,stop==='deadline'?1000:10000),close=f.db.closeReconciliationRun;let closes=0;
 f.db.closeReconciliationRun=async(...args)=>{closes++;return close(...args);};
 f.transport.arm({matchSql:/UPDATE whoop_reconciliation_runs/,before:async()=>{
  if(stop==='cancel')f.budget.cancel();else await new Promise(resolve=>setTimeout(resolve,f.budget.remainingMs()+5));
 }});
 await assert.rejects(f.run(),error=>error.code===(stop==='cancel'?'SYNC_CANCELLED':'SYNC_TIMEOUT'));
 const limit=Date.now()+2000;while(!f.transport.evidence.some(x=>x.event==='commit_durable')&&Date.now()<limit)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.transport.evidence.some(x=>x.event==='commit_durable'));const state=await f.state(),runs=await f.runs();
 assert.ok(state.windowWatermark);assert.ok(state.lastSuccessAt);assert.equal(runs[0].result,'SUCCESS');assert.ok(runs[0].finishedAt);assert.equal(closes,1);assert.equal(f.providers,1);assert.equal(f.context.indeterminate,true);
});
test('parent cancellation between ordered operations rolls back settlement and cannot close an unacknowledged success',async t=>{
 const f=await setup(t),close=f.db.closeReconciliationRun;
 f.db.closeReconciliationRun=async(...args)=>{f.budget.cancel();return close(...args);};
 await assert.rejects(f.run(),error=>error.code==='SYNC_CANCELLED');
 const state=await f.state(),runs=await f.runs();assert.equal(state.windowWatermark,null);assert.equal(state.lastSuccessAt,null);assert.equal(runs[0].result,null);assert.equal(runs[0].finishedAt,null);
});
for(const mode of ['expired','takeover'])test(`original resource ${mode} fences settlement while closing only its own diagnostic run as FENCED`,async t=>{
 const f=await setup(t);
 const result=await f.run({whoop:{apiGet:async()=>{
  assert.equal(f.db.processingTransactionActive(),false);
  await f.other.execute({sql:'UPDATE whoop_reconciliation_state SET owner=?,lease_expires_at=? WHERE user_id=? AND resource=?',args:[mode==='takeover'?'successor':'synthetic-owner',mode==='takeover'?new Date(Date.now()+60000).toISOString():'1970-01-01T00:00:00Z','alice','sleep']});
  return {records:[],next_token:null};
 }}});
 assert.equal(result.result,'FENCED');const state=await f.state(),runs=await f.runs();assert.equal(state.windowWatermark,null);assert.equal(state.lastSuccessAt,null);assert.equal(runs[0].result,'FENCED');assert.equal(runs[0].owner,'synthetic-owner');
 if(mode==='takeover')assert.equal(state.owner,'successor');
});
test('PARTIAL closes honestly, resumed final page retains original window and advances success only after its own close',async t=>{
 const f=await setup(t),seen=[];const whoop={apiGet:async(_path,q)=>{assert.equal(f.db.processingTransactionActive(),false);seen.push(q.nextToken??null);return {records:[],next_token:q.nextToken?null:'synthetic-next'};}};
 const partial=await f.run({whoop,ownerId:'first'});assert.equal(partial.result,'PARTIAL');const pending=await f.state();assert.equal(pending.continuationToken,'synthetic-next');assert.equal(pending.windowWatermark,null);
 const complete=await f.run({whoop,ownerId:'second'});assert.equal(complete.result,'SUCCESS');assert.equal(complete.window.resumed,true);assert.deepEqual(seen,[null,'synthetic-next']);
 const state=await f.state(),runs=await f.runs();assert.equal(state.windowWatermark,pending.continuationTo);assert.equal(state.continuationFrom,null);assert.deepEqual(runs.map(x=>x.result),['SUCCESS','PARTIAL']);
});
test('explicit, deep and point-in-time branches preserve original watermark rules and original diagnostic closure fields',async t=>{
 const f=await setup(t);await f.run({ownerId:'initial'});const original=await f.state();const time=new Date();
 const explicit=await f.run({ownerId:'explicit',options:{explicitWindow:{from:new Date(time.getTime()-7*86400000),to:new Date(time.getTime()-2*86400000)}}});assert.equal(explicit.result,'SUCCESS');assert.equal((await f.state()).windowWatermark,original.windowWatermark);assert.equal((await f.state()).lastSuccessAt,original.lastSuccessAt);
 const deep=await f.run({ownerId:'deep',options:{scope:'deep'}});assert.equal(deep.result,'SUCCESS');assert.equal((await f.state('sleep/deep')).windowWatermark,deep.window.from.toISOString());
 const point=await f.run({ownerId:'point',resource:'body_measurement',whoop:{bodyMeasurement:async()=>{assert.equal(f.db.processingTransactionActive(),false);return {height_meter:1.7,weight_kilogram:70};}}});assert.equal(point.result,'SUCCESS');assert.equal(point.pages,1);assert.equal(point.fetched,1);assert.equal(point.written,1);
 assert.equal((await f.state('body_measurement')).windowWatermark,point.window.to.toISOString());const modes=new Map((await f.runs()).map(x=>[x.mode,x.result]));assert.equal(modes.get('explicit_window'),'SUCCESS');assert.equal(modes.get('deep_slice'),'SUCCESS');assert.equal(modes.get('point_in_time'),'SUCCESS');
});
