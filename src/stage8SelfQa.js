import {labelForCategory} from './journal.js';
import {JOURNAL_COPY,presentationLocale} from './stage7Registry.js';
import {resolveIntent,parseCommand} from './bot/intent.js';
import {educationAnswer} from './bot/healthEducation.js';
import {selfQueryPerspective} from './scopedHealthContext.js';
import {computeDailyMetrics} from './dailyMetrics.js';
import {resolveMetric} from './healthQuery.js';
import {localDate} from './time.js';
export const SCOPED_COPY=Object.freeze({
 'zh-TW':{clarify:'你想問自己的哪個指標、哪段期間？例如「我最近 7 天的 HRV」。',third:'我不能透過一般問答查詢他人的健康資料。你可以改問一般性的健康問題。',updating:'分析仍在更新，尚無可驗證的當期分析結果。',missing:'目前沒有符合這段期間的可用來源紀錄。',source:'WHOOP 來源紀錄',asof:'資料截至',average:'平均',samples:'筆可用紀錄',observational:'僅為觀察性關聯，不代表因果。',journal:'你明確記錄的日誌',bodyUnavailable:'Body Energy 尚無可用的當期計算。'},
 en:{clarify:'Which of your metrics and which time range? For example, “my HRV over the last 7 days.”',third:'Ordinary Q&A cannot look up someone else’s health data. You can ask a general health question.',updating:'Analysis is updating; no verified current analysis is available yet.',missing:'No usable source records are available for this period.',source:'WHOOP source records',asof:'Data as of',average:'Average',samples:'usable records',observational:'Observational association only; not causation.',journal:'Your explicitly recorded journal',bodyUnavailable:'No current Body Energy calculation is available.'},
 vi:{clarify:'Bạn muốn hỏi chỉ số nào của mình, trong khoảng thời gian nào? Ví dụ: “HRV của tôi trong 7 ngày qua”.',third:'Hỏi đáp thông thường không thể tra cứu dữ liệu sức khỏe của người khác. Bạn có thể hỏi kiến thức sức khỏe chung.',updating:'Phân tích đang cập nhật; chưa có kết quả hiện tại đã được xác minh.',missing:'Chưa có bản ghi nguồn phù hợp trong khoảng thời gian này.',source:'Bản ghi nguồn WHOOP',asof:'Dữ liệu tính đến',average:'Trung bình',samples:'bản ghi phù hợp',observational:'Chỉ là mối liên hệ quan sát, không phải quan hệ nhân quả.',journal:'Nhật ký bạn đã ghi rõ',bodyUnavailable:'Chưa có kết quả Body Energy hiện tại.'},
});
const healthCommands=new Set(['now','energy','evidence','insights','journal','healthdata','status','predictions','healthspan']);
const fields={hrv:['HRV','ms',1],rhr:['RHR','bpm',1],recovery:['Recovery','%',1],sleep_total:['Sleep','min',60000],deep_sleep:['Deep sleep','min',60000],rem_sleep:['REM sleep','min',60000],previous_day_strain:['Strain','',1],respiratory_rate:['Respiratory rate','/min',1],sleep_performance:['Sleep performance','%',1]};
/** Wording consumes only the authorized bounded plan. No model, write,
 * notification, queue or scheduler capability is part of this module. */
