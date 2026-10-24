// Genuine isolated canonical schema/owned HTTP receiver; explicit fake execution
// authority and synthetic WHOOP row. DATA-lifetime test, no business result proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './v32ReviewFixture.js';
import {processingRawSourceStatement} from '../src/processingTransaction.js';
import {withDurableExecution,withExecutionReceiptTransaction} from '../src/phase4ExecutionContext.js';
import {withExecutionBudget} from '../src/executionBudget.js';
const UID='SYNTHETIC-RAW-LIFETIME',ID='SYNTHETIC-CYCLE';
const SQL='SELECT * FROM whoop_cycles WHERE user_id=? AND id=?';
test('owned original receiver preserves every fresh fence and bounds DATA to exact context, marker, writes and lifetime',async t=>{
 const {db,transport}=await fixture(t,35);await db.admitRuntime();
 await db.raw.execute({sql:'INSERT INTO whoop_cycles(user_id,id,synced_at,raw_json) VALUES(?,?,?,?)',args:[UID,ID,new Date().toISOString(),'SYNTHETIC-FIRST']});
 const context=Object.freeze({userId:UID,executionMode:'LIVE'});let authorityChecks=0,fences=0,mutateBeforeFence=null;
 const execution={receipts:false,pending:new Set(),claim:{request:{phase:'STAGE6_DRAIN',executionMode:'LIVE'}},authority:{assert(){authorityChecks++;}}};
 const clock=()=>{const ac=new AbortController();return {ac,signal:ac.signal,remainingMs:()=>60000,deadlineAt:Date.now()+60000,assert(){if(ac.signal.aborted)throw Error('SYNTHETIC_ABORT');}};};
 const query=()=>({sql:SQL,args:[UID,ID]});
 const read=(c=context,mark=true)=>{const q=query();return db.raw.execute(mark?processingRawSourceStatement(db.raw,c,q):q);};
 const canonical=()=>transport.counts.byFamily.CANONICAL??0;
 const root=(fn,{c=context,budget=clock()}={})=>withExecutionBudget(budget,()=>withDurableExecution(execution,()=>db.withProcessingReadSnapshot(c,()=>db.withRuntimeFence(async()=>{
   fences++;const mutate=mutateBeforeFence;mutateBeforeFence=null;mutate?.();await db.raw.execute({sql:'SELECT count(*) n FROM users WHERE id=?',args:[UID]});
  },()=>db.transaction(fn)))));
 await root(async()=>{
  const start=canonical(),beforeFence=fences;
  const first=await read();assert.equal(first.rows[0].raw_json,'SYNTHETIC-FIRST');
  first.rows[0].raw_json='CALLER-ONLY';
  await db.raw.execute({sql:'UPDATE resource_locks SET expires_at=expires_at WHERE name=?',args:['SYNTHETIC-NO-LOCK']});
  const hit=await read();assert.equal(hit.rows[0].raw_json,'SYNTHETIC-FIRST');
  assert.equal(canonical()-start,1,'known non-source mutation retains only row DATA');
  assert.deepEqual(Object.keys(hit),['rows'],'no lastInsertRowid/driver metadata survives');
  assert.ok(fences-beforeFence>=3,'both reads and mutation traverse original fences');
  const other=Object.freeze({...context});await db.withProcessingReadSnapshot(other,()=>read(other));
  assert.equal(canonical()-start,2,'same user with another context has separate DATA');
  await withExecutionReceiptTransaction(()=>read());
  assert.equal(canonical()-start,3,'new receipt marker cannot use the raw DATA mark');
 });
 await root(async()=>{
  const start=canonical();await read();
  const safe={sql:'UPDATE resource_locks SET expires_at=expires_at WHERE name=?',args:['SYNTHETIC-NO-LOCK']};
  mutateBeforeFence=()=>{safe.sql='UPDATE whoop_cycles SET raw_json=? WHERE user_id=? AND id=?';safe.args=['SYNTHETIC-UNSUBMITTED',UID,ID];};
  await db.raw.execute(safe);
  assert.equal((await read()).rows[0].raw_json,'SYNTHETIC-FIRST','post-entry caller mutation is not the submitted SQL');
  const batch=[{sql:'UPDATE resource_locks SET expires_at=expires_at WHERE name=?',args:['SYNTHETIC-NO-LOCK']}];
  mutateBeforeFence=()=>batch.push({sql:'UPDATE whoop_cycles SET raw_json=? WHERE user_id=? AND id=?',args:['SYNTHETIC-UNSUBMITTED',UID,ID]});
  await db.raw.batch(batch);
  assert.equal((await read()).rows[0].raw_json,'SYNTHETIC-FIRST','post-entry batch append is not submitted');
  assert.equal(canonical()-start,1,'only the original raw read dispatches, no source mutation dispatched');
 });
 await root(async()=>{
  const start=canonical();await read();
  await db.raw.execute({sql:"SELECT printf('%s',?) value",args:['SYNTHETIC-UNKNOWN-FUNCTION']});
  await read();assert.equal(canonical()-start,2,'unknown successful SQL closes DATA');
  await db.raw.execute({sql:'UPDATE resource_locks SET expires_at=expires_at WHERE name=?',args:['SYNTHETIC-NO-LOCK']});
  await read();assert.equal(canonical()-start,3,'known later write cannot reopen DATA');
 });
 await root(async()=>{
  const start=canonical();await read();
  await db.raw.execute({sql:'UPDATE whoop_cycles SET raw_json=? WHERE user_id=? AND id=?',args:['SYNTHETIC-SECOND',UID,ID]});
  assert.equal((await read()).rows[0].raw_json,'SYNTHETIC-SECOND');
  assert.equal(canonical()-start,3,'source UPDATE plus fresh SELECT are dispatched');
 });
 await assert.rejects(root(async()=>{
  await read();
  const error=await db.raw.execute('SELECT * FROM raw_lifetime_missing_table').then(()=>null,e=>e);
  assert.ok(error);await assert.rejects(read(),e=>e===error);
  throw error;
 }),/raw_lifetime_missing_table/);
 const aborted=clock();await assert.rejects(root(async()=>{
  await read();aborted.ac.abort();await read();
 },{budget:aborted}),/SYNTHETIC_ABORT/);
 await root(async()=>{
  const start=canonical();assert.equal((await read()).rows[0].raw_json,'SYNTHETIC-SECOND');
  assert.equal(canonical()-start,1,'new original root starts with no prior DATA');
 });
 assert.ok(authorityChecks>0);
});
