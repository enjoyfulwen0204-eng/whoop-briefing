import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBodyEnergy,initialBodyCharge,robustBaseline,linearQuantile,bodyFreshness,bodyQuality,
  meetsConfidenceThreshold,bodyConfidenceLabel } from '../src/bodyEnergy.js';
import { selectBodyEnergyInputs,exactBodyInstant,bodyHealthDate,validHealthDate } from '../src/bodyEnergyInputs.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { bodyInput } from './bodyEnergyFixture.js';

const calculate=input=>calculateBodyEnergy(selectBodyEnergyInputs(input).manifest);
const iso=ms=>new Date(ms).toISOString();
const hour=3600000;
const adjacent=(value,direction)=>{
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);
  view.setBigUint64(0,view.getBigUint64(0,false)+(direction>0?1n:-1n),false);return view.getFloat64(0,false);
};

test('Body confidence thresholds tolerate only the adjacent lower float and never round stored confidence',()=>{
  for(const [threshold,label] of [[0.8,'HIGH'],[0.6,'MEDIUM'],[0.4,'LOW']]) {
    const below=adjacent(threshold,-1),above=adjacent(threshold,1);
    assert.equal(meetsConfidenceThreshold(threshold,threshold),true);
    assert.equal(meetsConfidenceThreshold(below,threshold),true);
    assert.equal(meetsConfidenceThreshold(above,threshold),true);
    assert.equal(meetsConfidenceThreshold(adjacent(below,-1),threshold),false);
    assert.equal(meetsConfidenceThreshold(threshold-1e-12,threshold),false);
    assert.equal(bodyConfidenceLabel(threshold),label);
  }
  assert.equal(bodyConfidenceLabel(adjacent(0.6,-1)),'MEDIUM');
  assert.equal(bodyConfidenceLabel(adjacent(0.4,-1)),'LOW');
  assert.equal(bodyConfidenceLabel(0.4-1e-12),'INSUFFICIENT');
  for(const bad of [NaN,Infinity,-Infinity])assert.throws(()=>meetsConfidenceThreshold(bad,0.8),/CONFIDENCE_INVALID/);
  const manifest=selectBodyEnergyInputs(bodyInput()).manifest;
  for(const sync of Object.values(manifest.sync))sync.age_ms=24*hour;
  manifest.load.sync.age_ms=24*hour;manifest.warnings=[];manifest.reasons=[];
  const result=calculateBodyEnergy(manifest);
  assert.equal(result.confidence,0.7999999999999999);
  assert.equal(result.confidence_label,'HIGH');assert.equal(result.quality_state,'AVAILABLE');
});

test('Body Energy normative scale, rounding, robust median/MAD/IQR and registered versions',()=>{
  for(const [domain,result] of [[0,40],[25,55],[50,70],[75,85],[100,100]])assert.equal(initialBodyCharge(domain,domain),result);
  assert.equal(initialBodyCharge(75,50),80);assert.equal(initialBodyCharge(50+5/6,50+5/6),71);
  for(const missing of [null,undefined,NaN,Infinity,-1,101,'50'])assert.equal(initialBodyCharge(missing,50),null);
  assert.equal(linearQuantile([1,2,3,4],0.25),1.75);assert.equal(linearQuantile([1,2,3,4],0.5),2.5);
  const mad=robustBaseline([1,2,3,4,5,6,7]);assert.equal(mad.center,4);assert.equal(mad.scale,2*1.4826);assert.equal(mad.method,'MAD');
  const fallback=robustBaseline([1,1,2,2,2,2,3]);assert.equal(fallback.method,'IQR');assert.equal(fallback.scale,0.5/1.349);
  assert.equal(robustBaseline(Array(30).fill(50)).usable,false);assert.equal(robustBaseline([1,2,3,4,5,6]).usable,false);
  const r=calculate(bodyInput());assert.equal(r.value,70);assert.equal(r.quality_state,'AVAILABLE');assert.equal(r.confidence,1);
  assert.equal(r.algorithm_version,'body-energy-v1.2.0');assert.equal(r.constants_version,'body-energy-constants-v3');
  const manifest=selectBodyEnergyInputs(bodyInput()).manifest;manifest.algorithm_version='unregistered';
  assert.throws(()=>calculateBodyEnergy(manifest),/ALGORITHM_UNREGISTERED/);
});

