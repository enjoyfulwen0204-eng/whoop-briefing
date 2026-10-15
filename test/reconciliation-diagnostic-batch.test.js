import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,claim,fixtureKeys} from './v32ReviewFixture.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';import {withSyncOwnership} from '../src/syncOwnership.js';import {createReconciler} from '../src/reconcile.js';
async function setup(t,{rows=32,leaseMs=600000}={}){
 let latency=0;const f=await fixture(t,32,{traceTransactions:true,latency:()=>latency}),db=f.db;
 await db.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});await db.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'1001'});await db.getCapabilities('alice');
 const at=new Date(Date.now()-86400000).toISOString(),start=new Date(Date.now()-86400000-8*3600000).toISOString();
 await db.upsertSleeps('alice',Array.from({length:rows},(_,n)=>({id:'synthetic-missing-'+n,user_id:1001,start,end:at,created_at:at,updated_at:at,score_state:'SCORED',nap:false,score:{sleep_performance_percentage:50}})),{timezone:'Asia/Taipei'});
 const owner=await claim(db,request()),budget=createExecutionBudget({budgetMs:30000}),context={claim:owner,keys:fixtureKeys,pending:new Set(),authority:budget};t.after(()=>budget.close());
 const ordinary=()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,leaseMs,ownerId:'synthetic-ordinary-owner',whoop:{apiGet:async()=>({records:[],next_token:null})}}).reconcileResource('sleep');
 const run=()=>withExecutionBudget(budget,()=>withDurableExecution(context,()=>withSyncOwnership({db,userId:'alice',budget},()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId:'synthetic-diagnostic-owner',leaseMs,whoop:{apiGet:async()=>({records:[],next_token:null})}}).reconcileResource('sleep'))));
 return {...f,run,ordinary,context,setLatency:ms=>{latency=ms;},rows:()=>db.listDiscrepancies('alice'),receiptRows:()=>db.raw.execute({sql:"SELECT result_json FROM phase4_execution_work_receipts WHERE execution_id=? AND result_json=?",args:[owner.executionId,String(rows)]})};
}
test('actual32-row bounded absence diagnostic under115ms/5s',async t=>{
 const mode='bounded-batch';
 const f=await setup(t);
 f.transport.setTransactionMaxMs(5000);f.setLatency(115);const before={...f.transport.counts},at=performance.now();await f.run();f.setLatency(0);
 const rows=await f.rows(),tx=f.transport.transactions.filter(tx=>tx.statements.some(s=>s.table==='whoop_reconciliation_discrepancies')),receipts=await f.receiptRows();assert.equal(tx.length,1);
 const item={mode,latencyMs:115,transactionLimitMs:5000,totalMs:performance.now()-at,transactionMs:tx[0].finishedAt-tx[0].startedAt,httpOperations:tx[0].httpOperations,sqlOperations:tx[0].sqlOperations,outcome:tx[0].outcome,rows:rows.length,namedAbsenceReceipts:receipts.rows.length,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements};
 console.log('DIAGNOSTIC_CAPACITY '+JSON.stringify(item));
 assert.equal(rows.length,32);assert.equal(receipts.rows.length,1);assert.equal(item.outcome,'COMMITTED');assert.ok(item.transactionMs<4000);assert.equal(f.transport.evidence.some(e=>e.event==='transaction_timeout'),false);assert.ok(rows.every(r=>r.seenCount===1));
});
for(const attack of ['zero-row-owner','cross-tenant','stale-lifecycle'])test(`batch ${attack} rolls back valid earlier rows and appends no absence receipt`,async t=>{
 const f=await setup(t),bulk=f.db.recordDiscrepancies;
 f.db.recordDiscrepancies=entries=>bulk(entries.map((r,i)=>i!==1?r:attack==='zero-row-owner'?{...r,owner:'wrong-owner'}:attack==='cross-tenant'?{...r,userId:'bob'}:{...r,lifecycleGeneration:2}));
 await f.run();assert.equal((await f.rows()).length,0);assert.equal((await f.receiptRows()).rows.length,0);assert.equal((await f.db.listDiscrepancies('bob')).length,0);
 const tx=f.transport.transactions.find(tx=>tx.statements.some(s=>s.table==='whoop_reconciliation_discrepancies'));assert.equal(tx.outcome,'ROLLED_BACK');
});
test('lost diagnostic COMMIT ACK preserves32 durable rows and one original named receipt',async t=>{
 const f=await setup(t);f.transport.arm({matchSql:/INSERT INTO whoop_reconciliation_discrepancies/,loseAcknowledgement:true});
 await assert.rejects(f.run(),e=>e.code==='COMMIT_INDETERMINATE');assert.equal(f.context.indeterminate,true);assert.equal((await f.rows()).length,32);assert.equal((await f.receiptRows()).rows.length,1);assert.ok((await f.rows()).every(r=>r.seenCount===1));
});

