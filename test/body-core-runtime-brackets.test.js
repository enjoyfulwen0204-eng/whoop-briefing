import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys,request,claim,authority} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';

// Every business read/write below uses the admitted private facade and the
// installed HTTP/Hrana driver against one isolated synthetic v32 database.
async function setup(t) {
 const {db,transport}=await fixture(t);
 await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 const admission=await db.admitRuntime(),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});
 await stores.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:1})));
 // The private kernel is needed only to exercise its bounded comparator API;
 // its composition and authority are the same as the public Foundation.
 const core=await buildPhase4Core({keys:fixtureKeys,admission,
  authorizeMode:mode=>assert.equal(mode,'SHADOW'),
  processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
   withReadSnapshot:db.withProcessingReadSnapshot,assertFences:db.assertRuntimeFences,
   afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion}});
 return {db,transport,stores,core};
}
const sqlOf=statement=>typeof statement==='string'?statement:statement?.sql??'';
const computationRead=statement=>/^SELECT \* FROM phase4_computation_state WHERE/.test(sqlOf(statement));
const physicalSources=transport=>transport.counts.byFamily.CANONICAL??0;
const markerCount=async(db,key)=>(await db.raw.execute({sql:'SELECT count(*) n FROM telegram_state WHERE key=?',args:[key]})).rows[0].n;

test('fresh enclosing runtime guard brackets nested read-only metadata checks before any WHOOP business read',async t=>{
 const {db,transport,stores}=await setup(t),execute=db.raw.execute.bind(db.raw);
 let armed=false,revoked=false,metadataObserved=false,callbackEntered=false,deniedChecks=0;
 const guard=()=>{if(revoked){deniedChecks++;throw Error('SYNTHETIC_CONFIGURATION_REVOKED');}};
 db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(armed&&computationRead(statement)){metadataObserved=true;revoked=true;}
  return result;
 };
 await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{
  const before=physicalSources(transport);
  armed=true;
  // The enclosing marked check suppresses recursive execute interception.
  // Core's explicit brackets must therefore deny before root's health SQL.
  const nestedRead=readOnlyProcessingCheck(()=>stores.root(context,'sleep','sleep-00'));
  await assert.rejects(()=>db.withRuntimeFence(guard,()=>db.transaction(()=>{callbackEntered=true;},{before:nestedRead})),/SYNTHETIC_CONFIGURATION_REVOKED/);
  armed=false;revoked=false;
  assert.equal(metadataObserved,true);assert.ok(deniedChecks>0);
  assert.equal(callbackEntered,false);
  assert.equal(physicalSources(transport),before,'no private source SQL may follow the revoked metadata observation');
 });
 db.raw.execute=execute;
 await db.transaction(()=>db.raw.execute('SELECT 17 value'));
});

test('late runtime revocation during the final Core metadata check rolls back an already submitted write before COMMIT',async t=>{
 const {db,core}=await setup(t),execute=db.raw.execute.bind(db.raw),context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true});
 let armed=false,revoked=false,writeSubmitted=false,lateMetadataObserved=false;
 const guard=()=>{if(revoked)throw Error('SYNTHETIC_PILOT_REVOKED_BEFORE_COMMIT');};
 db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(armed&&computationRead(statement)){lateMetadataObserved=true;revoked=true;}
  return result;
 };
 try {
  await assert.rejects(()=>db.withRuntimeFence(guard,()=>core.run(context,async()=>{
   const result=await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('late_core_guard','synthetic','2026-10-11')");
   writeSubmitted=result.rowsAffected===1;armed=true;
  },{workStep:'synthetic.local.late-core-guard'})),/SYNTHETIC_PILOT_REVOKED_BEFORE_COMMIT/);
  armed=false;revoked=false;
  assert.equal(writeSubmitted,true);assert.equal(lateMetadataObserved,true);
  assert.equal(await markerCount(db,'late_core_guard'),0,'the same producing transaction must roll back');
  await db.transaction(()=>db.raw.execute('SELECT 23 value'));
 } finally {armed=false;revoked=false;db.raw.execute=execute;await core.contextRegistry.release(context);}
});

