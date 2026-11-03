import {localDate,localHour,addDays,daysBetween} from './time.js';
import {healthReminderTiming} from './healthReminderPolicy.js';
import {reportRoom,reportIdentity,sendScheduledReport} from './scheduledReport.js';
import {createMorningSnapshotStore} from './morningReportSnapshot.js';
const duration=m=>`${Math.floor(Math.round(m)/60)}h${Math.round(m)%60}m`;
export function morningUpdateText(before,after,locale){
 const light=after.recovery>=67?'🟢':after.recovery>=34?'🟡':'🔴';
 const c=locale==='en'?['🔄 Morning brief update','WHOOP updated last night’s data:','Recovery','Sleep','Other metrics were updated too. Ask “How am I today?” for the latest version.']:locale==='vi'?['🔄 Cập nhật bản tin sáng','WHOOP đã cập nhật dữ liệu đêm qua:','Phục hồi','Giấc ngủ','Các chỉ số khác cũng được cập nhật. Hãy hỏi “Hôm nay tôi thế nào?” để xem bản mới nhất.']:['🔄 晨報更新','WHOOP 更新了你昨晚的資料：','恢復','睡眠','其他指標也更新了，問我「今天狀況」可以看最新版本'];
 return `${c[0]}\n${c[1]}\n${c[2]} ${Math.round(before.recovery)}% → ${Math.round(after.recovery)}% ${light}\n${c[3]} ${duration(before.minutes)} → ${duration(after.minutes)}\n${c[4]}`;
}
export const morningChanged=(a,b)=>Number.isFinite(b?.recovery)&&Number.isFinite(b?.minutes)&&(Math.abs(a.recovery-b.recovery)>=10||Math.abs(a.minutes-b.minutes)>=30);
export const noSleepReminderDue=days=>days<3||(days-3)%3===0;
export function noSleepText({days,nap,locale}){
 if(days>=3)return locale==='en'?`😴 No WHOOP sleep data has arrived for ${days} days. Please check that your band is syncing with the WHOOP app.`:locale==='vi'?`😴 Đã ${days} ngày chưa nhận dữ liệu giấc ngủ WHOOP. Hãy kiểm tra vòng đeo đã đồng bộ với ứng dụng WHOOP chưa.`:`😴 已經 ${days} 天沒有收到 WHOOP 的睡眠資料，請確認手環有沒有跟 WHOOP App 同步。`;
 return locale==='en'?`😴 Last night’s main sleep has not been detected today\n${nap?'WHOOP recorded only naps':'WHOOP has not recorded sleep'}, so there is no morning brief yet.\nIf you wore your band, open the WHOOP app to sync. The brief will follow when data arrives within the delivery window.`:locale==='vi'?`😴 Hôm nay chưa phát hiện giấc ngủ chính đêm qua\n${nap?'WHOOP chỉ ghi nhận giấc ngủ ngắn':'WHOOP chưa ghi nhận giấc ngủ'}, nên chưa có bản tin sáng.\nNếu đã đeo vòng, hãy mở ứng dụng WHOOP để đồng bộ. Bản tin sẽ được gửi khi dữ liệu đến trong thời hạn gửi.`:`😴 今天還沒偵測到昨晚的主睡眠\n${nap?'WHOOP 只記錄到小睡':'WHOOP 沒有記錄到睡眠'}，所以今天還沒有晨報。\n如果昨晚有戴，打開 WHOOP App 同步一下，資料進來後晨報會自動補發。`;
}
/** Per-user tick cache is transient; nothing is persisted here. */
export function createMorningFollowups({db,keys,user,telegram,locale,now=()=>new Date()}){
 const store=createMorningSnapshotStore({db,keys});let cached,identityCache,claimCache;
 const dailyClaim=()=>claimCache??=(db.getClaim(user.id,'daily',localDate(now(),user.timezone)));
 const currentIdentity=()=>identityCache??=(reportIdentity(db,user));
 const load=()=>cached??=(async()=>{
  const at=now(),day=localDate(at,user.timezone),identity=await currentIdentity();
  if(!identity)return null;
  const timing=await healthReminderTiming(db,user.id,user.timezone,at);if(timing.quiet||timing.paused)return null;
  const sleeps=await db.getSleeps(user.id,{from:day,to:day,includeNaps:true});
  const mains=sleeps.filter(s=>s.nap===0&&s.health_date<=day).sort((a,b)=>Date.parse(b.end_at)-Date.parse(a.end_at));
  return {at,day,identity,sleeps,main:mains[0]??null};
 })();
 async function briefUpdate(){
  if(localHour(now(),user.timezone)>=18)return {status:'NOT_DUE'};
  if(!reportRoom())return {status:'DEFERRED_BUDGET'};
  // No immutable snapshot => no comparison and no reconstructed old numbers.
  const day=localDate(now(),user.timezone),claim=await dailyClaim();
  if(claim?.deliveryState!=='DELIVERED'||!claim.telegramSentAt)return {status:'NO_SNAPSHOT'};
  const identity=await currentIdentity();if(!identity)return {status:'NOT_READY'};
  const before=await store.read({userId:user.id,healthDate:day,claim,control:identity});if(!before)return {status:'NO_SNAPSHOT'};
  const view=await load();if(!view||view.main?.health_date!==day||view.main.score_state!=='SCORED')return {status:'NOT_READY'};
  const recoveries=await db.getRecoveries(user.id,{from:addDays(day,-2),to:day});
  const recovery=recoveries.find(r=>r.sleep_id===view.main.id&&r.score_state==='SCORED'&&r.user_calibrating!==1);
  const after={recovery:recovery?.recovery_score,minutes:Number.isFinite(view.main.total_sleep_milli)?view.main.total_sleep_milli/60000:null};
  if(!morningChanged(before,after))return {status:'NO_CHANGE'};
  if(claim.lifecycleGeneration!==user.lifecycleGeneration)return {status:'FENCED'};
  return sendScheduledReport({db,user,telegram,kind:'brief_update',day,identity:view.identity,now,text:morningUpdateText(before,after,locale),
   verify:async()=>localHour(now(),user.timezone)<18&&localDate(now(),user.timezone)===day});
 }
 async function noSleep(){
  if(localHour(now(),user.timezone)<12)return {status:'NOT_DUE'};
  if(!reportRoom())return {status:'DEFERRED_BUDGET'};
  const claim=await dailyClaim();
  if(claim&&['DELIVERY_STARTED','AMBIGUOUS','DELIVERED'].includes(claim.deliveryState))return {status:'HAS_SLEEP_OR_REPORT'};
  const view=await load();if(!view)return {status:'NOT_READY'};
  if(view.main?.health_date===view.day)return {status:'HAS_SLEEP_OR_REPORT'};
  // The source date, not an in-memory notification counter, anchors the gap.
  const last=view.identity.last_main_date;
  const days=last?daysBetween(view.day,last):Math.max(1,daysBetween(view.day,localDate(view.identity.created_at,user.timezone))+1);
  if(!Number.isFinite(days)||days<1)return {status:'NOT_READY'};
  if(!noSleepReminderDue(days))return {status:'GAP_COOLDOWN'};
  return sendScheduledReport({db,user,telegram,kind:'no_sleep',day:view.day,identity:view.identity,now,
   text:noSleepText({days,nap:view.sleeps.some(s=>s.health_date===view.day&&s.nap===1),locale}),
   verify:async()=>localHour(now(),user.timezone)>=12&&localDate(now(),user.timezone)===view.day});
 }
 return {briefUpdate,noSleep};
}
