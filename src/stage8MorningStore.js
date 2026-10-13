import {createStage8MorningPlan,renderMorningPlan} from './stage8MorningPlan.js';
import {createPhase4EntityStore,canonicalJson} from './phase4EntityStore.js';
import {createPhase4MessageStore,semanticReservationKey} from './phase4MessageStore.js';
import {createPhase4TransportStore} from './phase4TransportStore.js';
import {localDate,addDays} from './time.js';
import {morningWallInstant} from './morningBriefPolicy.js';
const FAMILY='MORNING_BRIEF_V1',fail=code=>{throw Error(code);};
/** All mutations use the admitted shared transaction. Scheduling returns only
 * durable due-state; the dispatcher is the sole owner of a provider capability. */
export function createStage8MorningStore({core,db,preferences,enabled}){
 if(core.schemaVersion!==34||typeof enabled!=='function')fail('MORNING_V34_FACTORY_REQUIRED');
 const {client,keys}=core,entities=createPhase4EntityStore(core),messages=createPhase4MessageStore(core,entities),plans=createStage8MorningPlan({core,db,preferences});
 const transport=createPhase4TransportStore(core,entities,null,{morningAuthority:plans});
 const query=async(sql,args)=>(await client.execute({sql,args})).rows;
 async function context(control){await core.assertControl(control);if(!enabled(control.userId))fail('MORNING_DISABLED');return core.capture(control.userId,{executionMode:'LIVE',providerRequired:true});}
 async function requestCutover(control,{expectedRevision}){
  const ctx=await context(control);return core.run(ctx,async()=>{
   const mode=await transport.mode(ctx,FAMILY);if(mode.revision!==expectedRevision||mode.mode!=='LEGACY')fail('MORNING_CUTOVER_CAS');
   const day=addDays(localDate(core.now(),ctx.timezone),1),boundary=new Date(morningWallInstant(day,'00:00',ctx.timezone)).toISOString();
   await transport.destination(ctx);
   await client.execute({sql:`UPDATE tenant_delivery_modes SET mode='CUTOVER_PENDING',cutover_boundary=?,cutover_health_date=?,timezone=?,revision=revision+1,
    lifecycle_generation=?,auth_generation=?,changed_at=?,reason_code='CUTOVER_REQUESTED' WHERE user_id=? AND execution_mode='LIVE' AND message_family=? AND revision=? AND mode='LEGACY'`,
    args:[boundary,day,ctx.timezone,ctx.lifecycleGeneration,ctx.authGeneration,core.timestamp(),ctx.userId,FAMILY,expectedRevision]});
   return {state:'CUTOVER_PENDING',boundary,healthDate:day};
  });
 }
 async function commitCutover(ctx){return core.run(ctx,async()=>{
  const mode=await transport.mode(ctx,FAMILY);if(mode.mode!=='CUTOVER_PENDING')return mode;
  if(!enabled(ctx.userId)||mode.timezone!==ctx.timezone||mode.lifecycle_generation!==ctx.lifecycleGeneration||mode.auth_generation!==ctx.authGeneration)fail('MORNING_CUTOVER_FENCED');
  if(core.timestamp()<mode.cutover_boundary)return mode;
  await transport.destination(ctx);
  const active=await query(`SELECT 1 FROM report_claims WHERE user_id=? AND report_type='daily'
   AND (delivery_state='DELIVERY_STARTED' OR delivery_state='CLAIMED' AND expires_at>?) LIMIT 1`,[ctx.userId,core.timestamp()]);
  if(active.length)return {...mode,deferred:'LEGACY_IN_FLIGHT'};
  const legacy=await query(`SELECT local_date,delivery_state,telegram_sent_at FROM report_claims WHERE user_id=? AND report_type='daily' AND local_date>=? ORDER BY local_date LIMIT 33`,[ctx.userId,mode.cutover_health_date]);
  const sent=await query(`SELECT local_date,id FROM report_runs WHERE user_id=? AND report_type='daily' AND status='SENT' AND local_date>=? ORDER BY local_date LIMIT 33`,[ctx.userId,mode.cutover_health_date]);
  if(legacy.length>32||sent.length>32)fail('MORNING_LEGACY_BOUNDS');
  const barrier=new Map(sent.map(r=>[r.local_date,{outcome:'DELIVERED',table:'report_runs',id:String(r.id)}]));
  for(const r of legacy)if(r.telegram_sent_at||['DELIVERED','AMBIGUOUS'].includes(r.delivery_state))barrier.set(r.local_date,{outcome:r.delivery_state==='AMBIGUOUS'?'AMBIGUOUS':'DELIVERED',table:'report_claims',id:canonicalJson([ctx.userId,'daily',r.local_date])});
  for(const [day,b] of barrier){
   const key=semanticReservationKey(ctx.userId,FAMILY,day),old=await query("SELECT state FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode='LIVE' AND message_family=? AND semantic_key=?",[ctx.userId,FAMILY,key]);
   if(old.length){if(old[0].state!=='CONSUMED')fail('MORNING_BARRIER_CONFLICT');continue;}
   await client.execute({sql:`INSERT INTO outbound_semantic_reservations(user_id,execution_mode,reservation_id,message_family,semantic_key,local_health_date,state,origin,legacy_table,legacy_row_id,created_at,consumed_outcome,consumed_at)
    VALUES(?,'LIVE',?,?,?,?, 'CONSUMED','LEGACY_BARRIER',?,?,?,?,?)`,args:[ctx.userId,core.newId(),FAMILY,key,day,b.table,b.id,core.timestamp(),b.outcome,core.timestamp()]});
  }
  const changed=await client.execute({sql:"UPDATE tenant_delivery_modes SET mode='PHASE4',revision=revision+1,changed_at=?,reason_code='CUTOVER_COMMITTED' WHERE user_id=? AND execution_mode='LIVE' AND message_family=? AND revision=? AND mode='CUTOVER_PENDING'",args:[core.timestamp(),ctx.userId,FAMILY,mode.revision]});
  if(changed.rowsAffected!==1)fail('MORNING_CUTOVER_CAS');return transport.mode(ctx,FAMILY);
 });}
 async function owns(control,day){const ctx=await context(control),mode=await commitCutover(ctx);return mode.mode==='PHASE4'&&day>=mode.cutover_health_date;}
 async function expire(control,messageId){return core.runMaintenance(control,'LIVE',async()=>{
  const r=(await query("SELECT * FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_id=? AND message_class=?",[control.userId,messageId,FAMILY]))[0];
  if(!r||r.expires_at>core.timestamp()||!['PROPOSED','ELIGIBLE','FAILED_DEFINITE'].includes(r.state))return false;
  if(r.state==='FAILED_DEFINITE'){await transport.closeFailed(control,'LIVE',{messageId,expectedRevision:r.revision});return true;}
  if(r.attempt_count===0&&(await query("SELECT 1 FROM outbound_delivery_attempts WHERE user_id=? AND execution_mode='LIVE' AND message_id=? LIMIT 1",[control.userId,messageId])).length)return false;
  await client.execute({sql:"INSERT INTO morning_expiry_audit(user_id,message_id,reason,expired_at) VALUES(?,?,'EXPIRED_SYSTEM_OUTAGE',?) ON CONFLICT DO NOTHING",args:[control.userId,messageId,core.timestamp()]});
  await client.execute({sql:"UPDATE outbound_messages SET state='SUPPRESSED',terminal_reason='EXPIRED',revision=revision+1,updated_at=? WHERE user_id=? AND execution_mode='LIVE' AND message_id=? AND revision=?",args:[core.timestamp(),control.userId,messageId,r.revision]});
  await client.execute({sql:"UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='SUPPRESSED',closed_at=? WHERE user_id=? AND execution_mode='LIVE' AND reservation_id=? AND state='RESERVED'",args:[core.timestamp(),control.userId,r.reservation_id]});return true;
 });}
 async function prepare(control,{healthDate=undefined}={}){
  const ctx=await context(control),day=healthDate??localDate(core.now(),ctx.timezone),mode=await commitCutover(ctx);
  if(mode.mode!=='PHASE4'||day<mode.cutover_health_date)return {status:'LEGACY_OWNS'};
  return core.run(ctx,async()=>{
   const reservation=await messages.readReservation(control,'LIVE',{family:FAMILY,identity:day});
   if(reservation?.state&&reservation.state!=='RESERVED')return {status:'ALREADY_SETTLED'};
   let old=reservation?.message_id?(await query("SELECT * FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_id=?",[ctx.userId,reservation.message_id]))[0]:null;
   if(old){
    if(old.state==='FAILED_DEFINITE'){
     if(old.expires_at<=core.timestamp()){await expire(control,old.message_id);return {status:'FAILED_TERMINAL',messageId:old.message_id};}
     const last=(await query("SELECT error_code FROM outbound_delivery_attempts WHERE user_id=? AND execution_mode='LIVE' AND message_id=? AND attempt_number=?",[ctx.userId,old.message_id,old.attempt_count]))[0];
     if(old.attempt_count>=3||!['PROVIDER_RATE_LIMIT','PROVIDER_UNAVAILABLE'].includes(last?.error_code)||old.input_generation!==ctx.inputGeneration){
      await transport.closeFailed(control,'LIVE',{messageId:old.message_id,expectedRevision:old.revision});return {status:'FAILED_TERMINAL',messageId:old.message_id};
     }
     await transport.retryDefinite(ctx,{messageId:old.message_id,expectedRevision:old.revision});
     old=(await query("SELECT * FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_id=?",[ctx.userId,old.message_id]))[0];
    }
    if(old.state==='ELIGIBLE'&&old.attempt_count>0){
     if(old.expires_at<=core.timestamp()){await expire(control,old.message_id);return {status:'EXPIRED_SYSTEM_OUTAGE',messageId:old.message_id};}
     return {status:old.next_attempt_at>core.timestamp()?'RETRY_WAIT':'READY',messageId:old.message_id,revision:old.revision};
    }
    if(!['PROPOSED','ELIGIBLE'].includes(old.state)||old.attempt_count!==0||old.lease_owner||old.lease_expires_at)return {status:old.state,messageId:old.message_id};
    if(old.expires_at<=core.timestamp())return {status:await expire(control,old.message_id)?'EXPIRED_SYSTEM_OUTAGE':old.state,messageId:old.message_id};
    if(old.lifecycle_generation!==ctx.lifecycleGeneration||old.auth_generation!==ctx.authGeneration||old.purge_generation!==ctx.purgeGeneration
      ||old.destination_binding_id!==await transport.destination(ctx)||old.content_state!=='PRESENT')return {status:'FENCED'};
    if(JSON.parse(old.payload_json).timezone!==ctx.timezone)return {status:'TIMEZONE_CHANGED'};
   }
   const built=await plans.build(ctx,{healthDate:day});if(!built.timing.eligible)return {status:built.timing.reason};
   const previous=old?(await query("SELECT plan_json FROM morning_brief_plans WHERE user_id=? AND execution_mode='LIVE' AND plan_id=?",[ctx.userId,JSON.parse(old.payload_json).morningPlanId]))[0]:null;
   if(previous?.plan_json){const a=JSON.parse(previous.plan_json),b=built.plan;
    if(['preferenceVersion','profileRevision','sourceGeneration','inputGeneration','locale'].every(k=>a[k]===b[k])&&core.now()-Date.parse(a.asOfUtc)<60*60000)return {status:'READY',messageId:old.message_id,revision:old.revision};}
   const stored=await plans.persist(ctx,built),payload=canonicalJson({morningPlanId:stored.row.plan_id,healthDate:day,timezone:ctx.timezone}),text=renderMorningPlan(built.plan);
   if(!old){const result=await messages.propose(ctx,{semantic:{family:FAMILY,identity:day},message:{payload_text:text,payload_json:payload,
    semantic_key_version:'semantic-key-v1',semantic_hash:keys.lookup(['morning-semantic-v1',ctx.userId,day]),expires_at:built.plan.expiresAt},sourceRefs:[stored.ref]});
    return {status:'READY',messageId:result.row.message_id,revision:result.row.revision};}
   const attempts=await query("SELECT 1 FROM outbound_delivery_attempts WHERE user_id=? AND execution_mode='LIVE' AND message_id=? LIMIT 1",[ctx.userId,old.message_id]);if(attempts.length)return {status:'ATTEMPT_FROZEN'};
   const hash=keys.digest(old.content_digest_salt,canonicalJson([text,payload])),permit={userId:ctx.userId,messageId:old.message_id,revision:old.revision,oldHash:old.payload_hash,newHash:hash,
    oldGeneration:old.input_generation,newGeneration:ctx.inputGeneration,reservationId:old.reservation_id,planId:stored.row.plan_id,planHmac:stored.row.plan_hmac,purgeGeneration:ctx.purgeGeneration};
   await client.execute({sql:`INSERT INTO morning_projection_refreshes(user_id,message_id,from_revision,to_revision,old_payload_hash,new_payload_hash,old_input_generation,new_input_generation,plan_id,reservation_id,purge_generation,plan_hmac,permit_hmac,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[ctx.userId,old.message_id,old.revision,old.revision+1,old.payload_hash,hash,old.input_generation,ctx.inputGeneration,stored.row.plan_id,old.reservation_id,ctx.purgeGeneration,stored.row.plan_hmac,keys.lookup(['morning-refresh-v1',permit]),core.timestamp()]});
   const result=await client.execute({sql:`UPDATE outbound_messages SET payload_text=?,payload_json=?,payload_hash=?,input_generation=?,revision=revision+1,updated_at=?
    WHERE user_id=? AND execution_mode='LIVE' AND message_id=? AND revision=? AND state IN ('PROPOSED','ELIGIBLE') AND attempt_count=0 AND lease_owner IS NULL AND lease_expires_at IS NULL`,
    args:[text,payload,hash,ctx.inputGeneration,core.timestamp(),ctx.userId,old.message_id,old.revision]});if(result.rowsAffected!==1)fail('MORNING_REFRESH_CAS');
   await client.execute({sql:"UPDATE phase4_source_links SET unlinked_at=? WHERE user_id=? AND artifact_execution_mode='LIVE' AND artifact_type='outbound_messages' AND artifact_id=? AND unlinked_at IS NULL",args:[core.timestamp(),ctx.userId,old.privacy_artifact_id]});
   await core.link(ctx,'outbound_messages',old.privacy_artifact_id,[stored.ref]);
   const current=await core.artifact(ctx,'outbound_messages',{message_id:old.message_id});await plans.validate(ctx,current.row);
   return {status:'READY',messageId:old.message_id,revision:old.revision+1,refreshed:true};
  });
 }
 async function expirePending(control){
  await core.assertControl(control);const pending=await query("SELECT message_id FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_class='MORNING_BRIEF_V1' AND expires_at<=? AND state IN ('PROPOSED','ELIGIBLE','FAILED_DEFINITE') ORDER BY expires_at,message_id LIMIT 8",[control.userId,core.timestamp()]);
  for(const row of pending)await expire(control,row.message_id);return pending.length;
 }
 return Object.freeze({expirePending,requestCutover,commitCutover,owns,prepare,expire,transport,plans,context});
}
