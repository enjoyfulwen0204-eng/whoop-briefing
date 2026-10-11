import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';

export async function representativeBodyWork(t,{snapshot=true,asOfEpochMs=Date.now()}={}){
 const {db,transport}=await fixture(t);
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const stores=await createPhase4Foundation({db:snapshot?db:{...db,withProcessingReadSnapshot:undefined},keys:fixtureKeys,admission:await db.admitRuntime()});
 await stores.initializeTenant('a','SHADOW');
 const input=bodyInput({asOf:asOfEpochMs-1000});await db.transaction(()=>seedBodyInput(db,input));
 const sync=request(),sc=await claim(db,sync);
 await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const complete=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority);
 const drain=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:complete.handoff}),dc=await claim(db,drain);
 const before=structuredClone(transport.counts),start=performance.now();
 const result=await withDurableExecution({claim:dc,keys:fixtureKeys,pending:new Set(),authority},()=>stores.withContext('a',
  {executionMode:'SHADOW',providerRequired:true},context=>stores.bodyEnergy.compute(context,{asOfEpochMs})));
 const measured={httpRequests:transport.counts.httpRequests-before.httpRequests,sqlStatements:transport.counts.sqlStatements-before.sqlStatements,
  byFamily:Object.fromEntries(Object.entries(transport.counts.byFamily).map(([k,v])=>[k,v-(before.byFamily[k]??0)])),durationMs:performance.now()-start};
 assert.equal(result.row.quality_state,'AVAILABLE');assert.equal(result.row.value,70);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',[drain.requestId])).rows[0].n,1);
 return {measured,projection:{value:result.row.value,quality:result.row.quality_state,confidence:result.row.confidence,
  reasons:result.calculation.reasons,drivers:result.calculation.drivers},db,stores,transport};
}

test('representative real v32 durable Body work counts actual installed-driver SQL and mocked Hrana requests',async t=>{
 const asOfEpochMs=Date.now();
 const baseline=await representativeBodyWork(t,{snapshot:false,asOfEpochMs}),reused=await representativeBodyWork(t,{asOfEpochMs});
 assert.deepEqual(reused.projection,baseline.projection);
 assert.equal(reused.measured.byFamily.EXECUTION_OWNER,baseline.measured.byFamily.EXECUTION_OWNER);
 assert.ok(reused.measured.httpRequests<baseline.measured.httpRequests*0.4);
 assert.ok(reused.measured.sqlStatements<baseline.measured.sqlStatements*0.4);
 console.log('ISOLATED_BODY_WORK_DRIVER_COUNTS '+JSON.stringify({baseline:baseline.measured,reused:reused.measured,
  declaration:'ACTUAL_SQL_AND_MOCKED_HRANA_SAME_WORK_UNIT_NOT_PROVIDER_COST_OR_CAPACITY'}));
});

test('real schema/context checks still observe same-transaction source, access, purge, auth, lifecycle and generation writes then rollback',async t=>{
 const {db}=await fixture(t);await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});await stores.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:1})));
 const changes=[
  ["UPDATE whoop_resource_access SET status='UNAVAILABLE' WHERE user_id='a' AND resource='sleep'",'PHASE4_RESOURCE_FENCED'],
  ["UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",'PHASE4_AUTH_FENCED'],
  ["UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",'PHASE4_PURGE_FENCED'],
  ["UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",'PHASE4_LIFECYCLE_FENCED'],
  ["UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'",'PHASE4_INPUT_FENCED'],
  ["UPDATE resource_locks SET expires_at='1970-01-01T00:00:00.000Z' WHERE name LIKE 'p4ctx:%'",'PHASE4_CONTEXT_REVOKED'],
 ];
 for(const [sql,code] of changes)await assert.rejects(stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>db.transaction(async()=>{
  await stores.root(context,'sleep','sleep-00');await stores.root(context,'sleep','sleep-00');await db.raw.execute(sql);
  return stores.root(context,'sleep','sleep-00');
 })),error=>error.code===code);
 await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>db.transaction(async()=>{
  const original=await stores.root(context,'sleep','sleep-00');assert.equal(original.row.sleep_performance_percentage,50);
  await db.raw.execute("UPDATE whoop_sleeps SET sleep_performance_percentage=51 WHERE user_id='a' AND id='sleep-00'");
  assert.equal((await stores.root(context,'sleep','sleep-00')).row.sleep_performance_percentage,51);
 }));
 await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>assert.equal((await stores.root(context,'sleep','sleep-00')).row.sleep_performance_percentage,51));
 let clock=Date.now();const timed=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime(),now:()=>new Date(clock)});
 await assert.rejects(timed.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>db.transaction(async()=>{
  await timed.root(context,'sleep','sleep-00');clock+=16*60*1000;return timed.root(context,'sleep','sleep-00');
 })),error=>error.code==='PHASE4_CONTEXT_EXPIRED');
});
