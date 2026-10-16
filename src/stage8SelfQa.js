import {assessUrgency,urgentReply,isSymptomEducationQuestion,symptomEducationReply} from './bot/triage.js';
import {labelForCategory} from './journal.js';
import {JOURNAL_COPY,presentationLocale} from './stage7Registry.js';
import {resolveIntent,parseCommand} from './bot/intent.js';
import {educationAnswer} from './bot/healthEducation.js';
import {selfQueryPerspective} from './scopedHealthContext.js';
import {computeDailyMetrics} from './dailyMetrics.js';
import {resolveMetric} from './healthQuery.js';
import {t,formatNumber} from './localization.js';
export const SCOPED_COPY=Object.freeze({
 'zh-TW':{clarify:'你想問自己的哪個指標、哪段期間？例如「我最近 7 天的 HRV」。',third:'我不能透過一般問答查詢他人的健康資料。你可以改問一般性的健康問題。',updating:'分析仍在更新，尚無可驗證的當期分析結果。',missing:'目前沒有符合這段期間的可用來源紀錄。',source:'WHOOP 來源紀錄',asof:'資料截至',average:'平均',samples:'筆可用紀錄',observational:'僅為觀察性關聯，不代表因果。',journal:'你明確記錄的日誌',bodyUnavailable:'Body Energy 尚無可用的當期計算。'},
 en:{clarify:'Which of your metrics and which time range? For example, “my HRV over the last 7 days.”',third:'Ordinary Q&A cannot look up someone else’s health data. You can ask a general health question.',updating:'Analysis is updating; no verified current analysis is available yet.',missing:'No usable source records are available for this period.',source:'WHOOP source records',asof:'Data as of',average:'Average',samples:'usable records',observational:'Observational association only; not causation.',journal:'Your explicitly recorded journal',bodyUnavailable:'No current Body Energy calculation is available.'},
 vi:{clarify:'Bạn muốn hỏi chỉ số nào của mình, trong khoảng thời gian nào? Ví dụ: “HRV của tôi trong 7 ngày qua”.',third:'Hỏi đáp thông thường không thể tra cứu dữ liệu sức khỏe của người khác. Bạn có thể hỏi kiến thức sức khỏe chung.',updating:'Phân tích đang cập nhật; chưa có kết quả hiện tại đã được xác minh.',missing:'Chưa có bản ghi nguồn phù hợp trong khoảng thời gian này.',source:'Bản ghi nguồn WHOOP',asof:'Dữ liệu tính đến',average:'Trung bình',samples:'bản ghi phù hợp',observational:'Chỉ là mối liên hệ quan sát, không phải quan hệ nhân quả.',journal:'Nhật ký bạn đã ghi rõ',bodyUnavailable:'Chưa có kết quả Body Energy hiện tại.'},
});
const healthCommands=new Set(['now','energy','journal','healthdata','status','predictions','healthspan']);
const LIVE_COPY=Object.freeze({
 'zh-TW':{title:'🔎 本人的當期 LIVE 分析',empty:'目前沒有可驗證的合格結果；可能是證據不足。沒有結果不代表沒有健康變化。',insufficient:'現有資料不足以說明恢復偏低的原因；以下僅列出已驗證的觀察。',history:'📚 已保留的分析歷程',historyScope:'歷程僅包含目前資料版本中仍可驗證的紀錄，不代表完整的過往健康史。',noHistory:'目前沒有足夠的可驗證歷程，無法判定以前是否發生過。',evidence:'🧾 證據',period:'來源期間',calculated:'分析截至',samples:'基準樣本數',current:'分析時點的值',baseline:'個人基準中位數',range:'個人基準中間 50% 範圍',delta:'與個人基準的差異',limited:'資料品質有限',qualified:'資料品質合格',unqualified:'證據不足，不能比較個人基準或推論健康關聯。',groups:'有記錄／明確記錄未發生／未知',source:'WHOOP 與你明確記錄的日誌',opened:'開始觀察',observed:'最近觀察',resolved:'結束觀察',help:'🔎 /insights live\n📈 /episodes\n🧾 /evidence live\n📚 /insights live history 或 /episodes history',states:{OPEN:'觀察中',UPDATING:'更新中',ESCALATED:'變化增大',EXPLAINED:'已加入說明',STABILIZING:'趨於穩定',RESOLVED:'已結束',SUPPORTED:'有證據支持',EMERGING:'仍在確認',HYPOTHESIS:'待驗證',WEAKENED:'支持減弱',RETIRED:'已封存'}},
 en:{title:'🔎 Your current LIVE analysis',empty:'No verified qualifying result is available; evidence may be insufficient. No result does not mean no health change.',insufficient:'Available evidence cannot establish why your Recovery is low. Only verified observations are shown below.',history:'📚 Retained analysis history',historyScope:'History includes only records still verifiable in the current data generation; it is not your complete health history.',noHistory:'There is not enough verifiable history to determine whether this happened before.',evidence:'🧾 Evidence',period:'Source period',calculated:'Analysis as of',samples:'Baseline samples',current:'Value at analysis cutoff',baseline:'Personal baseline median',range:'Middle 50% of your personal baseline',delta:'Difference from your personal baseline',limited:'Limited data quality',qualified:'Qualified data quality',unqualified:'Insufficient evidence for a personal baseline comparison or a health association.',groups:'Recorded exposure / explicitly recorded non-exposure / unknown',source:'WHOOP and your explicit journal records',opened:'Observation opened',observed:'Last observed',resolved:'Observation resolved',help:'🔎 /insights live\n📈 /episodes\n🧾 /evidence live\n📚 /insights live history or /episodes history',states:{OPEN:'Under observation',UPDATING:'Updating',ESCALATED:'Change increased',EXPLAINED:'Explanation recorded',STABILIZING:'Stabilizing',RESOLVED:'Resolved',SUPPORTED:'Supported',EMERGING:'Emerging',HYPOTHESIS:'Unverified hypothesis',WEAKENED:'Weakened support',RETIRED:'Archived'}},
 vi:{title:'🔎 Phân tích LIVE hiện tại của bạn',empty:'Chưa có kết quả đủ điều kiện đã được xác minh; có thể chưa đủ bằng chứng. Không có kết quả không có nghĩa là không có thay đổi sức khỏe.',insufficient:'Bằng chứng hiện có chưa xác định được vì sao điểm Phục hồi của bạn thấp. Dưới đây chỉ là các quan sát đã được xác minh.',history:'📚 Lịch sử phân tích được lưu giữ',historyScope:'Lịch sử chỉ gồm các bản ghi còn xác minh được trong phiên bản dữ liệu hiện tại, không phải toàn bộ lịch sử sức khỏe.',noHistory:'Chưa đủ lịch sử có thể xác minh để xác định việc này đã xảy ra trước đây hay chưa.',evidence:'🧾 Bằng chứng',period:'Khoảng dữ liệu nguồn',calculated:'Phân tích tính đến',samples:'Số mẫu nền',current:'Giá trị tại thời điểm phân tích',baseline:'Trung vị dữ liệu nền cá nhân',range:'Khoảng 50% giữa của dữ liệu nền cá nhân',delta:'Chênh lệch so với dữ liệu nền cá nhân',limited:'Chất lượng dữ liệu hạn chế',qualified:'Chất lượng dữ liệu đủ điều kiện',unqualified:'Chưa đủ bằng chứng để so sánh dữ liệu nền cá nhân hoặc suy ra mối liên hệ sức khỏe.',groups:'Có ghi nhận / xác nhận không xảy ra / chưa rõ',source:'WHOOP và nhật ký bạn đã ghi rõ',opened:'Bắt đầu theo dõi',observed:'Quan sát gần nhất',resolved:'Kết thúc theo dõi',help:'🔎 /insights live\n📈 /episodes\n🧾 /evidence live\n📚 /insights live history hoặc /episodes history',states:{OPEN:'Đang theo dõi',UPDATING:'Đang cập nhật',ESCALATED:'Thay đổi tăng',EXPLAINED:'Đã ghi giải thích',STABILIZING:'Đang ổn định',RESOLVED:'Đã kết thúc',SUPPORTED:'Có bằng chứng',EMERGING:'Đang xác nhận',HYPOTHESIS:'Giả thuyết chưa xác minh',WEAKENED:'Bằng chứng giảm',RETIRED:'Đã lưu trữ'}},
});
const factorNames={alcohol:'alcohol',caffeine:'caffeine',stress:'stress',late_meal:'lateMeal',late_sleep:'lateSleep',sickness:'sickness',travel:'travel',exercise_note:'exercise',sauna:'sauna',supplement:'supplement',medication:'medication',flight:'flight',location:'location',massage:'massage',food:'food',custom:'custom'};
/** Only the explicit LIVE namespace is consumed. Bare/phase4 legacy forms
 * return null so their registered existing handlers retain authority. */
