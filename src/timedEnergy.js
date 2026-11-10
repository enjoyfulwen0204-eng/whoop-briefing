import {localDate,localTime} from './time.js';
import {healthReminderTiming} from './healthReminderPolicy.js';
import {reportRoom,reportIdentity,sendScheduledReport} from './scheduledReport.js';
import {timedEnergyEnabled} from './bot/privateControls.js';
import {predictionDue} from './predictionNotification.js';

// The scheduled instant comes from the signed extras request, not its arrival.
export function energySlot(tick,now,tz){
 if(!(tick instanceof Date)||!Number.isFinite(+tick)||+tick>+now||+now- +tick>=3600000)return null;
 const hhmm=localTime(tick,tz),day=localDate(tick,tz),hour=Number(hhmm.slice(0,2));
 if(![15,18,21].includes(hour)||!hhmm.endsWith(':10')||localDate(now,tz)!==day||localTime(now,tz).slice(0,2)!==hhmm.slice(0,2))return null;
 return {day,hour,overlap:hour===21&&predictionDue(tick)};
}
const finite=Number.isFinite;
const valueOf=r=>['AVAILABLE','LIMITED'].includes(r?.calculation?.quality_state)&&finite(r.calculation.value)?r.calculation.value:null;
export function renderTimedEnergy(locale,hour,current,wake,earlier){
 const zh=locale==='zh-TW',vi=locale==='vi';
 const lines=[zh?`🔋 ${hour}:00 電量 ${current}`:vi?`🔋 ${hour}:00 Năng lượng ${current}`:`🔋 ${hour}:00 Energy ${current}`];
 if(hour===15&&finite(wake))lines.push(zh?`起床 ${wake} → 到現在用掉 ${wake-current}`:vi?`Lúc thức dậy ${wake} → đã dùng ${wake-current}`:`At wake-up ${wake} → used ${wake-current} so far`);
 if(hour===18&&finite(earlier)){
  const difference=current-earlier;
  const amount=Math.abs(difference);
  if(difference===0)lines.push(zh?'跟 15:00 一樣':vi?'Không đổi so với 15:00':'Unchanged since 15:00');
  else if(zh)lines.push(`比 15:00 ${difference<0?'少':'多'}了 ${amount}`);
  else if(vi)lines.push(`${difference<0?'Giảm':'Tăng'} ${amount} so với 15:00`);
  else lines.push(`${difference<0?'Down':'Up'} ${amount} since 15:00`);
 }
 if(hour===21){
  if(finite(wake)&&wake>=current){
   const used=wake-current;
   lines.push(zh?`今天總共用掉 ${used}`:vi?`Hôm nay đã dùng ${used}`:`Used today: ${used}`);
  }
  if(current<=33)lines.push(zh?'🌙 早點休息':vi?'🌙 Nghỉ ngơi sớm nhé':'🌙 Get some rest early');
 }
 return lines.join('\n');
}
export async function prepareTimedEnergy(input,slot){
 const {db,user,enrollment,now,getBody,tick,locale}=input;
 if(!slot)return {status:'NOT_DUE'};
 const verifyPrefs=async()=>Boolean(energySlot(tick,now(),user.timezone)&&await enrollment.eligible(user)&&await timedEnergyEnabled(enrollment,user.id));
 if(!enrollment||!await verifyPrefs())return {status:'DISABLED_OR_INELIGIBLE'};
 const timing=await healthReminderTiming(db,user.id,user.timezone,now());
 if(timing.quiet||timing.paused)return {status:'QUIET_OR_PAUSED'};
 const kind=slot.overlap?'prediction':'timed_energy_'+slot.hour;
 const prior=await db.getClaim(user.id,kind,slot.day);
 if(prior&&['DELIVERED','DELIVERY_STARTED','AMBIGUOUS'].includes(prior.deliveryState))return {status:'ALREADY_RESERVED'};
 if(!reportRoom(10000))return {status:'DEFERRED_BUDGET'};
 const identity=await reportIdentity(db,user);
 if(!identity)return {status:'NOT_READY'};
 if(identity.last_main_date!==slot.day)return {status:'MAIN_SLEEP_MISSING'};
 const body=await getBody(),at=now(),inspect=requestedAt=>body.inspect({userId:user.id,healthDate:slot.day,requestedAt});
 let r;try{r=await inspect(at);}catch(e){if(e?.code==='NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS')return {status:'INPUT_UNAVAILABLE'};throw e;}
 const current=valueOf(r);
 if(current===null||r.healthDate!==slot.day||!r.wakeAt)return {status:'BODY_'+(['NO_DATA','WARMING_UP','DEGRADED','UNAVAILABLE'].includes(r.calculation?.quality_state)?r.calculation.quality_state:'UNAVAILABLE')};
 const comparison=slot.hour===18?await compareWithAfternoon({inspect,tick,slot,timezone:user.timezone,current:r}):null;
 return {status:'READY',comparisonCode:comparison?.code,plan:{...input,kind,day:slot.day,identity,text:renderTimedEnergy(locale,slot.hour,current,r.calculation.drivers?.initial_charge,comparison?.value),
  verify:async()=>await verifyPrefs()&&await body.identityCurrent(user.id,r.identity)}};
}
// Recalculate only when the original sources can still be authenticated at
// 15:00. Later revisions must never stand in for the earlier measurement.
async function compareWithAfternoon({inspect,tick,slot,timezone,current}){
 const at=new Date(+tick-(3*60+10)*60000);
 at.setUTCSeconds(0,0);
 if(localDate(at,timezone)!==slot.day||localTime(at,timezone)!=='15:00')return {code:'PRIOR_LOCAL_TIME_MISMATCH'};
 let previous;
 try{previous=await inspect(at);}
 catch(error){
  if(error?.code==='NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS')return {code:'NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS'};
  throw error;
 }
 if(previous?.healthDate!==slot.day||previous.wakeAt!==current.wakeAt)return {code:'PRIOR_WAKE_MISMATCH'};
 if(JSON.stringify(previous.identity)!==JSON.stringify(current.identity))return {code:'PRIOR_IDENTITY_CHANGED'};
 const value=valueOf(previous);
 return value===null?{code:'PRIOR_VALUE_UNAVAILABLE'}:{code:'COMPARISON_INCLUDED',value};
}
// A prediction is only persisted inside the original fenced claim, immediately
// before delivery. At an overlapping slot BOTH variants use its existing key.
export async function extrasReports(input,{step,predict,prepare=prepareTimedEnergy,deliver=sendScheduledReport}){
 const slot=energySlot(input.tick,input.now(),input.user.timezone);
 let predictionPlan=null;
 let prediction=await step('prediction',()=>predict({...input,...(slot?.overlap?{deliver:async plan=>{predictionPlan=plan;return {status:'PREPARED'};}}:{})}));
 if(!slot)return {prediction:prediction.status,timed_energy:'NOT_DUE'};
 let dispatched=false;
 const energy=await step('timed_energy',async()=>{
  const prepared=await prepare(input,slot);
  if(!prepared.plan)return prepared;
  const e=prepared.plan,p=predictionPlan;
  const plan=p?{...p,text:e.text+'\n\n'+p.text,verify:async()=>await e.verify()&&await p.verify()}:e;
  dispatched=true;
  const result=await deliver(plan);
  if(result.status==='DELIVERED'&&prepared.comparisonCode){
   try{console.log(JSON.stringify({event:'timed_energy_comparison',code:prepared.comparisonCode}));}
   catch{/* Delivery is already settled. */}
  }
  return result;
 });
 if(predictionPlan){
  prediction=dispatched?energy:await step('prediction',()=>deliver(predictionPlan));
 }
 return {prediction:prediction.status,timed_energy:energy.status};
}