test('Required-domain missingness, invalidity, calibration and quality precedence never manufacture a value',()=>{
  for(const [kind,field,reason] of [['sleep','sleep_performance_percentage','SLEEP_PERFORMANCE'],['recovery','hrv_rmssd_milli','HRV'],['recovery','resting_heart_rate','RHR']]) {
    const input=bodyInput();input.sources[kind][0][field]=null;
    const r=calculate(input);assert.equal(r.value,null);assert.equal(r.quality_state,'LIMITED');assert.ok(r.reasons.includes(`${reason}_MISSING`));
    for(const bad of [-1,NaN,Infinity,'50',...(kind==='sleep'?[101]:[0])]) {
      input.sources[kind][0][field]=bad;const invalid=calculate(input);
      assert.equal(invalid.value,null);assert.equal(invalid.quality_state,'DEGRADED');assert.ok(invalid.reasons.includes(`${reason}_INVALID`));
    }
  }
  for(const calibration of [null,1]) {
    const input=bodyInput();input.sources.recovery[0].user_calibrating=calibration;
    const result=calculate(input);assert.equal(result.value,null);assert.equal(result.quality_state,'DEGRADED');
  }
  const six=bodyInput({days:6});assert.equal(calculate(six).quality_state,'WARMING_UP');assert.equal(calculate(six).value,null);
  six.sync.find(r=>r.resource==='recovery').last_success_at=iso(six.asOfEpochMs-2*hour);
  assert.equal(calculate(six).quality_state,'DEGRADED');assert.equal(calculate(six).value,null);
  six.capabilities[0].status='APP_ONLY_UNAVAILABLE_TO_API';assert.equal(calculate(six).quality_state,'UNAVAILABLE');
  const zero=bodyInput();for(const r of zero.sources.recovery)r.hrv_rmssd_milli=50;
  assert.equal(calculate(zero).quality_state,'WARMING_UP');assert.ok(calculate(zero).reasons.includes('BASELINE_SCALE_UNAVAILABLE'));
  const none=bodyInput();none.sources.sleep=[];assert.equal(calculate(none).quality_state,'NO_DATA');
  for(let n=0;n<64;n++) {
    const flags=Object.fromEntries(['unavailable','noData','degraded','warming','limited'].map((k,i)=>[k,Boolean(n&(1<<i))]));
    assert.equal(bodyQuality(flags),['UNAVAILABLE','NO_DATA','DEGRADED','WARMING_UP','LIMITED'][Object.values(flags).findIndex(Boolean)]??'AVAILABLE');
  }
});

test('Sleep Performance is selected before validity; recovery must exactly match and contextual metrics have zero effect',()=>{
  const input=bodyInput(),base=canonicalJson(calculate(input));
  for(const score of [null,0,90,100,NaN]) {input.sources.recovery[0].recovery_score=score;assert.equal(canonicalJson(calculate(input)),base);}
  Object.assign(input.sources.sleep[0],{total_sleep_milli:0,sleep_need_baseline_milli:999999,sleep_need_debt_milli:999999});
  assert.equal(canonicalJson(calculate(input)),base);
  input.sources.sleep[0].sleep_performance_percentage=null;assert.equal(calculate(input).value,null);
  input.sources.sleep[0].sleep_performance_percentage=50;
  input.sources.recovery[0].sleep_id='different-sleep';assert.equal(calculate(input).quality_state,'NO_DATA');
  input.sources.recovery[0].sleep_id='sleep-00';input.sources.recovery.push({...input.sources.recovery[0]});
  assert.throws(()=>calculate(input),/DUPLICATE_MATCHED_RECOVERY/);
});

test('Main-sleep ordering, date alignment, source-version fences, tenant/auth/access and tombstones are exact',()=>{
  const input=bodyInput(),main=input.sources.sleep[0];
  input.sources.sleep.push({...main,id:'A',sleep_performance_percentage:75});
  input.sources.recovery.push({...input.sources.recovery[0],sleep_id:'A'});
  let selected=selectBodyEnergyInputs(input);assert.equal(selected.manifest.main_sleep.id,'A');assert.equal(calculateBodyEnergy(selected.manifest).value,80);
  input.sources.sleep.at(-1).updated_at=iso(input.asOfEpochMs-1);assert.equal(selectBodyEnergyInputs(input).manifest.main_sleep.id,'sleep-00');
  main.health_date='2026-09-18';assert.equal(calculate(input).quality_state,'DEGRADED');assert.ok(calculate(input).reasons.includes('HEALTH_DATE_REALIGNMENT'));
  main.health_date='2026-09-19';main.updated_at=null;input.sources.sleep.pop();assert.ok(calculate(input).reasons.includes('SOURCE_VERSION_UNKNOWN'));
  main.updated_at=iso(input.asOfEpochMs+1);assert.equal(selectBodyEnergyInputs(input).notReproducible,true);
  main.updated_at=iso(input.asOfEpochMs);main.synced_at=iso(input.asOfEpochMs+1);assert.equal(selectBodyEnergyInputs(input).notReproducible,true);
  main.synced_at=iso(input.asOfEpochMs);input.tombstones.push({user_id:'a',resource_type:'sleep',resource_id:main.id,state:'ACTIVE'});
  assert.notEqual(selectBodyEnergyInputs(input).manifest.main_sleep?.id,main.id);
  input.sources.sleep=input.sources.sleep.map(r=>({...r,user_id:'b'}));assert.equal(calculate(input).quality_state,'NO_DATA');
  input.access[0].lifecycle_generation=0;assert.equal(calculate(input).quality_state,'UNAVAILABLE');
  input.access[0].lifecycle_generation=1;input.authGeneration=2;assert.equal(calculate(input).quality_state,'UNAVAILABLE');
});

