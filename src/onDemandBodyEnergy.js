import {createBodyEnergyNotificationControl} from './bodyEnergyNotificationControl.js';
import {registerBodyEnergyTelegramReplyBoundary} from './bodyEnergyTelegramReplyBoundary.js';
import {isBodyEnergyQuery} from './bodyEnergyPresentation.js';
import {localDate} from './time.js';

export function onDemandBodyEnabled(environment={}){
 const value=environment.BODY_ENERGY_ON_DEMAND??'off';
 if(!['on','off'].includes(value))throw Error('BODY_ENERGY_ON_DEMAND_CONFIG_INVALID');
 return value==='on';
}
const COPY={
 'zh-TW':{missing:'資料不足',limited:'（參考值）',wake:'（起床時）',baseline:'需要先累積至少 7 天可用且有變化的 HRV 和靜止心率',other:'需要新鮮、已評分且授權有效的睡眠與恢復資料',initial:'起床',time:'時間消耗',load:'今天活動',nap:'小睡'},
 en:{missing:'Insufficient data',limited:'(reference estimate)',wake:'(at wake-up)',baseline:'At least 7 days of usable, varying HRV and resting heart rate are needed',other:'Fresh, scored sleep and recovery with valid access are needed',initial:'Wake-up',time:'Time',load:'Activity today',nap:'Nap'},
 vi:{missing:'Chưa đủ dữ liệu',limited:'(giá trị tham khảo)',wake:'(khi thức dậy)',baseline:'Cần ít nhất 7 ngày HRV và nhịp tim nghỉ hợp lệ, có biến thiên',other:'Cần dữ liệu giấc ngủ và phục hồi mới, đã chấm điểm và còn quyền truy cập',initial:'Thức dậy',time:'Thời gian',load:'Hoạt động hôm nay',nap:'Ngủ ngắn'},
};
export function renderOnDemandBody(calculation,{locale='zh-TW',morning=false,details=false,dataAsOfUtc=null,timezone}={}){
 const c=COPY[locale]??COPY['zh-TW'],d=calculation?.drivers,value=morning?d?.initial_charge:calculation?.value;
 if(!['AVAILABLE','LIMITED'].includes(calculation?.quality_state)||!Number.isFinite(value)){
  const baseline=calculation?.reasons?.some(r=>['INSUFFICIENT_BASELINE','BASELINE_SCALE_UNAVAILABLE'].includes(r));
  return `🔋 Body Energy：${c.missing}。${baseline?c.baseline:c.other}`;
 }
 let text=`🔋 Body Energy：${value}/100${morning?c.wake:''}${calculation.quality_state==='LIMITED'?c.limited:''}`;
 if(calculation.reasons?.some(code=>/^(SLEEP|RECOVERY|CYCLE|WORKOUT)_STALE$/.test(code))&&Number.isFinite(Date.parse(dataAsOfUtc))&&timezone){
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(dataAsOfUtc));
  text+=locale==='en'?` (data as of ${time})`:locale==='vi'?` (dữ liệu lúc ${time})`:`（${time} 的資料）`;
 }
 if(details&&!morning){
  const n=x=>Number(x.toFixed(1));
  text+=`\n${c.initial} ${d.initial_charge} → ${c.time} −${n(d.time_depletion)} → ${c.load} −${n(d.load_depletion)}`;
  if(d.nap_recharge>0)text+=` → ${c.nap} +${n(d.nap_recharge)}`;
 }
 return text;
}
/** The existing source selector/calculator is read without persist/compute,
 * Stage 6, publication grants or numerical result storage. */
