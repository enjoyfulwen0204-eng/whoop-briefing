import {STAGE8_LIVE_DRAIN_BUDGET} from '../src/stage8LiveDrainPolicy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
test('genuine LIVE subunits consume selected twelve-item LIVE leg budget without fabricated cursor completion',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:uid=>uid==='a'});
 const otherBefore=(await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='b' ORDER BY execution_mode")).rows;
 let last,packed=false,firstGenerations=null;const progression=[];
 for(let leg=0;leg<32;leg++){
  const before=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
  last=await producer.run({userId:'a',requestId:`bounded-live-units-${leg}`});
  assert.equal(last.result.jobsFailed,0);assert.ok(last.result.itemsProcessed+last.result.unitsCommitted<=STAGE8_LIVE_DRAIN_BUDGET.maxItemsPerTenant);
  const after=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
  assert.ok(after-before>=last.result.unitsCommitted,'all counted subunits have genuine durable named work');
  packed||=last.result.unitsCommitted>1;
  const current=(await f.db.raw.execute("SELECT job_kind,state,requested_generation,completed_generation,attempt,full_scan_cursor FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
  assert.equal(current.length,2);firstGenerations??=current.map(r=>r.requested_generation);
  current.forEach((r,i)=>{assert.equal(r.requested_generation,firstGenerations[i]);assert.equal(r.attempt,0);assert.ok(r.completed_generation<=r.requested_generation);});
  progression.push({leg,itemsProcessed:last.result.itemsProcessed,unitsCommitted:last.result.unitsCommitted,remainingJobs:last.result.remainingJobs,jobs:current.map(r=>({kind:r.job_kind,state:r.state,requestedGeneration:r.requested_generation,completedGeneration:r.completed_generation,cursorPresent:r.full_scan_cursor!==null,attempt:r.attempt}))});
  if(last.publication.status==='CURRENT')break;
 }
 assert.equal(packed,true);assert.equal(last.publication.status,'CURRENT');
 const jobs=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.completed_generation===j.requested_generation&&j.scope_kind==='NONE'));
 const originalExecutions=(await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows;
 for(const row of originalExecutions){assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);}
 const originalReceipts=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows;
 const receipts=originalReceipts.length;
 assert.equal((await producer.run({userId:'a',requestId:'bounded-live-units-0'})).replayed,true);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,receipts);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows,originalReceipts);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows,originalExecutions);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='b' ORDER BY execution_mode")).rows,otherBefore);
 console.log('LIVE12_GENUINE_PROGRESS '+JSON.stringify({contract:'isolated-owned-live12-job-progression-v1',selectedPerTenantCeiling:12,progression,currentPublication:true,twoJobsComplete:true,originalRowsAndReceiptsPreserved:true,exactOriginalIdentityReplay:true,otherUserComputationUnchanged:true,original45sDeadline60sLeasePreserved:true,productionEvidence:false,capacityQualified:false}));
});
