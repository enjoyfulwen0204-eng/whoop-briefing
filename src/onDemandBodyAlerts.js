import {BODY_ENERGY_NOTIFICATION_POLICY} from './bodyEnergyNotificationPolicy.js';
import {healthReminderTiming} from './healthReminderPolicy.js';
import {localDate} from './time.js';
import {workStepOptions} from './phase4WorkStep.js';
import {isSuppressedDelivery} from './accountLifecycle.js';
export const LOW_ENERGY_FLOOR=BODY_ENERGY_NOTIFICATION_POLICY.absoluteFloor;
export function lowEnergyMessage(value,locale){
 return locale==='vi'?`🪫 Body Energy còn ${value}/100. Hôm nay tiêu hao khá nhiều, hãy nghỉ ngơi sớm nhé.`:
  locale==='en'?`🪫 Body Energy is ${value}/100. You've used more energy today; consider resting early.`:
  `🪫 Body Energy 剩 ${value}/100，今天消耗比較大，早點休息吧。`;
}
/** Existing proactive event is the at-most-once reservation. Unknown sends
 * retain it; no claim takeover, receipt reset, or numerical result persistence. */
export async function checkLowEnergy({db,bodyEnergy,keys,user,telegram,now=new Date()}){
 const started=Date.now(),currentTime=()=>new Date(now.getTime()+Date.now()-started);
 const id=user.id,life=user.lifecycleGeneration,control=await bodyEnergy.notificationControl.read(id);
 if(!control.alertsEnabled)return {status:'DISABLED'};
 const timing=await healthReminderTiming(db,id,user.timezone,now);
 if(timing.paused)return {status:'PAUSED'};
 const view=await bodyEnergy.inspect({userId:id,requestedAt:now}),calculation=view.calculation;
 if(!['AVAILABLE','LIMITED'].includes(calculation.quality_state)||!Number.isFinite(calculation.value)||calculation.value>=LOW_ENERGY_FLOOR)return {status:'NOT_LOW'};
 const day=localDate(now,user.timezone),key='body-low-discard:'+keys.lookup([id,life,day]);
 // Quiet-hour work is discarded for this source generation. A later cron may
 // consider genuinely new WHOOP inputs, never replay this deferred alert.
 const source=keys.lookup(['body-low-source',...view.identity]);
 if(timing.quiet){await db.transaction(()=>db.setState(key,source,{now}),workStepOptions('body-low.discard',[id,life,day,source]));return {status:'QUIET_DISCARDED'};}
 if(await db.getState(key)===source)return {status:'QUIET_DISCARDED'};
 const message=lowEnergyMessage(calculation.value,view.locale);
 const verify=async()=>{
  await db.assertAccountActive(id,life);
  if(localDate(currentTime(),user.timezone)!==day)return false;
  const current=await bodyEnergy.notificationControl.read(id),gate=await healthReminderTiming(db,id,user.timezone,currentTime());
  if(!current.alertsEnabled||current.revision!==control.revision||gate.paused||gate.quiet)return false;
  const fresh=await bodyEnergy.inspect({userId:id,requestedAt:now});
  return keys.lookup([fresh])===keys.lookup([view]);
 };
 const claim=await db.transaction(async()=>{
  if(!await verify())return null;
  return db.claimProactiveEvent(id,{healthDate:day,idempotencyKey:`body-low-v1:${day}:L${life}`,signals:[],decision:'NOTIFY',
   reason:{kind:'LOW_ENERGY'},policyVersion:'body-low-on-demand-v1',messageText:message},{now,expectedLifecycleGeneration:life});
 },workStepOptions('body-low.claim',[id,life,day],{discardResult:true,replay:async()=>null}));
 if(!claim?.claimed)return {status:'ALREADY_RESERVED_OR_LIMITED'};
 const sent=await telegram.send(message,{authorize:verify});
 if(isSuppressedDelivery(sent)||sent?.dryRun)return {status:'SUPPRESSED'};
 if(!/^\d+$/.test(String(sent?.messageId??'')))return {status:'UNKNOWN'};
 await db.transaction(()=>db.markProactiveEventSent(id,claim.id,{}, {now}),workStepOptions('body-low.settle',[id,claim.id],{discardResult:true}));
 return {status:'DELIVERED'};
}
