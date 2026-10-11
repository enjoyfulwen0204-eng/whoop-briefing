import test from 'node:test';import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {canonicalJson} from '../src/phase4EntityStore.js';
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
test('genuine future captures and malformed retained manifests fail with zero accepted-case accounting',()=>{
  const future=bodyInput({asOf:Date.now()+86400000});
  const genuine={...packet([current(future)]),dataDeclaration:'GENUINE_AUTHORIZED_RETAINED_INPUTS'};
  const rejected=evaluateBodyEnergyPrivate(genuine).summary;
  assert.equal(rejected.rejectionCounts.EVALUATION_FUTURE_CAPTURE,1);assert.equal(rejected.casesEvaluated,0);
  const manifest=selectBodyEnergyInputs(bodyInput()).manifest,r=calculateBodyEnergy(manifest);delete manifest.warnings;
  const bad={kind:'CAPTURED_MANIFEST',userId:'a',manifest,savedValue:r.value,savedQuality:r.quality_state,
    provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}};
  const summary=evaluateBodyEnergyPrivate(packet([bad])).summary;
  assert.equal(summary.casesEvaluated,0);assert.equal(summary.capturedResultsReproduced,0);
  assert.equal(summary.eligibleAtCapturedInstant,0);assert.equal(summary.rejectionCounts.CAPTURE_MANIFEST_SHAPE_INVALID,1);
  const raw=selectBodyEnergyInputs(bodyInput()).manifest;raw.recovery.raw_json='synthetic';
  assert.equal(evaluateBodyEnergyPrivate(packet([{...bad,manifest:raw}])).summary.rejectionCounts.CAPTURE_MANIFEST_SHAPE_INVALID,1);
});
test('JSON primitive coercion traps never partially count a rejected retained capture',()=>{
  const original=selectBodyEnergyInputs(bodyInput()).manifest,result=calculateBodyEnergy(original);
  const mutations=[
    m=>{m.sync.sleep.age_ms={valueOf:null,toString:null};},
    m=>{m.load.sync.age_ms='0';},
    m=>{m.as_of_epoch_ms={valueOf:null,toString:null};},
    m=>{m.main_sleep.end_at={toString:null};},
    m=>{m.recovery.user_calibrating={valueOf:null};},
    m=>{m.eligibility.required_sync_valid=1;},
    m=>{m.baseline.hrv[0].value={valueOf:null};},
    m=>{m.load.rows[0].strain={valueOf:null,toString:null};},
    m=>{m.access_evidence[0].auth_generation='1';},
    m=>{m.sync.recovery.last_success_at={toString:null};},
  ];
  for(const mutate of mutations){
    const manifest=JSON.parse(JSON.stringify(original));mutate(manifest);
    const summary=evaluateBodyEnergyPrivate(packet([{kind:'CAPTURED_MANIFEST',userId:'a',manifest,
      savedValue:result.value,savedQuality:result.quality_state,
      provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}}])).summary;
    assert.equal(summary.casesEvaluated,0);assert.equal(summary.capturedResultsReproduced,0);
    assert.equal(summary.eligibleAtCapturedInstant,0);assert.deepEqual(summary.qualityCounts,{});
    assert.equal(Object.values(summary.rejectionCounts).reduce((sum,n)=>sum+n,0),1);
  }
});
test('earlier-only paired observed inputs support correlation without invented historical scores or duplicate dominance',()=>{
  const input=bodyInput();for(let n=1;n<input.sources.sleep.length;n++)input.sources.sleep[n].sleep_performance_percentage=40+n;
  const result=evaluateBodyEnergyPrivate(packet([current(input)]));
  assert.equal(result.summary.casesEvaluated,1);assert.equal(result.privateAnalysis.correlation.value.hrv.pearson,null);
  const earlier=result.privateAnalysis.earlierBaselineInputCorrelation;
  assert.equal(earlier.pairedTenantDays,30);assert.equal(earlier.matrix.sleepPerformance.hrv.pearson,1);
  assert.equal(earlier.matrix.hrv.rhr.pearson,1);assert.equal(earlier.matrix.value,undefined);
  const captured=selectBodyEnergyInputs(input).manifest,calculation=calculateBodyEnergy(captured);
  const second=structuredClone(captured);second.as_of_epoch_ms+=1;second.as_of_utc=new Date(second.as_of_epoch_ms).toISOString();
  for(const row of [second.sync.sleep,second.sync.recovery,second.load.sync])row.age_ms+=1;
  const entry=manifest=>({kind:'CAPTURED_MANIFEST',userId:'a',manifest,savedValue:calculateBodyEnergy(manifest).value,
    savedQuality:calculateBodyEnergy(manifest).quality_state,provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}});
  const repeated=evaluateBodyEnergyPrivate(packet([entry(captured),entry(second)])).privateAnalysis.earlierBaselineInputCorrelation;
  assert.equal(repeated.pairedTenantDays,30);assert.equal(repeated.conflictingSourceRevisionsOmitted,0);
  second.baseline.hrv[0].recovery.hrv_rmssd_milli+=1;second.baseline.hrv[0].value+=1;
  second.baseline.rhr[0].recovery.hrv_rmssd_milli+=1;
  const conflict=evaluateBodyEnergyPrivate(packet([entry(captured),entry(second)])).privateAnalysis.earlierBaselineInputCorrelation;
  assert.equal(conflict.pairedTenantDays,29);assert.equal(conflict.conflictingSourceRevisionsOmitted,1);
  for(const id of [input.userId,input.sources.sleep[1].id])assert.ok(!JSON.stringify(earlier).includes(`"${id}"`));
});

test('actual canonical receipt serialization does not invent conflicting observed source revisions',()=>{
  const input=bodyInput(),original=selectBodyEnergyInputs(input).manifest;
  const retained=JSON.parse(canonicalJson(original));retained.as_of_epoch_ms+=1;
  retained.as_of_utc=new Date(retained.as_of_epoch_ms).toISOString();
  for(const row of [retained.sync.sleep,retained.sync.recovery,retained.load.sync])row.age_ms+=1;
  const saved=calculateBodyEnergy(retained);
  const entry={kind:'CAPTURED_MANIFEST',userId:'a',manifest:retained,savedValue:saved.value,savedQuality:saved.quality_state,
    provenance:{receiptVerified:true,retainedContent:true,originalCapturedManifest:true}};
  const analysis=evaluateBodyEnergyPrivate(packet([current(input),entry]));
  assert.equal(analysis.summary.casesEvaluated,2);assert.equal(analysis.summary.capturedResultsReproduced,1);
  assert.equal(analysis.privateAnalysis.earlierBaselineInputCorrelation.pairedTenantDays,30);
  assert.equal(analysis.privateAnalysis.earlierBaselineInputCorrelation.conflictingSourceRevisionsOmitted,0);
});
