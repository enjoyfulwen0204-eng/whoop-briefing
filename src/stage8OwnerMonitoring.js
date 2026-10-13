import {randomUUID} from 'node:crypto';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {canonicalJson} from './phase4EntityStore.js';
import {OWNER_NOTIFICATION_CLASSES} from './phase4V34Schema.js';
import {buildPhase4Core,readableRow} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {issueStage8LiveAuthority} from './stage8LiveAuthority.js';
import {createStage8MorningPlan} from './stage8MorningPlan.js';
import {localDate,completedWeeks} from './time.js';
const fail=code=>{throw Error(code);};
const VERSION='owner-current-synthesis-v1';
/** Dedicated dual-principal capability. No ordinary Q&A route receives this
 * store. Configuration accepts an explicit enrolled subject, never admin scope. */
export async function createOwnerMonitoring({db,keys,ownerId,enabled,now=()=>new Date()}){
 if(typeof ownerId!=='string'||!ownerId||typeof enabled!=='function')fail('OWNER_SERVER_CONFIGURATION_REQUIRED');
 let admission=await db.admitRuntime();if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==34)fail('OWNER_V34_REQUIRED');
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const client=db.raw,actors=new WeakMap(),tickets=new WeakMap(),timestamp=()=>now().toISOString();
 const rows=async(sql,args=[])=>(await client.execute({sql,args})).rows;
 async function principal(uid,{enrolled=false}={}){
  const row=(await rows(`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count,
   o.state enrollment,o.enrollment_revision,o.ready_at FROM users u JOIN phase4_user_state p ON p.user_id=u.id LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
   LEFT JOIN user_onboarding o ON o.user_id=u.id WHERE u.id=?`,[uid]))[0];
  if(!row||row.status!=='ACTIVE'||row.auth_generation<1||row.pending_purge_count!==0||enrolled&&row.enrollment!=='READY')fail('OWNER_PRINCIPAL_FENCED');
  const computation=(await rows("SELECT input_generation,last_completed_generation,source_generation_seen,algorithm_set_version,revision FROM phase4_computation_state WHERE user_id=? AND execution_mode='LIVE'",[uid]))[0]??null;
  const binding=(await rows("SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",[uid]));
  if(binding.length!==1||!/^\d+$/.test(binding[0].telegram_chat_id))fail('OWNER_DESTINATION_FENCED');
  return {...row,profileRevision:await db.getProfileRevision(uid),locale:await db.getLocale(uid),computation,
   destination:keys.lookup(['destination-binding-v1',uid,binding[0].telegram_chat_id,binding[0].linked_at])};
 }
 async function authenticate({user,chatId}){
  if(!enabled()||user?.id!==ownerId||!/^\d+$/.test(String(chatId)))fail('OWNER_AUTHORITY_REQUIRED');
  const resolved=(await db.resolveUserByChatId(chatId))?.user;
  if(resolved?.id!==ownerId||resolved.lifecycleGeneration!==user.lifecycleGeneration)fail('OWNER_ACTOR_FENCED');
  const state=await principal(ownerId),actor=Object.freeze({ownerId,chatId:String(chatId)});actors.set(actor,{state,expiresAt:now().getTime()+900000});return actor;
 }
 async function assertActor(actor){
  requireRuntimeAdmission(client,admission,keys,db.transaction);
  const captured=actors.get(actor);if(!captured||!enabled()||captured.expiresAt<=now().getTime()||(await db.resolveUserByChatId(actor.chatId))?.user?.id!==ownerId)fail('OWNER_ACTOR_FENCED');
  const state=await principal(ownerId);if(canonicalJson(state)!==canonicalJson(captured.state))fail('OWNER_ACTOR_CHANGED');await db.assertRuntimeFences?.();return state;
 }
 const classCheck=value=>{if(!OWNER_NOTIFICATION_CLASSES.includes(value))fail('OWNER_CLASS_NOT_ALLOWED');};
 async function enrolled(actor){await assertActor(actor);const found=await rows(`SELECT u.id FROM users u JOIN user_onboarding o ON o.user_id=u.id
   JOIN phase4_user_state p ON p.user_id=u.id JOIN user_whoop_tokens t ON t.user_id=u.id
   WHERE u.id<>? AND u.status='ACTIVE' AND o.state='READY' AND p.pending_purge_count=0 AND t.auth_generation>0 ORDER BY u.id LIMIT 101`,[ownerId]);
  if(found.length>100)fail('OWNER_CONFIGURATION_BOUNDS');await assertActor(actor);return found.map(r=>({subjectId:r.id}));}
 async function configure(actor,{subjectId,notificationClass,enabled:enable,expectedRevision,operationKey}){
  classCheck(notificationClass);if(typeof enable!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof operationKey!=='string'||!operationKey||operationKey.length>128||subjectId===ownerId)fail('OWNER_CONFIGURATION_INVALID');
  return db.transaction(async()=>{
   const owner=await assertActor(actor),existing=(await rows('SELECT * FROM owner_monitoring_subscriptions WHERE user_id=? AND owner_id=? AND notification_class=?',[subjectId,ownerId,notificationClass]))[0];
   const subject=enable?await principal(subjectId,{enrolled:true}):existing?{lifecycle_generation:existing.subject_lifecycle,auth_generation:existing.subject_auth,enrollment_revision:existing.enrollment_revision}:null;
   if(!subject)fail('OWNER_SUBSCRIPTION_NOT_FOUND');
   const replay=(await rows('SELECT * FROM owner_monitoring_subscription_events WHERE owner_id=? AND operation_key=?',[ownerId,operationKey]))[0];
   if(replay){if(replay.user_id!==subjectId||replay.notification_class!==notificationClass||replay.enabled!==Number(enable))fail('OWNER_OPERATION_REPLAY_CONFLICT');return {revision:replay.revision,replayed:true};}
   if((existing?.revision??0)!==expectedRevision)fail('OWNER_SUBSCRIPTION_CAS');
   const record={user_id:subjectId,owner_id:ownerId,notification_class:notificationClass,enabled:Number(enable),revision:expectedRevision+1,
    owner_lifecycle:owner.lifecycle_generation,owner_auth:owner.auth_generation,subject_lifecycle:subject.lifecycle_generation,subject_auth:subject.auth_generation,
    enrollment_revision:subject.enrollment_revision,changed_at:timestamp(),operation_key:operationKey};
   const names=Object.keys(record);await client.execute({sql:`INSERT INTO owner_monitoring_subscriptions(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')}) ON CONFLICT(user_id,owner_id,notification_class) DO UPDATE SET ${names.slice(3).map(k=>`${k}=excluded.${k}`).join(',')} WHERE owner_monitoring_subscriptions.revision=?`,args:[...names.map(k=>record[k]),expectedRevision]});
   const {changed_at,...event}=record;event.effective_at=changed_at;event.audit_hmac=keys.lookup(['owner-follow-event-v1',record]);const fields=Object.keys(event);
   await client.execute({sql:`INSERT INTO owner_monitoring_subscription_events(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,args:fields.map(k=>event[k])});
   // Revocation or any revision change invalidates all prior unsent copies.
   await client.execute({sql:`UPDATE owner_monitoring_outbox SET state=CASE WHEN state='DELIVERY_STARTED' THEN 'AMBIGUOUS' ELSE 'SUPPRESSED' END,revision=revision+1,updated_at=?
    WHERE user_id=? AND owner_id=? AND notification_class=? AND state IN ('PROPOSED','FAILED_DEFINITE','DELIVERY_STARTED')`,args:[timestamp(),subjectId,ownerId,notificationClass]});
   return {revision:record.revision,enabled:enable};
  });
 }
 async function subscriptions(actor){await assertActor(actor);return rows('SELECT user_id subjectId,notification_class notificationClass,enabled,revision FROM owner_monitoring_subscriptions WHERE owner_id=? ORDER BY user_id,notification_class',[ownerId]);}
 async function scope(actor,subjectId,notificationClass){
  classCheck(notificationClass);if(subjectId===ownerId)fail('OWNER_DISTINCT_SUBJECT_REQUIRED');
  const owner=await assertActor(actor),subject=await principal(subjectId,{enrolled:true});
  const subscription=(await rows('SELECT * FROM owner_monitoring_subscriptions WHERE user_id=? AND owner_id=? AND notification_class=?',[subjectId,ownerId,notificationClass]))[0];
  if(!subscription?.enabled||subscription.owner_lifecycle!==owner.lifecycle_generation||subscription.owner_auth!==owner.auth_generation
   ||subscription.subject_lifecycle!==subject.lifecycle_generation||subscription.subject_auth!==subject.auth_generation||subscription.enrollment_revision!==subject.enrollment_revision)fail('OWNER_SUBSCRIPTION_FENCED');
  const paused=(await rows('SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',[ownerId]))[0];if(paused?.notifications_paused)fail('OWNER_NOTIFICATIONS_PAUSED');
  return {owner,subject,subscriptionRevision:subscription.revision,notificationClass};
 }
 async function synthesis(captured,asOf=now()){
  const uid=captured.subject.id,comp=captured.subject.computation;if(!comp||comp.source_generation_seen!==captured.subject.source_generation)return {status:'NO_CURRENT_SYNTHESIS'};
  const grant=issueStage8LiveAuthority({db,keys,admission,userIds:[uid],enabled}),core=await buildPhase4Core({keys,admission,liveAuthority:grant,now,
   processing:{client,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},
   authorizeMode(mode,connection,userId){if(mode!=='LIVE'||connection!==client||userId!==uid)fail('OWNER_PLAN_SCOPE');}});
  const stores=composePhase4Stores(core),ctx=await core.capture(uid,{executionMode:'LIVE',providerRequired:true}),klass=captured.notificationClass;
  if(klass==='DAILY_SUMMARY'){
   const day=localDate(now(),ctx.timezone),ids=await rows("SELECT plan_id FROM morning_brief_plans WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND health_date=? AND content_state='PRESENT' ORDER BY created_at DESC,plan_id DESC LIMIT 1",[uid,ctx.inputGeneration,day]);
   if(!ids.length)return {status:'NO_APPROVED_CURRENT_PLAN'};
   const plan=await createStage8MorningPlan({core,db,preferences:stores.preferences}).read(ctx,ids[0].plan_id),claims=Object.entries(plan.plan.sections).filter(([,v])=>v.status==='CURRENT').map(([metric,v])=>({kind:'SOURCE_FACT_SUMMARY',metric,value:v.value,asOfUtc:plan.plan.asOfUtc}));
   return claims.length?{status:'APPROVED',semanticIdentity:day,claims,refs:[{table:'morning_brief_plans',id:plan.row.plan_id,hmac:plan.row.plan_hmac}],asOfUtc:plan.plan.asOfUtc,expiresAt:plan.row.expires_at}:{status:'NO_QUALIFYING_CONTENT'};
  }
  if(comp.last_completed_generation!==comp.input_generation)return {status:'ANALYSIS_UPDATING'};
  // Completion metadata alone cannot authorize an empty LIVE synthesis. The
  // frozen v32 producer contract is SHADOW-only; preserve that allocation and
  // report updating until a separately approved LIVE producer exists.
  const producers=await rows(`SELECT p.*,e.state,e.phase,e.generation final_generation,e.execution_seq final_seq
    FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
    WHERE p.user_id=? AND p.execution_mode='LIVE' AND p.input_generation=?`,[uid,comp.input_generation]);
  if(!producers.length||producers.some(p=>p.state!=='FINALIZED_SUCCESS'||p.phase!=='STAGE6_DRAIN'||p.execution_seq!==p.final_seq||p.producing_generation>p.final_generation
    ||p.tenant_proof!==keys.lookup(['execution-producer-v1',uid,'LIVE',comp.input_generation,p.producing_execution_id,p.execution_seq,p.producing_generation])))return {status:'ANALYSIS_UPDATING'};

  if((await rows("SELECT 1 FROM phase4_invalidations WHERE user_id=? AND execution_mode='LIVE' AND scope_kind<>'NONE'",[uid])).length)return {status:'ANALYSIS_UPDATING'};
  // Registered typed reads verify operation receipts and current evidence.
  if(klass==='WEEKLY_SUMMARY'){
   const week=completedWeeks(asOf,ctx.timezone).last,ids=await rows("SELECT id FROM health_insights WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND legacy_classification='PHASE4' AND status='SUPPORTED' AND expires_at>? ORDER BY last_recalculated_at DESC,id LIMIT 3",[uid,ctx.inputGeneration,timestamp()]);
   const claims=[],refs=[];for(const {id} of ids){const value=await stores.insights.read(ctx,id,{asOfUtc:asOf.toISOString()});const text=value.revision.normalized_claim;
    if(typeof text!=='string'||!text.trim()||text.length>300)fail('OWNER_CLAIM_INVALID');
    claims.push({kind:'OBSERVATIONAL_ASSOCIATION',claim:text,nonCausal:true});refs.push({table:'health_insights',id,revision:value.row.current_revision,hash:keys.lookup(['owner-insight-v1',canonicalJson({...value.revision})])});}
   return claims.length?{status:'APPROVED',semanticIdentity:week.startDate,claims,refs,asOfUtc:asOf.toISOString(),expiresAt:new Date(asOf.getTime()+3600000).toISOString()}:{status:'NO_QUALIFYING_CONTENT'};
  }
  const found=await rows("SELECT message_id FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_class='EPISODE_NOTIFICATION' AND state IN ('DELIVERED','AMBIGUOUS') AND input_generation=? AND expires_at>? AND content_state='PRESENT' ORDER BY created_at DESC,message_id LIMIT 1",[uid,ctx.inputGeneration,timestamp()]);
  if(!found.length)return {status:'NO_APPROVED_CURRENT_ALERT'};
  const message=await core.artifact(ctx,'outbound_messages',{message_id:found[0].message_id}),decision=await core.artifact(ctx,'phase4_proactive_decisions',{decision_id:message.row.decision_id});
  if(decision.row.action!=='NOTIFY'||!message.row.episode_semantic_event_id||!message.row.payload_text)fail('OWNER_ALERT_NOT_APPROVED');
  await stores.episodes.read(ctx,decision.row.episode_id);
  return {status:'APPROVED',semanticIdentity:message.row.episode_semantic_event_id,claims:[{kind:'APPROVED_IMPORTANT_ALERT',claim:message.row.payload_text}],refs:[{table:'outbound_messages',id:message.row.message_id,hash:message.row.payload_hash}],asOfUtc:asOf.toISOString(),expiresAt:message.row.expires_at};
 }
 async function authorize(actor,{subjectId,notificationClass}){return db.transaction(async()=>{
  const captured=await scope(actor,subjectId,notificationClass),plan=await synthesis(captured);
  if(canonicalJson(await scope(actor,subjectId,notificationClass))!==canonicalJson(captured))fail('OWNER_SCOPE_CHANGED');
  if(plan.status!=='APPROVED')return {status:plan.status};
  const expiresAt=new Date(Math.min(Date.parse(plan.expiresAt),now().getTime()+120000)).toISOString();
  const ticket=Object.freeze({});tickets.set(ticket,{captured,plan,expiresAt});return {status:'APPROVED',ticket};
 });}
 async function propose(actor,ticket){return db.transaction(async()=>{
  const value=tickets.get(ticket);if(!value||value.expiresAt<=timestamp())fail('OWNER_APPROVED_TICKET_REQUIRED');
  const {captured,plan}=value,subjectId=captured.subject.id,klass=captured.notificationClass;
  if(canonicalJson(await scope(actor,subjectId,klass))!==canonicalJson(captured)||canonicalJson(await synthesis(captured,new Date(plan.asOfUtc)))!==canonicalJson(plan))fail('OWNER_PLAN_CHANGED');
  const semantic=keys.lookup(['owner-semantic-v1',ownerId,subjectId,klass,plan.semanticIdentity]),existing=(await rows('SELECT message_id,state FROM owner_monitoring_outbox WHERE user_id=? AND owner_id=? AND notification_class=? AND semantic_key=?',[subjectId,ownerId,klass,semantic]))[0];if(existing)return {status:existing.state,messageId:existing.message_id,replayed:true};
  const id=randomUUID(),messageId=randomUUID(),salt=keys.newSalt(),at=timestamp(),scopeJson=canonicalJson({...captured,planRefs:plan.refs,semanticIdentity:plan.semanticIdentity}),claimsJson=canonicalJson(plan.claims);
  const auth={user_id:subjectId,owner_id:ownerId,authorization_id:id,notification_class:klass,subscription_revision:captured.subscriptionRevision,plan_version:VERSION,as_of_utc:plan.asOfUtc,
   scope_json:scopeJson,claims_json:claimsJson,reason_code:'APPROVED_CURRENT_SYNTHESIS',destination_binding_id:captured.owner.destination,created_at:at,expires_at:value.expiresAt};
  auth.authorization_hmac=keys.lookup(['owner-authorization-v1',auth]);
  const insert=async(table,data)=>{const fields=Object.keys(data);await client.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,args:fields.map(k=>data[k])});};
  const envelope=table=>({content_state:'PRESENT',source_linkage_state:'COMPLETE',content_digest_salt:salt,purge_generation:captured.subject.purge_generation,privacy_artifact_id:keys.lookup(['owner-private-copy-v1',table,ownerId,subjectId,id])});
  await insert('owner_monitoring_authorizations',{...auth,...envelope('owner_monitoring_authorizations')});
  const payload=canonicalJson({notificationClass:klass,subjectId,claims:plan.claims,asOfUtc:plan.asOfUtc});
  await insert('owner_monitoring_outbox',{user_id:subjectId,owner_id:ownerId,message_id:messageId,authorization_id:id,notification_class:klass,semantic_key:semantic,state:'PROPOSED',payload_json:payload,created_at:at,updated_at:at,expires_at:value.expiresAt,...envelope('owner_monitoring_outbox')});
  await client.execute({sql:"INSERT INTO stage8_scoped_read_audit(user_id,read_id,purpose,execution_mode,scope_hmac,as_of_utc,created_at) VALUES(?,?,'OWNER_MONITORING','LIVE',?,?,?)",args:[subjectId,randomUUID(),keys.lookup(['owner-read-v1',ownerId,id,captured]),plan.asOfUtc,at]});
  return {status:'PROPOSED',messageId};
 });}
 async function validate(actor,subjectId,messageId){
  await assertActor(actor);
  const metadata=(await rows('SELECT notification_class FROM owner_monitoring_outbox WHERE user_id=? AND owner_id=? AND message_id=?',[subjectId,ownerId,messageId]))[0];if(!metadata)fail('OWNER_MESSAGE_NOT_FOUND');
  await scope(actor,subjectId,metadata.notification_class);
  const row=(await rows('SELECT * FROM owner_monitoring_outbox WHERE user_id=? AND owner_id=? AND message_id=?',[subjectId,ownerId,messageId]))[0];if(!readableRow(row)||row.expires_at<=timestamp())fail('OWNER_MESSAGE_FENCED');
  const auth=(await rows('SELECT * FROM owner_monitoring_authorizations WHERE user_id=? AND owner_id=? AND authorization_id=?',[subjectId,ownerId,row.authorization_id]))[0];if(!readableRow(auth)||auth.expires_at<=timestamp())fail('OWNER_AUTHORIZATION_FENCED');
  const fields=['user_id','owner_id','authorization_id','notification_class','subscription_revision','plan_version','as_of_utc','scope_json','claims_json','reason_code','destination_binding_id','created_at','expires_at'];
  if(auth.plan_version!==VERSION||auth.authorization_hmac!==keys.lookup(['owner-authorization-v1',Object.fromEntries(fields.map(k=>[k,auth[k]]))]))fail('OWNER_AUTHORIZATION_INTEGRITY');
  const stored=JSON.parse(auth.scope_json),{planRefs,semanticIdentity,...captured}=stored,current=await scope(actor,subjectId,row.notification_class);
  if(canonicalJson(current)!==canonicalJson(captured))fail('OWNER_SCOPE_CHANGED');
  const plan=await synthesis(current,new Date(auth.as_of_utc));if(plan.status!=='APPROVED'||canonicalJson(plan.refs)!==canonicalJson(planRefs)||canonicalJson(plan.claims)!==auth.claims_json||plan.semanticIdentity!==semanticIdentity)fail('OWNER_PLAN_CHANGED');
  const payload=JSON.parse(row.payload_json);if(payload.subjectId!==subjectId||payload.notificationClass!==row.notification_class||canonicalJson(payload.claims)!==auth.claims_json||payload.asOfUtc!==auth.as_of_utc)fail('OWNER_PAYLOAD_CHANGED');
  return {row,auth,payload};
 }
 async function start(actor,{subjectId,messageId,expectedRevision}){return db.transaction(async()=>{
  const {row,payload}=await validate(actor,subjectId,messageId);if(row.state!=='PROPOSED'||row.revision!==expectedRevision||row.attempt_count!==0)fail('OWNER_START_CAS');
  const id=randomUUID(),at=timestamp();await client.execute({sql:"INSERT INTO owner_monitoring_attempts(user_id,message_id,attempt_id,attempt_number,state,started_at) VALUES(?,?,?,1,'DELIVERY_STARTED',?)",args:[subjectId,messageId,id,at]});
  const changed=await client.execute({sql:"UPDATE owner_monitoring_outbox SET state='DELIVERY_STARTED',attempt_count=1,revision=revision+1,updated_at=? WHERE user_id=? AND owner_id=? AND message_id=? AND revision=? AND state='PROPOSED'",args:[at,subjectId,ownerId,messageId,expectedRevision]});if(changed.rowsAffected!==1)fail('OWNER_START_CAS');return {attemptId:id,payload};
 });}
 async function settle({subjectId,messageId,attemptId,outcome,providerMessageId=null}){
  if(!['DELIVERED','AMBIGUOUS','FAILED_DEFINITE'].includes(outcome)||providerMessageId!==null&&!/^[A-Za-z0-9:_-]{1,128}$/.test(providerMessageId))fail('OWNER_OUTCOME_INVALID');
  return db.transaction(async()=>{
   const attempt=(await rows('SELECT a.* FROM owner_monitoring_attempts a JOIN owner_monitoring_outbox m ON m.user_id=a.user_id AND m.message_id=a.message_id WHERE a.user_id=? AND a.message_id=? AND a.attempt_id=? AND m.owner_id=?',[subjectId,messageId,attemptId,ownerId]))[0];if(!attempt)fail('OWNER_ATTEMPT_NOT_FOUND');
   if(attempt.state!=='DELIVERY_STARTED'){if(attempt.state!==outcome||attempt.provider_message_id!==providerMessageId)fail('OWNER_SETTLEMENT_CONFLICT');return {replayed:true};}
   await client.execute({sql:"UPDATE owner_monitoring_attempts SET state=?,settled_at=?,provider_message_id=? WHERE user_id=? AND message_id=? AND attempt_id=? AND state='DELIVERY_STARTED'",args:[outcome,timestamp(),providerMessageId,subjectId,messageId,attemptId]});
   await client.execute({sql:"UPDATE owner_monitoring_outbox SET state=?,provider_message_id=?,revision=revision+1,updated_at=? WHERE user_id=? AND owner_id=? AND message_id=? AND state='DELIVERY_STARTED'",args:[outcome,providerMessageId,timestamp(),subjectId,ownerId,messageId]});return {outcome};
  });
 }
 return Object.freeze({authenticate,enrolled,configure,subscriptions,authorize,propose,start,settle,validate});
}
