import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyInput} from './checkout/test/bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from './checkout/src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from './checkout/src/bodyEnergy.js';
import {stage8BodyEnergyProjection} from './checkout/src/stage8BodyEnergyProjection.js';
import {baselineOnlyProvisional} from './checkout/src/bodyEnergyProvisionalPolicy.js';
import {authorizeBodyEnergyOwnerProvisional,assertBodyEnergyPublication} from './checkout/src/bodyEnergyQualificationAuthority.js';
function rowFor(input){const {manifest}=selectBodyEnergyInputs(input),calculation=calculateBodyEnergy(manifest);return {row:{as_of_epoch_ms:manifest.as_of_epoch_ms,input_manifest_json:JSON.stringify(manifest),value:calculation.value,quality_state:calculation.quality_state,confidence:calculation.confidence,algorithm_version:calculation.algorithm_version},manifest,calculation};}
for(const missing of ['hrv_rmssd_milli','resting_heart_rate','sleep_performance_percentage'])test('authentic original LIMITED/null is numerically suppressed: '+missing,()=>{
 const input=bodyInput({days:30});(missing==='sleep_performance_percentage'?input.sources.sleep[0]:input.sources.recovery[0])[missing]=null;
 const s=rowFor(input);assert.equal(s.row.quality_state,'LIMITED');assert.equal(s.row.value,null);assert.equal(baselineOnlyProvisional(s),false);assert.equal(stage8BodyEnergyProjection(s.row,s.manifest.as_of_epoch_ms),null);assert.equal(stage8BodyEnergyProjection({...s.row,value:50},s.manifest.as_of_epoch_ms),null);
 console.log('INDEPENDENT_TRUE_LIMITED_NULL',JSON.stringify({missing,quality:s.row.quality_state,value:s.row.value,confidence:s.row.confidence,reasons:s.calculation.reasons}));
});
test('separate actual component sample counts are preserved in provisional eligibility',()=>{
 const input=bodyInput({days:30});input.sources.recovery[1].hrv_rmssd_milli=null;
 const s=rowFor(input);assert.equal(s.calculation.drivers.baselines.hrv.n,29);assert.equal(s.calculation.drivers.baselines.rhr.n,30);const value=stage8BodyEnergyProjection(s.row,s.manifest.as_of_epoch_ms);assert.equal(value?.provisional,true);assert.equal(value?.value,s.calculation.value);assert.equal(Object.isFrozen(value),true);
});
test('true numeric captures with absent load, stale sync, flat baseline or calibration remain excluded',()=>{
 for(const change of [x=>x.sources.cycle=[],x=>x.sync[0].last_success_at=new Date(x.asOfEpochMs-91*60000).toISOString(),x=>x.sources.recovery.forEach(r=>r.hrv_rmssd_milli=50),x=>x.sources.recovery[0].user_calibrating=1]){const input=bodyInput({days:30});change(input);const s=rowFor(input);assert.equal(stage8BodyEnergyProjection(s.row,s.manifest.as_of_epoch_ms),null);}
});
test('registered constants and full row calculation binding cannot be replaced by plausible numeric metadata',()=>{
 const s=rowFor(bodyInput({days:30}));for(const patch of [{value:'70'},{value:Infinity},{value:-1},{value:100.5},{confidence:NaN},{confidence:s.row.confidence-.01},{algorithm_version:'unknown'}])assert.equal(stage8BodyEnergyProjection({...s.row,...patch},s.manifest.as_of_epoch_ms),null);
 const m={...s.manifest,constants_hash:'a'.repeat(64)};assert.equal(stage8BodyEnergyProjection({...s.row,input_manifest_json:JSON.stringify(m)},s.manifest.as_of_epoch_ms),null);
});
test('a presentation object and its version label do not mint the separate registered Owner capability',async()=>{
 const s=rowFor(bodyInput({days:7})),value=stage8BodyEnergyProjection(s.row,s.manifest.as_of_epoch_ms),db={raw:{}};assert.ok(value?.provisional);await assert.rejects(assertBodyEnergyPublication(value,db,'a'),/NOT_QUALIFIED/);
 const cap=authorizeBodyEnergyOwnerProvisional({db,userIds:['a'],ownerUserId:'a',qualificationId:value.presentationPolicy});await assert.rejects(assertBodyEnergyPublication(cap,db,'b'),/NOT_QUALIFIED/);await assert.rejects(assertBodyEnergyPublication(cap,db,'a',{purpose:'alerts'}),/NOT_QUALIFIED/);
});

for(const resource of ['sleep','recovery','cycle'])test('exact original90min consumption boundary is enforced independently for '+resource,()=>{
 const input=bodyInput({days:30}),at=input.asOfEpochMs;input.sync.find(s=>s.resource===resource).last_success_at=new Date(at-85*60000).toISOString();
 const s=rowFor(input);assert.equal(s.row.quality_state,'AVAILABLE');assert.ok(stage8BodyEnergyProjection(s.row,at+5*60000));assert.equal(stage8BodyEnergyProjection(s.row,at+5*60000+1),null);assert.equal(stage8BodyEnergyProjection(s.row,at+10*60000),null);
});
test('missing, future-relative, nonintegral and invalid read/capture times fail closed',()=>{
 const s=rowFor(bodyInput({days:30})),at=s.manifest.as_of_epoch_ms;
 for(const read of [undefined,null,NaN,Infinity,String(at),at+.5,at-1,at+90*60000+1])assert.equal(stage8BodyEnergyProjection(s.row,read),null);
 for(const value of [undefined,null,NaN,Infinity,String(at),at+.5])assert.equal(stage8BodyEnergyProjection({...s.row,as_of_epoch_ms:value},at),null);
});