test('Earlier-only baselines select one daily main, latest 30/45 days and per-component valid values without current-day leakage',()=>{
  const input=bodyInput({days:50});
  let m=selectBodyEnergyInputs(input).manifest;
  assert.equal(m.baseline.hrv.length,30);assert.ok(m.baseline.hrv.every(x=>x.health_date<m.health_date));
  assert.equal(m.baseline.hrv[0].sleep.id,'sleep-01');assert.equal(m.baseline.hrv.at(-1).sleep.id,'sleep-30');
  input.sources.recovery[1].hrv_rmssd_milli=0;
  m=selectBodyEnergyInputs(input).manifest;assert.equal(m.baseline.hrv[0].sleep.id,'sleep-02');assert.equal(m.baseline.hrv.at(-1).sleep.id,'sleep-31');
  assert.equal(m.baseline.rhr[0].sleep.id,'sleep-01');
  input.sources.sleep.push({...input.sources.sleep[1],id:'earlier-same-day',end_at:iso(Date.parse(input.sources.sleep[1].end_at)-1000)});
  input.sources.recovery.push({...input.sources.recovery[1],sleep_id:'earlier-same-day',hrv_rmssd_milli:9999});
  assert.ok(!selectBodyEnergyInputs(input).manifest.baseline.hrv.some(x=>x.value===9999));
  input.sources.recovery[2].synced_at=iso(input.asOfEpochMs+1);assert.ok(!selectBodyEnergyInputs(input).manifest.baseline.hrv.some(x=>x.sleep.id==='sleep-02'));
  const old=bodyInput();old.asOfEpochMs+=36*hour;for(const row of old.sync){row.last_success_at=iso(old.asOfEpochMs);row.updated_at=iso(old.asOfEpochMs);}
  assert.ok(selectBodyEnergyInputs(old).manifest.main_sleep);old.asOfEpochMs+=1;assert.equal(selectBodyEnergyInputs(old).manifest.main_sleep,null);
});

test('Required sync and selected-load freshness boundaries are independent of physiological age',()=>{
  assert.equal(bodyFreshness(90*60000),1);assert.equal(bodyFreshness(6*hour),0.5);assert.equal(bodyFreshness(24*hour),0.2);assert.equal(bodyFreshness(24*hour+1),0);
  for(const [age,state,numeric] of [[90*60000,'AVAILABLE',true],[90*60000+1,'DEGRADED',true],[2*hour,'DEGRADED',true],[24*hour,'DEGRADED',true],[24*hour+1,'NO_DATA',false]]) {
    const input=bodyInput();input.sync.find(r=>r.resource==='recovery').last_success_at=iso(input.asOfEpochMs-age);
    const result=calculate(input);assert.equal(result.quality_state,state);assert.equal(result.value!==null,numeric);
  }
  const input=bodyInput();input.sync=input.sync.filter(r=>r.resource!=='sleep');assert.equal(calculate(input).quality_state,'NO_DATA');
  const future=bodyInput();future.sync[0].updated_at=iso(future.asOfEpochMs+1);
  assert.equal(calculate(future).quality_state,'NO_DATA');assert.equal(selectBodyEnergyInputs(future).notReproducible,true);
});

