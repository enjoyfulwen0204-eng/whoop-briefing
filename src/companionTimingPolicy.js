import {DAILY_PROACTIVE_MAXIMUM} from './proactiveQuota.js';
import {localDate} from './time.js';
export const COMPANION_DEFAULTS=Object.freeze({version:'companion-defaults-v1',journalDailyMaximum:1,coachDailyMaximum:1,
 optionalDailyMaximum:DAILY_PROACTIVE_MAXIMUM,coachAfterWakeMinimumHours:4,coachAfterWakeMaximumHours:6,journalGapHours:2,
 quietStart:'22:00',quietEnd:'08:00'});
const hm=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('COMPANION_QUIET_HOURS_INVALID');return Number(value.slice(0,2))*60+Number(value.slice(3));};
export function inCompanionQuietHours(instant,timezone,start=COMPANION_DEFAULTS.quietStart,end=COMPANION_DEFAULTS.quietEnd){
 const a=hm(start),b=hm(end);if(a===b)return false;
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const t=Number(p.hour)*60+Number(p.minute);return a<b?t>=a&&t<b:t>=a||t<b;
}
/** Stage 7's fixed quiet floor; the shared Stage 8 helper remains unchanged. */
export function inStage7QuietHours(instant,timezone,start=COMPANION_DEFAULTS.quietStart,end=COMPANION_DEFAULTS.quietEnd){
 const selected=inCompanionQuietHours(instant,timezone,start,end);
 return inCompanionQuietHours(instant,timezone)||selected;
}
export function companionSchedulerSlots(from,through){
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(through)||through<from||through-from>86400000)throw Error('COMPANION_SLOT_RANGE_INVALID');
 const out=[];
 for(let at=Math.ceil(from/60000)*60000;at<=through;at+=60000){const d=new Date(at);if(d.getUTCHours()<4?d.getUTCMinutes()%10===0:d.getUTCMinutes()===10)out.push(at);}
 return out;
}
/** Server supplies an existing canonical wake + acknowledged brief/Journal.
 * The caller must persist the result once under user/health-day, even a skip.
 * Version/template/locale changes never enter the dedupe key or redraw a slot. */
export function selectCompanionInvitation({now,wakeAt,briefAt,journalAt,healthDay,timezone,seed,
 quietStart=COMPANION_DEFAULTS.quietStart,quietEnd=COMPANION_DEFAULTS.quietEnd,config=COMPANION_DEFAULTS}){
 if(![now,wakeAt,briefAt,journalAt].every(Number.isSafeInteger)||wakeAt>now||briefAt>now||journalAt>now
   ||localDate(new Date(wakeAt),timezone)!==healthDay||typeof seed!=='string'||!/^[a-f0-9]{64}$/.test(seed))throw Error('COMPANION_WAKE_AUTHORITY_REQUIRED');
 hm(quietStart);hm(quietEnd);
 if(![config.coachAfterWakeMinimumHours,config.coachAfterWakeMaximumHours,config.journalGapHours].every(Number.isFinite)||typeof config.version!=='string'||!config.version
   ||config.journalDailyMaximum!==1||config.coachDailyMaximum!==1||config.optionalDailyMaximum!==2
   ||config.coachAfterWakeMinimumHours<4||config.coachAfterWakeMaximumHours>6
   ||config.coachAfterWakeMinimumHours>config.coachAfterWakeMaximumHours||config.journalGapHours<2)throw Error('COMPANION_DEFAULTS_INVALID');
 const starts=wakeAt+config.coachAfterWakeMinimumHours*3600000,ends=wakeAt+config.coachAfterWakeMaximumHours*3600000;
 const from=Math.max(now+1,starts,briefAt+1,journalAt+config.journalGapHours*3600000);
 const eligible=(from<=ends?companionSchedulerSlots(from,ends):[])
  .filter(at=>at<=ends&&localDate(new Date(at),timezone)===healthDay&&!inStage7QuietHours(at,timezone,quietStart,quietEnd));
 if(!eligible.length)return Object.freeze({state:'SKIPPED',reason:'NO_ELIGIBLE_FUTURE_SLOT',selectedAt:null,expiresAt:ends,policyVersion:config.version});
 return Object.freeze({state:'SCHEDULED',selectedAt:eligible[Number.parseInt(seed.slice(0,8),16)%eligible.length],expiresAt:ends,policyVersion:config.version});
}
