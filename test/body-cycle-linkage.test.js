import test from 'node:test';import assert from 'node:assert/strict';
import {selectBodyEnergyInputs,bodyCycleMatchesSleep} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
const hour=3600000,iso=ms=>new Date(ms).toISOString();
function linked(){const input=bodyInput(),sleep=input.sources.sleep[0],recovery=input.sources.recovery[0],cycle=input.sources.cycle[0];
 recovery.cycle_id=cycle.id;cycle.start_at=sleep.start_at;cycle.score_state='SCORED';return input;}
const select=input=>selectBodyEnergyInputs(input),calc=input=>calculateBodyEnergy(select(input).manifest);
test('actual WHOOP sleep-start cycle linkage selects scored current load without changing calculator constants',()=>{
 const input=linked(),manifest=select(input).manifest,result=calc(input);
 assert.equal(manifest.load.kind,'CYCLE');assert.equal(manifest.recovery.cycle_id,input.sources.cycle[0].id);
 assert.equal(manifest.load.rows[0].score_state,'SCORED');assert.equal(result.quality_state,'AVAILABLE');
 assert.equal(result.value,70);assert.equal(result.confidence,1);assert.equal(result.algorithm_version,'body-energy-v1.2.0');
 const old=bodyInput();assert.equal(calc(old).value,result.value);assert.equal(calc(old).quality_state,'AVAILABLE');
});
test('linked cycle retains exact two-hour sleep-start bound, wake interval and scoring; wrong near-wake cycle cannot substitute',()=>{
 const input=linked(),main=input.sources.sleep[0],recovery=input.sources.recovery[0],cycle=input.sources.cycle[0],asOf=input.asOfEpochMs;
 for(const offset of [-2*hour,2*hour])assert.equal(bodyCycleMatchesSleep({...cycle,start_at:iso(Date.parse(main.start_at)+offset)},main,recovery,asOf),true);
 for(const offset of [-2*hour-1,2*hour+1])assert.equal(bodyCycleMatchesSleep({...cycle,start_at:iso(Date.parse(main.start_at)+offset)},main,recovery,asOf),false);
 for(const patch of [{id:'wrong',start_at:main.end_at},{score_state:'PENDING_SCORE'},{score_state:null},{end_at:iso(Date.parse(main.end_at)-1)},{end_at:iso(asOf+1)}])
  assert.equal(bodyCycleMatchesSleep({...cycle,...patch},main,recovery,asOf),false,JSON.stringify(patch));
 input.sources.cycle[0].id='wrong';assert.equal(select(input).manifest.load.kind,'NONE');assert.equal(calc(input).quality_state,'DEGRADED');
 input.sources.recovery[0].cycle_id='';assert.equal(select(input).manifest.load.kind,'NONE');
});
test('linked cycle still respects source ownership, access, tombstones, fresh synchronization and calibration',()=>{
 for(const mutate of [i=>i.sources.cycle[0].user_id='other',i=>i.access.find(r=>r.resource==='cycle').auth_generation=2,
  i=>i.tombstones.push({user_id:'a',resource_type:'cycle',resource_id:'cycle-current',state:'ACTIVE'}),
  i=>i.sync.find(r=>r.resource==='cycle').last_success_at=iso(i.asOfEpochMs-6*hour-1)]){
  const input=linked();mutate(input);assert.equal(select(input).manifest.load.kind,'NONE');assert.notEqual(calc(input).quality_state,'AVAILABLE');
 }
 const stale=linked();for(const row of stale.sync)row.last_success_at=iso(stale.asOfEpochMs-91*60000);assert.equal(calc(stale).quality_state,'DEGRADED');
 const calibrating=linked();calibrating.sources.recovery[0].user_calibrating=1;assert.equal(calc(calibrating).quality_state,'DEGRADED');
 const immature=linked();immature.sources.recovery.splice(28);assert.equal(calc(immature).quality_state,'LIMITED');
});
test('canonical store captures and audits recovery-cycle linkage; same-clock linkage correction fences the stored result',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'body-cycle-test-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:32});await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 const input=linked();await db.transaction(()=>seedBodyInput(db,input));
 const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});await stores.initializeTenant('a','SHADOW');
 await stores.withContext('a',{executionMode:'SHADOW'},async context=>{
  const body=await stores.bodyEnergy.compute(context,{asOfEpochMs:input.asOfEpochMs});
  assert.equal(body.row.quality_state,'AVAILABLE');const audit=await stores.bodyEnergy.audit(context,body.row.result_id);
  assert.equal(audit.manifest.recovery.cycle_id,'cycle-current');assert.equal(audit.manifest.load.rows[0].score_state,'SCORED');
  await db.raw.execute("UPDATE whoop_recoveries SET cycle_id='different-current-cycle' WHERE user_id='a' AND sleep_id='sleep-00'");
  await assert.rejects(stores.bodyEnergy.audit(context,body.row.result_id),/ROOT_VERSION_MISMATCH|SOURCE_VERSION_MISMATCH/);
 });
});