test('Current incomplete cycle selection and workout fallback are mutually exclusive, bounded and never prorated',()=>{
  const input=bodyInput();input.asOfEpochMs+=2*hour;
  const wake=input.asOfEpochMs-2*hour,workout={user_id:'a',id:'workout',start_at:iso(wake+60000),end_at:iso(wake+hour),strain:10,updated_at:iso(wake+hour),synced_at:iso(wake+hour)};
  input.sources.workout=[workout];input.sources.cycle[0].strain=10;
  let r=calculate(input);assert.equal(r.drivers.load_kind,'CYCLE');assert.equal(r.drivers.load_depletion,0.85*Math.pow(10,1.25));
  input.sources.cycle[0].strain=22;r=calculate(input);assert.equal(r.drivers.load_kind,'WORKOUT');assert.equal(r.drivers.load_depletion,0.75*Math.pow(10,1.15));
  input.sources.workout.push({...workout,id:'cross',start_at:iso(wake-1)},{...workout,id:'ongoing',end_at:null});
  let m=selectBodyEnergyInputs(input).manifest;assert.equal(m.load.rows.length,1);assert.ok(m.exclusions.some(e=>e.reason==='CROSSING_WAKE_WORKOUT_EXCLUDED'));
  assert.ok(m.exclusions.some(e=>e.reason==='ONGOING_WORKOUT_EXCLUDED'));
  input.sources.workout.push({...workout,id:'second',strain:21});assert.equal(calculate(input).drivers.load_depletion,24);
  input.sources.workout=[];assert.equal(calculate(input).drivers.load_depletion,0);assert.ok(calculate(input).reasons.includes('LOAD_UNAVAILABLE'));
  input.sources.cycle[0].strain=0;input.sources.cycle[0].start_at=iso(wake-2*hour);assert.equal(calculate(input).drivers.load_kind,'CYCLE');
  input.sources.cycle[0].start_at=iso(wake-2*hour-1);assert.equal(calculate(input).drivers.load_kind,'NONE');
  input.sources.cycle[0].start_at=iso(wake);input.sync.find(r=>r.resource==='cycle').last_success_at=iso(input.asOfEpochMs-6*hour);
  assert.equal(calculate(input).drivers.load_kind,'CYCLE');input.sync.find(r=>r.resource==='cycle').last_success_at=iso(input.asOfEpochMs-6*hour-1);
  assert.equal(calculate(input).drivers.load_kind,'NONE');
});

test('Qualified scored nap IDs count once with exact duration/wait bounds and no initial-charge overshoot',()=>{
  for(const [duration,wait,qualifies] of [[19.999,15,false],[20,15,true],[180,15,true],[180.001,15,false],[30,14.999,false]]) {
    const input=bodyInput();input.asOfEpochMs+=5*hour;
    const end=input.asOfEpochMs-wait*60000;
    const nap={...input.sources.sleep[0],id:'nap',nap:1,start_at:iso(end-duration*60000),end_at:iso(end)};
    input.sources.sleep.push(nap,{...nap});const r=calculate(input);
    assert.equal(r.drivers.nap_bumps.length,qualifies?1:0);assert.ok(r.value<=r.drivers.initial_charge);
  }
  const input=bodyInput();input.asOfEpochMs+=12*hour;
  for(let n=0;n<4;n++)input.sources.sleep.push({...input.sources.sleep[0],id:`nap-${n}`,nap:1,start_at:iso(input.asOfEpochMs-(n+4)*hour),end_at:iso(input.asOfEpochMs-(n+1)*hour)});
  const r=calculate(input);assert.ok(r.drivers.nap_bumps.every(n=>n.bump<=12));assert.equal(r.drivers.nap_recharge,15);
});

test('Deterministic output and seeded bounds/time/strain monotonicity retain IEEE precision',()=>{
  let seed=1729;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
  for(let n=0;n<250;n++) {
    const input=bodyInput(),sleep=random()*100,strain=random()*21;
    input.sources.sleep[0].sleep_performance_percentage=sleep;input.sources.cycle[0].strain=strain;
    const first=calculate(input);assert.ok(Number.isInteger(first.value)&&first.value>=0&&first.value<=100);
    assert.equal(canonicalJson(first),canonicalJson(calculate(structuredClone(input))));
    input.sources.sleep.reverse();input.sources.recovery.reverse();assert.equal(canonicalJson(first),canonicalJson(calculate(input)));
    input.sources.cycle[0].strain=Math.min(21,strain+random());assert.ok(calculate(input).value<=first.value);
    input.sources.cycle[0].strain=strain;input.asOfEpochMs+=random()*hour|0;assert.ok(calculate(input).value<=first.value);
  }
});

