import {presentationLocale} from './stage7Registry.js';
import {formatNumber,t} from './localization.js';
import {localDate} from './time.js';

export const COACH_FOLLOWUPS=Object.freeze(['baseline','patterns','history','evidence']);
export const COACH_CONTEXT_COPY=Object.freeze({
 'zh-TW':{choose:'選擇想查看的期間。',next:'還想了解哪一部分？',unavailable:'🔎 目前沒有可驗證的當期分析；不推測原因。',empty:'🔎 這個主題與期間沒有合格的當期分析。證據不足不代表沒有健康變化。',title:'🔎 你的已驗證觀察',nonCausal:'歷史關聯不代表因果，不能據此判定原因。',current:'當期值',baseline:'個人基準中位數',delta:'與基準差異',samples:'基準樣本數',period:'證據來源期間',asof:'分析截至',limited:'資料品質有限',insufficient:'證據不足，無法比較個人基準或推論關聯。',groups:'有記錄／明確記錄未發生／未知',history:'📚 目前資料版本中保留的歷程',historyLimit:'僅顯示目前資料版本可驗證的分析歷程，不代表完整健康史。',noHistory:'可驗證歷程不足，無法判定以前是否發生過。',episode:'📈 個人基準變化',observed:'最近觀察',resolved:'觀察已結束',evidence:'🧾 證據',minutes:'分鐘',respiratory:'呼吸率',followups:{sleep:['📊 睡眠與個人基準','🔗 有證據的睡眠關聯','📈 以前有類似睡眠變化？','🧾 查看睡眠證據'],recovery:['📊 恢復與個人基準','🔗 有證據的恢復關聯','📈 以前有類似恢復變化？','🧾 查看恢復證據'],exercise:['📊 每日負荷與個人基準','🔗 有證據的負荷關聯','📈 以前有類似負荷變化？','🧾 查看負荷證據']}},
 en:{choose:'Choose the period you want to explore.',next:'What would you like to explore next?',unavailable:'🔎 No verified current analysis is available; causes cannot be inferred.',empty:'🔎 No qualifying current analysis matches this topic and period. Insufficient evidence does not mean no health change.',title:'🔎 Your verified observations',nonCausal:'Historical association is not causation and does not establish a cause.',current:'Current value',baseline:'Personal baseline median',delta:'Difference from baseline',samples:'Baseline samples',period:'Evidence source period',asof:'Analysis as of',limited:'Limited data quality',insufficient:'Insufficient evidence for a personal baseline comparison or an association.',groups:'Recorded exposure / explicitly recorded non-exposure / unknown',history:'📚 Retained history in the current data generation',historyLimit:'Only analysis history still verifiable in the current data generation is shown; this is not a complete health history.',noHistory:'There is not enough verifiable history to determine whether this happened before.',episode:'📈 Personal baseline change',observed:'Last observed',resolved:'Observation resolved',evidence:'🧾 Evidence',minutes:'minutes',respiratory:'Respiratory rate',followups:{sleep:['📊 Sleep vs your baseline','🔗 Supported sleep associations','📈 Similar sleep changes before?','🧾 Show sleep evidence'],recovery:['📊 Recovery vs your baseline','🔗 Supported Recovery associations','📈 Similar Recovery changes before?','🧾 Show Recovery evidence'],exercise:['📊 Daily strain vs your baseline','🔗 Supported strain associations','📈 Similar strain changes before?','🧾 Show strain evidence']}},
 vi:{choose:'Chọn khoảng thời gian bạn muốn tìm hiểu.',next:'Bạn muốn tìm hiểu thêm phần nào?',unavailable:'🔎 Chưa có phân tích hiện tại đã được xác minh; không suy đoán nguyên nhân.',empty:'🔎 Chưa có phân tích hiện tại đủ điều kiện cho chủ đề và khoảng thời gian này. Thiếu bằng chứng không có nghĩa là không có thay đổi sức khỏe.',title:'🔎 Các quan sát đã xác minh của bạn',nonCausal:'Mối liên hệ trong lịch sử không phải quan hệ nhân quả và không xác định nguyên nhân.',current:'Giá trị hiện tại',baseline:'Trung vị mức nền cá nhân',delta:'Chênh lệch so với mức nền',samples:'Số mẫu nền',period:'Khoảng dữ liệu nguồn',asof:'Phân tích tính đến',limited:'Chất lượng dữ liệu hạn chế',insufficient:'Chưa đủ bằng chứng để so sánh mức nền cá nhân hoặc suy ra mối liên hệ.',groups:'Có ghi nhận / xác nhận không xảy ra / chưa rõ',history:'📚 Lịch sử lưu giữ trong phiên bản dữ liệu hiện tại',historyLimit:'Chỉ hiển thị lịch sử phân tích còn xác minh được trong phiên bản dữ liệu hiện tại, không phải toàn bộ lịch sử sức khỏe.',noHistory:'Chưa đủ lịch sử có thể xác minh để xác định việc này đã xảy ra trước đây.',episode:'📈 Thay đổi so với mức nền cá nhân',observed:'Quan sát gần nhất',resolved:'Đã kết thúc theo dõi',evidence:'🧾 Bằng chứng',minutes:'phút',respiratory:'Nhịp thở',followups:{sleep:['📊 Giấc ngủ so với mức nền','🔗 Liên hệ giấc ngủ có bằng chứng','📈 Từng có thay đổi giấc ngủ tương tự?','🧾 Xem bằng chứng giấc ngủ'],recovery:['📊 Phục hồi so với mức nền','🔗 Liên hệ Phục hồi có bằng chứng','📈 Từng có thay đổi Phục hồi tương tự?','🧾 Xem bằng chứng Phục hồi'],exercise:['📊 Mức tải ngày so với mức nền','🔗 Liên hệ mức tải có bằng chứng','📈 Từng có thay đổi mức tải tương tự?','🧾 Xem bằng chứng mức tải']}},
});
const metrics=Object.freeze({sleep:['sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate'],recovery:['recovery_score','hrv','rhr'],exercise:['cycle_strain']});
const factors={alcohol:'alcohol',caffeine:'caffeine',stress:'stress',late_meal:'lateMeal',late_sleep:'lateSleep',sickness:'sickness',travel:'travel',exercise_note:'exercise',sauna:'sauna',supplement:'supplement',medication:'medication',flight:'flight',location:'location',massage:'massage',food:'food',custom:'custom'};
const episodeStates={
 'zh-TW':{OPEN:'觀察中',UPDATING:'更新中',ESCALATED:'變化增大',EXPLAINED:'已加入說明',STABILIZING:'趨於穩定',RESOLVED:'已結束'},
 en:{OPEN:'Under observation',UPDATING:'Updating',ESCALATED:'Change increased',EXPLAINED:'Explanation recorded',STABILIZING:'Stabilizing',RESOLVED:'Resolved'},
 vi:{OPEN:'Đang theo dõi',UPDATING:'Đang cập nhật',ESCALATED:'Thay đổi tăng',EXPLAINED:'Đã ghi giải thích',STABILIZING:'Đang ổn định',RESOLVED:'Đã kết thúc'},
};
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const label=(metric,locale,c)=>metric==='respiratory_rate'?c.respiratory:t(locale,`metric.${metric}`);
function inPeriod(evidence,scope){
 if(!validDate(evidence.asOfUtc)||Date.parse(evidence.asOfUtc)>scope.asOfEpochMs||!validDate(evidence.period?.from)||!validDate(evidence.period?.to))return false;
 const day=evidence.healthDate??(validDate(evidence.observedAt)?localDate(new Date(evidence.observedAt),scope.timezone):null);
 return day?day>=scope.fromDate&&day<=scope.toDate:localDate(new Date(evidence.period.to),scope.timezone)>=scope.fromDate&&localDate(new Date(evidence.period.from),scope.timezone)<=scope.toDate;
}
function renderEvidence(e,locale,c){
 const number=value=>formatNumber(locale,value,1),unit=e.unit==='minutes'?c.minutes:({score:'',percent:'%',breaths_per_minute:'/min',strain:''}[e.unit]??e.unit),lines=[`${c.evidence} · ${label(e.metricKey,locale,c)}`,`${c.period}: ${e.period.from.slice(0,10)} — ${e.period.to.slice(0,10)}`,`${c.asof}: ${e.asOfUtc}`];
 if(e.outcome==='PERSONAL_BASELINE_COMPARISON'&&[e.current,e.baseline?.median,e.delta,e.samples].every(Number.isFinite))lines.push(`${c.current}: ${number(e.current)} ${unit}`,`${c.baseline}: ${number(e.baseline.median)} ${unit}`,`${c.delta}: ${number(e.delta)} ${unit}`,`${c.samples}: ${number(e.samples)}`,...(e.quality==='LIMITED'?[c.limited]:[]));
 else if(e.method==='JOURNAL_ASSOCIATION'&&Object.hasOwn(factors,e.factor)&&[e.exposedCount,e.unexposedCount,e.unknownCount].every(Number.isFinite))lines.push(`${t(locale,`factor.${factors[e.factor]}`)} · ${c.groups}: ${e.exposedCount} / ${e.unexposedCount} / ${e.unknownCount}`,e.outcome==='REPEATED_ASSOCIATION_EVIDENCE'?c.nonCausal:c.insufficient);
 else lines.push(c.insufficient);
 return lines.join('\n');
}
/** Consumes only the server's canonical typed LIVE reader. Topic/range/focus
 * originate from the trusted callback registry, never free-form SQL or claims. */
