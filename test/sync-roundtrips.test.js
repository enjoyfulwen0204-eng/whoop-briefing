import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthStore} from '../src/store.js';
import {recoveryFixture} from './round4Fixture.js';
import {TOMBSTONE_OBSERVATION_SQL} from '../src/whoopTombstoneObservation.js';
const now=new Date('2026-11-03T06:10:00Z');
test('blocked observations batch at 100, preserve duplicates, order and timestamps',async()=>{
 const calls=[],client={execute:async()=>({rows:[{resource_id:'gone'}]}),batch:async rows=>{calls.push(rows);return rows.map(()=>({rowsAffected:1}));}};
 let transactions=0;const store=createHealthStore(client,{transaction:async fn=>{transactions++;return fn();}});
 const n=await store.upsertSleeps('synthetic',Array.from({length:201},()=>({id:'gone'})),{timezone:'Asia/Taipei',now});
 assert.equal(n,0);assert.equal(transactions,1);assert.deepEqual(calls.map(c=>c.length),[100,100,1]);
 for(const row of calls.flat()){assert.equal(row.sql,TOMBSTONE_OBSERVATION_SQL);assert.deepEqual(row.args,[now.toISOString(),now.toISOString(),'synthetic','sleep','gone','ACTIVE']);}
});
test('real v33: tombstones remain blocking, tenant isolated, observation failure rolls back',async t=>{
 const {db}=await recoveryFixture(t);
 for(const id of ['a','b']){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});for(const resource of ['sleep','recovery','workout'])for(const key of ['one','two'])await db.raw.execute({sql:'INSERT INTO whoop_resource_tombstones(user_id,resource_type,resource_id,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',args:[id,resource,key,now.toISOString(),now.toISOString(),now.toISOString()]});}
 for(const [method,resource]of [['upsertSleeps','sleep'],['upsertRecoveries','recovery'],['upsertWorkouts','workout']]){
  assert.equal(await db[method]('a',[{id:'one',sleep_id:'one'},{id:'two',sleep_id:'two'},{id:'one',sleep_id:'one'}],{timezone:'Asia/Taipei',now}),0);
  const rows=(await db.raw.execute({sql:'SELECT user_id,resource_id,blocked_count FROM whoop_resource_tombstones WHERE resource_type=? ORDER BY user_id,resource_id',args:[resource]})).rows;
  assert.deepEqual(rows.map(r=>r.blocked_count),[2,1,0,0]);
 }
 // Inject a failure into the second observation: neither the first increment
 // nor a preceding allowed canonical row may survive the original transaction.
 await db.raw.execute("CREATE TRIGGER synthetic_observation_failure BEFORE UPDATE ON whoop_resource_tombstones WHEN NEW.resource_type='sleep' AND NEW.resource_id='two' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
 await assert.rejects(db.upsertSleeps('a',[{id:'fresh',end:now.toISOString(),updated_at:now.toISOString()},{id:'one'},{id:'two'}],{timezone:'Asia/Taipei',now}),/synthetic_failure/);
 assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM whoop_sleeps WHERE id='fresh'")).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT blocked_count n FROM whoop_resource_tombstones WHERE user_id='a' AND resource_type='sleep' AND resource_id='one'")).rows[0].n,2);
 await db.raw.execute('DROP TRIGGER synthetic_observation_failure');
});

test('compatibility fast path rejects wrong tenant/resource and oversized observation batches',async()=>{
 const {createLegacyHealthAdapter}=await import('../src/legacyHealthAdapter.js');
 const {fixtureKeys}=await import('./localDb.js');
 let submitted=0;const raw={execute:async()=>({rows:[]}),batch:async rows=>{submitted++;return rows.map(()=>({rowsAffected:1}));}};
 const adapter=createLegacyHealthAdapter({client:raw,processing:{transaction:async fn=>fn()},privacy:{available:async()=>true,capture:async()=>({purgeGeneration:0}),assert:async()=>{}},keys:fixtureKeys});
 const entry=adapter.wrap({upsertSleeps:async(uid,statements)=>adapter.client.batch(statements)});
 const good={sql:TOMBSTONE_OBSERVATION_SQL,args:[now.toISOString(),now.toISOString(),'a','sleep','one','ACTIVE']};
 for(const bad of [{...good,args:[...good.args.slice(0,2),'b',...good.args.slice(3)]},{...good,args:[...good.args.slice(0,3),'recovery',...good.args.slice(4)]}])await assert.rejects(entry.upsertSleeps('a',[bad]),/PHASE4_BATCH_TENANT_MISMATCH/);
 await assert.rejects(entry.upsertSleeps('a',Array(101).fill(good)),/PHASE4_CANONICAL_BATCH_LIMIT/);
 assert.equal(submitted,0);await entry.upsertSleeps('a',[good]);assert.equal(submitted,1);
});
