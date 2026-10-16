import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {localDate} from '../src/time.js';
import {bodyCycleMatchesSleep} from '../src/bodyEnergyInputs.js';
import {OFFLINE_LIVE_USERS,OFFLINE_LIVE_RESOURCES,OFFLINE_LIVE_TABLES,offlineLiveFixtureShape,offlineLiveFixtureInput} from './stage8LiveLinuxFixture.js';

const asOf=Date.parse('2026-10-16T02:00:00.000Z');
const counts=input=>Object.fromEntries(OFFLINE_LIVE_RESOURCES.map(type=>[type,input.sources[type].length]));

test('dense is exactly one 40-by-four synthetic user and two empty users; empty keeps all three empty',()=>{
 assert.deepEqual(OFFLINE_LIVE_USERS,['a','b','c']);assert.ok(Object.isFrozen(OFFLINE_LIVE_USERS));
 for(const profile of ['dense','empty']){
  const shape=offlineLiveFixtureShape(profile),inputs=OFFLINE_LIVE_USERS.map(userId=>offlineLiveFixtureInput({profile,userId,asOf}));
  assert.equal(shape.syntheticUsers,3);assert.equal(shape.heavyUser,profile==='dense'?'a':null);
  assert.deepEqual(Object.fromEntries(inputs.map(input=>[input.userId,counts(input)])),shape.expectedRowsPerUser);
  for(const type of OFFLINE_LIVE_RESOURCES)assert.equal(inputs.reduce((n,input)=>n+input.sources[type].length,0),shape.expectedTotalRows[type]);
  assert.equal(shape.provenance.productionRecordsUsed,false);assert.equal(shape.provenance.productionHealthValuesUsed,false);
  assert.match(shape.provenance.limitation,/not three simultaneously dense users/);
 }
 // A report consumer cannot mutate future fixture profiles or another user.
 const changed=offlineLiveFixtureShape('dense');changed.expectedRowsPerUser.a.sleep=0;
 assert.equal(offlineLiveFixtureShape('dense').expectedRowsPerUser.a.sleep,40);
 assert.equal(offlineLiveFixtureShape('dense').expectedRowsPerUser.b.sleep,0);
});

test('every user has current own-generation access/sync metadata; populated events are valid and Recovery cycles are linked',()=>{
 for(const profile of ['dense','empty'])for(const userId of OFFLINE_LIVE_USERS){
  const input=offlineLiveFixtureInput({profile,userId,asOf}),at=new Date(asOf).toISOString();
  assert.equal(input.userId,userId);assert.equal(input.authGeneration,1);assert.equal(input.lifecycleGeneration,1);
  assert.deepEqual(input.access.map(row=>row.resource),OFFLINE_LIVE_RESOURCES);
  assert.ok(input.access.every(row=>row.user_id===userId&&row.status==='ACCESSIBLE'&&row.auth_generation===1&&row.lifecycle_generation===1));
  assert.ok(input.sync.every(row=>row.user_id===userId&&row.last_success_at===at&&row.updated_at===at));
  assert.ok(input.capabilities.every(row=>row.user_id===userId&&row.status==='SUPPORTED'&&row.lifecycle_generation===1));
  assert.deepEqual(input.tombstones,[]);
  for(const type of OFFLINE_LIVE_RESOURCES){
   const rows=input.sources[type],key=type==='recovery'?'sleep_id':'id';assert.equal(new Set(rows.map(row=>row[key])).size,rows.length);
   for(const row of rows){
    assert.equal(row.user_id,userId);assert.equal(row.score_state,'SCORED');assert.equal(row.synced_at,at);
    assert.ok(Number.isFinite(Date.parse(row.updated_at))&&Date.parse(row.updated_at)<=asOf);
    if(type!=='recovery'){
     assert.ok(Date.parse(row.start_at)<=asOf);
     assert.ok(row.end_at===null||Date.parse(row.start_at)<Date.parse(row.end_at)&&Date.parse(row.end_at)<=asOf);
    }
    if(type==='sleep'||type==='workout')assert.equal(row.health_date,localDate(new Date(row.end_at),input.timezone));
   }
  }
  if(userId==='a'&&profile==='dense'){
   assert.equal((Date.parse(input.sources.sleep[0].end_at)-Date.parse(input.sources.sleep.at(-1).end_at))/86400000,39);
   assert.equal(input.sources.cycle.filter(row=>row.end_at===null).length,1);
   for(let i=0;i<40;i++){
    const sleep=input.sources.sleep[i],recovery=input.sources.recovery[i],cycle=input.sources.cycle[i],workout=input.sources.workout[i];
    assert.equal(recovery.sleep_id,sleep.id);assert.equal(recovery.cycle_id,cycle.id);
    assert.ok(bodyCycleMatchesSleep(cycle,sleep,recovery,asOf));
    assert.ok(Date.parse(workout.end_at)<Date.parse(sleep.start_at));
    if(i>0)assert.equal(cycle.end_at,input.sources.cycle[i-1].start_at);
   }
  }
 }
});

