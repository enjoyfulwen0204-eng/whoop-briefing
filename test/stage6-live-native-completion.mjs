// One fresh representative synthetic producer, from untouched jobs to true EOF.
// This is not a Production permit, six-job proof, or OS crash/restart proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/phase4EntityStore.js';
import {createDb,createStage6OwnedMemoryDb} from '../src/db.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {fixtureKeys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {nativeShadowFixture} from './stage6ShadowNativeFixture.mjs';
import {NATIVE_LIMITS} from './stage6-linux-native-contract.mjs';
import {nativeTraceSummary,assertNativeLegObservations} from './stage6ShadowNativeTrace.mjs';
const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const prefixProfile=process.env.STAGE6_NATIVE_PREFIX_PROFILE==='1';
const coldProfile=process.env.STAGE6_NATIVE_COLD_PROFILE==='1',profile=prefixProfile||coldProfile;
assert.ok(!(prefixProfile&&coldProfile),'DIAGNOSTIC_SCOPES_MUST_NOT_MIX');
test(profile?(coldProfile?'one fresh native cold producer call: diagnostic only':'one genuine owned-prefix native producer call: diagnostic only'):'fresh native LIVE producer completes original representative jobs through EOF', {timeout:profile?180000:NATIVE_LIMITS.wallMs},async t=>{
 assert.equal(process.env.STAGE6_SHADOW_NATIVE_SQLD,'1','EXPLICIT_ISOLATED_NATIVE_INTENT_REQUIRED');
 const seed=await createStage6OwnedMemoryDb(async()=>{},fixtureKeys);
 let native,db; t.after(async()=>{native?.setPhase('CLEANUP','CLEANUP');try{await db?.close();}finally{try{await native?.close();}finally{seed.close();}}});
 await seed.migrate({targetVersion:35});
 await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const stores=await createPhase4Foundation({db:seed,keys:fixtureKeys});await stores.initializeTenant('a','SHADOW');
 await seed.transaction(()=>seedBodyInput(seed,bodyInput({asOf:Date.now()-1000,days:0})));
 await seed.ensureOnboarding('a',{state:'READY'});await seed.linkTelegram({userId:'a',chatId:'10001'});await seed.setLocale('a','en');
 assert.equal((await seed.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE'")).rows[0].n,0);
 if(prefixProfile){
  assert.ok(globalThis.__stage6RawReplayProfile,'EXPLICIT_DIAGNOSTIC_PRELOAD_REQUIRED');
  // One genuine server-factory leg on an owned synthetic receiver; never
  // install a cursor, result, receipt, worker override or extended deadline.
  const prefix=await createStage8LiveProducer({db:seed,keys:fixtureKeys,admission:await seed.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
  const value=await prefix.run({userId:'a',requestId:'representative-owned-prefix-one'});
  assert.ok(value.result.itemsProcessed||value.result.unitsCommitted||value.result.jobsCompleted);
  assert.notEqual(value.publication.status,'CURRENT','PROFILE_REQUIRES_UNFINISHED_GENUINE_PREFIX');
  console.log('SYNTHETIC_OWNED_PREFIX '+JSON.stringify({oneOriginalFactoryLeg:true,result:value.result,productionEvidence:false,wholeRuntimeQualified:false}));
 }
 native=await nativeShadowFixture({synthetic:true,db:seed});
 let latency=true;
 const fetch=request=>{
  const work=async()=>{if(latency)await new Promise(resolve=>setTimeout(resolve,NATIVE_LIMITS.addedHttpLatencyMs));return native.fetch(request);};
  return profile?globalThis.__stage6RawReplayProfile.fetch(work):work();
 };
 const open=()=>createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});db=open();
 const producer=async()=>createStage8LiveProducer({db,keys:fixtureKeys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const jobs=async()=>(await db.raw.execute("SELECT job_kind,state,scope_kind,requested_generation,completed_generation,attempt,full_scan_cursor FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
 const canonical=async()=>{
  const names=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'stage8_live_%' OR name IN ('phase4_jobs','phase4_computation_state')) ORDER BY name")).rows.map(r=>r.name),facts=[];
  for(const name of names){assert.match(name,/^[a-z0-9_]+$/);const rows=(await db.raw.execute('SELECT * FROM '+name)).rows;assert.ok(rows.length<=4096);facts.push([name,rows.map(r=>JSON.stringify(r)).sort()]);}
  return digest(facts);
 };
 native.setPhase('ADMISSION_AND_COMPOSITION','BUILD_LIVE_PRODUCER');
 const start=performance.now(),p=await producer(),progress=[];let firstGenerations,last,original;
 if(profile){assert.ok(globalThis.__stage6RawReplayProfile,'EXPLICIT_DIAGNOSTIC_PRELOAD_REQUIRED');globalThis.__stage6RawReplayProfile.start();}
 for(let leg=0;leg<(profile?1:NATIVE_LIMITS.maximumCalls-1);leg++){
  assert.ok(performance.now()-start<NATIVE_LIMITS.wallMs);
  const at=performance.now(),requestId='representative-native-live-'+leg;
  // The observer's closed call-ordinal contract is 0/1. Every original leg is
  // separately numbered below; this label attributes the work category only.
  native.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',1);
  last=await p.run({userId:'a',requestId});native.setPhase('READBACK','READBACK');
  assert.equal(last.result.jobsFailed,0);assert.notEqual(last.result.outcome,'FAILED');
  const current=await jobs();assert.equal(current.length,2);firstGenerations??=current.map(j=>j.requested_generation);
  current.forEach((j,i)=>{assert.equal(j.requested_generation,firstGenerations[i]);assert.equal(j.attempt,0);});
  progress.push({leg,elapsedMs:performance.now()-at,result:last.result,publication:last.publication.status,jobs:current});
  console.log('SYNTHETIC_NATIVE_LIVE_LEG '+JSON.stringify(progress.at(-1)));
  const {transactionSamples,...observation}=nativeTraceSummary(native.snapshot());
  console.log('SYNTHETIC_NATIVE_LIVE_LEG_TRACE '+JSON.stringify({leg,...observation,transactionExamples:transactionSamples.filter(t=>t.durationUpperBoundMs>=5000).slice(0,8),provisional:true}));
  if(profile){console.log('SYNTHETIC_NATIVE_RAW_REPLAY_PROFILE '+JSON.stringify(globalThis.__stage6RawReplayProfile.snapshot()));return;}
  assertNativeLegObservations(native.snapshot());
  assert.ok(last.result.itemsProcessed||last.result.unitsCommitted||last.result.jobsCompleted,
   'NO_DURABLE_NATIVE_PROGRESS_STOP_NO_RETRY');
  original??={requestId,resultDigest:digest(last.result)};
  if(last.publication.status==='CURRENT')break;
 }
 assert.equal(last.publication.status,'CURRENT','FULL_NATIVE_REPRESENTATIVE_EOF_NOT_QUALIFIED');
 const completed=await jobs();assert.ok(completed.every(j=>j.state==='COMPLETED'&&j.scope_kind==='NONE'&&j.full_scan_cursor===null&&j.completed_generation===j.requested_generation));
 const executions=(await db.raw.execute('SELECT * FROM stage8_live_executions')).rows;
 assert.ok(executions.length>0);for(const row of executions){assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);verifyLiveExecutionResult(fixtureKeys,row);}
 assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n,0);
 const before=await canonical();await db.close();db=open();const replay=await (await producer()).run({userId:'a',requestId:original.requestId});
 assert.equal(replay.replayed,true);assert.equal(replay.publication.status,'CURRENT');assert.equal(digest(replay.result),original.resultDigest);assert.equal(await canonical(),before);
 const admission=await db.admitRuntime(),reader=createStage8DerivedReader({db,keys:fixtureKeys,admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({db,keys:fixtureKeys,admission,derivedReader:reader}),typed=[];
 for(const kind of ['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']){
  const scope=await scopes.open({user:await db.getUser('a'),chatId:'10001',text:'/insights'}),value=await scopes.derived(scope,kind);
  assert.equal(value.status,'CURRENT');typed.push({kind,items:value.items.length});
  if(kind==='INSIGHTS')assert.equal(value.items.length,0,'one observation cannot manufacture an association');
 }
 console.log('SYNTHETIC_NATIVE_LIVE_COMPLETION '+JSON.stringify({contract:'fresh-representative-live-native-eof-v1',synthetic:true,sourceRows:3,applicableJobs:2,completedJobs:2,trueEOF:true,calls:progress.length+1,typed,originalGenerationAndDeadlinesPreserved:true,exactOriginalIdentityReplay:true,replayPreservedCanonicalMetadata:true,freshClientReplay:true,osProcessRestart:false,elapsedMs:performance.now()-start,productionEvidence:false,sixJobCompletionQualified:false,wholeRuntimeQualified:false}));
 latency=false;
});
