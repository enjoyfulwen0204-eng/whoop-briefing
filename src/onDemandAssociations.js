import {AsyncLocalStorage} from 'node:async_hooks';
import {pearson} from './analytics/correlation.js';
import {mean,stddev} from './analytics/statistics.js';
import {addDays,localDate} from './time.js';
import {TOPICS,TOPIC_ICONS,JOURNAL_COPY} from './stage7Registry.js';
import {currentExecutionBudget} from './executionBudget.js';
import {deviationSignal} from './signals.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
export const ASSOCIATION_METRICS=Object.freeze(['hrv','recovery','rhr','sleep_performance']);
const scope=new AsyncLocalStorage();
export const withAssociationTick=fn=>scope.run(new Map(),fn);
/** Inputs are current, validated facts. Missing/ambiguous exposure never becomes
 * a control day. A conflicting day is excluded rather than guessed. */
export function calculateAssociations({facts,days,today}){
 const from=addDays(today,-89),baselineFrom=addDays(today,-29),byDate=new Map(days.filter(d=>d.health_date>=from&&d.health_date<=today).map(d=>[d.health_date,d]));
 const result=TOPICS.map(topic=>{
  const exposure=new Map();
  for(const f of facts){if(f.category!==topic||f.fact_status!=='ACTIVE'||f.content_state!=='PRESENT'||!['EXPOSED','CONFIRMED_UNEXPOSED'].includes(f.exposure_state))continue;
   // health_date already uses alignJournalFact's wake-day attribution.
   const date=addDays(f.health_date,1);if(date<from||date>today||!byDate.has(date))continue;
   if(!exposure.has(date))exposure.set(date,new Set());exposure.get(date).add(f.exposure_state);
  }
  const yes=[],no=[];for(const [date,states] of exposure)if(states.size===1)(states.has('EXPOSED')?yes:no).push(byDate.get(date));
  let eligibleMetrics=0;const metrics=[],evidence=[];
  for(const metric of ASSOCIATION_METRICS){const a=yes.map(d=>d[metric]).filter(Number.isFinite),b=no.map(d=>d[metric]).filter(Number.isFinite),base=[...byDate.values()].filter(d=>d.health_date>=baselineFrom).map(d=>d[metric]).filter(Number.isFinite),sd=stddev(base);
   if(a.length<5||b.length<5||sd===null)continue;
   eligibleMetrics++;const delta=mean(a)-mean(b);
   evidence.push({metric,n:a.length+b.length,exposed:a.length,unexposed:b.length,effectSize:pearson([...a.map(()=>1),...b.map(()=>0)],[...a,...b]),difference:metric==='hrv'&&mean(b)>0?delta/mean(b)*100:delta});if(delta===0||Math.abs(delta)<sd*.5||metric==='hrv'&&mean(b)<=0)continue;
   metrics.push({metric,difference:metric==='hrv'?delta/mean(b)*100:delta,direction:delta>0?'high':'low',exposed:a.length,unexposed:b.length});
  }
  return {topic,exposed:yes.length,unexposed:no.length,status:yes.length<5||no.length<5||eligibleMetrics===0?'INSUFFICIENT':metrics.length?'ASSOCIATION':'NO_DIFFERENCE',metrics,evidence};
 });
 const signals=ASSOCIATION_METRICS.map(metric=>deviationSignal({metric,anchorDate:today,series:[...byDate.values()].map(d=>({date:d.health_date,value:d[metric]})).filter(d=>Number.isFinite(d.value)),capabilityStatus:'SUPPORTED'})).filter(Boolean);
 return {today,topics:result,signals};
}
const TEXT={
 'zh-TW':{title:'🔍 可能的關聯（不代表因果）',counts:(a,b)=>`有 ${a} 天 vs 沒有 ${b} 天`,missing:'資料還不夠',need:'兩邊各需要至少 5 天',none:'目前看不出明顯差異',next:'的隔天',high:'高',low:'低',point:'分',sleep:'睡眠表現',rhr:'靜止心率'},
 en:{title:'🔍 Possible association (not causation)',counts:(a,b)=>`Yes ${a} days vs No ${b} days`,missing:'Insufficient data',need:'At least 5 days in each group are needed',none:'No clear difference currently',next:' — next day',high:'higher',low:'lower',point:'points',sleep:'Sleep performance',rhr:'Resting heart rate'},
 vi:{title:'🔍 Mối liên hệ có thể có (không phải nhân quả)',counts:(a,b)=>`Có ${a} ngày vs Không ${b} ngày`,missing:'Chưa đủ dữ liệu',need:'Cần ít nhất 5 ngày ở mỗi nhóm',none:'Hiện chưa thấy khác biệt rõ',next:' — ngày hôm sau',high:'cao hơn',low:'thấp hơn',point:'điểm',sleep:'Hiệu suất giấc ngủ',rhr:'Nhịp tim nghỉ'},
};
export function renderAssociations(result,locale='zh-TW',topic=null){
 const c=TEXT[locale]??TEXT.en,j=JOURNAL_COPY[locale]??JOURNAL_COPY.en;
 return [c.title,...result.topics.filter(r=>!topic||r.topic===topic).map(r=>{
  const title=`${TOPIC_ICONS[r.topic]} ${j.topics[TOPICS.indexOf(r.topic)]}`,counts=c.counts(r.exposed,r.unexposed);
  if(r.status==='INSUFFICIENT')return `${title}：${c.missing}（${counts}；${c.need}）`;
  if(!r.metrics.length)return `${title}：${c.none}（${counts}）`;
  return `${title}${c.next}：`+r.metrics.map(m=>`${({hrv:'HRV',recovery:'Recovery',rhr:c.rhr,sleep_performance:c.sleep})[m.metric]} ${c[m.direction]} ${Number(Math.abs(m.difference).toPrecision(3))}${m.metric==='hrv'?'%':m.metric==='rhr'?' bpm':' '+c.point}（${c.counts(m.exposed,m.unexposed)}）`).join('、');
 })].join('\n');
}
export function associationQuestion(text){
 const s=String(text??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 if(!/影響|影响|關聯|关联|相關|相关|impact|affect|effect|association|anh huong|lien he/.test(s))return null;
 return Object.entries({caffeine:/咖啡|caffeine|coffee|ca phe/,alcohol:/酒|alcohol|drink|beer|ruou|bia/,late_meal:/宵夜|晚餐|late meal|an muon/,exercise_note:/運動|运动|exercise|tap luyen/,travel:/旅行|travel|du lich/,stress:/壓力|压力|stress|cang thang/,late_sleep:/晚睡|熬夜|late sleep|ngu muon/}).find(([,r])=>r.test(s))?.[0]??null;
}
export function createOnDemandAssociations({db,core,stores,now=()=>new Date()}){
 async function stamp(id){
  const row=(await db.raw.execute({sql:`SELECT u.status,u.lifecycle_generation,u.timezone,t.auth_generation,(t.access_token<>'') connected,
   p.purge_generation,p.source_generation,p.pending_purge_count,o.state onboarding,o.updated_at onboarding_updated,
   (SELECT group_concat(x,'|') FROM (SELECT resource||':'||status||':'||auth_generation||':'||lifecycle_generation x FROM whoop_resource_access WHERE user_id=u.id AND resource IN ('sleep','recovery') ORDER BY resource)) access_state,
   (SELECT group_concat(x,'|') FROM (SELECT key||':'||status||':'||lifecycle_generation x FROM whoop_capabilities WHERE user_id=u.id AND key IN ('sleep','recovery') ORDER BY key)) capability_state
   FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_whoop_tokens t ON t.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id WHERE u.id=?`,args:[id]})).rows[0];
  if(!row||row.status!=='ACTIVE'||row.onboarding!=='READY'||row.connected!==1||row.pending_purge_count!==0)fail('PHASE4_AUTH_FENCED');
  return {...row};
 }
 async function assertFresh(id,result){if(JSON.stringify(await stamp(id))!==JSON.stringify(result.identity))fail('PHASE4_SOURCE_NOT_CURRENT');return true;}
 async function calculate(id){
  if(currentExecutionBudget()&&currentExecutionBudget().remainingMs()<12000)return null;
  return stores.withContext(id,{executionMode:'SHADOW',providerRequired:true},async context=>{
   const identity=await stamp(id),today=localDate(now(),identity.timezone),from=addDays(today,-89);
   const facts=await stores.journal.list(context,{limit:500,fromDate:addDays(from,-1),toDate:addDays(today,-1)});
   if(facts.length===500)fail('ASSOCIATION_FACT_BOUNDS');
   // No source row can bypass resource authority, tombstones or identity. Only
   // the four authorized metrics leave this query; nothing is persisted.
   const days=(await db.raw.execute({sql:`SELECT s.health_date,s.end_at,s.id,r.hrv_rmssd_milli hrv,r.recovery_score recovery,r.resting_heart_rate rhr,s.sleep_performance_percentage sleep_performance
    FROM whoop_sleeps s JOIN whoop_recoveries r ON r.user_id=s.user_id AND r.sleep_id=s.id
    JOIN user_whoop_tokens t ON t.user_id=s.user_id
    WHERE s.user_id=? AND s.health_date BETWEEN ? AND ? AND s.nap=0 AND s.score_state='SCORED' AND r.score_state='SCORED'
    AND COALESCE(r.user_calibrating,0)=0 AND s.whoop_user_id=t.whoop_user_id AND r.whoop_user_id=t.whoop_user_id
    AND s.end_at<=? AND s.synced_at<=? AND r.synced_at<=? AND (s.updated_at IS NULL OR s.updated_at<=s.synced_at) AND (r.updated_at IS NULL OR r.updated_at<=r.synced_at)
    AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones z WHERE z.user_id=s.user_id AND z.state='ACTIVE' AND ((z.resource_type='sleep' AND z.resource_id=s.id) OR (z.resource_type='recovery' AND z.resource_id=r.sleep_id)))
    AND (SELECT count(DISTINCT a.resource) FROM whoop_resource_access a WHERE a.user_id=s.user_id AND a.resource IN ('sleep','recovery') AND a.status='ACCESSIBLE' AND a.auth_generation=? AND a.lifecycle_generation=?)=2
    AND NOT EXISTS(SELECT 1 FROM whoop_capabilities c WHERE c.user_id=s.user_id AND c.key IN ('sleep','recovery') AND c.lifecycle_generation=? AND c.status IN ('UNSUPPORTED','UNAVAILABLE'))
    ORDER BY s.end_at DESC LIMIT 1001`,args:[id,from,today,now().toISOString(),now().toISOString(),now().toISOString(),context.authGeneration,context.lifecycleGeneration,context.lifecycleGeneration]})).rows;
   if(days.length>1000)fail('ASSOCIATION_SOURCE_BOUNDS');
   const unique=[...new Map([...days].reverse().map(d=>[d.health_date,d])).values()];
   const result={...calculateAssociations({facts,days:unique,today}),identity,factIds:facts.map(f=>f.privacy_artifact_id)};
   await stores.assertCurrent(context);await assertFresh(id,result);return result;
  });
 }
 async function inspect(id){const cache=scope.getStore();if(!cache)return calculate(id);
  if(!cache.has(id))cache.set(id,calculate(id));const result=await cache.get(id);if(result)await assertFresh(id,result);return result;
 }
 async function coachReply(userId,locale,topic,projection){
  const allowed={sleep:['sleep_performance'],recovery:['hrv','recovery','rhr']}[topic];if(!allowed)fail('COACH_REGISTERED_QUERY_REQUIRED');
  const result=await inspect(userId);if(!result)return null;
  const view={...result,topics:result.topics.map(r=>{const metrics=r.metrics.filter(m=>allowed.includes(m.metric));return {...r,metrics,status:r.status==='ASSOCIATION'&&!metrics.length?'NO_DIFFERENCE':r.status};})};
  const range=locale==='vi'?'90 ngày qua':locale==='en'?'Past 90 days':'最近 90 天';
  return sealReply(userId,result,{...projection,text:projection.text+'\n\n'+range+'\n'+renderAssociations(view,locale)});
 }
 function sealReply(userId,result,projection){
  const at=now().toISOString(),identity=result.identity;
  return {...projection,associationGuard:{at,identity,proof:core.keys.lookup(['association-reply-v1',userId,projection.text,at,identity])}};
 }
 async function reply(userId,locale,topic){const result=await inspect(userId);if(!result)return null;
  const text=renderAssociations(result,locale,topic),at=now().toISOString(),identity=result.identity;
  return {text,associationGuard:{at,identity,proof:core.keys.lookup(['association-reply-v1',userId,text,at,identity])}};
 }
 async function verifyReply(input){const g=input.reply?.associationGuard;if(!g)return true;
  if(typeof g.at!=='string'||now().getTime()-Date.parse(g.at)>90000||Date.parse(g.at)>now().getTime()||g.proof!==core.keys.lookup(['association-reply-v1',input.userId,input.reply.text,g.at,g.identity]))return false;
  try{return await assertFresh(input.userId,{identity:g.identity});}catch{return false;}
 }
 return Object.freeze({inspect,assertFresh,reply,coachReply,verifyReply,question:associationQuestion,render:renderAssociations});
}
