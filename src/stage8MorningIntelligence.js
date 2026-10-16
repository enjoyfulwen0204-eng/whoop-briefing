import {canonicalJson} from './phase4EntityStore.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {verifyStage8LivePublication} from './stage8LivePublication.js';
import {stage8EvidenceProjection,stage8AssociationProjection,stage8EvidenceItemSelection} from './stage8DerivedReader.js';
import {PHASE4_METRICS} from './phase4IntelligenceRegistry.js';
import {formatNumber,t} from './localization.js';

export const MORNING_INTELLIGENCE_VERSION='morning-intelligence-v1';
const optionalFailures=new WeakSet();
export const isOptionalMorningIntelligenceFailure=error=>Boolean(error&&typeof error==='object'&&optionalFailures.has(error));
const recoverable=new Set(['PHASE4_PARENT_STALE','PHASE4_PARENT_NOT_FOUND','CONTENT_REDACTED','PHASE4_SOURCE_DELETED','PHASE4_SOURCE_NOT_FOUND','PHASE4_SOURCE_NOT_CURRENT','PHASE4_RESOURCE_FENCED','PHASE4_CAPABILITY_FENCED','PHASE4_INCOMPLETE_PROVENANCE','PHASE4_PARENT_LINK_MISSING','PHASE4_SOURCE_LINK_REQUIRED']);
const copy={
 'zh-TW':{updating:'分析仍在更新',empty:'目前沒有合格的當期觀察；證據不足不代表沒有健康變化。',unavailable:'目前無法驗證分析；本次簡報保留可用的來源紀錄。',baseline:'個人基準比較',current:'當期值',median:'個人基準中位數',samples:'基準樣本數',limited:'資料品質有限',source:'已驗證的 WHOOP 與日誌證據',nonCausal:'歷史關聯不代表因果。',asof:'分析截至',minutes:'分鐘',respiratory:'呼吸率'},
 en:{updating:'Analysis is updating',empty:'No qualifying current observation is available; insufficient evidence does not mean no health change.',unavailable:'Analysis cannot currently be verified; available source records remain in this brief.',baseline:'Personal baseline comparison',current:'Current',median:'Personal baseline median',samples:'Baseline samples',limited:'Limited data quality',source:'Verified WHOOP and journal evidence',nonCausal:'Historical association is not causation.',asof:'Analysis as of',minutes:'minutes',respiratory:'Respiratory rate'},
 vi:{updating:'Phân tích đang cập nhật',empty:'Chưa có quan sát hiện tại đủ điều kiện; thiếu bằng chứng không có nghĩa là không có thay đổi sức khỏe.',unavailable:'Hiện chưa thể xác minh phân tích; bản tin vẫn giữ các bản ghi nguồn phù hợp.',baseline:'So sánh mức nền cá nhân',current:'Hiện tại',median:'Trung vị mức nền cá nhân',samples:'Số mẫu nền',limited:'Chất lượng dữ liệu hạn chế',source:'Bằng chứng WHOOP và nhật ký đã xác minh',nonCausal:'Mối liên hệ trong lịch sử không phải quan hệ nhân quả.',asof:'Phân tích tính đến',minutes:'phút',respiratory:'Nhịp thở'},
};
const factors={alcohol:'alcohol',caffeine:'caffeine',stress:'stress',late_meal:'lateMeal',late_sleep:'lateSleep',sickness:'sickness',travel:'travel',exercise_note:'exercise',sauna:'sauna',supplement:'supplement',medication:'medication',flight:'flight',location:'location',massage:'massage',food:'food',custom:'custom'};
const metric=key=>key!=='body_energy'&&Object.hasOwn(PHASE4_METRICS,key);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const metricLabel=(key,locale,c)=>key==='respiratory_rate'?c.respiratory:t(locale,`metric.${key}`);
export function renderMorningIntelligence(value,locale){
 const c=copy[locale]??copy['zh-TW'];
 if(!value||value.status==='ANALYSIS_UPDATING')return c.updating;
 if(value.status==='UNAVAILABLE')return c.unavailable;
 if(value.status!=='CURRENT')return c.empty;
 const lines=[];
 for(const observation of value.observations.slice(0,2)){
  const e=observation.evidence,unit=e.unit==='minutes'?c.minutes:({score:'',percent:'%',breaths_per_minute:'/min',strain:''}[e.unit]??e.unit),number=n=>formatNumber(locale,n,1);
  if(observation.kind==='ASSOCIATION')lines.push(t(locale,'beta.associationSupported',{factor:t(locale,`factor.${factors[observation.factor]}`),metric:metricLabel(observation.metricKey,locale,c),direction:t(locale,`beta.direction${observation.direction==='HIGHER'?'Higher':'Lower'}`)}),c.nonCausal);
  else lines.push(`${c.baseline} · ${metricLabel(observation.metricKey,locale,c)}: ${c.current} ${number(e.current)} ${unit} · ${c.median} ${number(e.baseline.median)} ${unit} · ${c.samples} ${e.samples}${e.quality==='LIMITED'?` · ${c.limited}`:''}`);
  lines.push(`${c.asof}: ${e.asOfUtc}`);
 }
 // A baseline uses WHOOP alone; an association additionally uses explicitly
 // recorded Journal exposures. Never imply a Journal source was consulted
 // when the accepted observations contain only personal baselines.
 const source=value.observations.some(observation=>observation.kind==='ASSOCIATION')?c.source:({'zh-TW':'已驗證的 WHOOP 證據',en:'Verified WHOOP evidence',vi:'Bằng chứng WHOOP đã xác minh'}[locale]??'已驗證的 WHOOP 證據');
 lines.push(source);return lines.join('\n');
}
/** Optional presentation of existing finalized calculations only. No queue,
 * producer, model, provider or calculation capability is held here. */