export function stage8LiveCommand(text){
 const command=parseCommand(text);if(!command||!['insights','evidence','episodes'].includes(command.command))return null;
 const args=command.args.map(value=>value.toLowerCase());
 if(command.command!=='episodes'&&args[0]!=='live')return null;
 if(args[0]==='live')args.shift();
 return args.length===0||args.length===1&&args[0]==='history'?{kind:command.command==='insights'?'INSIGHTS':command.command==='evidence'?'EVIDENCE':'EPISODES',history:args[0]==='history'}:{invalid:true};
}
const metricLabel=(key,locale)=>key==='respiratory_rate'?({'zh-TW':'呼吸率',en:'Respiratory rate',vi:'Nhịp thở'}[locale]??'Respiratory rate'):t(locale,`metric.${key}`);
const unitLabel=unit=>({score:'',percent:'%',minutes:'min',breaths_per_minute:'/min',strain:''}[unit]??unit??'');
function renderEvidence(item,locale,c){
 const n=value=>formatNumber(locale,value,2),unit=unitLabel(item.unit),lines=[`${metricLabel(item.metricKey,locale)} · ${c.calculated}: ${item.asOfUtc}`,`${c.period}: ${item.period.from.slice(0,10)} — ${item.period.to.slice(0,10)}`];
 if(item.outcome==='PERSONAL_BASELINE_COMPARISON')lines.push(`${c.current}: ${n(item.current)} ${unit}`,`${c.baseline}: ${n(item.baseline.median)} ${unit}`,`${c.range}: ${n(item.baseline.q1)} — ${n(item.baseline.q3)} ${unit}`,`${c.delta}: ${n(item.delta)} ${unit}`,`${c.samples}: ${n(item.samples)}`,item.quality==='LIMITED'?c.limited:c.qualified);
 else if(item.method==='JOURNAL_ASSOCIATION')lines.push(`${t(locale,`factor.${factorNames[item.factor]}`)} · ${c.groups}: ${n(item.exposedCount)} / ${n(item.unexposedCount)} / ${n(item.unknownCount)}`,c.source,item.outcome==='INSUFFICIENT_EVIDENCE'?c.unqualified:SCOPED_COPY[locale].observational);
 else lines.push(`${c.samples}: ${n(item.samples)}`,c.unqualified);
 return lines.join('\n');
}
function renderDerived(results,{locale,history=false,evidence=false,recoveryOnly=false}={}){
 const c=LIVE_COPY[locale]??LIVE_COPY.en,copy=SCOPED_COPY[locale]??SCOPED_COPY.en;
 if(results.some(result=>result.status!=='CURRENT'))return copy.updating;
 const items=results.flatMap(result=>result.items).filter(item=>!recoveryOnly||item.metricKey==='recovery_score'),parts=[c.title];
 if(recoveryOnly)parts.push(c.insufficient);
 if(!items.length)parts.push(c.empty);
 for(const item of items.slice(0,5)){
  if(item.kind==='INSIGHTS')parts.push(t(locale,'beta.associationSupported',{factor:t(locale,`factor.${factorNames[item.factor]}`),metric:metricLabel(item.metricKey,locale),direction:t(locale,`beta.direction${item.direction==='HIGHER'?'Higher':'Lower'}`)}),copy.observational);
  else if(item.kind==='EPISODES')parts.push(`${item.state==='RESOLVED'?metricLabel(item.metricKey,locale):t(locale,`beta.episode${item.direction==='HIGHER'?'Higher':'Lower'}`,{metric:metricLabel(item.metricKey,locale)})}\n${c.states[item.state]}\n${c.opened}: ${item.openedAt}\n${c.observed}: ${item.lastObservedAt}${item.resolvedAt?`\n${c.resolved}: ${item.resolvedAt}`:''}`);
  if(evidence||item.kind==='EPISODES'||item.kind==='EVIDENCE')for(const value of (item.evidence??[]).slice(0,2))parts.push(`${c.evidence}\n${renderEvidence(value,locale,c)}`);
  if(history&&(item.history?.length??0)>1)parts.push(`${c.history}\n${item.history.map(value=>`${value.at} · ${c.states[value.status??value.state]??copy.missing}`).join('\n')}`);
 }
 // Revisions of a single episode cannot establish a separate prior episode.
 const priorEpisode=items.filter(item=>item.kind==='EPISODES').some(prior=>prior.resolvedAt&&items.some(current=>current.kind==='EPISODES'&&current.id!==prior.id&&Date.parse(prior.resolvedAt)<Date.parse(current.openedAt)));
 const insufficientHistory=recoveryOnly?!priorEpisode:!items.some(item=>(item.history?.length??0)>1);
 const historyFooter=history?`${c.historyScope}${insufficientHistory?`\n${c.noHistory}`:''}\n\n`:'';
 const footer=`${historyFooter}${copy.asof}: ${results[0].asOfUtc}\n\n${c.help}`,bounded=[];let length=footer.length;
 for(const part of parts){if(length+part.length+2>3800)break;bounded.push(part);length+=part.length+2;}
 return [...bounded,footer].join('\n\n');
}
const fields={hrv:['HRV','ms',1],rhr:['RHR','bpm',1],recovery:['Recovery','%',1],sleep_total:['Sleep','min',60000],deep_sleep:['Deep sleep','min',60000],rem_sleep:['REM sleep','min',60000],previous_day_strain:['Strain','',1],respiratory_rate:['Respiratory rate','/min',1],sleep_performance:['Sleep performance','%',1]};
/** Wording consumes only the authorized bounded plan. No model, write,
 * notification, queue or scheduler capability is part of this module. */
