import test from 'node:test';
import assert from 'node:assert/strict';
import {processingTransactions,consumeReadOnlyRollback,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {prepareReadOnly,settledReadPreparation} from '../src/readOnlyPreparation.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {fixture} from './v32ReviewFixture.js';
import {reapExpiredProactiveQuestions} from '../src/proactiveReaper.js';
import {dueForUser} from '../src/index.js';

function receiver({rollbackFault=false,commitFault=null,delayRollback}={}){
 const events=[];
 const base={protocol:'file',execute:async()=>({rows:[]}),batch:async()=>[],transaction:async()=>({
  execute:async statement=>{events.push(typeof statement==='string'?statement:statement.sql);return {rows:[]};},
  batch:async()=>{events.push('BATCH');return [];},commit:async()=>{events.push('COMMIT');if(commitFault)throw commitFault;},
  rollback:async()=>{events.push('ROLLBACK');await delayRollback?.();if(rollbackFault)throw Error('ROLLBACK_UNKNOWN');},close(){events.push('CLOSE');},closed:false,
 })};
 const p=processingTransactions(base,{privateRuntime:true});return {p,events,db:{readOnlyTransaction:p.readOnlyTransaction}};
}
test('fixed readonly siblings settle completely and first original failure keeps priority before acknowledged rollback fallback',async()=>{
 const f=receiver(),first=Error('FIRST'),second=Error('SECOND');let done=false,fallback=0;
 const result=await prepareReadOnly(f.db,()=>settledReadPreparation([
  async()=>{throw first;},async()=>{await new Promise(r=>setTimeout(r,10));done=true;throw second;},
 ]),()=>{assert.equal(done,true);assert.ok(f.events.includes('ROLLBACK'));fallback++;return 17;});
 assert.equal(result,17);assert.equal(fallback,1);assert.equal(consumeReadOnlyRollback(first),false,'proof is consumed once');
});
test('forged status/boolean rollback claims and unacknowledged rollback cannot authorize fallback',async()=>{
 for(const f of [receiver({rollbackFault:true}),{db:{readOnlyTransaction:async()=>{throw Object.assign(Error('FORGED'),{definiteReadOnlyRollback:true});}},events:[]}]){
  let called=false;await assert.rejects(prepareReadOnly(f.db,()=>{throw Error('ORIGINAL');},()=>{called=true;}));assert.equal(called,false);
 }
});
for(const mutation of [p=>p.client.execute('INSERT INTO forbidden VALUES(1)'),p=>p.client.batch(['SAVEPOINT forbidden']),p=>p.outside('provider',()=>{throw Error('PROVIDER_RAN');})])test('readonly unit refuses mutation/provider work even if caught and never runs unprotected fallback',async()=>{
 const f=receiver();let fallback=false;
 await assert.rejects(prepareReadOnly(f.db,async()=>{try{await mutation(f.p);}catch{}return 1;},()=>{fallback=true;}),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(fallback,false);assert.deepEqual(f.events,['ROLLBACK','CLOSE']);
});
for(const code of ['SYNC_TIMEOUT','SYNC_CANCELLED','COMMIT_INDETERMINATE','ABORT_ERR'])test(`readonly failure ${code} never permits fallback`,async()=>{
 const f=receiver();let fallback=false;
 await assert.rejects(prepareReadOnly(f.db,()=>{throw Object.assign(Error(code),{code});},()=>{fallback=true;}),error=>error.code===code);assert.equal(fallback,false);
});
test('unknown submitted COMMIT cannot authorize fallback or callback replay',async()=>{
 const f=receiver({commitFault:Error('ACK_UNKNOWN')});let composed=0,fallback=0;
 await assert.rejects(prepareReadOnly(f.db,()=>{composed++;return 1;},()=>{fallback++;}),error=>error.code==='COMMIT_INDETERMINATE');
 assert.equal(composed,1);assert.equal(fallback,0);
});
test('parent abort during acknowledged rollback, changed budget identity, and reused errors fail closed',async()=>{
 const budget=createExecutionBudget({budgetMs:2000}),replacement=createExecutionBudget({budgetMs:2000}),error=Error('READ_FAILED');
 try{
  const f=receiver({delayRollback:()=>budget.cancel()});let fallback=false;
  await assert.rejects(withExecutionBudget(budget,()=>prepareReadOnly(f.db,()=>{throw error;},()=>{fallback=true;})));assert.equal(fallback,false);
  const g=receiver();await assert.rejects(g.p.readOnlyTransaction(()=>{throw error;}));
  assert.equal(withExecutionBudget(replacement,()=>consumeReadOnlyRollback(error)),false);
  g.db.readOnlyTransaction=async()=>{throw error;};
  await assert.rejects(withExecutionBudget(replacement,()=>prepareReadOnly(g.db,()=>{},()=>{fallback=true;})));assert.equal(fallback,false);
 }finally{budget.close();replacement.close();}
});
test('original live runtime fences still run on entry and COMMIT without readonly scope suppressing them',async()=>{
 const f=receiver();let checks=0;
 await f.p.withFence(readOnlyProcessingCheck(async client=>{checks++;if(client)await client.execute('SELECT live_owner');}),()=>f.p.readOnlyTransaction(()=>f.p.client.execute('SELECT fixed_data')));
 assert.ok(checks>=3);assert.equal(f.events.filter(e=>e==='SELECT live_owner').length,2);assert.ok(f.events.indexOf('SELECT fixed_data')>f.events.indexOf('SELECT live_owner'));
});
test('actual installed Hrana sibling reads share transport while original SQL results/fences remain unchanged',async t=>{
 const {db,transport}=await fixture(t);let fences=0;
 const check=readOnlyProcessingCheck(async client=>{fences++;if(client)assert.equal((await client.execute('SELECT 19 owner')).rows[0].owner,19);});
 const measure=async grouped=>{
  const before=transport.counts.httpRequests;
  const work=()=>settledReadPreparation([()=>db.raw.execute('SELECT 23 first'),()=>db.raw.execute('SELECT 29 second')]);
  const result=await db.withRuntimeFence(check,()=>grouped?db.readOnlyTransaction(work):db.transaction(async()=>[await db.raw.execute('SELECT 23 first'),await db.raw.execute('SELECT 29 second')],{readOnly:true}));
  assert.equal(result[0].rows[0].first,23);assert.equal(result[1].rows[0].second,29);return transport.counts.httpRequests-before;
 };
 const serial=await measure(false),grouped=await measure(true);assert.equal(serial-grouped,1);assert.ok(fences>=6);
});
test('actual shared SQL fault rolls back before fresh independent read, without a business receipt/effect',async t=>{
 const {db}=await fixture(t);let fallback=0,settled=false;
 const result=await prepareReadOnly(db,()=>settledReadPreparation([
  ()=>db.raw.execute('SELECT * FROM deliberately_absent_preparation_table'),async()=>{try{await db.raw.execute('SELECT 31 sibling');}finally{settled=true;}},
 ]),async()=>{assert.equal(settled,true);fallback++;return (await db.raw.execute('SELECT 37 fresh')).rows[0].fresh;});
 assert.equal(result,37);assert.equal(fallback,1);
 assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,0);
});
test('reaper empty-pass grouping cannot prefetch orphan rows across an original first-pass mutation',async()=>{
 const f=receiver(),events=[];
 const db={...f.db,listReapablePendingQuestions:async()=>{events.push('pending');return [{id:'q',status:'OPEN',unresolvedEventId:'e'}];},
  expirePendingQuestion:async()=>{events.push('expire');return true;},resolveProactiveEventIfUnresolved:async()=>{events.push('resolve');return true;},
  listUnresolvableProactiveEvents:async()=>{events.push('orphans');return [];}};
 const result=await reapExpiredProactiveQuestions({db,userId:'a',now:new Date()});assert.equal(result.expired,1);assert.equal(result.noResponse,1);
 assert.deepEqual(events,['pending','expire','resolve','orphans']);
});
test('definite failed first reaper list still executes original orphan pass, and empty success shares a single unit',async()=>{
 const f=receiver();let first=0,orphans=0;
 const db={...f.db,listReapablePendingQuestions:async()=>{first++;throw Error('FIRST_LIST');},listUnresolvableProactiveEvents:async()=>{orphans++;return [];}};
 await reapExpiredProactiveQuestions({db,userId:'a'});assert.equal(first,2);assert.equal(orphans,1);
 const g=receiver();const healthy={...g.db,listReapablePendingQuestions:async()=>[],listUnresolvableProactiveEvents:async()=>[]};
 await reapExpiredProactiveQuestions({db:healthy,userId:'a'});assert.equal(g.events.filter(e=>e==='COMMIT').length,1);
});
test('reaper keeps nonthrowing maintenance contract but never retries or writes after uncertain COMMIT or parent cancellation',async()=>{
 for(const code of ['COMMIT_INDETERMINATE','SYNC_CANCELLED']){
  let reads=0,writes=0;
  const db={readOnlyTransaction:async()=>{throw Object.assign(Error(code),{code});},
   listReapablePendingQuestions:async()=>{reads++;return [];},listUnresolvableProactiveEvents:async()=>{reads++;return [];},
   resolveProactiveEventIfUnresolved:async()=>{writes++;return true;}};
  const result=await reapExpiredProactiveQuestions({db,userId:'a'});assert.equal(reads,0);assert.equal(writes,0);assert.equal(result.noResponse,0);
 }
});
test('due daily/weekly readonly branches settle with original priority and preserve daily short circuit',async()=>{
 const calls=[];let weeklySettled=false;const first=Error('DAILY_FIRST');
 await assert.rejects(dueForUser({db:{isSent:async(_uid,family)=>{calls.push(family);if(family==='daily')throw first;await new Promise(r=>setTimeout(r,5));weeklySettled=true;throw Error('WEEKLY_SECOND');}},userId:'a',timezone:'UTC',now:new Date('2026-10-12T00:00:00Z')}),error=>error===first);
 assert.equal(weeklySettled,true);assert.deepEqual(calls,['daily','weekly']);
 let dailyCalls=0;const result=await dueForUser({db:{isSent:async(_uid,family)=>{if(family==='daily')dailyCalls++;return false;}},userId:'a',timezone:'UTC',now:new Date('2026-10-12T00:00:00Z')});
 assert.equal(dailyCalls,1);assert.equal(result.dailySettled,false);assert.equal(result.weeklyDue,true);
});