test('actual schema v35 accepts the synthetic shape with exact user counts and current own-user source authority',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date(asOf+1000)});
 await f.db.createUser({id:'c',displayName:'Synthetic offline qualification',timezone:'Asia/Taipei',status:'ACTIVE'});await f.core.initializeTenant('c','SHADOW');
 for(const userId of OFFLINE_LIVE_USERS)await f.db.transaction(()=>seedBodyInput(f.db,offlineLiveFixtureInput({profile:'dense',userId,asOf})));
 const expected=offlineLiveFixtureShape('dense');
 for(const [type,table] of Object.entries(OFFLINE_LIVE_TABLES)){
  assert.equal(Number((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n),expected.expectedTotalRows[type]);
  for(const userId of OFFLINE_LIVE_USERS)assert.equal(Number((await f.db.raw.execute({sql:`SELECT count(*) n FROM ${table} WHERE user_id=?`,args:[userId]})).rows[0].n),expected.expectedRowsPerUser[userId][type]);
 }
 const context=await f.core.capture('a',{executionMode:'SHADOW'}),input=offlineLiveFixtureInput({profile:'dense',userId:'a',asOf});
 const descriptors=OFFLINE_LIVE_RESOURCES.map(type=>({type,id:input.sources[type][0][type==='recovery'?'sleep_id':'id']}));
 const roots=await f.core.readRoots(context,descriptors);
 assert.equal(roots.length,4);assert.ok(roots.every(root=>root.row.user_id==='a'&&f.core.isReference(root.ref)));
 const other=await f.core.capture('b',{executionMode:'SHADOW'});
 await assert.rejects(f.core.readRoots(other,descriptors),/PHASE4_SOURCE_NOT_FOUND/);
 for(const table of ['stage8_live_publications','stage8_live_job_completions','outbound_messages'])assert.equal(Number((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n),0);
});

test('unknown profiles/users and non-exact timestamps are rejected without runtime work',()=>{
 assert.throws(()=>offlineLiveFixtureShape('production'),/EXPLICIT_SYNTHETIC_PROFILE_REQUIRED/);
 assert.throws(()=>offlineLiveFixtureInput({profile:'dense',userId:'outside',asOf}),/SYNTHETIC_COHORT_REQUIRED/);
 for(const value of [null,NaN,asOf+0.5,Infinity])assert.throws(()=>offlineLiveFixtureInput({profile:'dense',userId:'a',asOf:value}),/EXACT_SYNTHETIC_AS_OF_REQUIRED/);
});

test('fixture-only integration preserves bounded campaigns, latency and genuine producer path',()=>{
 // Do not import the executable harness: its container/HTTP qualification is
 // separately opt-in. This static check prevents a fixture fix enlarging it.
 const harness=readFileSync(new URL('./stage8-live-linux-http.mjs',import.meta.url),'utf8'),shell=readFileSync(new URL('./stage8-live-linux-http.sh',import.meta.url),'utf8');
 assert.match(harness,/LATENCY_MS=115,LEG_SUPERVISION_MS=90000/);
 assert.match(harness,/liveExecutionDeadlineMs:45000,workerWallMs:45000,workerSafetyMarginMs:15000,workerEffectiveMs:30000,maxItemsPerTenant:6/);
 assert.match(harness,/const input=offlineLiveFixtureInput\(\{profile,userId,asOf\}\)/);
 assert.match(harness,/assert\.deepEqual\(report\.seededRowsPerUser,report\.input\.expectedRowsPerUser/);
 assert.match(harness,/producer\.run\(\{userId,requestId\}\)/);
 assert.match(shell,/timeout --signal=TERM --kill-after=5s 900s node/);
 assert.match(shell,/run_profile empty 16/);assert.match(shell,/dense_limit=\$\(\(64-empty_calls\)\)/);
 assert.match(shell,/GLOBAL_CALL_LIMIT_EXCEEDED/);
});
