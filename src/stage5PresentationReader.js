import {createPhase4Foundation} from './phase4Foundation.js';
import {isApprovedStage7Three} from './stage7Cohort.js';
import {t,formatNumber} from './localization.js';

const COPY={
 'zh-TW':{title:'🔎 個人健康分析',provenance:'來源：Stage 5 SHADOW 分析；此畫面不會啟用 LIVE 計算。',empty:'目前沒有可驗證的合格分析結果；可能仍在更新或證據不足。沒有結果不代表沒有健康變化。',unavailable:'此分析目前無法使用，請稍後再試。',association:'觀察性關聯，不代表因果。',episodes:'📈 有證據支持的變化',evidence:'🧾 分析證據',asof:'查詢時間',period:'資料期間',samples:'樣本數',current:'當期值',baseline:'個人基準中間 50% 範圍',delta:'與基準的差異',groups:'有記錄／明確記錄未發生',sources:'WHOOP 來源與你明確記錄的日誌',details:'🧾 查看證據：/evidence phase4',summary:'🔎 查看分析：/insights phase4',limited:'資料品質有限',available:'資料品質合格'},
 en:{title:'🔎 Personal health analysis',provenance:'Source: Stage 5 SHADOW analysis; this view does not enable LIVE computation.',empty:'No verified qualifying analysis is available. Analysis may be updating or evidence may be insufficient. No result does not mean no health change.',unavailable:'This analysis is currently unavailable. Please try again later.',association:'Observational association, not causation.',episodes:'📈 Evidence-supported changes',evidence:'🧾 Analysis evidence',asof:'Query time',period:'Source period',samples:'Samples',current:'Current value',baseline:'Middle 50% of your personal baseline',delta:'Difference from baseline',groups:'Recorded exposure / explicitly recorded non-exposure',sources:'WHOOP sources and your explicit journal records',details:'🧾 View evidence: /evidence phase4',summary:'🔎 View analysis: /insights phase4',limited:'Limited data quality',available:'Qualified data quality'},
 vi:{title:'🔎 Phân tích sức khỏe cá nhân',provenance:'Nguồn: phân tích SHADOW Giai đoạn 5; màn hình này không bật tính toán LIVE.',empty:'Chưa có phân tích đủ điều kiện đã được xác minh. Phân tích có thể đang cập nhật hoặc chưa đủ bằng chứng. Không có kết quả không có nghĩa là không có thay đổi sức khỏe.',unavailable:'Hiện chưa thể xem phân tích này. Vui lòng thử lại sau.',association:'Mối liên hệ quan sát, không phải quan hệ nhân quả.',episodes:'📈 Thay đổi có bằng chứng',evidence:'🧾 Bằng chứng phân tích',asof:'Thời điểm truy vấn',period:'Khoảng dữ liệu nguồn',samples:'Số mẫu',current:'Giá trị hiện tại',baseline:'Khoảng 50% giữa của dữ liệu nền cá nhân',delta:'Chênh lệch so với dữ liệu nền',groups:'Có ghi nhận / xác nhận không xảy ra',sources:'Nguồn WHOOP và nhật ký bạn đã ghi rõ',details:'🧾 Xem bằng chứng: /evidence phase4',summary:'🔎 Xem phân tích: /insights phase4',limited:'Chất lượng dữ liệu hạn chế',available:'Chất lượng dữ liệu đủ điều kiện'},
};
const METRICS=new Set(['recovery_score','hrv','rhr','sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain']);
const FACTORS={alcohol:'alcohol',caffeine:'caffeine',stress:'stress',late_meal:'lateMeal',late_sleep:'lateSleep',sickness:'sickness',travel:'travel',exercise_note:'exercise',sauna:'sauna',supplement:'supplement',medication:'medication',flight:'flight',location:'location',massage:'massage',food:'food',custom:'custom'};
const command=text=>/^\/(insights|evidence)(?:@[a-z0-9_]+)?\s+phase4\s*$/iu.exec(String(text??'').trim());
export const isStage5PresentationCommand=text=>/^\/(insights|evidence)(?:@[a-z0-9_]+)?\s+phase4(?:\s|$)/iu.test(String(text??'').trim());
export const stage5PresentationUnavailable=locale=>(COPY[locale]??COPY.en).unavailable;
export const stage5PresentationHelp=locale=>{const c=COPY[locale]??COPY.en;return `${c.summary}\n${c.details}`;};

