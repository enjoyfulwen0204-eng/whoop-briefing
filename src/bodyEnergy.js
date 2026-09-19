import { BODY_ENERGY as C, BODY_ENERGY_CONSTANTS_HASH, bodyEnergyVersion } from './bodyEnergyRegistry.js';
import { fail } from './phase4Core.js';
import { exactBodyInstant } from './bodyEnergyInputs.js';

export const clamp=(lo,hi,value)=>Math.min(hi,Math.max(lo,value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function linearQuantile(sorted,p) {
  if(!sorted.length)return null;
  const h=(sorted.length-1)*p,lo=Math.floor(h),hi=Math.ceil(h);
  return sorted[lo]+(h-lo)*(sorted[hi]-sorted[lo]);
}
export function robustBaseline(values) {
  const sorted=values.filter(x=>finite(x)&&x>0).sort((a,b)=>a-b),n=sorted.length;
  const center=linearQuantile(sorted,0.5);
  const mad=center===null?null:linearQuantile(sorted.map(x=>Math.abs(x-center)).sort((a,b)=>a-b),0.5);
  const iqr=n?linearQuantile(sorted,0.75)-linearQuantile(sorted,0.25):null;
  const scale=mad>0?mad*C.madScale:iqr>0?iqr/C.iqrScale:null;
  return {n,center,mad,iqr,scale,method:mad>0?'MAD':iqr>0?'IQR':null,usable:n>=C.baselineMinimum&&scale!==null,
    readiness:n<C.baselineMinimum?'BASELINE_WARMING_UP':n<C.baselineTarget?'BASELINE_LIMITED':'BASELINE_MATURE'};
}
export function initialBodyCharge(sleep,autonomic) {
  if(![sleep,autonomic].every(x=>finite(x)&&x>=0&&x<=100))return null;
  return Math.round(clamp(C.initialFloor,100,C.initialFloor+C.initialGain*(C.sleepWeight*sleep+C.autonomicWeight*autonomic)));
}
export function bodyFreshness(ageMs) {
  if(!finite(ageMs)||ageMs<0||ageMs>C.requiredSyncMaxHours*3600000)return 0;
  const hours=ageMs/3600000;
  if(hours<=1.5)return 1;
  if(hours<=6)return 1-(hours-1.5)*0.5/4.5;
  return 0.5-(hours-6)*0.3/18;
}
export function bodyQuality({unavailable,noData,degraded,warming,limited}) {
  return unavailable?'UNAVAILABLE':noData?'NO_DATA':degraded?'DEGRADED':warming?'WARMING_UP':limited?'LIMITED':'AVAILABLE';
}
/** Pure, synchronous and full precision. Only initial and final scores round.
 * No Journal, Recovery score, sleep duration/need/debt or LLM substitution. */
export function calculateBodyEnergy(manifest) {
  bodyEnergyVersion(manifest?.algorithm_version);
  if(manifest.manifest_version!==C.manifest||manifest.constants_version!==C.constants||manifest.baseline_version!==C.baseline
    ||manifest.metric_registry_version!==C.metrics||manifest.constants_hash!==BODY_ENERGY_CONSTANTS_HASH)fail('BODY_ENERGY_MANIFEST_VERSION_UNREGISTERED');
  exactBodyInstant(manifest.as_of_epoch_ms,manifest.as_of_utc);
  const reasons=new Set(manifest.reasons),warnings=new Set(manifest.warnings);
  const value=(raw,name,valid)=>{
    if(raw==null){reasons.add(`${name}_MISSING`);return null;}
    if(!finite(raw)||!valid(raw)){reasons.add(`${name}_INVALID`);warnings.add(`${name}_INVALID`);return null;}
    return raw;
  };
  const sleep=value(manifest.main_sleep?.sleep_performance_percentage,'SLEEP_PERFORMANCE',x=>x>=0&&x<=100);
  const hrv=value(manifest.recovery?.hrv_rmssd_milli,'HRV',x=>x>0),rhr=value(manifest.recovery?.resting_heart_rate,'RHR',x=>x>0);
  const calibrationValid=manifest.recovery?.user_calibrating===0;
  if(manifest.recovery&&!calibrationValid){warnings.add('RECOVERY_CALIBRATION_UNVERIFIED');reasons.add('RECOVERY_CALIBRATION_UNVERIFIED');}
  const baseline={hrv:robustBaseline(manifest.baseline.hrv.map(x=>x.value)),rhr:robustBaseline(manifest.baseline.rhr.map(x=>x.value))};
  for(const name of ['hrv','rhr']) {
    if(baseline[name].n<C.baselineMinimum)reasons.add('INSUFFICIENT_BASELINE');
    if(baseline[name].scale===null)reasons.add('BASELINE_SCALE_UNAVAILABLE');
    if(baseline[name].n>=C.baselineMinimum&&baseline[name].n<C.baselineTarget)reasons.add('BASELINE_LIMITED');
  }
  const z=(current,base)=>current!==null&&base.usable&&calibrationValid?clamp(-C.zLimit,C.zLimit,(current-base.center)/base.scale):null;
  const hrvZ=z(hrv,baseline.hrv),rhrZ=z(rhr,baseline.rhr);
  const hrvScore=hrvZ===null?null:clamp(0,100,50+(50/3)*hrvZ),rhrScore=rhrZ===null?null:clamp(0,100,50-(50/3)*rhrZ);
  const autonomic=hrvScore!==null&&rhrScore!==null?(hrvScore+rhrScore)/2:null;
  const requiredInvalid=manifest.eligibility.failed_required||!calibrationValid
    ||[...reasons].some(code=>['SLEEP_PERFORMANCE_INVALID','HRV_INVALID','RHR_INVALID'].includes(code));
  const eligible=!manifest.eligibility.unavailable&&manifest.eligibility.required_sync_valid&&!requiredInvalid
    &&manifest.main_sleep!==null&&manifest.eligibility.matched_scored_recovery;
  const initial=eligible?initialBodyCharge(sleep,autonomic):null;
  const hours=manifest.wake_at_utc===null?0:Math.max(0,(manifest.as_of_epoch_ms-Date.parse(manifest.wake_at_utc))/3600000);
  const time=C.earlyDepletion*Math.min(hours,C.firstWakeHours)+C.lateDepletion*Math.max(hours-C.firstWakeHours,0);
  const load=manifest.load.kind==='CYCLE'?C.cycleMultiplier*Math.pow(manifest.load.rows[0].strain,C.cycleExponent)
    :manifest.load.kind==='WORKOUT'?Math.min(C.workoutCap,C.workoutMultiplier*manifest.load.rows.reduce((sum,r)=>sum+Math.pow(r.strain,C.workoutExponent),0)):0;
  const napBumps=manifest.naps.map(n=>({id:n.source.id,bump:Math.min(C.napCap,C.napBase+C.napPerMinute*n.duration_minutes)}));
  const nap=Math.min(C.napDayCap,napBumps.reduce((sum,n)=>sum+n.bump,0));
  const raw=initial===null?null:initial-time-load+nap;
  const score=raw===null?null:Math.round(clamp(0,initial,raw));
  const completeness=C.sleepWeight*(sleep!==null?1:0)+C.autonomicWeight*((hrv!==null?1:0)+(rhr!==null?1:0))/2;
  const freshness=Math.min(bodyFreshness(manifest.sync.sleep.age_ms),bodyFreshness(manifest.sync.recovery.age_ms),
    ...(manifest.load.sync?[bodyFreshness(manifest.load.sync.age_ms)]:[]));
  const baselineConfidence=(['hrv','rhr'].reduce((sum,name)=>sum+(baseline[name].usable?clamp(0,1,baseline[name].n/C.baselineTarget):0),0))/2;
  const validity=manifest.eligibility.unavailable||requiredInvalid||!manifest.main_sleep||!manifest.eligibility.matched_scored_recovery?0:warnings.size?0.5:1;
  const confidence=clamp(0,1,0.35*completeness+0.25*freshness+0.25*baselineConfidence+0.15*validity);
  const noData=!manifest.main_sleep||!manifest.eligibility.matched_scored_recovery||!manifest.eligibility.required_sync_valid;
  const warming=(hrv!==null&&!baseline.hrv.usable)||(rhr!==null&&!baseline.rhr.usable);
  const quality=bodyQuality({unavailable:manifest.eligibility.unavailable,noData,degraded:warnings.size>0||manifest.eligibility.failed_required,
    warming,limited:sleep===null||hrv===null||rhr===null||baseline.hrv.n<C.baselineTarget||baseline.rhr.n<C.baselineTarget||confidence<0.80});
  for(const warning of warnings)reasons.add(warning);
  return {algorithm_version:C.algorithm,constants_version:C.constants,baseline_version:C.baseline,metric_registry_version:C.metrics,
    constants_hash:BODY_ENERGY_CONSTANTS_HASH,authorship:'Kelvin Health OS',interpretation:'Engineering estimate; not a diagnosis or medical-safety prediction.',
    value:score,quality_state:quality,confidence,confidence_label:confidence>=0.8?'HIGH':confidence>=0.6?'MEDIUM':confidence>=0.4?'LOW':'INSUFFICIENT',
    reasons:[...reasons].sort(),drivers:{sleep_domain:sleep,hrv_z:hrvZ,rhr_z:rhrZ,hrv_score:hrvScore,rhr_score:rhrScore,autonomic_domain:autonomic,
      domain_mean:sleep===null||autonomic===null?null:C.sleepWeight*sleep+C.autonomicWeight*autonomic,
      initial_charge:initial,wake_hours:hours,time_depletion:time,load_kind:manifest.load.kind,load_depletion:load,
      nap_bumps:napBumps,nap_recharge:nap,raw,baselines:baseline,
      confidence_components:{completeness,freshness,baseline:baselineConfidence,source_validity:validity}}};
}