test('DST elapsed depletion uses UTC and exact millisecond / expanded-year identities reject rounding',()=>{
  for(const [wake,asOf] of [['2026-03-08T06:00:00.000Z','2026-03-08T08:00:00.000Z'],['2026-11-01T05:00:00.000Z','2026-11-01T07:00:00.000Z']]) {
    const input=bodyInput({asOf:Date.parse(wake),timezone:'America/New_York'});input.asOfEpochMs=Date.parse(asOf);
    for(const row of input.sources.sleep)row.health_date=bodyHealthDate(Date.parse(row.end_at),input.timezone);
    for(let n=0;n<input.sources.recovery.length;n++)input.sources.recovery[n].health_date=input.sources.sleep[n].health_date;
    assert.equal(calculate(input).drivers.wake_hours,2);assert.equal(calculate(input).drivers.time_depletion,3.2);
  }
  for(const ms of [-8640000000000000,8640000000000000,0,1])assert.equal(exactBodyInstant(ms),new Date(ms).toISOString());
  for(const ms of [NaN,Infinity,0.1,8640000000000001])assert.throws(()=>exactBodyInstant(ms),/INVALID_EXACT_AS_OF/);
  assert.throws(()=>exactBodyInstant(0,'1970-01-01T00:00:00Z'),/INVALID_EXACT_AS_OF/);
  assert.equal(bodyHealthDate(-62167219200000,'UTC'),'0000-01-01');
  assert.equal(validHealthDate('-271821-04-19'),true);assert.equal(validHealthDate('2026-02-29'),false);
  assert.equal(validHealthDate('0000-02-29'),true);assert.equal(validHealthDate('+001000-01-01'),false);
});

test('Domain inputs act once, both standardized components are required, and attainable endpoints are 0 and 100',()=>{
  const input=bodyInput();input.sources.recovery[0].hrv_rmssd_milli=1000;input.sources.recovery[0].resting_heart_rate=0.1;
  input.sources.sleep[0].sleep_performance_percentage=100;
  let r=calculate(input);assert.equal(r.drivers.hrv_score,100);assert.equal(r.drivers.rhr_score,100);assert.equal(r.value,100);
  input.sources.recovery[0].hrv_rmssd_milli=0.1;input.sources.recovery[0].resting_heart_rate=1000;input.sources.sleep[0].sleep_performance_percentage=0;
  input.asOfEpochMs+=36*hour;for(const row of input.sync){row.last_success_at=iso(input.asOfEpochMs);row.updated_at=iso(input.asOfEpochMs);}
  r=calculate(input);assert.equal(r.drivers.initial_charge,40);assert.equal(r.value,0);
  const partial=bodyInput({days:7});assert.equal(calculate(partial).quality_state,'LIMITED');assert.equal(calculate(partial).value,70);
  partial.sources.recovery[0].hrv_rmssd_milli=null;assert.equal(calculate(partial).value,null);
  partial.sources.recovery[0].hrv_rmssd_milli=50;assert.equal(calculate(partial).value,70);
  const one=bodyInput();const baseline=calculate(one);one.sources.recovery[0].hrv_rmssd_milli+=5;
  assert.ok(calculate(one).value>baseline.value);assert.equal(calculate(one).drivers.rhr_score,baseline.drivers.rhr_score);
  assert.equal(calculate(one).drivers.sleep_domain,baseline.drivers.sleep_domain);
});

test('Future inputs cannot change an earlier pure result and conflicting duplicate nap identities fail deterministically',()=>{
  const input=bodyInput(),prior=canonicalJson(calculate(input));
  input.sources.sleep.push({...input.sources.sleep[0],id:'future-sleep',end_at:iso(input.asOfEpochMs+hour),updated_at:iso(input.asOfEpochMs+hour)});
  input.sources.recovery.push({...input.sources.recovery[0],sleep_id:'future-sleep',hrv_rmssd_milli:99999});
  input.sources.workout.push({user_id:'a',id:'future-workout',start_at:iso(input.asOfEpochMs+1),end_at:iso(input.asOfEpochMs+hour),strain:21});
  assert.equal(canonicalJson(calculate(input)),prior);assert.equal(selectBodyEnergyInputs(input).notReproducible,true);
  const nap={...input.sources.sleep[0],id:'nap',nap:1,start_at:iso(input.asOfEpochMs+hour),end_at:iso(input.asOfEpochMs+2*hour)};
  input.sources.sleep.push(nap,{...nap,end_at:iso(input.asOfEpochMs+3*hour)});
  assert.throws(()=>calculate(input),/DUPLICATE_NAP_CONFLICT/);
});