/** Reuses the existing fixed three-user release authority. This is a separate
 * read-only presentation contract, not a beta pilot or a producer grant. */
export function stage5PresentationCohort(environment={}){
 const ids=String(environment.STAGE7_COMPANION_USER_IDS??'').split(',').map(id=>id.trim()).filter(Boolean);
 return environment.STAGE7_COMPANION==='on'&&isApprovedStage7Three(ids)?Object.freeze(ids):Object.freeze([]);
}
export async function createStage5PresentationRuntime({db,keys,environment={},now=()=>new Date()}){
 const users=stage5PresentationCohort(environment);if(!users.length)return null;
 const pinned=JSON.stringify(users),eligible=id=>JSON.stringify(stage5PresentationCohort(environment))===pinned&&users.includes(id);
 const admission=await db.admitRuntime();if(![33,34,35].includes(db.requireRuntimeAdmission(admission)))throw Error('STAGE5_PRESENTATION_V33_REQUIRED');
 const stores=await createPhase4Foundation({db,keys,admission,now});
 return createStage5PresentationReader({db,stores,keys,eligible,now});
}
/** Keep the boundary installed in the same-schema recovery profile. A saved
 * analysis response cannot fall back to an unguarded sender after restart. */
export function createStage5PresentationSender(runtime,send){
 if(typeof send!=='function')throw Error('STAGE5_PRESENTATION_SENDER_REQUIRED');
 return input=>{
  if(input.reply?.stage5PresentationGuard&&!runtime)return {sent:false,messageId:null,reason:'stage5_presentation_disabled'};
  return runtime?runtime.sendReply(send,input):send(input);
 };
}
const json=value=>JSON.stringify(value);
const fail=()=>{throw Error('STAGE5_PRESENTATION_FENCED');};

/** Server composition only. No request can choose a tenant, execution mode,
 * artifact, query, producer or authority. All health reads use typed stores. */