test('a synchronous bounded-root comparator throw waits for the submitted sibling before transaction rollback',async t=>{
 const {db,transport,core}=await setup(t),context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true});
 let siblingSettled=false,firstCompared=false;
 const before=physicalSources(transport);
 try {
  await assert.rejects(()=>core.run(context,async()=>{
   await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('root_comparator_rollback','synthetic','2026-10-11')");
   await core.readRoots(context,[{type:'sleep',id:'sleep-00'},{type:'sleep',id:'sleep-01'}],{
    verify:source=>{
     if(source.id==='sleep-00'){firstCompared=true;throw Error('SYNCHRONOUS_SOURCE_COMPARATOR_REJECTED');}
     return new Promise(resolve=>setTimeout(resolve,40)).finally(()=>{siblingSettled=true;});
    },
   });
  },{workStep:'synthetic.local.root-comparator-rollback'}),/SYNCHRONOUS_SOURCE_COMPARATOR_REJECTED/);
  assert.equal(firstCompared,true);assert.equal(siblingSettled,true,'rejection/rollback cannot leave a submitted sibling validator running');
  assert.ok(physicalSources(transport)>=before+2,'both roots passed through the actual installed transport');
  assert.equal(await markerCount(db,'root_comparator_rollback'),0);
  await db.transaction(()=>db.raw.execute('SELECT 31 value'));
 } finally {await core.contextRegistry.release(context);}
});

test('same-transaction generation, purge, auth and lifecycle mutations remain visible after a verified source memo hit',async t=>{
 const {db,transport,stores}=await setup(t);
 const changes=[
  ["UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'",'PHASE4_INPUT_FENCED'],
  ["UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'",'PHASE4_INPUT_FENCED'],
  ["UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",'PHASE4_PURGE_FENCED'],
  ["UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",'PHASE4_AUTH_FENCED'],
  ["UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",'PHASE4_LIFECYCLE_FENCED'],
 ];
 for(const [sql,code] of changes)await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{
  let warmedSources;
  await assert.rejects(()=>db.transaction(async()=>{
   const first=await stores.root(context,'sleep','sleep-00');
   warmedSources=physicalSources(transport);
   const repeated=await stores.root(context,'sleep','sleep-00');
   assert.deepEqual(repeated.row,first.row);
   assert.equal(physicalSources(transport),warmedSources,'the repeated deterministic source actually hit the memo');
   await db.raw.execute(sql);
   return stores.root(context,'sleep','sleep-00');
  }),error=>error.code===code);
  assert.equal(physicalSources(transport),warmedSources,'changed authority must reject before another source payload query');
 });
 // Every failed mutation rolled back; a fresh context still has all original
 // authority generations and can read the synthetic source.
 await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{
  assert.equal(context.inputGeneration,0);assert.equal(context.sourceGeneration,0);
  assert.equal(context.purgeGeneration,0);assert.equal(context.authGeneration,1);assert.equal(context.lifecycleGeneration,1);
  assert.equal((await stores.root(context,'sleep','sleep-00')).row.sleep_performance_percentage,50);
 });
});

test('nested unmarked before retains intended named durable writes while marked before denies the same write',async t=>{
 const {db}=await setup(t),r=request(),owner=await claim(db,r);
 const execute=fn=>withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority},fn);
 let unmarkedBeforeRan=false,unmarkedCallbackRan=false,markedCallbackRan=false;
 const insert=key=>({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[key,'synthetic','2026-10-11']});
 await execute(()=>db.transaction(()=>db.transaction(()=>{unmarkedCallbackRan=true;},{before:async client=>{
  await client.execute(insert('unmarked_nested_before'));unmarkedBeforeRan=true;
 }}),{workStep:'synthetic.local.unmarked-nested-before',discardResult:true}));
 assert.equal(unmarkedBeforeRan,true);assert.equal(unmarkedCallbackRan,true);
 assert.equal(await markerCount(db,'unmarked_nested_before'),1);
 const receiptCount=async()=>(await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n;
 assert.equal(await receiptCount(),1,'the intended write belongs to the admitted owner\'s named work receipt');
 const before=readOnlyProcessingCheck(client=>client.execute(insert('marked_nested_before')));
 await assert.rejects(()=>execute(()=>db.transaction(()=>db.transaction(()=>{markedCallbackRan=true;},{before}),
  {workStep:'synthetic.local.marked-nested-before',discardResult:true})),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(markedCallbackRan,false);assert.equal(await markerCount(db,'marked_nested_before'),0);
 assert.equal(await receiptCount(),1,'the denied write cannot create a second durable work receipt');
});

