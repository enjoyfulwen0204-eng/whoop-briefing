import {loadDailyMetrics} from './dailyMetrics.js';
import {seriesByMetric,changeFor} from './analytics/index.js';
import {latestMemory,memoryEvidence,INSIGHT_ICONS} from './associationMemory.js';
import {fromInsight,renderEvidence} from './evidence.js';
import {localDate,addDays} from './time.js';
import {t} from './localization.js';
import {fail} from './phase4Core.js';

const metrics={sleep:['sleep_total','sleep_performance','sleep_efficiency','respiratory_rate'],recovery:['recovery','hrv','rhr'],exercise:['previous_day_strain']};
const copy={
 'zh-TW':{baseline:'📊 個人基準（最近 30 天）',history:'📈 歷史變化（與前 30 天比較）',empty:'🔎 還在累積資料',mean:'平均',n:'筆',current:'當期',change:'差異',unavailable:'資料不足',minutes:'分鐘'},
 en:{baseline:'📊 Personal baseline (past 30 days)',history:'📈 Changes versus the preceding 30 days',empty:'🔎 Still collecting data',mean:'Average',n:'samples',current:'Current',change:'Difference',unavailable:'Insufficient data',minutes:'minutes'},
 vi:{baseline:'📊 Mức nền cá nhân (30 ngày qua)',history:'📈 Thay đổi so với 30 ngày trước',empty:'🔎 Đang tích lũy dữ liệu',mean:'Trung bình',n:'mẫu',current:'Hiện tại',change:'Chênh lệch',unavailable:'Chưa đủ dữ liệu',minutes:'phút'},
};
const number=v=>Number.isFinite(v)?Number(v.toFixed(2)).toString():null;
/** The same daily-metric and What Changed kernels used by the morning brief.
 * No LLM, Stage8 producer or persisted calculation. Bounds are calendar days;
 * missing days never become zero and the comparison excludes the selected day. */