export function createStage8MorningIntelligence({core}){
 const stores=composePhase4Stores(core),{client,keys}=core;
 const unavailable=(asOfUtc,healthDate,status='ANALYSIS_UPDATING')=>({projection:{version:MORNING_INTELLIGENCE_VERSION,status,asOfUtc,healthDate,observations:[]},refs:[]});
 async function build(context,{asOfUtc,healthDate,omit=false}){
  if(omit)return unavailable(asOfUtc,healthDate,'UNAVAILABLE');
  if(core.schemaVersion!==35||!core.liveAllocation||context.executionMode!=='LIVE'||!context.providerRequired)return unavailable(asOfUtc,healthDate);
  const asOf=Date.parse(asOfUtc);if(!Number.isFinite(asOf)||asOf>core.now().getTime())throw Error('MORNING_INTELLIGENCE_ASOF_INVALID');
  const publication=(await client.execute({sql:'SELECT publication_hmac,issued_at,expires_at FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[context.userId,context.inputGeneration]})).rows[0];
  // Missing publication is ordinary updating, never a request to run analysis.
  if(!publication||publication.issued_at>asOf||!await verifyStage8LivePublication(core,context))return unavailable(asOfUtc,healthDate);
  const refs=[],observations=[],seen=new Set(),expiries=[publication.expires_at],evidenceCache=new Map();
  const evidence=async id=>{
   if(evidenceCache.has(id))return evidenceCache.get(id);
   const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:id}),run=await stores.readArtifact(context,'evidence_runs',{run_id:item.row.run_id});
   if(Date.parse(run.row.completed_at)>asOf||Date.parse(run.row.as_of_utc)>asOf)return null;
   const value=stage8EvidenceProjection(run.row,item.row);
   if(!value||!metric(value.metricKey)||value.nonCausal!==true)return null;
   refs.push(item.ref,run.ref);evidenceCache.set(id,value);return value;
  };
  const baseline=e=>e?.outcome==='PERSONAL_BASELINE_COMPARISON'&&['AVAILABLE','LIMITED'].includes(e.quality)
   &&metric(e.metricKey)&&e.samples>=PHASE4_METRICS[e.metricKey].baselineMinimum&&validTime(e.observedAt)
   &&Date.parse(e.observedAt)<=asOf&&asOf-Date.parse(e.observedAt)<=PHASE4_METRICS[e.metricKey].stalenessLimitMs
   &&[e.current,e.baseline?.median,e.baseline?.q1,e.baseline?.q3,e.delta].every(Number.isFinite);
  try{
   const episodes=(await client.execute({sql:"SELECT episode_id FROM observation_episodes WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING') AND content_state='PRESENT' AND invalidated_at IS NULL AND expires_at>? AND last_observed_at<=? ORDER BY last_observed_at DESC,episode_id LIMIT 4",args:[context.userId,context.inputGeneration,asOfUtc,asOfUtc]})).rows;
   for(const {episode_id} of episodes){
    if(observations.length===2)break;
    const episode=await stores.readArtifact(context,'observation_episodes',{episode_id}),e=await evidence(episode.row.latest_evidence_item_id);
    if(!baseline(e)||e.metricKey!==episode.row.subject_key||seen.has(e.metricKey))continue;
    refs.push(episode.ref);expiries.push(Date.parse(episode.row.expires_at),Date.parse(e.observedAt)+PHASE4_METRICS[e.metricKey].stalenessLimitMs);seen.add(e.metricKey);observations.push({kind:'BASELINE',metricKey:e.metricKey,evidence:e});
   }
   const insights=observations.length<2?(await client.execute({sql:"SELECT id FROM health_insights WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND status='SUPPORTED' AND legacy_classification='PHASE4' AND content_state='PRESENT' AND expires_at>? AND last_recalculated_at<=? ORDER BY last_recalculated_at DESC,id LIMIT 4",args:[context.userId,context.inputGeneration,asOfUtc,asOfUtc]})).rows:[];
   for(const {id} of insights){
    if(observations.length===2)break;
    const insight=await stores.readArtifact(context,'health_insights',{id}),association=stage8AssociationProjection(insight.revision?.normalized_claim),support=JSON.parse(insight.revision?.supporting_evidence_ids_json??'null');
    if(!association||seen.has(association.metricKey)||!Array.isArray(support)||!support.length||support.length>20)continue;
    const accepted=[];for(const evidenceId of support){const e=await evidence(evidenceId);if(!e||e.outcome!=='REPEATED_ASSOCIATION_EVIDENCE'||!['AVAILABLE','LIMITED'].includes(e.quality)||e.factor!==association.factor||e.metricKey!==association.metricKey||e.direction!==association.direction)break;accepted.push(e);}
    if(accepted.length!==support.length)continue;
    refs.push(insight.ref);expiries.push(Date.parse(insight.row.expires_at));seen.add(association.metricKey);observations.push({kind:'ASSOCIATION',...association,evidence:accepted[0]});
   }
   // A normal personal-baseline result is useful even without an anomaly.
   const runs=observations.length<2?(await client.execute({sql:"SELECT run_id FROM evidence_runs WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND method='PERSONAL_BASELINE_DEVIATION' AND state='COMPLETED' AND content_state='PRESENT' AND invalidated_at IS NULL AND completed_at<=? ORDER BY completed_at DESC,run_id LIMIT 4",args:[context.userId,context.inputGeneration,asOfUtc]})).rows:[];
   for(const {run_id} of runs){
    if(observations.length===2)break;
    const entries=(await client.execute(stage8EvidenceItemSelection(context,context.inputGeneration,run_id))).rows;
    for(const {evidence_item_id} of entries){const e=await evidence(evidence_item_id);if(!baseline(e)||seen.has(e.metricKey))continue;expiries.push(Date.parse(e.observedAt)+PHASE4_METRICS[e.metricKey].stalenessLimitMs);seen.add(e.metricKey);observations.push({kind:'BASELINE',metricKey:e.metricKey,evidence:e});if(observations.length===2)break;}
   }
   await core.assertContext(context);
   if(!await verifyStage8LivePublication(core,context)||!expiries.every(Number.isFinite)||Math.min(...expiries)<=core.now().getTime())return unavailable(asOfUtc,healthDate);
   const projection={version:MORNING_INTELLIGENCE_VERSION,status:observations.length?'CURRENT':'NO_QUALIFYING_RESULT',asOfUtc,healthDate,validUntil:new Date(Math.min(...expiries)).toISOString(),publication:publication.publication_hmac,observations};
   return {projection,refs};
  }catch(error){if(error instanceof SyntaxError||recoverable.has(error?.code??error?.message))optionalFailures.add(error);throw error;}
 }
 async function validate(context,projection){
  if(projection?.version!==MORNING_INTELLIGENCE_VERSION)throw Error('MORNING_INTELLIGENCE_MISMATCH');
  if(['ANALYSIS_UPDATING','UNAVAILABLE'].includes(projection.status))return true;
  if(!validTime(projection.validUntil)||core.timestamp()>=projection.validUntil){const error=Error('MORNING_INTELLIGENCE_EXPIRED');optionalFailures.add(error);throw error;}
  const current=await build(context,{asOfUtc:projection.asOfUtc,healthDate:projection.healthDate});
  if(canonicalJson(current.projection)!==canonicalJson(projection)){const error=Error('MORNING_INTELLIGENCE_CHANGED');optionalFailures.add(error);throw error;}
  return true;
 }
 return Object.freeze({build,validate});
}