export function createStage8SelfQa({scopes,db,bodyEnergy,decorate=null,now=()=>new Date()}){
 async function handle({user,chatId,text}){
  const raw=String(text??'').trim(),command=parseCommand(raw);
  if(command&&!healthCommands.has(command.name??command.command))return null;
  const intent=await resolveIntent(raw,{coach:null});
  if(!command&&intent.intent==='unknown'&&!/[?？]|hrv|rhr|sleep|recovery|body energy|睡|恢復|體能|證據|evidence|giấc ngủ|phục hồi/iu.test(raw))return null;
  const locale=await db.getLocale(user.id),c=SCOPED_COPY[locale]??SCOPED_COPY['zh-TW'];
  const perspective=selfQueryPerspective({text:raw,intent:intent.intent});
  if(!perspective.usePersonalData){const education=educationAnswer({text:raw,perspective:perspective.perspective,locale});return {text:education?.text??(perspective.perspective==='third_party'?c.third:c.clarify)};}
  const explicitDays=raw.match(/(?:last|past|最近|過去)\s*(\d+)\s*(?:days?|天)|(?:trong\s*)?(\d+)\s*ngày(?:\s*qua)?/iu);
  const days=/\btoday\b|今天|今日|hôm nay/iu.test(raw)?1:explicitDays?Number(explicitDays[1]??explicitDays[2]):1;
  if(days>120||days<1||/\d{4}-\d{2}-\d{2}|上週|昨天|昨晚|yesterday|last night|last week|hôm qua|tuần trước/iu.test(raw))return {text:c.clarify};
  const scope=await scopes.open({user,chatId,text:raw,intent:intent.intent,asOf:now(),maxHealthDays:days});
  if(!scope.permitted)return {text:c.clarify};
  let reply;
  if(bodyEnergy&&(/^(?:\/energy)(?:\s|$)/i.test(raw)||/body energy|體能電量|能量分數/iu.test(raw))){
   // Section 7's explicitly versioned owner presentation remains its separate
   // registered authority. It is never relabelled as a LIVE derived result.
   const body=await bodyEnergy.query({text:raw,userId:scope.userId,requestedAt:new Date(scope.asOfEpochMs)});
   if(body){await scopes.assert(scope);return {reply:body.message,bodyEnergyReplyGuard:body.replyGuard};}
   reply={text:c.bodyUnavailable};
  }else if(/evidence|證據|insights|關聯|predictions|healthspan|預測|健康壽命/iu.test(raw)){
   const result=await scopes.derived(scope,'INSIGHTS');
   reply={text:result.status==='CURRENT'&&result.items.length?result.items.map(item=>`${item.claim}\n${c.observational}`).join('\n'):result.status==='CURRENT'?c.missing:c.updating};
  }else if(/^\/journal\s*$/i.test(raw)||intent.intent==='journal_recall'){
   const rows=await scopes.journal(scope),j=JOURNAL_COPY[presentationLocale(locale)],exposure=row=>row.exposure_state==='EXPOSED'?j.yes:row.exposure_state==='CONFIRMED_UNEXPOSED'?j.no:j.unknown;reply={text:rows.length?`${c.journal}\n${rows.map(r=>`${r.health_date} · ${labelForCategory(r.category,locale)} · ${exposure(r)}`).join('\n')}`:c.missing};
  }else{
   const source=Object.fromEntries(await Promise.all(['sleep','recovery','cycle','workout'].map(async type=>[type,await scopes.facts(scope,type)])));
   const rows=computeDailyMetrics({sleepRows:source.sleep.rows,recoveryRows:source.recovery.rows,cycleRows:source.cycle.rows,workoutRows:source.workout.rows,timezone:scope.timezone,
    available:{sleeps:!['RESOURCE_NOT_AUTHORIZED','UNAVAILABLE_FOR_ACCOUNT'].includes(source.sleep.status),recoveries:!['RESOURCE_NOT_AUTHORIZED','UNAVAILABLE_FOR_ACCOUNT'].includes(source.recovery.status),cycles:!['RESOURCE_NOT_AUTHORIZED','UNAVAILABLE_FOR_ACCOUNT'].includes(source.cycle.status),workouts:source.workout.status==='CURRENT_SOURCE_FACTS',bodyMeasurement:false}}).filter(r=>r.health_date>=scope.fromDate&&r.health_date<=scope.toDate);
   const metric=resolveMetric(intent.metric),chosen=metric?[metric]:['sleep_total','recovery','hrv','rhr'];
   const lines=[];for(const key of chosen){const spec=fields[key];if(!spec)continue;
    const samples=rows.filter(r=>r[key]!==null&&Number.isFinite(r[key])&&(days===1||!r.calibrating));
    if(samples.length){const value=samples.reduce((n,r)=>n+r[key],0)/samples.length/spec[2];lines.push(`${spec[0]}: ${value.toFixed(1)} ${spec[1]}${days>1?` · ${c.average} · ${samples.length} ${c.samples}`:''}${samples.some(r=>r.calibrating)?' · WHOOP calibrating':''}`);}
   }
   reply={text:lines.length?`${scope.fromDate} — ${scope.toDate}\n${lines.join('\n')}\n${c.source} · ${c.asof}: ${scope.asOfUtc}`:c.missing};
  }
  await scopes.assert(scope);const projection=decorate?await decorate({user,chatId,text:raw,reply}):reply;
  if(projection.text!==reply.text)throw Error('SCOPED_WORDING_CHANGED');return scopes.sealReply(scope,projection);
 }
 return {handle};
}