export function createOnDemandBodyEnergy({db,stores,keys,environment,now=()=>new Date()}){
 const notificationControl=createBodyEnergyNotificationControl({db,keys,now});
 async function inspect({userId,healthDate,requestedAt=new Date(now()),morning=false,expectedSleepId=null}){
  if(!onDemandBodyEnabled(environment))throw Error('BODY_ENERGY_ON_DEMAND_DISABLED');
  const user=await db.getUser(userId),locale=await db.getLocale(userId);
  if(user?.status!=='ACTIVE'||!locale||(await db.getOnboarding(userId))?.state!=='READY')throw Error('BODY_ENERGY_RECIPIENT_FENCED');
  return stores.withContext(userId,{executionMode:'SHADOW',providerRequired:true},async context=>{
   const date=healthDate??localDate(requestedAt,context.timezone);
   const result=await stores.bodyEnergy.calculateReadOnly(context,{asOfEpochMs:requestedAt.getTime(),targetHealthDate:date},{morning,expectedSleepId});
   await stores.assertCurrent(context);
   return {...result,locale,identity:[context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,context.sourceGeneration,context.inputGeneration,context.timezone]};
  });
 }
 async function currentSection({userId,healthDate,requestedAt=new Date(now()),morning=false,details=false,expectedSleepId=null}){
  const result=await inspect({userId,healthDate,requestedAt,morning,expectedSleepId});
  if(morning&&!['AVAILABLE','LIMITED'].includes(result.calculation?.quality_state)){
   try{console.log(JSON.stringify({event:'morning_body_energy_unavailable',user:keys.lookup(['companion-diagnostic-user-v1',userId]),
    quality_state:/^[A-Z_]{1,48}$/.test(result.calculation?.quality_state??'')?result.calculation.quality_state:'UNKNOWN',
    reasons:(result.calculation?.reasons??[]).filter(v=>typeof v==='string'&&/^[A-Z_]{1,80}$/.test(v)).slice(0,30)}));}catch{/* Diagnostic only. */}
  }
  const message=renderOnDemandBody(result.calculation,{locale:result.locale,morning,details,dataAsOfUtc:result.dataAsOfUtc,timezone:result.timezone});
  const recipe={version:'on-demand-body-v1',at:requestedAt.toISOString(),healthDate:result.healthDate,morning,details,expectedSleepId,
   proof:keys.lookup(['on-demand-body-v1',userId,result,message])};
  return {message,status:result.calculation.quality_state,replyGuard:recipe,verifyCurrent:()=>verifyReplyGuard(recipe,userId)};
 }
 async function verifyReplyGuard(recipe,userId){
  if(recipe?.version==='body-energy-control-reply-v1')return notificationControl.verifyReplyGuard(recipe,userId);
  if(recipe?.version!=='on-demand-body-v1'||typeof recipe.proof!=='string'||!Number.isFinite(Date.parse(recipe.at)))throw Error('BODY_ENERGY_REPLY_GUARD_INVALID');
  const age=new Date(now()).getTime()-Date.parse(recipe.at);
  if(age<0||age>90000)throw Error('BODY_ENERGY_REPLY_EXPIRED');
  const result=await inspect({userId,healthDate:recipe.healthDate,requestedAt:new Date(recipe.at),morning:recipe.morning,expectedSleepId:recipe.expectedSleepId??null});
  const message=renderOnDemandBody(result.calculation,{locale:result.locale,morning:recipe.morning,details:recipe.details,dataAsOfUtc:result.dataAsOfUtc,timezone:result.timezone});
  if(keys.lookup(['on-demand-body-v1',userId,result,message])!==recipe.proof)throw Error('BODY_ENERGY_CURRENTNESS_FENCED');
  return true;
 }
 const isQuery=text=>isBodyEnergyQuery(text)||/電量|电量|năng lượng|nang luong/iu.test(text??'');
 registerBodyEnergyTelegramReplyBoundary(db,verifyReplyGuard);
 return Object.freeze({inspect,currentSection,verifyReplyGuard,notificationControl,isQuery,
  query:request=>isQuery(request.text)?currentSection({...request,details:true}):null,beforeMorning:async()=>({action:'ORDINARY'})});
}
