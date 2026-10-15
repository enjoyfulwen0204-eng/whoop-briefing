import test from 'node:test';import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {baselineOnlyProvisional,BODY_ENERGY_PROVISIONAL_POLICY as POLICY} from '../src/bodyEnergyProvisionalPolicy.js';
import {authorizeBodyEnergyOwnerProvisional,assertBodyEnergyPublication,BODY_ENERGY_QUALIFICATION_REGISTRATION} from '../src/bodyEnergyQualificationAuthority.js';
const stored=input=>{const {manifest}=selectBodyEnergyInputs(input),calculation=calculateBodyEnergy(manifest);return {manifest,calculation,row:{
  quality_state:calculation.quality_state,algorithm_version:calculation.algorithm_version,value:calculation.value,confidence:calculation.confidence}};};
for(const days of [7,8,27,29])test(`registered real selector/calculator admits baseline-only ${days} days`,()=>{
 const s=stored(bodyInput({days}));assert.equal(s.calculation.quality_state,'LIMITED');assert.equal(baselineOnlyProvisional(s),true);
 assert.equal(POLICY.baselineTarget,30);assert.equal(s.calculation.drivers.baselines.hrv.n,days);
});
test('separate component counts remain actual; one mature component does not conceal immature other component',()=>{
 const input=bodyInput({days:30});input.sources.recovery[1].hrv_rmssd_milli=null;
 const s=stored(input);assert.equal(s.calculation.drivers.baselines.hrv.n,29);assert.equal(s.calculation.drivers.baselines.rhr.n,30);
 assert.equal(baselineOnlyProvisional(s),true);
});
const cases={
 'six days':x=>x.sources.recovery.splice(7),
 'flat scale':x=>{for(const r of x.sources.recovery)r.hrv_rmssd_milli=50;},
 'calibrating current':x=>{x.sources.recovery[0].user_calibrating=1;},
 'calibrating history':x=>{for(const r of x.sources.recovery.slice(1))r.user_calibrating=1;},
 'unscored current':x=>{x.sources.recovery[0].score_state='PENDING_SCORE';},
 'mismatched recovery':x=>{x.sources.recovery[0].sleep_id='foreign';},
 'missing sleep performance':x=>{x.sources.sleep[0].sleep_performance_percentage=null;},
 'missing load':x=>{x.sources.cycle=[];},
 'wake misaligned load':x=>{x.sources.cycle[0].start_at=new Date(x.asOfEpochMs+1000).toISOString();},
 'stale source':x=>{x.sync[0].last_success_at=new Date(x.asOfEpochMs-91*60000).toISOString();},
 'unsupported source':x=>{x.access[0].status='FORBIDDEN';},
};
for(const [name,change] of Object.entries(cases))test(`${name} stays nonnumeric in provisional policy`,()=>{
 const input=bodyInput({days:27});change(input);assert.equal(baselineOnlyProvisional(stored(input)),false);
});
test('mature result, extra reason, warning, forged number and invalid scale cannot enter trial tier',()=>{
 assert.equal(baselineOnlyProvisional(stored(bodyInput())),false);
 for(const change of [s=>s.calculation.reasons.push('OTHER_LIMITATION'),s=>s.manifest.warnings.push('LOAD_UNAVAILABLE'),
  s=>s.row.value=NaN,s=>s.row.confidence=.79,s=>s.calculation.drivers.baselines.hrv.scale=0,
  s=>s.manifest.load.rows=[],s=>s.manifest.baseline.hrv[0].recovery.user_calibrating=1]){
  const s=stored(bodyInput({days:27}));change(s);assert.equal(baselineOnlyProvisional(s),false);
 }
});
test('new owner presentation authority is connection bound, cannot grant alerts or rewrite pending mature approval',async()=>{
 const db={raw:{}},args={db,userIds:['a'],ownerUserId:'a',qualificationId:POLICY.version};
 const cap=authorizeBodyEnergyOwnerProvisional(args);assert.equal((await assertBodyEnergyPublication(cap,db,'a')).presentationPolicy,POLICY.version);
 await assert.rejects(assertBodyEnergyPublication(cap,db,'b'),/NOT_QUALIFIED/);
 await assert.rejects(assertBodyEnergyPublication(cap,{raw:db.raw},'a'),/NOT_QUALIFIED/);
 await assert.rejects(assertBodyEnergyPublication(cap,db,'a',{purpose:'alerts'}),/NOT_QUALIFIED/);
 assert.throws(()=>authorizeBodyEnergyOwnerProvisional({...args,userIds:['b']}),/OWNER_ONLY/);
 assert.throws(()=>authorizeBodyEnergyOwnerProvisional({...args,userIds:['a','b']}),/OWNER_ONLY/);
 assert.throws(()=>authorizeBodyEnergyOwnerProvisional({...args,notificationUserIds:['a']}),/OWNER_ONLY/);
 assert.equal(authorizeBodyEnergyOwnerProvisional({...args,qualificationId:'on'}),null);
 assert.equal(BODY_ENERGY_QUALIFICATION_REGISTRATION.state,'PENDING_GENUINE_EVIDENCE_AND_FINAL_GATE');
 assert.equal(BODY_ENERGY_QUALIFICATION_REGISTRATION.approvedPacket,null);
});
