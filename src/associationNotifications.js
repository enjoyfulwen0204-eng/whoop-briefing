import {healthReminderTiming} from './healthReminderPolicy.js';
import {localDate,addDays} from './time.js';
import {workStepOptions} from './phase4WorkStep.js';
import {currentExecutionBudget} from './executionBudget.js';
import {renderAssociations} from './onDemandAssociations.js';
export const ASSOCIATION_POLICY='on-demand-association-v1';
export const associationWeek=day=>addDays(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
const direction=row=>Object.fromEntries(row.metrics.map(m=>[m.metric,m.direction]));
export function changedAssociation(topics,history){return topics.find(row=>row.status==='ASSOCIATION'&&(!history[row.topic]||row.metrics.some(m=>history[row.topic][m.metric]&&history[row.topic][m.metric]!==m.direction)))??null;}
export async function notifyAssociation({db,reader,user,telegram,locale,now=new Date()}){
 if(currentExecutionBudget()&&currentExecutionBudget().remainingMs()<12000)return {status:'DEFERRED_BUDGET'};
 const started=Date.now(),clock=()=>new Date(now.getTime()+Date.now()-started);
 const timing=await healthReminderTiming(db,user.id,user.timezone,now);if(timing.quiet||timing.paused)return {status:'QUIET_OR_PAUSED'};
 const day=localDate(now,user.timezone),week=associationWeek(day),semantic=`association-week-v1:${week}`;
 const previous=(await db.raw.execute({sql:'SELECT 1 FROM proactive_events WHERE user_id=? AND idempotency_key=? LIMIT 1',args:[user.id,semantic]})).rows;
 if(previous.length)return {status:'ALREADY_RESERVED'};
 const view=await reader.inspect(user.id);if(!view)return {status:'DEFERRED_BUDGET'};
 const rows=(await db.raw.execute({sql:`SELECT reason_json FROM (SELECT reason_json,row_number() OVER(PARTITION BY json_extract(reason_json,'$.topic') ORDER BY id DESC) rank FROM proactive_events WHERE user_id=? AND policy_version=?) WHERE rank=1 LIMIT 8`,args:[user.id,ASSOCIATION_POLICY]})).rows;
 if(rows.length>7)throw Error('ASSOCIATION_HISTORY_INVALID');
 const history={};for(const r of rows){const x=JSON.parse(r.reason_json);history[x.topic]=x.directions;}
 const selected=changedAssociation(view.topics,history);if(!selected)return {status:'NO_NEW_ASSOCIATION'};
 const verify=async()=>{
  await reader.assertFresh(user.id,view);await db.assertAccountActive(user.id,user.lifecycleGeneration);
  const fresh=await healthReminderTiming(db,user.id,user.timezone,clock());return !fresh.quiet&&!fresh.paused&&associationWeek(localDate(clock(),user.timezone))===week;
 };
 const claim=await db.transaction(async()=>{
  if(!await verify())return null;
  return db.claimProactiveEvent(user.id,{healthDate:day,idempotencyKey:semantic,decision:'NOTIFY',signals:[],reason:{kind:'ASSOCIATION',topic:selected.topic,directions:direction(selected)},policyVersion:ASSOCIATION_POLICY,messageText:null},{now,expectedLifecycleGeneration:user.lifecycleGeneration});
 },workStepOptions('association.claim',[user.id,week],{discardResult:true,replay:async()=>null}));
 if(!claim?.claimed)return {status:'ALREADY_RESERVED_OR_LIMITED'};
 // Durable reservation is retained even on lost ACK or source revocation.
 const result=await telegram.send(renderAssociations(view,locale,selected.topic),{authorize:verify});
 if(result?.suppressed||result?.dryRun)return {status:'SUPPRESSED'};
 if(!/^\d+$/.test(String(result?.messageId??'')))return {status:'UNKNOWN'};
 await db.transaction(()=>db.markProactiveEventSent(user.id,claim.id,{}, {now}),workStepOptions('association.settle',[user.id,claim.id],{discardResult:true}));return {status:'DELIVERED',deliveredNow:true};
}
