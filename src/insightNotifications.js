import {healthReminderTiming} from './healthReminderPolicy.js';
import {localDate,localMidnightUtc} from './time.js';
import {associationWeek,ASSOCIATION_POLICY} from './associationNotifications.js';
import {latestMemory,selectMemoryChange,renderMemory} from './associationMemory.js';
import {currentExecutionBudget} from './executionBudget.js';
import {workStepOptions} from './phase4WorkStep.js';

export async function notifyMemory({db,keys,user,telegram,locale,now=new Date()}){
 if(currentExecutionBudget()&&currentExecutionBudget().remainingMs()<8000)return {status:'DEFERRED_BUDGET'};
 const timing=await healthReminderTiming(db,user.id,user.timezone,now);
 if(timing.quiet||timing.paused)return {status:'QUIET_OR_PAUSED'};
 const day=localDate(now,user.timezone),week=associationWeek(day),since=localMidnightUtc(week,user.timezone).toISOString();
 const history=(await db.raw.execute({sql:'SELECT reason_json,created_at FROM proactive_events WHERE user_id=? AND policy_version=? ORDER BY id DESC LIMIT 501',args:[user.id,ASSOCIATION_POLICY]})).rows;
 if(history.length>500)throw Error('INSIGHT_NOTIFICATION_HISTORY_BOUNDS');
 if(history.some(row=>row.created_at>=since))return {status:'ALREADY_RESERVED'};
 const notified=new Set(history.map(r=>{try{return JSON.parse(r.reason_json).insightVersion;}catch{return null;}}));
 const selected=selectMemoryChange(await latestMemory(db,user.id),week,notified);
 if(!selected)return {status:'NO_NEW_INSIGHT'};
 const identity=`${selected.id}:${selected.version}`,started=Date.now(),clock=()=>new Date(now.getTime()+Date.now()-started);
 const verify=async()=>{
  await db.assertAccountActive(user.id,user.lifecycleGeneration);
  const row=await db.getInsight(user.id,selected.id),t=await healthReminderTiming(db,user.id,user.timezone,clock());
  return row?.version===selected.version&&row?.status===selected.status&&row.evidence_json===selected.evidence_json
   &&!t.quiet&&!t.paused&&associationWeek(localDate(clock(),user.timezone))===week;
 };
 const claim=await db.transaction(async()=>{
  if(!await verify())return null;
  // Same weekly ceiling includes the old B2 notifier, including lost ACKs.
  if((await db.raw.execute({sql:'SELECT 1 FROM proactive_events WHERE user_id=? AND policy_version=? AND created_at>=? LIMIT 1',args:[user.id,ASSOCIATION_POLICY,since]})).rows.length)return null;
  return db.claimProactiveEvent(user.id,{healthDate:day,idempotencyKey:keys.lookup(['insight-notice-v1',user.id,identity]),decision:'NOTIFY',signals:[],
   reason:{kind:'INSIGHT',insightVersion:identity},policyVersion:ASSOCIATION_POLICY,messageText:null},{now,expectedLifecycleGeneration:user.lifecycleGeneration});
 },workStepOptions('insight.claim',[user.id,week,identity],{discardResult:true,replay:async()=>null}));
 if(!claim?.claimed)return {status:'ALREADY_RESERVED_OR_LIMITED'};
 const sent=await telegram.send(renderMemory(selected,locale,now),{authorize:verify});
 if(sent?.suppressed||sent?.dryRun)return {status:'SUPPRESSED'};
 if(!/^\d+$/.test(String(sent?.messageId??'')))return {status:'UNKNOWN'};
 await db.transaction(()=>db.markProactiveEventSent(user.id,claim.id,{}, {now}),workStepOptions('insight.settle',[user.id,claim.id],{discardResult:true}));
 return {status:'DELIVERED',deliveredNow:true};
}