test('reversed context/job metadata completion preserves context-first failure and settles before any health callback',async t=>{
 const {db,transport,core}=await setup(t),context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true}),execute=db.raw.execute.bind(db.raw);
 let armed=false,contextSettled=false,jobSettled=false,callback=false;
 db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(armed&&sqlOf(statement).includes('COALESCE(t.auth_generation')){
   result.rows[0].lifecycle_generation++;await new Promise(resolve=>setTimeout(resolve,40));contextSettled=true;
  }return result;
 };
 const before=physicalSources(transport);
 try {
  armed=true;
  await assert.rejects(()=>core.withJobFence(Object.freeze({purpose:'SYNTHETIC_NON_HEALTH_PRIORITY'}),async()=>{
   await db.raw.execute('SELECT 1 metadata_only');jobSettled=true;throw Error('SYNTHETIC_JOB_FAILED_FIRST');
  },()=>core.run(context,()=>{callback=true;return core.root(context,'sleep','sleep-00');})),error=>error.code==='PHASE4_LIFECYCLE_FENCED');
  armed=false;assert.equal(contextSettled,true);assert.equal(jobSettled,true);assert.equal(callback,false);
  assert.equal(physicalSources(transport),before);
 } finally {armed=false;db.raw.execute=execute;await core.contextRegistry.release(context);}
});

test('canonical source failure remains first and all submitted resource observations settle before rollback',async t=>{
 const {db,core}=await setup(t),context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true}),execute=db.raw.execute.bind(db.raw);
 let accessSettled=false,capabilitySettled=false,tombstoneSettled=false;
 db.raw.execute=statement=>{
  const sql=sqlOf(statement);
  if(/^SELECT \* FROM whoop_sleeps WHERE/.test(sql))throw Error('FIRST_CANONICAL_SOURCE_FAILURE');
  return execute(statement).then(async result=>{
   if(/^SELECT status FROM whoop_resource_access/.test(sql)){await new Promise(resolve=>setTimeout(resolve,40));accessSettled=true;throw Error('SECOND_ACCESS_FAILURE');}
   if(/^SELECT 1 FROM whoop_capabilities/.test(sql))capabilitySettled=true;
   if(/^SELECT 1 FROM whoop_resource_tombstones/.test(sql))tombstoneSettled=true;
   return result;
  });
 };
 try{
  await assert.rejects(()=>core.run(context,async()=>{
   await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('source_observations_rollback','synthetic','2026-10-11')");
   return core.root(context,'sleep','sleep-00');
  },{workStep:'synthetic.local.source-observations'}),/FIRST_CANONICAL_SOURCE_FAILURE/);
  assert.equal(accessSettled,true);assert.equal(capabilitySettled,true);assert.equal(tombstoneSettled,true);
  assert.equal(await markerCount(db,'source_observations_rollback'),0);
 }finally{db.raw.execute=execute;await core.contextRegistry.release(context);}
});

test('revocation during a concurrent resource observation denies source return and COMMIT with fresh final runtime authority',async t=>{
 const {db,core}=await setup(t),context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true}),execute=db.raw.execute.bind(db.raw);
 let revoked=false,returned=false,armed=false;
 db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(armed&&/^SELECT status FROM whoop_resource_access/.test(sqlOf(statement)))revoked=true;
  return result;
 };
 const guard=()=>{if(revoked)throw Error('RESOURCE_OBSERVATION_PILOT_REVOKED');};
 try{
  await assert.rejects(()=>db.withRuntimeFence(guard,()=>core.run(context,async()=>{
   await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('source_observation_revoked','synthetic','2026-10-11')");
   armed=true;await core.root(context,'sleep','sleep-00');returned=true;
  },{workStep:'synthetic.local.source-observation-revoked'})),/RESOURCE_OBSERVATION_PILOT_REVOKED/);
  armed=false;revoked=false;assert.equal(returned,false);
  assert.equal(await markerCount(db,'source_observation_revoked'),0);
 }finally{armed=false;revoked=false;db.raw.execute=execute;await core.contextRegistry.release(context);}
});