test('original5s model rejects delayed diagnostic COMMIT and rolls back rows and receipt',async t=>{
 const f=await setup(t);f.transport.setTransactionMaxMs(5000);f.transport.arm({matchSql:/INSERT INTO whoop_reconciliation_discrepancies/,before:()=>new Promise(r=>setTimeout(r,5005))});
 await f.run().catch(e=>{assert.ok(['TRANSACTION_TIMEOUT','COMMIT_INDETERMINATE'].includes(e.code));});assert.ok(f.transport.evidence.some(e=>e.event==='transaction_timeout'));assert.equal((await f.rows()).length,0);assert.equal((await f.receiptRows()).rows.length,0);
});

test('33 rows preserve32+1 bounded chunks and exactly one absence receipt',async t=>{
 const f=await setup(t,{rows:33}),bulk=f.db.recordDiscrepancies,sizes=[];f.db.recordDiscrepancies=entries=>{sizes.push(entries.length);return bulk(entries);};
 assert.equal((await f.run()).result,'SUCCESS');assert.deepEqual(sizes,[32,1]);assert.equal((await f.rows()).length,33);assert.equal((await f.receiptRows()).rows.length,1);
});
test('second chunk zero-row rejection rolls back the acknowledged first chunk',async t=>{
 const f=await setup(t,{rows:33}),bulk=f.db.recordDiscrepancies;let chunk=0;f.db.recordDiscrepancies=entries=>bulk(++chunk===2?entries.map(e=>({...e,owner:'wrong-owner'})):entries);
 await f.run();assert.equal(chunk,2);assert.equal((await f.rows()).length,0);assert.equal((await f.receiptRows()).rows.length,0);
});
test('cancellation after batch ACK rolls back all diagnostic rows and receipt',async t=>{
 const f=await setup(t),bulk=f.db.recordDiscrepancies;f.db.recordDiscrepancies=async entries=>{const result=await bulk(entries);f.context.authority.cancel();return result;};
 await f.run().catch(e=>assert.equal(e.code,'SYNC_CANCELLED'));assert.equal((await f.rows()).length,0);assert.equal((await f.receiptRows()).rows.length,0);
});
test('lease expiry during diagnostic transport rejects the whole batch before receipt COMMIT',async t=>{
 const f=await setup(t,{rows:3,leaseMs:1200}),bulk=f.db.recordDiscrepancies;f.db.recordDiscrepancies=async entries=>{await new Promise(r=>setTimeout(r,1350));return bulk(entries);};
 assert.equal((await f.run()).result,'FENCED');assert.equal((await f.rows()).length,0);assert.equal((await f.receiptRows()).rows.length,0);
});

test('ordinary non-durable reconciliation preserves per-row dispatch and original clock sampling',async t=>{
 const f=await setup(t,{rows:3}),single=f.db.recordDiscrepancy;let calls=0;f.db.recordDiscrepancy=entry=>{calls++;return single(entry);};f.db.recordDiscrepancies=()=>{throw Error('ORDINARY_PATH_MUST_NOT_BATCH');};
 assert.equal((await f.ordinary()).result,'SUCCESS');assert.equal(calls,3);assert.equal((await f.rows()).length,3);assert.equal((await f.receiptRows()).rows.length,0);
});