export function createCompanionCoachContext({scopes=null,getScopes=null}={}){
 const current=()=>getScopes?getScopes():scopes;
 async function project({user,chatId,topic,range,focus='baseline',locale,reply}){
  if(!Object.hasOwn(metrics,topic)||!['today','week'].includes(range)||!COACH_FOLLOWUPS.includes(focus))throw Error('COACH_CONTEXT_REGISTERED_QUERY_REQUIRED');
  locale=presentationLocale(locale);const c=COACH_CONTEXT_COPY[locale],reader=current();
  if(!reader)return {...reply,text:`${reply.text}\n\n${c.unavailable}`};
  const scope=await reader.open({user,chatId,text:`my ${topic} over the last ${range==='today'?1:7} days`,maxHealthDays:range==='today'?1:7});
  if(!scope.permitted)throw Error('COACH_CONTEXT_SELF_SCOPE_REQUIRED');
  const kinds=focus==='patterns'?['INSIGHTS']:focus==='history'?['EPISODES']:['EVIDENCE',...(focus==='baseline'?['EPISODES']:[])],results=[];
  for(const kind of kinds)results.push(await reader.derived(scope,kind));
  const evidenceFor=item=>(item.evidence??[]).filter(e=>metrics[topic].includes(e.metricKey)&&e.nonCausal===true&&inPeriod(e,scope));
  const parts=[];let count=0,historyCount=0;
  if(results.some(result=>result.status!=='CURRENT'))parts.push(c.unavailable);
  else for(const item of results.flatMap(result=>result.items).slice(0,20)){
   if(count>=3)break;const evidence=evidenceFor(item);if(!evidence.length)continue;
   if(item.kind==='INSIGHTS'){
    if(!metrics[topic].includes(item.metricKey)||!Object.hasOwn(factors,item.factor)||!['HIGHER','LOWER'].includes(item.direction)||item.nonCausal!==true)continue;
    parts.push(t(locale,'beta.associationSupported',{factor:t(locale,`factor.${factors[item.factor]}`),metric:label(item.metricKey,locale,c),direction:t(locale,`beta.direction${item.direction==='HIGHER'?'Higher':'Lower'}`)}),c.nonCausal);
   }else if(item.kind==='EPISODES'){
    if(!metrics[topic].includes(item.metricKey)||!Object.hasOwn(episodeStates[locale],item.state)||!['HIGHER','LOWER'].includes(item.direction)||item.nonCausal!==true||!validDate(item.lastObservedAt)||localDate(new Date(item.lastObservedAt),scope.timezone)<scope.fromDate||localDate(new Date(item.lastObservedAt),scope.timezone)>scope.toDate)continue;
    // Historical resolved episodes are never described as still under observation.
    parts.push(`${c.episode} · ${label(item.metricKey,locale,c)} · ${episodeStates[locale][item.state]}\n${c.observed}: ${item.lastObservedAt}${item.resolvedAt?`\n${c.resolved}: ${item.resolvedAt}`:''}`);
    if(focus==='history'){
     const history=(item.history??[]).filter(value=>Object.hasOwn(episodeStates[locale],value.state)&&validDate(value.at)&&Date.parse(value.at)<=scope.asOfEpochMs).slice(0,5);
     if(history.length>1){historyCount++;parts.push(`${c.history}\n${history.map(value=>`${value.at} · ${episodeStates[locale][value.state]}`).join('\n')}`);}
    }
   }else if(item.kind!=='EVIDENCE')continue;
   parts.push(...evidence.slice(0,1).map(e=>renderEvidence(e,locale,c)));count++;
  }
  if(!parts.length)parts.push(c.empty);
  if(focus==='history')parts.push(...(!historyCount?[c.noHistory]:[]),c.historyLimit);
  await reader.assert(scope);
  const sealed=await reader.sealReply(scope,{...reply,text:`${reply.text}\n\n${c.title}\n${parts.join('\n\n')}`}),{stage8ReplyGuard,...projection}=sealed;
  if(!stage8ReplyGuard)throw Error('COACH_CONTEXT_REPLY_AUTHORITY_REQUIRED');
  return {...projection,stage7CoachContextGuard:stage8ReplyGuard};
 }
 async function verifyReply({userId,chatId,reply}){
  try{const reader=current();if(!reader||!reply?.stage7CoachContextGuard)return false;
   const {stage7CoachContextGuard,stage7ReplyGuard,...projection}=reply;
   return await reader.verifyReply({userId,chatId,reply:{...projection,stage8ReplyGuard:stage7CoachContextGuard}});
  }catch{return false;}
 }
 return Object.freeze({project,verifyReply});
}
