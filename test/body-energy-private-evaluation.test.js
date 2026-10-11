import test from 'node:test';import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {evaluateBodyEnergyPrivate} from '../scripts/body-energy-private-evaluation.mjs';
import {validateBodyEnergyQualificationPacket,BODY_ENERGY_RELEASE_CRITERIA as C} from '../src/bodyEnergyReleaseCriteria.js';
const current=input=>({kind:'CURRENT_CANONICAL',userId:input.userId,input,provenance:{currentCanonicalCapture:true,captureEpochMs:input.asOfEpochMs}});
const packet=cases=>({contractVersion:'body-energy-private-evaluation-input-v1',executionEnvironment:'NON_PRODUCTION',
  dataDeclaration:'SYNTHETIC',authorizedUserIds:['a'],cases});
test('bounded actual-input analysis remains private, operator-declared and independent-gated',()=>{
  const a=bodyInput(),b=bodyInput({asOf:a.asOfEpochMs+86400000});b.sources.sleep[0].sleep_performance_percentage=75;b.sources.recovery[0].hrv_rmssd_milli=60;
  const r=evaluateBodyEnergyPrivate(packet([current(a),current(b)]));assert.equal(r.summary.casesEvaluated,2);
  assert.equal(r.summary.eligibleAtCapturedInstant,2);assert.equal(r.summary.publicationQualified,false);
  assert.equal(r.summary.requiredDomainAblationInvariant,true);assert.equal(r.privateAnalysis.correlation.sleepPerformance.hrv.pearson,1);
  const safe=JSON.stringify(r.summary);for(const field of ['userId','input_manifest','hrv_rmssd','access_token','raw_json'])assert.ok(!safe.includes(field));
  assert.equal(C.clinicalGroundTruthRequired,false);assert.equal(C.empiricalNumericCutoffs,null);
});
test('retained capture requires provenance and reproduces without inventing earlier overwritten canonical versions',()=>{
  const input=bodyInput(),manifest=selectBodyEnergyInputs(input).manifest,result=calculateBodyEnergy(manifest);
  const captured={kind:'CAPTURED_MANIFEST',userId:'a',manifest,savedValue:result.value,savedQuality:result.quality_state,
    provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}};
  assert.equal(evaluateBodyEnergyPrivate(packet([captured])).summary.capturedResultsReproduced,1);
  assert.equal(evaluateBodyEnergyPrivate(packet([{...captured,savedValue:1}])).summary.rejectionCounts.CAPTURE_REPRODUCTION_MISMATCH,1);
  input.asOfEpochMs-=3600000;assert.equal(evaluateBodyEnergyPrivate(packet([current(input)])).summary.rejectionCounts.NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS,1);
  assert.equal(evaluateBodyEnergyPrivate(packet([{...captured,provenance:{}}])).summary.rejectionCounts.AUTHENTICATED_RETAINED_CAPTURE_REQUIRED,1);
});
test('unconsented/mixed tenant, raw payload and unbounded inputs reject before analysis',()=>{
  const input=bodyInput();input.sources.recovery.push({...input.sources.recovery[0],user_id:'b'});
  assert.equal(evaluateBodyEnergyPrivate(packet([current(input)])).summary.rejectionCounts.EVALUATION_SOURCE_SCOPE_REQUIRED,1);
  assert.throws(()=>evaluateBodyEnergyPrivate({...packet([]),cases:Array(46).fill({})}),/CASE_LIMIT/);
  assert.throws(()=>evaluateBodyEnergyPrivate({...packet([{}]),executionEnvironment:'PRODUCTION'}),/CONTRACT_REQUIRED/);
  assert.equal(evaluateBodyEnergyPrivate(packet([{...current(bodyInput()),userId:'b'}])).summary.rejectionCounts.EVALUATION_USER_NOT_AUTHORIZED,1);
  const same=current(bodyInput());assert.equal(evaluateBodyEnergyPrivate(packet([same,same])).summary.rejectionCounts.DUPLICATE_EVALUATION_CAPTURE,1);
});
test('synthetic/local analyses and flags never satisfy independent publication packet approval',()=>{
  const r=validateBodyEnergyQualificationPacket({criteriaVersion:C.version,algorithm:C.algorithm,constantsHash:C.constantsHash,
    executionEnvironment:'NON_PRODUCTION',dataDeclaration:'SYNTHETIC',analyses:{},approvals:{},flag:'on'});
  assert.equal(r.complete,false);assert.ok(r.reasons.includes('GENUINE_INPUT_EVIDENCE_REQUIRED'));
  assert.ok(r.reasons.includes('APPROVAL_PENDING:independentFinalGate'));
});
