/** Isolated v35 compatibility regression.
 * Uses only the existing isolated fixture/real SHADOW source-unit receipts.
 * No provider, real user, publication registration or Production operation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {fixtureKeys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {request,claim,authority} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {BODY_ENERGY_PROVISIONAL_POLICY as PROVISIONAL} from '../src/bodyEnergyProvisionalPolicy.js';
import {authorizeBodyEnergyFixturePublication,authorizeBodyEnergyPublication,assertBodyEnergyPublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';

const catalogSQL="SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
async function setup(t,days){
 const f=await syntheticPhase4Fixture(t,{targetVersion:34,ownedConnection:true,now:()=>new Date()});
 const frozen=(await f.db.raw.execute(catalogSQL)).rows;
 assert.deepEqual((await f.db.migrate({targetVersion:35})).versionsApplied,[35]);
 const admission=await f.db.freshRuntimeAdmission();
 assert.equal((await f.db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,35);
 const allocated=new Map((await f.db.raw.execute(catalogSQL)).rows.map(row=>[row.name,row.sql]));
 for(const row of frozen)assert.equal(allocated.get(row.name),row.sql,row.name);
 assert.match(allocated.get('phase4_execution_producers'),/execution_mode='SHADOW'/);
 assert.match(allocated.get('stage8_live_execution_producers'),/execution_mode='LIVE'/);
 const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,admission});
 const input=bodyInput({asOf:Date.now()-1000,days});
 input.sources.recovery[0].cycle_id=input.sources.cycle[0].id;
 input.sources.cycle[0].start_at=input.sources.sleep[0].start_at;
 input.sources.cycle[0].score_state='SCORED';
 await f.db.transaction(()=>seedBodyInput(f.db,input));
 await f.db.ensureOnboarding('a',{state:'READY'});
 await f.db.linkTelegram({userId:'a',chatId:'10001'});
 await f.db.setLocale('a','en');
 await f.db.setLocale('b','en');
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 const sync=request(),sc=await claim(f.db,sync);
 await commitPhaseWork(f.db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const complete=await finalizePhaseWork(f.db,sync,sc,fixtureKeys,authority);
 const r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:complete.handoff}),c=await claim(f.db,r);
 const drained=await withDurableExecution({claim:c,keys:fixtureKeys,pending:new Set(),authority},()=>worker.drain({budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1}}));
 assert.equal(drained.outcome,'PARTIAL');assert.equal(drained.completedJobs,0);assert.equal(drained.failedJobs,0);
 const finish=async()=>{
  await commitPhaseWork(f.db,r,c,{outcome:drained.outcome,itemsProcessed:drained.processedItems,jobsCompleted:0,jobsFailed:0,remainingJobs:drained.remainingJobs,completion:'PARTIAL'},authority);
  const parent=await finalizePhaseWork(f.db,r,c,fixtureKeys,authority);
  assert.equal(parent.settlementState,'FINALIZED_SUCCESS');assert.equal(parent.outcome,'PARTIAL');
 };
 const read=(userId='a',presentationPolicy=null)=>stores.withContext(userId,{executionMode:'SHADOW',providerRequired:true},context=>stores.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now(),presentationPolicy}));
 const state=async()=>({
  generation:(await f.db.raw.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows,
  jobs:(await f.db.raw.execute("SELECT job_kind,state,requested_generation,completed_generation,lease_owner FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows,
  liveExecutions:(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,
  outbound:(await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,
 });
 return {...f,stores,input,read,finish,state};
}
async function withReadProjection(f,match,change,work){
 const original=f.db.raw.execute;
 f.db.raw.execute=async statement=>{
  const result=await original(statement),sql=typeof statement==='string'?statement:statement?.sql??'';
  return match(sql)?{...result,rows:result.rows.map(row=>change({...row}))}:result;
 };
 try{return await work();}finally{f.db.raw.execute=original;}
}

test('additive v35 preserves frozen v34 objects and requires original finalized SHADOW Body receipts, tenant and currentness authority',async t=>{
 const f=await setup(t,30);
 assert.equal((await f.read()).status,'PROCESSING','unfinalized source work never publishes');
 await f.finish();
 const view=await f.read();assert.equal(view.status,'AVAILABLE');assert.ok(view.publicationProof);
 assert.equal(view.executionMode,'SHADOW');
 const before=await f.state();assert.equal(before.liveExecutions,0);assert.equal(before.outbound,0);
 assert.ok(before.generation[0].last_completed_generation<before.generation[0].input_generation);
 await assert.rejects(f.read('b'),/AUTH_FENCED/);
 await assert.rejects(f.stores.withContext('a',{executionMode:'LIVE'},async()=>{}),/LIVE_NOT_AUTHORIZED/);
 const producers=sql=>/FROM phase4_execution_producers p JOIN phase4_executions/.test(sql);
 await withReadProjection(f,producers,row=>({...row,state:'WORK_COMMITTED'}),async()=>assert.equal((await f.read()).status,'PROCESSING'));
 await withReadProjection(f,producers,row=>({...row,state:'FINALIZED_FAILURE'}),async()=>assert.equal((await f.read()).status,'PROCESSING'));
 await withReadProjection(f,producers,row=>({...row,tenant_proof:'0'.repeat(64)}),()=>assert.rejects(f.read(),/PRODUCER_INVALID/));
 const sourceReceipt=sql=>/SELECT \* FROM phase4_execution_work_receipts WHERE execution_id/.test(sql);
 await withReadProjection(f,sourceReceipt,row=>({...row,receipt_key:'0'.repeat(64)}),()=>assert.rejects(f.read(),/RECEIPT_INVALID/));
 const schema=sql=>sql==='SELECT MAX(version) v FROM schema_version';
 await withReadProjection(f,schema,()=>({v:36}),async()=>assert.equal((await f.read()).status,'PROCESSING','unreviewed future schema remains closed'));
 assert.equal((await f.read()).status,'AVAILABLE');
 assert.deepEqual(await f.state(),before,'read qualification does not complete whole jobs, enter LIVE allocation or deliver messages');
 const noGrant=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:null});
 assert.equal((await noGrant.query({text:'/energy',userId:'a'})).status,'QUALIFICATION_PENDING');
 assert.equal(authorizeBodyEnergyPublication({db:f.db,userIds:['a'],qualificationId:'on'}),null);
 await f.db.raw.execute("UPDATE whoop_cycles SET strain=18 WHERE user_id='a' AND id='cycle-current'");
 await assert.rejects(f.read(),/VERSION_MISMATCH/);
 await f.db.raw.execute("UPDATE whoop_cycles SET strain=0 WHERE user_id='a' AND id='cycle-current'");
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 assert.equal((await f.read()).status,'PROCESSING');
});

test('v35 owner provisional remains LIMITED, separately granted, owner only, finalized, current and without alert authority',async t=>{
 const f=await setup(t,7);
 assert.equal((await f.read('a',PROVISIONAL.version)).status,'PROCESSING');
 await f.finish();
 assert.equal((await f.read()).status,'LIMITED');
 const view=await f.read('a',PROVISIONAL.version);assert.equal(view.status,'PROVISIONAL');assert.equal(view.quality,'LIMITED');
 const cap=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],presentationPolicy:PROVISIONAL.version});
 const ui=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:cap});
 assert.equal((await ui.query({text:'/energy',userId:'a'})).status,'PROVISIONAL');
 assert.equal((await ui.query({text:'/energy',userId:'b'})).status,'QUALIFICATION_PENDING');
 await assert.rejects(assertBodyEnergyPublication(cap,f.db,'a',{purpose:'alerts'}),/NOT_QUALIFIED/);
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");
 await assert.rejects(f.read('a',PROVISIONAL.version),/PURGE_FENCED/);
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=0 WHERE user_id='a'");
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 assert.equal((await f.read('a',PROVISIONAL.version)).status,'PROCESSING');
});