export function renderMorningComparison({rows,topic,focus,range,today,locale}){
 const c=copy[locale]??copy.en,series=seriesByMetric(rows,metrics[topic]),first=range==='week'?addDays(today,-6):today;
 const days=focus==='history'?[...new Set(rows.filter(r=>r.health_date>=first&&r.health_date<=today).map(r=>r.health_date))].sort().reverse():[today];
 const lines=[];
 for(const day of days)for(const metric of metrics[topic]){
  const result=changeFor(metric,series[metric],day);if(!result||!result.baseline_30d_n)continue;
  const scale=metric==='sleep_total'?60000:1,unit=metric==='sleep_total'?' '+c.minutes:'';
  const mean=number(result.baseline_30d_mean/scale),current=number(result.current/scale);
  if(mean===null||current===null)continue;
  const label=t(locale,'answer.metric.'+metric);
  lines.push(`${focus==='history'?day+' · ':''}${label}: ${c.mean} ${mean}${unit} (${result.baseline_30d_n} ${c.n}) · ${c.current} ${current}${unit}`
   +(focus==='history'?` · ${c.change} ${number(result.vs_30d_pct)??c.unavailable}${Number.isFinite(result.vs_30d_pct)?'%':''} · z: ${number(result.z_score)??c.unavailable}`:''));
 }
 return `${c[focus]}\n${lines.length?lines.join('\n'):c.empty}`;
}
export function createCompanionMorningContext({db,core,stores,now=core.now}){
 async function stamp(id){
  const rows=(await db.raw.execute({sql:`SELECT u.status,u.timezone,u.lifecycle_generation,t.auth_generation,t.whoop_user_id,
   (t.access_token<>'') connected,p.source_generation,p.purge_generation,p.pending_purge_count,
   c.input_generation,c.revision,o.state onboarding,
   (SELECT json_group_array(json_object('resource',resource,'status',status,'auth',auth_generation,'life',lifecycle_generation)) FROM whoop_resource_access WHERE user_id=u.id AND resource IN ('sleep','recovery','cycle')) access,
   (SELECT json_group_array(key) FROM whoop_capabilities WHERE user_id=u.id AND lifecycle_generation=u.lifecycle_generation AND status IN ('UNSUPPORTED','UNAVAILABLE')) denied,
   (SELECT json_group_array(resource_type||':'||resource_id) FROM whoop_resource_tombstones WHERE user_id=u.id AND state='ACTIVE' AND resource_type IN ('sleep','recovery','cycle')) tombstones
   FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_whoop_tokens t ON t.user_id=u.id
   JOIN user_onboarding o ON o.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW'
   WHERE u.id=?`,args:[id]})).rows;
  const row=rows[0];if(rows.length!==1||row.status!=='ACTIVE'||row.onboarding!=='READY'||row.connected!==1||row.pending_purge_count!==0)fail('PHASE4_AUTH_FENCED');
  return {...row};
 }
 async function project({userId,topic,range,focus,locale,reply}){
  if(!metrics[topic]||!['today','week'].includes(range)||!['baseline','history','evidence'].includes(focus))fail('COACH_REGISTERED_QUERY_REQUIRED');
  return stores.withContext(userId,{executionMode:'SHADOW',providerRequired:true},async context=>{
   const captured=await stamp(userId),today=localDate(now(),captured.timezone);let text,memory=null;
   if(focus==='evidence'){
    // Same healthMemory rows and evidence-card renderer as /evidence. Hide
    // hypotheses and unrelated metrics; never expose stored free-form prose.
    const rows=(await latestMemory(db,userId)).filter(r=>INSIGHT_ICONS[r.status]&&metrics[topic].includes(memoryEvidence(r)?.metric));
    memory=core.keys.lookup(rows);
    text=rows.length?renderEvidence({available:true,cards:rows.slice(0,7).map(r=>fromInsight(r))},locale):(copy[locale]??copy.en).empty;
   }else{
    const access=JSON.parse(captured.access),denied=new Set(JSON.parse(captured.denied)),tombstones=new Set(JSON.parse(captured.tombstones)),instant=now().toISOString();
    const allowed=type=>access.some(a=>a.resource===type&&a.status==='ACCESSIBLE'&&a.auth===captured.auth_generation&&a.life===captured.lifecycle_generation)&&!denied.has(type);
    if(!allowed('sleep')||!allowed('recovery')||topic==='exercise'&&!allowed('cycle'))fail('PHASE4_RESOURCE_FENCED');
    // Keep the existing privacy-filtered reads, additionally enforce canonical
    // provider/resource/tombstone authority in bulk (no per-record round trips).
    const read=(method,type)=>async(...args)=>{
     if(!allowed(type))return [];
     const rows=await db[method](...args);if(rows.length>1000)fail('COACH_QUERY_BOUNDS');
     return rows.filter(r=>r.whoop_user_id===captured.whoop_user_id&&captured.whoop_user_id!==null&&!tombstones.has(type+':'+(type==='recovery'?r.sleep_id:r.id))
      &&r.synced_at<=instant&&(!r.updated_at||r.updated_at<=r.synced_at)&&(!r.end_at||r.end_at<=instant));
    };
    const source={getSleeps:read('getSleeps','sleep'),getRecoveries:read('getRecoveries','recovery'),getCycles:read('getCycles','cycle'),getWorkouts:async()=>[],getLatestBodyMeasurement:async()=>null};
    const rows=await loadDailyMetrics({db:source,userId,timezone:captured.timezone,from:addDays(today,-36),to:today});
    text=renderMorningComparison({rows,topic,focus,range,today,locale});
   }
   await stores.assertCurrent(context);
   if(JSON.stringify(captured)!==JSON.stringify(await stamp(userId)))fail('PHASE4_SOURCE_NOT_CURRENT');
   const projection={...reply,text:reply.text+'\n\n'+text},at=now().toISOString();
   // The wire guard contains only a signed state digest, never provider IDs,
   // tombstone identities or stored evidence. Existing Stage7 seals bind it.
   const state=core.keys.lookup(captured);
   return {...projection,stage7MorningGuard:{state,memory,topic,at,proof:core.keys.lookup(['coach-morning-v1',userId,projection.text,at,state,memory,topic])}};
  });
 }
 async function verifyReply({userId,reply}){
  try{const g=reply?.stage7MorningGuard,age=now().getTime()-Date.parse(g?.at);
   if(!g||!metrics[g.topic]||!Number.isFinite(age)||age<0||age>90000||g.proof!==core.keys.lookup(['coach-morning-v1',userId,reply.text,g.at,g.state,g.memory,g.topic])||g.state!==core.keys.lookup(await stamp(userId)))return false;
   return g.memory===null||g.memory===core.keys.lookup((await latestMemory(db,userId)).filter(r=>INSIGHT_ICONS[r.status]&&metrics[g.topic].includes(memoryEvidence(r)?.metric)));
  }catch{return false;}
 }
 return {project,verifyReply};
}