export function createStage5PresentationReader({db,stores,keys,eligible,now=()=>new Date()}){
 if(typeof eligible!=='function'||typeof stores?.betaSummary?.readCurrent!=='function'||typeof keys?.lookup!=='function')fail();
 async function stamp({user,chatId}){
  if(!eligible(user?.id)||!/^\d+$/.test(String(chatId)))fail();
  const current=(await db.resolveUserByChatId(chatId))?.user;
  if(current?.id!==user.id||current.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration)fail();
  const schemaVersion=db.requireRuntimeAdmission(await db.admitRuntime());
  if(![33,34,35].includes(schemaVersion))fail();
  const state=(await db.raw.execute({sql:`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,
   p.source_generation,p.purge_generation,p.pending_purge_count,o.state onboarding_state,o.updated_at onboarding_updated_at${schemaVersion>=34?',o.enrollment_revision':''}
   FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id
   JOIN user_onboarding o ON o.user_id=u.id WHERE u.id=?`,args:[user.id]})).rows[0];
  if(!state||state.auth_generation<1||state.pending_purge_count!==0||state.status!=='ACTIVE'||state.onboarding_state!=='READY'||state.lifecycle_generation!==current.lifecycleGeneration)fail();
  const computation=(await db.raw.execute({sql:"SELECT input_generation,last_completed_generation,source_generation_seen,algorithm_set_version,revision FROM phase4_computation_state WHERE user_id=? AND execution_mode='SHADOW'",args:[user.id]})).rows[0]??null;
  const invalidation=(await db.raw.execute({sql:"SELECT requested_generation,scope_kind,scope_revision FROM phase4_invalidations WHERE user_id=? AND execution_mode='SHADOW'",args:[user.id]})).rows;
  return {userId:user.id,chatId:String(chatId),state,computation,invalidation,profile:await db.getProfileRevision(user.id),locale:await db.getLocale(user.id)};
 }
 function association(row,locale){
  const match=/^(.*?) has been repeatedly associated in your data with (higher|lower) ([a-z_]+)\.$/.exec(row.claim);
  if(!match||row.status!=='SUPPORTED'||!Object.hasOwn(FACTORS,match[1])||!METRICS.has(match[3]))return null;
  return t(locale,'beta.associationSupported',{factor:t(locale,`factor.${FACTORS[match[1]]}`),direction:t(locale,`beta.direction${match[2]==='higher'?'Higher':'Lower'}`),metric:t(locale,`metric.${match[3]}`)});
 }
 async function collect(actor,asOfUtc){
  const locale=COPY[actor.locale]?actor.locale:'en',c=COPY[locale],parts=[],evidence=[],expiries=[],fingerprints=[];
  const comp=actor.computation;
  if(!comp||comp.last_completed_generation!==comp.input_generation||comp.source_generation_seen!==actor.state.source_generation||actor.invalidation.some(row=>row.scope_kind!=='NONE'))return {parts,evidence,expiries,fingerprints};
  return stores.withContext(actor.userId,{executionMode:'SHADOW',providerRequired:true},async context=>{
   const summary=await stores.betaSummary.readCurrent(context,{asOfUtc});
   if(summary.userId!==actor.userId||summary.executionMode!=='SHADOW')fail();
   const readEvidence=async id=>{
    const item=(await stores.readArtifact(context,'evidence_items',{evidence_item_id:id})).row;
    const run=(await stores.readArtifact(context,'evidence_runs',{run_id:item.run_id})).row;
    if(run.state!=='COMPLETED'||!['LIMITED','AVAILABLE'].includes(item.quality)||item.causal_status!=='ASSOCIATION_ONLY')fail();
    fingerprints.push(['evidence',item,run]);
    const p=JSON.parse(item.provenance_json??'null'),num=value=>formatNumber(locale,value,2);
    const lines=[`${c.period}: ${run.window_start_utc?.slice(0,10)} — ${run.window_end_utc?.slice(0,10)}`,`${c.samples}: ${Number.isSafeInteger(run.sample_count)?num(run.sample_count):'—'} · ${item.quality==='LIMITED'?c.limited:c.available}`];
    if(p?.method==='CURRENT_VS_ROBUST_BASELINE'&&Number.isFinite(p.current?.value)&&[item.lower_bound,item.upper_bound,item.effect].every(Number.isFinite)){
     lines.push(`${c.current}: ${num(p.current.value)} ${item.unit??''}`,`${c.baseline}: ${num(item.lower_bound)} — ${num(item.upper_bound)} ${item.unit??''}`,`${c.delta}: ${num(item.effect)} ${item.unit??''}`);
    }else if(p?.method==='EXPOSED_VS_CONFIRMED_UNEXPOSED'&&[item.exposed_count,item.confirmed_unexposed_count].every(Number.isSafeInteger)){
     lines.push(`${c.groups}: ${num(item.exposed_count)} / ${num(item.confirmed_unexposed_count)}`,c.sources,c.association);
    }else fail();
    evidence.push({privacyId:item.privacy_artifact_id,lines});
   };
   for(const value of summary.insights.filter(row=>row.status==='SUPPORTED').slice(0,2)){
    const text=association(value,locale);if(!text)continue;
    const insight=await stores.insights.read(context,value.resultId,{asOfUtc}),ids=JSON.parse(insight.revision.supporting_evidence_ids_json??'null');
    if(insight.row.status!=='SUPPORTED'||!Array.isArray(ids)||!ids.length||ids.length>20)fail();
    for(const id of ids.slice(0,2))await readEvidence(id);
    fingerprints.push(['insight',insight.row,insight.revision]);expiries.push(Date.parse(insight.row.expires_at));parts.push(`• ${text}\n${c.association}`);
   }
   for(const value of summary.episodes.slice(0,2)){
    if(!METRICS.has(value.metricKey)||!['HIGHER','LOWER'].includes(value.direction))continue;
    const episode=await stores.episodes.read(context,value.resultId);
    await readEvidence(episode.row.latest_evidence_item_id);
    fingerprints.push(['episode',episode.row]);expiries.push(Date.parse(episode.row.expires_at));
    parts.push(`• ${t(locale,`beta.episode${value.direction==='HIGHER'?'Higher':'Lower'}`,{metric:t(locale,`metric.${value.metricKey}`)})}`);
   }
   await stores.assertCurrent(context);return {parts,evidence,expiries,fingerprints};
  });
 }
 async function handle(input){
  if(!isStage5PresentationCommand(input.text))return null;
  const match=command(input.text);
  const locale=await db.getLocale(input.user.id),c=COPY[locale]??COPY.en;
  if(!match)return {text:stage5PresentationHelp(locale)};
  try{return await db.transaction(async()=>{
   const actor=await stamp(input),at=now(),result=await collect(actor,at.toISOString());
   if(json(await stamp(input))!==json(actor))fail();
   const evidenceMode=match[1].toLowerCase()==='evidence';
   const lines=[c.title,c.provenance];
   if(!result.parts.length)lines.push(c.empty);
   else{
    lines.push(...result.parts);
    if(evidenceMode)lines.push(c.evidence,...result.evidence.map((row,index)=>`${index+1}. ${row.lines.join('\n')}`));
   }
   lines.push(`${c.asof}: ${at.toISOString()}`,evidenceMode?c.summary:c.details);
   const payload={text:lines.join('\n\n'),stage5PresentationStatus:result.parts.length?'CURRENT':'NO_VERIFIED_RESULTS',stage7SourceEvidence:[...new Set(result.evidence.map(row=>row.privacyId))]};
   const expiresAt=Math.min(at.getTime()+120000,...result.expiries);
   if(!Number.isFinite(expiresAt)||expiresAt<=at.getTime())fail();
   const guard={actor,createdAt:at.getTime(),expiresAt,fingerprint:keys.lookup(['stage5-presentation-results-v1',result.fingerprints])};
   return {...payload,stage5PresentationGuard:{...guard,signature:keys.lookup(['stage5-presentation-reply-v1',payload,guard])}};
  });}catch{return {text:c.unavailable};}
 }
 async function verify({userId,chatId,reply}){
  try{return await db.transaction(async()=>{
   const {stage5PresentationGuard:guard,...payload}=reply??{};
   if(!guard)return false;
   const {signature,...body}=guard,at=now().getTime();
   if(signature!==keys.lookup(['stage5-presentation-reply-v1',payload,body])||at<guard.createdAt||at>=guard.expiresAt||guard.actor.userId!==userId||guard.actor.chatId!==String(chatId))return false;
   const user=await db.getUser(userId),actor=await stamp({user,chatId});
   if(json(actor)!==json(guard.actor))return false;
   const result=await collect(actor,new Date(at).toISOString());
   return keys.lookup(['stage5-presentation-results-v1',result.fingerprints])===guard.fingerprint&&json(await stamp({user,chatId}))===json(actor);
  });}catch{return false;}
 }
 async function sendReply(send,input){
  if(!input.reply?.stage5PresentationGuard)return send(input);
  const beforeSend=async()=> (!input.beforeSend||await input.beforeSend())&&await verify(input);
  if(!await beforeSend())return {sent:false,messageId:null,reason:'stage5_presentation_changed'};
  return send({...input,beforeSend});
 }
 return Object.freeze({handle,verify,sendReply,eligible});
}
