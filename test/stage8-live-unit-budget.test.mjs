import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
test('genuine LIVE subunits consume existing six-item leg budget without fabricated cursor completion',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:uid=>uid==='a'});
 let last,packed=false;
 for(let leg=0;leg<32;leg++){
  const before=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
  last=await producer.run({userId:'a',requestId:`bounded-live-units-${leg}`});
  assert.equal(last.result.jobsFailed,0);assert.ok(last.result.itemsProcessed+last.result.unitsCommitted<=6);
  const after=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
  assert.ok(after-before>=last.result.unitsCommitted,'all counted subunits have genuine durable named work');
  packed||=last.result.unitsCommitted>1;
  console.log('LIVE_UNIT_BUDGET',JSON.stringify({leg,...last}));
  if(last.publication.status==='CURRENT')break;
 }
 assert.equal(packed,true);assert.equal(last.publication.status,'CURRENT');
 const jobs=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.completed_generation===j.requested_generation&&j.scope_kind==='NONE'));
 const receipts=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
 assert.equal((await producer.run({userId:'a',requestId:'bounded-live-units-0'})).replayed,true);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,receipts);
});
