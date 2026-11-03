import {createExecutionBudget,currentExecutionBudget} from './executionBudget.js';
import {ANALYTICS_WORK} from './config.js';
import {localDate,localTime,addDays} from './time.js';
import {loadDailyMetricsDetailed} from './dailyMetrics.js';
import {trainEvaluateAndCompare,predict,persistPrediction,DEFAULT_FEATURES} from './prediction.js';
import {maturityOf} from './predictionPipeline.js';
import {reportRoom,reportIdentity,sendScheduledReport} from './scheduledReport.js';
import {healthReminderTiming} from './healthReminderPolicy.js';
import {capabilityStatusForField,isKnownUnavailable} from './capabilityMap.js';
export const predictionDue=at=>localTime(at,'Asia/Taipei')>='21:10'&&localTime(at,'Asia/Taipei')<'21:25';
export function evaluateEvening(rows,anchor,capabilityUnavailable=false){
 const run=trainEvaluateAndCompare(rows),verdict=maturityOf(run,{anchorDate:anchor,capabilityUnavailable});
 const features=rows.find(r=>r.health_date===anchor);
 const p=verdict.qualified&&features?predict(run.model,features):null;
 const factors=p?Object.entries(run.model.fit.coefficients??{}).filter(([k,c])=>DEFAULT_FEATURES.includes(k)&&Number.isFinite(c)&&Number.isFinite(features[k]))
  .map(([key,c])=>({key,value:features[key],contribution:c*features[key]})).filter(f=>Number.isFinite(f.contribution))
  .sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)).slice(0,2):[];
 return {run,verdict,prediction:p,features,factors};
}
export function recentAccuracy(runs,day){
 const rows=runs.filter(r=>r.target_date>=addDays(day,-13)&&r.target_date<=day&&Number.isFinite(r.actual_value)&&Number.isFinite(r.predicted_value));
 return rows.length>=5?{n:rows.length,mae:rows.reduce((n,r)=>n+Math.abs(r.actual_value-r.predicted_value),0)/rows.length}:null;
}
export function renderEveningPrediction(result,accuracy,locale){
 const c=locale==='en'?{title:'📈 Tomorrow’s Recovery prediction',approx:'about',basis:'Main model factors',accuracy:'Prediction accuracy over the past 14 days: mean error',learning:'Accuracy: still accumulating',points:'points',rough:'rough range',sleep_total:'Sleep',previous_day_strain:'Previous-day activity load',hrv:'HRV',rhr:'Resting heart rate',sleep_debt:'Sleep debt',effect:'model contribution'}:
 locale==='vi'?{title:'📈 Dự đoán Recovery ngày mai',approx:'khoảng',basis:'Yếu tố chính của mô hình',accuracy:'Độ chính xác 14 ngày qua: sai số trung bình',learning:'Độ chính xác: đang tích lũy',points:'điểm',rough:'khoảng ước tính',sleep_total:'Giấc ngủ',previous_day_strain:'Mức hoạt động ngày trước',hrv:'HRV',rhr:'Nhịp tim nghỉ',sleep_debt:'Nợ ngủ',effect:'đóng góp mô hình'}:
 {title:'📈 明天 Recovery 預測',approx:'約',basis:'主要依據',accuracy:'過去 14 天的預測準確度：平均誤差',learning:'準確度：還在累積',points:'分',rough:'粗略區間',sleep_total:'睡眠',previous_day_strain:'前一天活動負荷',hrv:'HRV',rhr:'靜止心率',sleep_debt:'睡眠債',effect:'模型貢獻'};
 const p=result.prediction,range=Number.isFinite(p.predicted_low)&&Number.isFinite(p.predicted_high)?`${Math.round(p.predicted_low)}–${Math.round(p.predicted_high)}（${c.rough}）`:`${c.approx} ${Math.round(p.predicted_value)}`;
 const lines=[`${c.title}：${range}`];
 if(result.factors.length)lines.push(c.basis+'：'+result.factors.map(f=>`${c[f.key]} ${['sleep_total','sleep_debt'].includes(f.key)?(f.value/3600000).toFixed(1)+'h':Number(f.value.toFixed(1))}（${c.effect} ${f.contribution>=0?'+':''}${f.contribution.toFixed(1)}）`).join('、'));
 lines.push(accuracy?`${c.accuracy} ${accuracy.mae.toFixed(1)} ${c.points}`:c.learning);return lines.join('\n');
}
export async function notifyPrediction({db,user,telegram,locale,now=()=>new Date(),load=loadDailyMetricsDetailed}){
 if(!predictionDue(now()))return {status:'NOT_DUE'};
 if(!reportRoom(15000))return {status:'DEFERRED_BUDGET'};
 const day=localDate(now(),user.timezone),prior=await db.getClaim(user.id,'prediction',day);
 if(prior&&['DELIVERY_STARTED','DELIVERED','AMBIGUOUS'].includes(prior.deliveryState))return {status:'ALREADY_RESERVED'};
 const timing=await healthReminderTiming(db,user.id,user.timezone,now());if(timing.quiet||timing.paused)return {status:'QUIET_OR_PAUSED'};
 const identity=await reportIdentity(db,user);if(!identity)return {status:'NOT_READY'};
 const anchor=(await db.coverage(user.id))?.last_date;
 if(anchor!==day)return {status:'SOURCE_STALE'};
 // Only read-only preparation runs under this sub-budget. An aborted late
 // continuation cannot persist a prediction or send; delivery uses the parent.
 const parent=currentExecutionBudget(),budget=createExecutionBudget({budgetMs:Math.max(1,Math.min(12000,(parent?.remainingMs()??20000)-8000)),signal:parent?.signal});
 let result;
 try{result=await budget.run(async()=>{
  const detailed=await load({db,userId:user.id,timezone:user.timezone,from:addDays(anchor,-ANALYTICS_WORK.HEAVY_LOOKBACK_DAYS),to:anchor});
  budget.assert();if(!detailed.complete)return null;
  const caps=await db.getCapabilities(user.id);budget.assert();
  return evaluateEvening(detailed.rows,anchor,isKnownUnavailable(capabilityStatusForField('recovery',caps)));
 });}catch(error){if(error?.code==='SYNC_TIMEOUT'&&!parent?.signal?.aborted)return {status:'DEFERRED_BUDGET'};throw error;}finally{budget.close();}
 if(!result)return {status:'INPUT_INCOMPLETE'};
 if(!result.verdict.qualified||!Number.isFinite(result.prediction?.predicted_value))return {status:'MODEL_UNQUALIFIED'};
 if(!reportRoom())return {status:'DEFERRED_BUDGET'};
 const accuracy=recentAccuracy(await db.getPredictions(user.id,{targetMetric:'recovery',limit:100}),day);
 return sendScheduledReport({db,user,telegram,kind:'prediction',day,identity,now,text:renderEveningPrediction(result,accuracy,locale),
  verify:async()=>predictionDue(now())&&localDate(now(),user.timezone)===day,
  beforeDelivery:()=>persistPrediction(db,user.id,{targetDate:addDays(day,1),targetMetric:'recovery',prediction:result.prediction,
   features:Object.fromEntries(DEFAULT_FEATURES.map(k=>[k,result.features[k]]))},{now:now()})});
}