export function createStage8SelfQa({scopes,db,bodyEnergy,decorate=null,now=()=>new Date()}){
 async function handle({user,chatId,text}){
  const raw=String(text??'').trim(),command=parseCommand(raw),liveCommand=stage8LiveCommand(raw);
  if(assessUrgency(raw).urgent)return {text:urgentReply(await db.getLocale(user.id)??'en')};
  if(isSymptomEducationQuestion(raw))return {text:symptomEducationReply(await db.getLocale(user.id)??'en')};
  if(command&&!liveCommand&&!healthCommands.has(command.name??command.command))return null;
  if(command?.command==='journal'&&command.argsText)return null;
  const intent=await resolveIntent(raw,{coach:null});
  if(intent.intent==='journal_log')return null;
  if(!command&&intent.intent==='unknown'&&!/[?？]|hrv|rhr|sleep|recovery|body energy|睡|恢復|體能|證據|evidence|insights|patterns|episodes|關聯|歷史|giấc ngủ|phục hồi|bằng chứng|mối liên hệ/iu.test(raw))return null;
  const savedLocale=await db.getLocale(user.id),locale=Object.hasOwn(SCOPED_COPY,savedLocale)?savedLocale:'zh-TW',c=SCOPED_COPY[locale];
  if(liveCommand?.invalid)return {text:(LIVE_COPY[locale]??LIVE_COPY.en).help};
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
  }else if(liveCommand||/evidence|證據|insights|關聯|patterns|episodes|predictions|healthspan|預測|健康壽命|bằng chứng|mối liên hệ/iu.test(raw)||/recovery|恢復|phục hồi/iu.test(raw)&&/why|為何|為什麼|tại sao|before|以前|曾經|發生過|trước đây/iu.test(raw)){
   const recoveryOnly=!command&&/recovery|恢復|phục hồi/iu.test(raw)&&/why|為何|為什麼|tại sao|before|以前|曾經|發生過|trước đây/iu.test(raw),history=liveCommand?.history||/before|以前|曾經|發生過|trước đây|歷史|historical/iu.test(raw),kind=liveCommand?.kind??(/evidence|證據|bằng chứng/iu.test(raw)?'EVIDENCE':'INSIGHTS');
   const results=[await scopes.derived(scope,kind)];if(recoveryOnly)results.push(await scopes.derived(scope,'EPISODES'));
   reply={text:renderDerived(results,{locale,history,evidence:kind==='EVIDENCE',recoveryOnly})};
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
