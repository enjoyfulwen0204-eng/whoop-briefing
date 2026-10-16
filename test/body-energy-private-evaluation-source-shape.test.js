import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {canonicalJson} from '../src/phase4EntityStore.js';
import {evaluateBodyEnergyPrivate} from '../scripts/body-energy-private-evaluation.mjs';

const request=cases=>({contractVersion:'body-energy-private-evaluation-input-v1',executionEnvironment:'NON_PRODUCTION',
  dataDeclaration:'SYNTHETIC',authorizedUserIds:['a'],cases});
const current=input=>({kind:'CURRENT_CANONICAL',userId:input.userId,input,
  provenance:{currentCanonicalCapture:true,captureEpochMs:input.asOfEpochMs}});
function captured(manifest){
  const saved=calculateBodyEnergy(manifest);
  return {kind:'CAPTURED_MANIFEST',userId:'a',manifest,savedValue:saved.value,savedQuality:saved.quality_state,
    provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}};
}
function linkedInput(){
  const input=bodyInput();
  input.sources.recovery[0].cycle_id='cycle-matched';
  Object.assign(input.sources.cycle[0],{id:'cycle-matched',start_at:input.sources.sleep[0].start_at,score_state:'SCORED',strain:2});
  return input;
}
function accepted(entry){
  const summary=evaluateBodyEnergyPrivate(request([entry])).summary;
  assert.equal(summary.casesEvaluated,1);
  assert.deepEqual(summary.rejectionCounts,{});
  assert.equal(summary.publicationQualified,false);
  return summary;
}
function rejected(manifest){
  const summary=evaluateBodyEnergyPrivate(request([captured(manifest)])).summary;
  assert.equal(summary.casesEvaluated,0);
  assert.equal(summary.capturedResultsReproduced,0);
  assert.equal(summary.eligibleAtCapturedInstant,0);
  assert.deepEqual(summary.qualityCounts,{});
  assert.deepEqual(summary.rejectionCounts,{CAPTURE_MANIFEST_SHAPE_INVALID:1});
}

test('private evaluation accepts the actual linked scored Cycle selector shape without changing the score',()=>{
  const input=linkedInput(),manifest=selectBodyEnergyInputs(input).manifest;
  assert.equal(manifest.recovery.cycle_id,'cycle-matched');
  assert.equal(manifest.load.kind,'CYCLE');
  assert.equal(manifest.load.rows[0].id,manifest.recovery.cycle_id);
  assert.equal(manifest.load.rows[0].score_state,'SCORED');
  const before=canonicalJson(manifest),summary=accepted(current(input));
  assert.equal(summary.eligibleAtCapturedInstant,1);
  assert.equal(accepted(captured(manifest)).capturedResultsReproduced,1);
  assert.equal(canonicalJson(manifest),before);
});

test('private evaluation preserves nullable legacy Cycle linkage and genuine selector mismatch exclusion',()=>{
  const input=bodyInput();input.sources.recovery[0].cycle_id=null;
  const manifest=selectBodyEnergyInputs(input).manifest;
  assert.equal(manifest.recovery.cycle_id,null);
  assert.equal(manifest.load.kind,'CYCLE');
  assert.equal(manifest.load.rows[0].score_state,null);
  assert.equal(accepted(current(input)).eligibleAtCapturedInstant,1);
  const mismatch=linkedInput();mismatch.sources.cycle[0].id='other-cycle';
  assert.equal(selectBodyEnergyInputs(mismatch).manifest.load.kind,'NONE');
  assert.equal(accepted(current(mismatch)).eligibleAtCapturedInstant,0);
});

test('private evaluation reproduces original retained captures with neither optional source field',()=>{
  const manifest=selectBodyEnergyInputs(bodyInput()).manifest;
  for(const recovery of [manifest.recovery,...manifest.baseline.hrv.map(row=>row.recovery),...manifest.baseline.rhr.map(row=>row.recovery)])
    delete recovery.cycle_id;
  delete manifest.load.rows[0].score_state;
  const before=canonicalJson(manifest);
  assert.equal(accepted(captured(manifest)).capturedResultsReproduced,1);
  assert.equal(canonicalJson(manifest),before);
});

test('optional recovery Cycle IDs retain strict primitive shape for current and baseline sources',()=>{
  for(const value of [true,{},[],undefined,Infinity]){
    for(const baseline of [false,true]){
      const manifest=selectBodyEnergyInputs(linkedInput()).manifest;
      (baseline?manifest.baseline.hrv[0].recovery:manifest.recovery).cycle_id=value;
      rejected(manifest);
    }
  }
  for(const value of [null,'cycle-matched',7]){
    const manifest=selectBodyEnergyInputs(linkedInput()).manifest;
    manifest.recovery.cycle_id=value;
    assert.equal(accepted(captured(manifest)).capturedResultsReproduced,1);
  }
});

test('optional Cycle score state accepts only selected states and never widens Workout or unknown fields',()=>{
  for(const value of [true,{},[],undefined,'PENDING',1]){
    const manifest=selectBodyEnergyInputs(linkedInput()).manifest;
    manifest.load.rows[0].score_state=value;
    rejected(manifest);
  }
  for(const value of [null,'SCORED']){
    const manifest=selectBodyEnergyInputs(linkedInput()).manifest;
    manifest.load.rows[0].score_state=value;
    assert.equal(accepted(captured(manifest)).capturedResultsReproduced,1);
  }
  const input=bodyInput(),wake=input.asOfEpochMs-3600000,iso=value=>new Date(value).toISOString();
  Object.assign(input.sources.sleep[0],{start_at:iso(wake-8*3600000),end_at:iso(wake)});
  input.sources.cycle=[];
  input.sources.workout=[{user_id:'a',id:'workout-current',start_at:iso(wake+60000),end_at:iso(wake+120000),
    strain:2,updated_at:iso(input.asOfEpochMs),synced_at:iso(input.asOfEpochMs)}];
  const workout=selectBodyEnergyInputs(input).manifest;
  assert.equal(workout.load.kind,'WORKOUT');
  assert.equal(accepted(current(input)).eligibleAtCapturedInstant,1);
  workout.load.rows[0].score_state=null;
  rejected(workout);
  delete workout.load.rows[0].score_state;
  assert.equal(accepted(captured(workout)).capturedResultsReproduced,1);
  for(const target of ['recovery','load']){
    const manifest=selectBodyEnergyInputs(linkedInput()).manifest;
    (target==='recovery'?manifest.recovery:manifest.load.rows[0]).raw_json='SYNTHETIC_FORBIDDEN_FIELD';
    rejected(manifest);
  }
});
