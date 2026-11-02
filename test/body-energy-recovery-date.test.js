import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {renderOnDemandBody} from '../src/onDemandBodyEnergy.js';

const evaluate=input=>{
  const {manifest}=selectBodyEnergyInputs(input);
  return {manifest,calculation:calculateBodyEnergy(manifest)};
};

for(const [position,index] of [['current',0],['baseline',1]]) {
  for(const date of [null,'2026-01-01']) {
    test(`Exact ${position} sleep_id preserves availability while recovery date is ${date??'not linked'}`,()=>{
      const input=bodyInput(),aligned=evaluate(input);
      input.sources.recovery[index].health_date=date;
      const before=structuredClone(input),{manifest,calculation}=evaluate(input);
      assert.equal(calculation.quality_state,'AVAILABLE');
      assert.equal(calculation.value,aligned.calculation.value);
      assert.deepEqual(calculation.drivers,aligned.calculation.drivers);
      assert.ok(manifest.reasons.includes('HEALTH_DATE_REALIGNMENT'));
      assert.ok(!manifest.warnings.includes('HEALTH_DATE_REALIGNMENT'));
      assert.equal(manifest.baseline.hrv.length,30);
      assert.equal(manifest.baseline.rhr.length,30);
      assert.deepEqual(input,before,'selection must never repair source records');
    });
  }
  test(`${position} sleep's own date mismatch still degrades even with exact recovery pairing`,()=>{
    const input=bodyInput();
    input.sources.sleep[index].health_date='2026-01-01';
    input.sources.recovery[index].health_date=null;
    const {manifest,calculation}=evaluate(input);
    assert.ok(manifest.warnings.includes('HEALTH_DATE_REALIGNMENT'));
    assert.equal(calculation.quality_state,'DEGRADED');
  });
}

test('A lagging recovery date never bypasses identity, version, calibration, tombstone or authorization fences',()=>{
  const cases=[
    input=>{input.sources.recovery[0].sleep_id='unrelated';},
    input=>{input.sources.recovery[0].user_id='other';},
    input=>{input.sources.recovery[0].score_state='PENDING_SCORE';},
    input=>{input.sources.recovery[0].user_calibrating=1;},
    input=>{input.sources.recovery[0].updated_at=null;},
    input=>{input.sources.recovery[0].synced_at=new Date(input.asOfEpochMs+1).toISOString();},
    input=>{input.tombstones.push({user_id:'a',resource_type:'recovery',resource_id:'sleep-00',state:'ACTIVE'});},
    input=>{input.access.find(r=>r.resource==='recovery').auth_generation=2;},
  ];
  for(const change of cases){
    const input=bodyInput();input.sources.recovery[0].health_date=null;change(input);
    assert.notEqual(evaluate(input).calculation.quality_state,'AVAILABLE');
  }
  const duplicate=bodyInput();duplicate.sources.recovery[0].health_date=null;
  duplicate.sources.recovery.push({...duplicate.sources.recovery[0]});
  assert.throws(()=>evaluate(duplicate),/BODY_ENERGY_DUPLICATE_MATCHED_RECOVERY/);
});

test('Morning Body Energy renders the same wake-up line as aligned sources in all locales',()=>{
  const input=bodyInput(),aligned=evaluate(input).calculation;
  input.sources.recovery[0].health_date=null;
  input.sources.recovery[1].health_date='2026-01-01';
  const result=evaluate(input).calculation;
  for(const locale of ['zh-TW','en','vi']){
    const options={locale,morning:true};
    assert.equal(renderOnDemandBody(result,options),renderOnDemandBody(aligned,options));
    assert.match(renderOnDemandBody(result,options),/70\/100/);
  }
});
