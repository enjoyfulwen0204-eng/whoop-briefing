import {healthReminderTiming} from './healthReminderPolicy.js';
import {currentExecutionBudget} from './executionBudget.js';
import {deliverReport} from './reportDelivery.js';
import {REPORT_CLAIM} from './config.js';
export const reportRoom=(needed=8000)=>!currentExecutionBudget()||currentExecutionBudget().remainingMs()>=needed;
/** Read only control identity, never token values. Recheck at the actual send
 * boundary; the original report claim retains uncertain delivery forever. */
export async function reportIdentity(db,user){
 const rows=(await db.raw.execute({sql:`SELECT u.status,u.lifecycle_generation,u.timezone,t.auth_generation,
  p.purge_generation,p.source_generation,p.pending_purge_count,o.state onboarding,g.telegram_chat_id,
  u.created_at,
  (SELECT COUNT(*) FROM whoop_resource_access a WHERE a.user_id=u.id AND a.resource IN ('sleep','recovery')
   AND a.status='ACCESSIBLE' AND a.auth_generation=t.auth_generation AND a.lifecycle_generation=u.lifecycle_generation) access_count,
  (SELECT MAX(health_date) FROM whoop_sleeps s WHERE s.user_id=u.id AND s.nap=0) last_main_date,
  (t.access_token IS NOT NULL AND t.access_token<>'') connected
  FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
  JOIN phase4_user_state p ON p.user_id=u.id
  JOIN user_telegram g ON g.user_id=u.id AND g.status='ACTIVE' WHERE u.id=?`,args:[user.id]})).rows;
 const row=rows.length===1?rows[0]:null;
 if(!row||row.status!=='ACTIVE'||row.lifecycle_generation!==user.lifecycleGeneration||row.onboarding!=='READY'||row.connected!==1||row.pending_purge_count!==0||row.access_count!==2
  ||(user.reportChatId!==undefined&&String(row.telegram_chat_id)!==String(user.reportChatId)))return null;
 return {...row};
}
export async function sendScheduledReport({db,user,telegram,kind,day,text,identity,now,verify=async()=>true,beforeDelivery}){
 const fenced=()=>Object.assign(Error('SCHEDULED_REPORT_FENCED'),{code:'SCHEDULED_REPORT_FENCED'});
 const check=async()=>{
  if(!reportRoom(2000)||!identity||JSON.stringify(await reportIdentity(db,user))!==JSON.stringify(identity))throw fenced();
  const timing=await healthReminderTiming(db,user.id,user.timezone,now());
  if(timing.quiet||timing.paused||!await verify())throw fenced();
  return true;
 };
 if(!reportRoom())return {status:'DEFERRED_BUDGET'};
 try{await check();}catch(error){if(error?.code==='SCHEDULED_REPORT_FENCED')return {status:'FENCED'};throw error;}
 const claimKey={userId:user.id,reportType:kind,localDateKey:day};
 const claim=await db.claimReport({...claimKey,ttlMs:REPORT_CLAIM.TTL_MS,expectedLifecycleGeneration:user.lifecycleGeneration,now:now()});
 if(!claim.granted)return {status:claim.ambiguous?'ALREADY_RESERVED':claim.alreadySent?'ALREADY_DELIVERED':'CLAIM_BUSY'};
 try{if(beforeDelivery){await check();await beforeDelivery();}}
 catch(error){await db.releaseClaim({...claimKey,owner:claim.owner});if(error?.code==='SCHEDULED_REPORT_FENCED')return {status:'FENCED'};throw error;}
 const result=await deliverReport({db,claimKey,claim,telegram,text,now,authorizeContent:check});
 return {status:({delivered:'DELIVERED',dry_run:'DRY_RUN',fenced:'FENCED',definite_failure:'FAILED_DEFINITE',ambiguous:'AMBIGUOUS',suppressed_stale_lifecycle:'FENCED'})[result.result]??'UNKNOWN'};
}
