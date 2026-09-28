import { requireTriggerSource } from './phase4DrainPolicy.js';
export { requireTriggerSource,TRIGGER_SOURCES,STAGE6_BUDGETS,stage6Budget } from './phase4DrainPolicy.js';
export const SCHEDULER_TIMEZONE='Asia/Taipei';
export const FUTURE_CLOUDFLARE_CRON='*/10 0-3 * * *';
export function schedulerWindow(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:SCHEDULER_TIMEZONE,
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const minutes=Number(parts.hour)*60+Number(parts.minute),active=minutes>=480&&minutes<720;
  return {cloudflareExpected:active,startupGrace:active&&minutes<=500,taipeiMinutes:minutes};
}
export function schedulerProviderState(heartbeat,provider,now=new Date()) {
  if(!['cloudflare','github'].includes(provider))throw new Error('SCHEDULER_PROVIDER_REQUIRED');
  const window=schedulerWindow(now),expected=provider==='cloudflare'?window.cloudflareExpected:!window.cloudflareExpected;
  const raw=heartbeat?.lastOkAt??heartbeat?.last_ok_at,age=raw?now.getTime()-Date.parse(raw):null;
  const ageMs=age!==null&&Number.isFinite(age)&&age>=0?age:null;
  if(!expected)return {provider,state:'not_expected',expected:false,ageMs};
  if(provider==='cloudflare'&&window.startupGrace)return {provider,state:'startup_grace',expected:true,ageMs};
  return {provider,state:ageMs!==null&&ageMs<=(provider==='cloudflare'?30*60000:3*3600000)?'healthy':'stale',expected:true,ageMs};
}
export function stage6SchedulerDecision({source,now=new Date(),cloudflareHeartbeat=null}) {
  requireTriggerSource(source);const window=schedulerWindow(now);
  if(source==='event'||source==='manual')return {drain:true,role:source,scheduler:false};
  if(source==='cloudflare')return {drain:window.cloudflareExpected,role:'primary',scheduler:true};
  const stale=schedulerProviderState(cloudflareHeartbeat,'cloudflare',now).state==='stale';
  return {drain:!window.cloudflareExpected||stale,role:window.cloudflareExpected?'fallback':'background',scheduler:true};
}
