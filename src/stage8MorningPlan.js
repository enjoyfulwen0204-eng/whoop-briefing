import {canonicalJson,createPhase4EntityStore} from './phase4EntityStore.js';
import {morningPlanTiming,MORNING_PLAN_VERSION} from './morningBriefPolicy.js';
import {localDate,localMidnightUtc,addDays} from './time.js';
import {createStage8MorningIntelligence,renderMorningIntelligence} from './stage8MorningIntelligence.js';
export const SMART_MORNING_PLAN_VERSION='morning-brief-v2-v35';
const authorities=new WeakMap();
export async function verifyMorningPlanAuthority(authority,core,context,row){const entry=authorities.get(authority);if(!entry||entry.core!==core)throw Error('MORNING_PLAN_AUTHORITY_REQUIRED');return entry.validate(context,row);}
const fail=code=>{throw Error(code);};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const sourceHash=(keys,row)=>keys.lookup(['morning-source-v1',canonicalJson(Object.fromEntries(Object.entries(row).filter(([k])=>k!=='synced_at')))]);
const copy={
 'zh-TW':{title:'今日健康簡報',body:'體能電量',sleep:'睡眠',recovery:'恢復',load:'目前負荷',insight:'個人分析',updating:'分析仍在更新',missing:'尚未取得可用資料',unavailable:'此帳號目前無法提供',pending:'等待評分',calibrating:'個人基準建立中',source:'WHOOP 來源紀錄',quality:'缺少資料的項目保持空缺；資料品質不是準確率。',asof:'資料截至'},
 en:{title:'Morning Brief',body:'Body Energy',sleep:'Sleep',recovery:'Recovery',load:'Current load',insight:'Personal analysis',updating:'Analysis is updating',missing:'Not available yet',unavailable:'Not available for this account',pending:'Waiting for scoring',calibrating:'Personal baseline is being established',source:'WHOOP source records',quality:'Missing inputs remain missing; data quality is not an accuracy probability.',asof:'Data as of'},
 vi:{title:'Bản tin sức khỏe',body:'Năng lượng cơ thể',sleep:'Giấc ngủ',recovery:'Phục hồi',load:'Tải hiện tại',insight:'Phân tích cá nhân',updating:'Phân tích đang cập nhật',missing:'Chưa có dữ liệu phù hợp',unavailable:'Tài khoản này chưa hỗ trợ',pending:'Đang chờ chấm điểm',calibrating:'Đang thiết lập mức nền cá nhân',source:'Bản ghi nguồn WHOOP',quality:'Dữ liệu thiếu vẫn được để trống; chất lượng dữ liệu không phải xác suất chính xác.',asof:'Dữ liệu tính đến'},
};
export function renderMorningPlan(plan){
 const c=copy[plan.locale]??copy['zh-TW'],value=section=>section.status==='CURRENT'?section.value:
  section.status==='UNAVAILABLE_ACCOUNT'?c.unavailable:section.status==='SCORE_PENDING'?c.pending:section.status==='CALIBRATING'?c.calibrating:c.missing;
 if(plan.version===SMART_MORNING_PLAN_VERSION){
  const body={'zh-TW':'體能電量（估計）: 目前沒有合格的估計',en:'Body Energy (estimate): No qualified estimate is available',vi:'Năng lượng cơ thể (ước tính): Chưa có ước tính đủ điều kiện'}[plan.locale]??'體能電量（估計）: 目前沒有合格的估計';
  return `${c.title} · ${plan.healthDate}\n${c.asof}: ${plan.asOfUtc}\n${body} · Kelvin Health OS\n${c.sleep}: ${value(plan.sections.sleep)}\n${c.recovery}: ${value(plan.sections.recovery)}\n${c.load}: ${value(plan.sections.load)}\n${c.source}\n${c.insight}: ${renderMorningIntelligence(plan.intelligence,plan.locale)}\n${c.quality}`;
 }
 return `${c.title} · ${plan.healthDate}\n${c.asof}: ${plan.asOfUtc}\n${c.body}: ${c.updating} · Kelvin Health OS\n${c.sleep}: ${value(plan.sections.sleep)}\n${c.recovery}: ${value(plan.sections.recovery)}\n${c.load}: ${value(plan.sections.load)}\n${c.source}\n${c.insight}: ${c.updating}\n${c.quality}`;
}
/** A bounded, same-tenant source plan, never a computation completion receipt.
 * It permits missingness without weakening ordinary derived-result readers. */
