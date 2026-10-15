import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {BODY_ENERGY_PROVISIONAL_POLICY} from '../src/bodyEnergyProvisionalPolicy.js';
import {stage8BodyEnergyProjection} from '../src/stage8BodyEnergyProjection.js';
const rowFor=input=>{
 const {manifest}=selectBodyEnergyInputs(input),calculation=calculateBodyEnergy(manifest);
 return {input_manifest_json:JSON.stringify(manifest),value:calculation.value,quality_state:calculation.quality_state,
  confidence:calculation.confidence,algorithm_version:calculation.algorithm_version};
};
for(const days of [7,8,27,29])test(`typed projection retains actual qualifying ${days}-day baseline as labelled provisional estimate`,()=>{
 const row=rowFor(bodyInput({days})),value=stage8BodyEnergyProjection(row);
 assert.equal(row.quality_state,'LIMITED');assert.ok(value);assert.equal(value.value,row.value);
 assert.equal(value.quality,'LIMITED');assert.equal(value.estimated,true);assert.equal(value.provisional,true);
 assert.equal(value.presentationPolicy,BODY_ENERGY_PROVISIONAL_POLICY.version);
 assert.match(value.interpretation,/ESTIMATE_NOT_MEDICAL/);
});
test('mature actual calculation remains a bounded engineering estimate without a provisional label',()=>{
 const row=rowFor(bodyInput({days:30})),value=stage8BodyEnergyProjection(row);
 assert.equal(row.quality_state,'AVAILABLE');assert.ok(value);assert.equal(value.value,row.value);
 assert.equal(value.estimated,true);assert.equal(value.provisional,undefined);
});
test('LIMITED caused by missing required data cannot masquerade as a baseline-only provisional estimate',()=>{
 const input=bodyInput({days:27});input.sources.sleep[0].sleep_performance_percentage=null;
 const row=rowFor(input);assert.equal(row.quality_state,'LIMITED');assert.equal(row.value,null);
 assert.equal(stage8BodyEnergyProjection(row),null);
 // A numeric value without an unchanged genuine calculation cannot cure it.
 assert.equal(stage8BodyEnergyProjection({...row,value:50}),null);
});
test('warnings, six-day history, stale inputs and unsupported sources stay unavailable for numeric projection',()=>{
 for(const change of [x=>x.sources.recovery.splice(7),x=>{x.sync[0].last_success_at=new Date(x.asOfEpochMs-91*60000).toISOString();},
  x=>{x.access[0].status='FORBIDDEN';},x=>{x.sources.cycle=[];}]){
  const input=bodyInput({days:27});change(input);assert.equal(stage8BodyEnergyProjection(rowFor(input)),null);
 }
});
test('malformed, mismatched and nonfinite captures fail closed without granting any authority',()=>{
 const row=rowFor(bodyInput({days:27}));
 for(const changed of [null,{...row,input_manifest_json:'{'},{...row,value:NaN},{...row,value:101},
  {...row,value:row.value+1},{...row,quality_state:'AVAILABLE'},{...row,confidence:.1},{...row,algorithm_version:'unknown'}])
  assert.equal(stage8BodyEnergyProjection(changed),null);
});
