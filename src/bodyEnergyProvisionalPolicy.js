import {BODY_ENERGY as C,BODY_ENERGY_CONSTANTS_HASH} from './bodyEnergyRegistry.js';
import {bodyCycleMatchesSleep} from './bodyEnergyInputs.js';
import {meetsConfidenceThreshold} from './bodyEnergy.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from './bodyEnergyReleaseCriteria.js';

// Owner V3 §7 is a new presentation decision, not a replacement calculator,
// mature-score qualification packet, medical sufficiency claim or alert grant.
export const BODY_ENERGY_PROVISIONAL_POLICY=Object.freeze({
  version:'body-energy-owner-provisional-v1',authority:'OWNER_V3_SECTION_7',
  scope:'ORIGINAL_OWNER_PRESENTATION_COHORT',tier:'PROVISIONAL',storedQuality:'LIMITED',
  baselineTarget:30,alerts:false,
});
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function baselineOnlyProvisional({row,manifest:m,calculation:c}={}){
  if(!row||!m||!c||row.quality_state!=='LIMITED'||c.quality_state!=='LIMITED'
    ||c.algorithm_version!==C.algorithm||c.constants_hash!==BODY_ENERGY_CONSTANTS_HASH
    ||row.algorithm_version!==C.algorithm||row.value!==c.value||row.confidence!==c.confidence
    ||!Number.isInteger(row.value)||row.value<0||row.value>100||!finite(row.confidence)||row.confidence>1
    ||!meetsConfidenceThreshold(row.confidence,CRITERIA.confidenceMinimum)
    ||c.reasons?.length!==1||c.reasons[0]!=='BASELINE_LIMITED'||!Array.isArray(m.warnings)||m.warnings.length
    ||m.eligibility?.unavailable!==false||m.eligibility.failed_required!==false
    ||m.eligibility.required_sync_valid!==true||m.eligibility.matched_scored_recovery!==true
    ||m.main_sleep?.score_state!=='SCORED'||m.main_sleep.nap!==0||m.recovery?.score_state!=='SCORED'
    ||m.recovery.user_calibrating!==0||String(m.recovery.sleep_id)!==String(m.main_sleep.id)
    ||!finite(m.main_sleep.sleep_performance_percentage)||m.main_sleep.sleep_performance_percentage<0||m.main_sleep.sleep_performance_percentage>100
    ||!finite(m.recovery.hrv_rmssd_milli)||m.recovery.hrv_rmssd_milli<=0||!finite(m.recovery.resting_heart_rate)||m.recovery.resting_heart_rate<=0
    ||!Number.isFinite(Date.parse(m.wake_at_utc))||Date.parse(m.wake_at_utc)>m.as_of_epoch_ms
    ||!['CYCLE','WORKOUT'].includes(m.load?.kind)||!Array.isArray(m.load.rows)||!m.load.rows.length
    ||m.load.rows.some(r=>!finite(r.strain)||r.strain<0||r.strain>C.strainMax)||!m.load.sync
    ||!c.drivers||['initial_charge','time_depletion','load_depletion','nap_recharge','wake_hours'].some(k=>!finite(c.drivers[k])||c.drivers[k]<0))return false;
  if(Date.parse(m.main_sleep.end_at)!==Date.parse(m.wake_at_utc))return false;
  if(m.load.kind==='CYCLE'&&(m.load.rows.length!==1||!bodyCycleMatchesSleep(m.load.rows[0],m.main_sleep,m.recovery,m.as_of_epoch_ms)))return false;
  if(m.load.kind==='WORKOUT'&&m.load.rows.some(r=>!Number.isFinite(Date.parse(r.start_at))||!Number.isFinite(Date.parse(r.end_at))
    ||Date.parse(r.start_at)<Date.parse(m.wake_at_utc)||Date.parse(r.end_at)<=Date.parse(r.start_at)||Date.parse(r.end_at)>m.as_of_epoch_ms))return false;
  const bases=['hrv','rhr'].map(k=>c.drivers.baselines?.[k]);
  if(bases.some((b,i)=>!b||!b.usable||!Number.isSafeInteger(b.n)||b.n<C.baselineMinimum||b.n>C.baselineTarget
    ||!finite(b.scale)||b.scale<=0||!['MAD','IQR'].includes(b.method)
    ||m.baseline?.[['hrv','rhr'][i]]?.length!==b.n
    ||m.baseline[['hrv','rhr'][i]].some(x=>x.recovery?.user_calibrating!==0||x.recovery?.score_state!=='SCORED'))
    ||!bases.some(b=>b.n<C.baselineTarget))return false;
  // Selector, persisted reproduction, source-unit signature and currentness
  // remain mandatory in the caller. Never treat absent load as zero evidence.
  return true;
}
