import {localDate,localTime,addDays} from './time.js';
export const MORNING_PLAN_VERSION='morning-brief-v1-v34';
const wallCache=new Map();
/** First repeated occurrence; a gap resolves to the first valid wall instant
 * after it. This bounded search uses IANA timezone rules, never server TZ. */
export function morningWallInstant(day,time,timezone){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('MORNING_WALL_TIME_INVALID');
 const key=JSON.stringify([day,time,timezone]);if(wallCache.has(key))return wallCache.get(key);
 const base=Date.parse(day+'T00:00:00.000Z');let after=null;
 for(let n=base-15*3600000;n<=base+39*3600000;n+=60000){const date=new Date(n),d=localDate(date,timezone),t=localTime(date,timezone);
  if(d===day&&t===time){wallCache.set(key,n);return n;}
  if(d===day&&t>time&&after===null)after=n;
 }
 if(after===null)throw Error('MORNING_LOCAL_DAY_UNAVAILABLE');
 if(wallCache.size>512)wallCache.clear();wallCache.set(key,after);return after;
}
export function morningPreferredAt({day,timezone,preferences,wakeAt=null}){
 if(preferences.morning_brief_mode==='FIXED_LOCAL_TIME')return morningWallInstant(day,preferences.morning_brief_local_time,timezone);
 if(preferences.morning_brief_mode!=='AFTER_WAKE')throw Error('MORNING_PREFERENCE_INVALID');
 if(Number.isSafeInteger(wakeAt)&&localDate(new Date(wakeAt),timezone)===day)return wakeAt+preferences.after_wake_delay_minutes*60000;
 return morningWallInstant(day,preferences.fallback_local_time,timezone);
}
export function morningPlanTiming({now,day,timezone,preferences,wakeAt=null}){
 const dueAt=morningPreferredAt({day,timezone,preferences,wakeAt});
 const expiresAt=morningPreferredAt({day:addDays(day,1),timezone,preferences});
 return {dueAt,expiresAt,eligible:!preferences.notifications_paused&&now>=dueAt&&now<expiresAt,
  reason:preferences.notifications_paused?'PAUSED':now>=expiresAt?'EXPIRED_SYSTEM_OUTAGE':now<dueAt?'NOT_DUE':wakeAt===null?'FALLBACK_MISSING_WAKE':'AFTER_WAKE_OR_FIXED'};
}
