import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {makeDataset} from './fixtures.js';
const now=new Date('2026-10-09T00:00:00Z');
async function fixture(t){
 const {db}=await deliveryFixture(t);
 for(const id of ['alice','bob'])await db.createUser({id,status:'ACTIVE',displayName:id});
 return {db,data:makeDataset({now,days:20,withNaps:false})};
}
test('HTTP canonical batches preserve tenant binding and atomic source invalidation',async t=>{
 const {db,data}=await fixture(t);
 for(const [method,table,rows] of [['upsertSleeps','whoop_sleeps',data.sleeps],['upsertRecoveries','whoop_recoveries',data.recoveries],['upsertCycles','whoop_cycles',data.cycles]]){
  assert.equal(await db[method]('alice',rows,{timezone:'Asia/Taipei',now}),rows.length);
  const actual=(await db.raw.execute(`SELECT user_id FROM ${table}`)).rows;
  assert.equal(actual.length,rows.length);assert.ok(actual.every(r=>r.user_id==='alice'));
 }
 assert.ok((await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation>0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='bob'")).rows[0].n,0);
});
test('a later SQL failure rolls back the entire ordered batch and source invalidation',async t=>{
 const {db,data}=await fixture(t),last=data.sleeps.at(-1).id;
 // Isolated fault trigger deliberately makes a real later batch statement fail.
 await db.raw.execute({sql:`CREATE TRIGGER synthetic_batch_failure BEFORE INSERT ON whoop_sleeps WHEN NEW.id='${last}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_BATCH_FAILURE'); END`});
 await assert.rejects(()=>db.upsertSleeps('alice',data.sleeps,{timezone:'Asia/Taipei',now}),/SYNTHETIC_BATCH_FAILURE/);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_sleeps')).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM analytics_invalidation WHERE user_id='alice'")).rows[0].n,0);
});
test('pending purge rejects the whole canonical batch before overwriting current source data',async t=>{
 const {db,data}=await fixture(t),first=data.sleeps[0];
 await db.upsertSleeps('alice',[first],{timezone:'Asia/Taipei',now});
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='alice'");
 const before=(await db.raw.execute('SELECT * FROM whoop_sleeps')).rows.map(r=>({...r}));
 await assert.rejects(()=>db.upsertSleeps('alice',data.sleeps,{timezone:'Asia/Taipei',now:new Date(now.getTime()+1000)}),/PHASE4_PURGE_FENCED/);
 assert.deepEqual((await db.raw.execute('SELECT * FROM whoop_sleeps')).rows.map(r=>({...r})),before);
});
test('older source versions in a batch preserve current rows and input generation',async t=>{
 const {db,data}=await fixture(t);
 await db.upsertSleeps('alice',data.sleeps,{timezone:'Asia/Taipei',now});
 const before=(await db.raw.execute('SELECT id,updated_at,raw_json FROM whoop_sleeps ORDER BY id')).rows.map(r=>({...r}));
 const generation=(await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation;
 const older=data.sleeps.map(r=>({...r,updated_at:'2020-01-01T00:00:00Z',score_state:'PENDING_SCORE'}));
 assert.equal(await db.upsertSleeps('alice',older,{timezone:'Asia/Taipei',now}),0);
 assert.deepEqual((await db.raw.execute('SELECT id,updated_at,raw_json FROM whoop_sleeps ORDER BY id')).rows.map(r=>({...r})),before);
 assert.equal((await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,generation);
});
test('missing privacy initialization is repaired before the callback; later purge state still rejects reads',async t=>{
 const {db}=await fixture(t);
 await db.getCapabilities('alice');
 await db.raw.execute("DELETE FROM phase4_computation_state WHERE user_id='alice'");
 assert.deepEqual(await db.getCapabilities('alice'),{});
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE user_id='alice' AND execution_mode='SHADOW'")).rows[0].n,1);
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='alice'");
 await assert.rejects(()=>db.getCapabilities('alice'),/PHASE4_PURGE_FENCED/);
});
