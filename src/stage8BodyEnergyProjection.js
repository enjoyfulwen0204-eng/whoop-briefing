import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from './bodyEnergyReleaseCriteria.js';
import {calculateBodyEnergy} from './bodyEnergy.js';
import {baselineOnlyProvisional,BODY_ENERGY_PROVISIONAL_POLICY} from './bodyEnergyProvisionalPolicy.js';

/** Data-only presentation after the caller authenticates the current artifact,
 * original producer and signed publication. This grants no read/publication
 * authority and does not replace the source/receipt/currentness checks. */
export function stage8BodyEnergyProjection(row,asOfEpochMs){
 if(!row||!Number.isSafeInteger(asOfEpochMs)||!Number.isSafeInteger(row.as_of_epoch_ms)
  ||!Number.isInteger(row.value)||row.value<0||row.value>100)return null;
 let manifest,calculation;
 try{manifest=JSON.parse(row.input_manifest_json);calculation=calculateBodyEnergy(manifest);}catch{return null;}
 if(row.value!==calculation.value||row.quality_state!==calculation.quality_state
  ||row.confidence!==calculation.confidence||row.algorithm_version!==calculation.algorithm_version)return null;
 const elapsed=asOfEpochMs-row.as_of_epoch_ms,ages=[manifest.sync.sleep.age_ms,manifest.sync.recovery.age_ms,manifest.load.sync?.age_ms];
 if(elapsed<0||elapsed>CRITERIA.freshMaximumMs||ages.some(age=>typeof age!=='number'
  ||!Number.isFinite(age)||age<0||age+elapsed>CRITERIA.freshMaximumMs))return null;
 const provisional=row.quality_state==='LIMITED';
 if(provisional?!baselineOnlyProvisional({row,manifest,calculation}):row.quality_state!=='AVAILABLE')return null;
 return Object.freeze({value:row.value,quality:row.quality_state,estimated:true,
  ...(provisional?{provisional:true,presentationPolicy:BODY_ENERGY_PROVISIONAL_POLICY.version}:{}),
  interpretation:'KELVIN_HEALTH_OS_ENGINEERING_ESTIMATE_NOT_MEDICAL_OR_REALTIME'});
}

/** Only the dedicated qualified self-query reader requests this larger view.
 * It is data, never publication authority; canonical artifact/receipt checks
 * precede this function and the grant is checked again at final transport. */
export function stage8BodyEnergyPresentationView(row,asOfEpochMs){
 const projected=stage8BodyEnergyProjection(row,asOfEpochMs);if(!projected)return null;
 const manifest=JSON.parse(row.input_manifest_json),calculation=calculateBodyEnergy(manifest),sources=new Map();
 const include=(type,row,role)=>{if(!row)return;const id=String(row[type==='recovery'?'sleep_id':'id']),key=JSON.stringify([type,id]);
  const old=sources.get(key);if(old){old.roles.push(role);return;}
  sources.set(key,{type,id,updatedAt:row.updated_at??null,ingestedAt:row.synced_at,roles:[role]});};
 include('sleep',manifest.main_sleep,'MAIN_SLEEP');include('recovery',manifest.recovery,'MATCHED_RECOVERY');
 for(const metric of ['hrv','rhr'])for(const row of manifest.baseline[metric]){
  include('sleep',row.sleep,`BASELINE_${metric.toUpperCase()}`);include('recovery',row.recovery,`BASELINE_${metric.toUpperCase()}`);}
 for(const row of manifest.load.rows)include(manifest.load.kind==='CYCLE'?'cycle':'workout',row,'LOAD');
 for(const row of manifest.naps)include('sleep',row.source,'NAP');
 // Bound the explicit source explanation instead of returning a manifest.
 if(sources.size>200||manifest.exclusions.length>1000)return null;
 return Object.freeze({status:projected.provisional?'PROVISIONAL':'AVAILABLE',presentationPolicy:projected.presentationPolicy??null,
  healthDate:manifest.health_date,asOfUtc:manifest.as_of_utc,timezone:manifest.timezone,wakeAtUtc:manifest.wake_at_utc,
  value:projected.value,quality:projected.quality,confidence:row.confidence,algorithm:row.algorithm_version,
  constantsHash:calculation.constants_hash,drivers:Object.freeze({initialCharge:calculation.drivers.initial_charge,
   timeDepletion:calculation.drivers.time_depletion,loadDepletion:calculation.drivers.load_depletion,napRecharge:calculation.drivers.nap_recharge}),
  provenance:Object.freeze({included:Object.freeze({mainSleepId:manifest.main_sleep.id,recoverySleepId:manifest.recovery.sleep_id,
   hrvBaselineCount:manifest.baseline.hrv.length,rhrBaselineCount:manifest.baseline.rhr.length,loadKind:manifest.load.kind,
   loadIds:manifest.load.rows.map(row=>String(row.id)),napIds:manifest.naps.map(row=>String(row.source.id))}),
   sources:Object.freeze([...sources.values()].map(s=>Object.freeze({...s,roles:Object.freeze([...new Set(s.roles)].sort())}))),
   excluded:Object.freeze(manifest.exclusions.map(e=>Object.freeze({resource:e.resource,id:e.id,reason:e.reason}))),
   reasons:Object.freeze([...calculation.reasons]),confidenceMeaning:'DATA_QUALITY_NOT_PHYSIOLOGICAL_ACCURACY'})});
}