export function createStage8MorningPlan({core,db,preferences}){
 const {client,keys}=core,entities=createPhase4EntityStore(core),builtPlans=new WeakMap(),intelligence=createStage8MorningIntelligence({core});
 async function access(context,type){
  const unavailable=(await client.execute({sql:"SELECT 1 FROM whoop_capabilities WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')",args:[context.userId,type,context.lifecycleGeneration]})).rows.length;
  const row=(await client.execute({sql:'SELECT status FROM whoop_resource_access WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?',args:[context.userId,type,context.authGeneration,context.lifecycleGeneration]})).rows[0];
  return unavailable?'UNAVAILABLE_ACCOUNT':row?.status==='ACCESSIBLE'?'AUTHORIZED':'NOT_AUTHORIZED';
 }
 async function fresh(context,type){
  const sync=(await client.execute({sql:'SELECT last_success_at FROM whoop_sync_state WHERE user_id=? AND resource=?',args:[context.userId,type]})).rows[0];
  const narrow=(await client.execute({sql:'SELECT captured_at FROM morning_readiness_refreshes WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?',args:[context.userId,type,context.authGeneration,context.lifecycleGeneration]})).rows[0];
  const time=Math.max(...[sync?.last_success_at,narrow?.captured_at].map(value=>Number.isFinite(Date.parse(value))?Date.parse(value):0));
  return time<=core.now().getTime()&&core.now().getTime()-time<=90*60000;
 }
 async function state(context){
  const p=await preferences.read(await core.captureControl(context.userId));
  return {preferences:p,profileRevision:await db.getProfileRevision(context.userId),locale:await db.getLocale(context.userId)};
 }
 async function build(context,{healthDate,omitIntelligence=false}){
  if(context.executionMode!=='LIVE'||![34,35].includes(core.schemaVersion))fail('MORNING_LIVE_V34_REQUIRED');
  return core.run(context,async()=>{
   const captured=await state(context),asOf=core.now(),from=localMidnightUtc(healthDate,context.timezone).toISOString(),until=localMidnightUtc(addDays(healthDate,1),context.timezone).toISOString();
   const refs=[(await core.root(context,'USER',context.userId)).ref],proofs=[];
   const root=async(type,id)=>{const item=await core.root(context,type,String(id));refs.push(item.ref);proofs.push({type,id:String(id),hash:sourceHash(keys,item.row)});return item.row;};
   const statuses=Object.fromEntries(await Promise.all(['sleep','recovery','cycle'].map(async type=>{const state=await access(context,type);return [type,state==='AUTHORIZED'&&!await fresh(context,type)?'STALE_SOURCE':state];})));
   let sleep=null,recovery=null,cycle=null;
   if(statuses.sleep==='AUTHORIZED'){
    const rows=(await client.execute({sql:`SELECT id FROM whoop_sleeps r WHERE user_id=? AND nap=0 AND end_at>=? AND end_at<? AND end_at<=?
     AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=r.user_id AND t.resource_type='sleep' AND t.resource_id=r.id AND t.state='ACTIVE') ORDER BY end_at DESC,id LIMIT 1`,args:[context.userId,from,until,asOf.toISOString()]})).rows;
    if(rows[0])sleep=await root('sleep',rows[0].id);
   }
   if(sleep&&statuses.recovery==='AUTHORIZED'){
    const rows=(await client.execute({sql:`SELECT sleep_id FROM whoop_recoveries r WHERE user_id=? AND sleep_id=?
     AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=r.user_id AND t.resource_type='recovery' AND t.resource_id=r.sleep_id AND t.state='ACTIVE')`,args:[context.userId,sleep.id]})).rows;
    if(rows[0])recovery=await root('recovery',rows[0].sleep_id);
   }
   if(statuses.cycle==='AUTHORIZED'){
    const rows=(await client.execute({sql:`SELECT id FROM whoop_cycles r WHERE user_id=? AND start_at<=? AND (end_at IS NULL OR end_at>=?)
     AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=r.user_id AND t.resource_type='cycle' AND t.resource_id=CAST(r.id AS TEXT) AND t.state='ACTIVE') ORDER BY start_at DESC,id LIMIT 2`,args:[context.userId,asOf.toISOString(),asOf.toISOString()]})).rows;
    if(rows.length===1){const row=(await client.execute({sql:'SELECT synced_at FROM whoop_cycles WHERE user_id=? AND id=?',args:[context.userId,rows[0].id]})).rows[0];if(Number.isFinite(Date.parse(row.synced_at))&&Date.parse(row.synced_at)<=asOf.getTime()&&asOf.getTime()-Date.parse(row.synced_at)<=90*60000)cycle=await root('cycle',rows[0].id);}
   }
   const missing=(type,row)=>({status:statuses[type]!=='AUTHORIZED'?statuses[type]:!row?'NOT_AVAILABLE_YET':row.score_state!=='SCORED'?'SCORE_PENDING':'NOT_AVAILABLE_YET',value:null});
   const sections={sleep:missing('sleep',sleep),recovery:missing('recovery',recovery),load:missing('cycle',cycle)};
   if(sleep?.score_state==='SCORED'&&finite(sleep.total_sleep_milli))sections.sleep={status:'CURRENT',value:`${Math.round(sleep.total_sleep_milli/60000)} min`};
   if(sleep?.score_state==='SCORED'&&recovery?.score_state==='SCORED'){
    if(recovery.user_calibrating)sections.recovery={status:'CALIBRATING',value:null};
    else if(finite(recovery.recovery_score))sections.recovery={status:'CURRENT',value:`${recovery.recovery_score.toFixed(1)}%`};
   }
   if(cycle?.score_state==='SCORED'&&finite(cycle.strain)&&Number.isFinite(Date.parse(cycle.synced_at))&&Date.parse(cycle.synced_at)<=asOf.getTime()&&asOf.getTime()-Date.parse(cycle.synced_at)<=90*60000)sections.load={status:'CURRENT',value:cycle.strain.toFixed(1)};
   const wakeAt=sleep?.score_state==='SCORED'&&recovery?.score_state==='SCORED'&&!recovery.user_calibrating&&Number.isFinite(Date.parse(sleep.end_at))?Date.parse(sleep.end_at):null;
   const timing=morningPlanTiming({now:asOf.getTime(),day:healthDate,timezone:context.timezone,preferences:captured.preferences,wakeAt});
   const analysis=await intelligence.build(context,{asOfUtc:asOf.toISOString(),healthDate,omit:omitIntelligence});refs.push(...analysis.refs);
   const plan={version:SMART_MORNING_PLAN_VERSION,healthDate,asOfUtc:asOf.toISOString(),timezone:context.timezone,locale:captured.locale,
    intelligence:analysis.projection,bodyEnergy:{status:'UNAVAILABLE',reason:'QUALIFIED_ESTIMATE_NOT_AVAILABLE'},
    wakeAt,sections,proofs,preferenceVersion:captured.preferences.preference_version,profileRevision:captured.profileRevision,
    sourceGeneration:context.sourceGeneration,inputGeneration:context.inputGeneration,purgeGeneration:context.purgeGeneration,
    lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,expiresAt:new Date(timing.expiresAt).toISOString()};
   if(canonicalJson(await state(context))!==canonicalJson(captured))fail('MORNING_PROFILE_CHANGED');
   const built=Object.freeze({plan:Object.freeze(plan),refs:Object.freeze([...refs]),timing:Object.freeze(timing)});builtPlans.set(built,{context,plan:structuredClone(plan),refs});return built;
  });
 }
 async function persist(context,built){
  const captured=builtPlans.get(built);if(!captured||captured.context!==context)fail('MORNING_REGISTERED_PLAN_REQUIRED');
  const {plan,refs}=captured,planId=core.newId(),json=canonicalJson(plan);
  if(core.now().getTime()-Date.parse(plan.asOfUtc)>120000||canonicalJson(plan)!==canonicalJson(built.plan))fail('MORNING_PLAN_CHANGED');
  return entities.append(context,'morning_brief_plans',{plan_id:planId,health_date:plan.healthDate,as_of_utc:plan.asOfUtc,
   plan_version:plan.version,plan_json:json,plan_hmac:keys.lookup(['morning-plan-v1',context.userId,'LIVE',planId,json]),
   preference_version:plan.preferenceVersion,profile_revision:plan.profileRevision,source_generation:context.sourceGeneration,expires_at:plan.expiresAt},refs);
 }
 async function read(context,planId){
  if(context.executionMode!=='LIVE')fail('MORNING_TYPED_PLAN_REQUIRED');
  const {row}=await core.artifact(context,'morning_brief_plans',{plan_id:planId}),plan=JSON.parse(row.plan_json);
  if(![MORNING_PLAN_VERSION,SMART_MORNING_PLAN_VERSION].includes(row.plan_version)||row.plan_version!==plan.version||row.plan_hmac!==keys.lookup(['morning-plan-v1',context.userId,'LIVE',row.plan_id,row.plan_json])
   ||row.health_date!==plan.healthDate||plan.timezone!==context.timezone||row.source_generation!==context.sourceGeneration
   ||plan.purgeGeneration!==context.purgeGeneration||plan.inputGeneration!==context.inputGeneration)fail('MORNING_PLAN_MISMATCH');
  const current=await state(context);
  if(row.preference_version!==current.preferences.preference_version||row.profile_revision!==current.profileRevision||plan.locale!==current.locale||current.preferences.notifications_paused)fail('MORNING_PREFERENCE_CHANGED');
  if(core.now().getTime()<Date.parse(plan.asOfUtc)||core.now().getTime()-Date.parse(plan.asOfUtc)>90*60000||core.timestamp()>=row.expires_at)fail('MORNING_PLAN_EXPIRED');
  for(const proof of plan.proofs){if(!['sleep','recovery','cycle'].includes(proof.type)||await access(context,proof.type)!=='AUTHORIZED'||!await fresh(context,proof.type))fail('MORNING_RESOURCE_REVOKED');
   const actual=await core.root(context,proof.type,proof.id);if(proof.type==='cycle'&&(!Number.isFinite(Date.parse(actual.row.synced_at))||Date.parse(actual.row.synced_at)>core.now().getTime()||core.now().getTime()-Date.parse(actual.row.synced_at)>90*60000))fail('MORNING_SOURCE_STALE');if(sourceHash(keys,actual.row)!==proof.hash)fail('MORNING_SOURCE_CHANGED');}
  if(plan.version===SMART_MORNING_PLAN_VERSION){
   if(plan.intelligence?.asOfUtc!==plan.asOfUtc||plan.intelligence?.healthDate!==plan.healthDate||plan.bodyEnergy?.status!=='UNAVAILABLE')fail('MORNING_PLAN_MISMATCH');
   await intelligence.validate(context,plan.intelligence);
  }
  return {row,plan};
 }
 async function validate(context,message){
  const payload=JSON.parse(message.payload_json??'null');if(message.message_class!=='MORNING_BRIEF_V1'||!payload?.morningPlanId)fail('MORNING_TYPED_PLAN_REQUIRED');
  const found=await read(context,payload.morningPlanId);
  if(found.plan.healthDate!==payload.healthDate||found.plan.timezone!==payload.timezone||message.payload_text!==renderMorningPlan(found.plan)
   ||message.payload_hash!==keys.digest(message.content_digest_salt,canonicalJson([message.payload_text,message.payload_json])))fail('MORNING_PLAN_MISMATCH');
  return found;
 }
 const authority=Object.freeze({build,persist,read,validate,render:renderMorningPlan});authorities.set(authority,{core,validate});return authority;
}
