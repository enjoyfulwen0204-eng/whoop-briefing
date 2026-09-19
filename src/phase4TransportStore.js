import { fail, requireInteger } from './phase4Core.js';
import { MESSAGE_FAMILIES, OPERATION_ERROR_CODES } from './phase4V24Schema.js';

// Conservative pre-gate storage policy; never schedules a retry itself.
export const TRANSPORT_RETRY_VERSION='phase4-transport-retry-v1';
export const TRANSPORT_MAX_ATTEMPTS=3;
const RETRYABLE=new Set(['PROVIDER_RATE_LIMIT','PROVIDER_UNAVAILABLE']);

export async function phase4Destination(core,context) {
  if(context.executionMode!=='LIVE')fail('PHASE4_LIVE_REQUIRED');
  return core.run(context,async()=>{
    const rows=(await core.client.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[context.userId]})).rows;
    if(rows.length!==1)fail('PHASE4_DESTINATION_UNAVAILABLE');
    return core.keys.lookup(['destination-binding-v1',context.userId,rows[0].telegram_chat_id,rows[0].linked_at]);
  });
}

/** Durable transport state only. There is deliberately no provider dependency,
 * HTTP request, timer, retry loop, scheduler or default LIVE authority. */
export function createPhase4TransportStore(core,entities,slotHooks) {
  const {client,timestamp,keys}=core,leases=new WeakMap();
  const scope=(c,id)=>[c.userId,c.executionMode,id];
  async function mode(context,family) {
    if(!MESSAGE_FAMILIES.includes(family))fail('PHASE4_MESSAGE_FAMILY_REQUIRED');
    return core.run(context,async()=>{
      await client.execute({sql:`INSERT INTO tenant_delivery_modes(user_id,execution_mode,message_family,lifecycle_generation,
        auth_generation,changed_at,reason_code) VALUES (?,?,?,?,?,?,'INITIAL') ON CONFLICT DO NOTHING`,
        args:[context.userId,context.executionMode,family,context.lifecycleGeneration,context.authGeneration,timestamp()]});
      return {...(await client.execute({sql:'SELECT * FROM tenant_delivery_modes WHERE user_id=? AND execution_mode=? AND message_family=?',args:scope(context,family)})).rows[0]};
    });
  }
  async function destination(context) {
    return phase4Destination(core,context);
  }
  async function eligibility(context,row) {
    if(context.executionMode!=='LIVE'||row.execution_mode!=='LIVE')fail('PHASE4_LIVE_REQUIRED');
    if(context.authGeneration<1)fail('PHASE4_AUTH_FENCED');
    const current=(await client.execute({sql:`SELECT 1 FROM phase4_computation_state c WHERE c.user_id=? AND c.execution_mode='LIVE'
      AND c.last_completed_generation=c.input_generation AND c.input_generation=?
      AND NOT EXISTS (SELECT 1 FROM phase4_invalidations i WHERE i.user_id=c.user_id AND i.execution_mode=c.execution_mode AND i.scope_kind<>'NONE')`,
      args:[context.userId,context.inputGeneration]})).rows.length;
    if(!current)fail('PHASE4_COMPUTATION_NOT_CURRENT');
    if(row.expires_at<=timestamp())fail('PHASE4_MESSAGE_EXPIRED');
    if(row.destination_binding_id!==await destination(context))fail('PHASE4_DESTINATION_CHANGED');
    const ready=(await client.execute({sql:"SELECT state FROM user_onboarding WHERE user_id=?",args:[context.userId]})).rows[0];
    if(ready?.state!=='READY')fail('PHASE4_ONBOARDING_NOT_READY');
    const prefs=(await client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[context.userId]})).rows[0];
    if(prefs?.notifications_paused)fail('PHASE4_NOTIFICATIONS_PAUSED');
    const delivery=await mode(context,row.message_class);
    if(delivery.mode!=='PHASE4'||delivery.lifecycle_generation!==context.lifecycleGeneration||delivery.auth_generation!==context.authGeneration)
      fail('PHASE4_DELIVERY_CUTOVER_REQUIRED');
    const reservation=(await client.execute({sql:"SELECT state,message_id FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode=? AND reservation_id=?",args:scope(context,row.reservation_id)})).rows[0];
    if(reservation?.state!=='RESERVED'||reservation.message_id!==row.message_id)fail('PHASE4_SEMANTIC_RESERVATION_CONSUMED');
    if(row.decision_id) {
      const decision=await core.artifact(context,'phase4_proactive_decisions',{decision_id:row.decision_id});
      if(decision.row.expires_at<=timestamp())fail('PHASE4_DECISION_EXPIRED');
    }
  }
  async function makeEligible(context,{messageId,expectedRevision}) {
    requireInteger(expectedRevision);
    return core.run(context,async()=>{
      const {row}=await core.artifact(context,'outbound_messages',{message_id:messageId});
      if(row.revision!==expectedRevision||row.state!=='PROPOSED')fail('PHASE4_OUTBOX_CAS_LOST');
      await eligibility(context,row);
      await client.execute({sql:"UPDATE outbound_messages SET state='ELIGIBLE',revision=revision+1,updated_at=? WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=?",
        args:[timestamp(),...scope(context,messageId),expectedRevision]});
      return core.artifact(context,'outbound_messages',{message_id:messageId});
    });
  }
  async function claim(context,{messageId,owner,leaseMs=60000}) {
    if(typeof owner!=='string'||!owner||owner.length>128)fail('PHASE4_LEASE_REQUIRED');
    requireInteger(leaseMs,1);if(leaseMs>15*60000)fail('PHASE4_LEASE_REQUIRED');
    return core.run(context,async()=>{
      const {row}=await core.artifact(context,'outbound_messages',{message_id:messageId});
      if(row.state!=='ELIGIBLE'||row.next_attempt_at&&row.next_attempt_at>timestamp())return null;
      await eligibility(context,row);
      const expiresAt=new Date(Date.parse(timestamp())+leaseMs).toISOString();
      const result=await client.execute({sql:`UPDATE outbound_messages SET state='CLAIMED',lease_owner=?,lease_expires_at=?,revision=revision+1,updated_at=?
        WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=? AND state='ELIGIBLE'`,
        args:[owner,expiresAt,timestamp(),...scope(context,messageId),row.revision]});
      if(result.rowsAffected!==1)return null;
      const lease=Object.freeze({messageId,owner,expiresAt,revision:row.revision+1});leases.set(lease,context);return lease;
    });
  }
  async function start(context,lease,{slotRevision=null}={}) {
    if(leases.get(lease)!==context)fail('PHASE4_SERVER_LEASE_REQUIRED');
    return core.run(context,async()=>{
      const message=await core.artifact(context,'outbound_messages',{message_id:lease.messageId}),r=message.row;
      if(r.state!=='CLAIMED'||r.revision!==lease.revision||r.lease_owner!==lease.owner
        ||r.lease_expires_at!==lease.expiresAt||lease.expiresAt<=timestamp())fail('PHASE4_OUTBOX_LEASE_LOST');
      await eligibility(context,r);
      if(r.message_class==='CONTEXT_QUESTION')await slotHooks.start(context,r,slotRevision);
      const at=timestamp(),number=r.attempt_count+1;
      const attempt=await entities.append(context,'outbound_delivery_attempts',{attempt_id:core.newId(),message_id:r.message_id,
        attempt_number:number,state:'DELIVERY_STARTED',request_hash:keys.digest(r.content_digest_salt,
          JSON.stringify([r.payload_hash,r.destination_binding_id,number])),delivery_started_at:at},[message.ref]);
      const changed=await client.execute({sql:`UPDATE outbound_messages SET state='DELIVERY_STARTED',attempt_count=?,revision=revision+1,updated_at=?
        WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=? AND lease_owner=? AND lease_expires_at=?`,
        args:[number,at,...scope(context,r.message_id),lease.revision,lease.owner,lease.expiresAt]});
      if(changed.rowsAffected!==1)fail('PHASE4_OUTBOX_CAS_LOST');
      return {attemptId:attempt.row.attempt_id,messageId:r.message_id,payloadText:r.payload_text,payloadJson:r.payload_json,
        destinationBindingId:r.destination_binding_id};
    });
  }
  async function settle(control,executionMode,{attemptId,outcome,providerMessageId=null,errorCode=null,ambiguityReason=null}) {
    if(executionMode!=='LIVE'||!['DELIVERED','AMBIGUOUS','FAILED_DEFINITE'].includes(outcome))fail('PHASE4_TRANSPORT_OUTCOME_REQUIRED');
    if(providerMessageId!==null&&(typeof providerMessageId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(providerMessageId)))fail('PHASE4_PROVIDER_ID_INVALID');
    if(errorCode!==null&&!OPERATION_ERROR_CODES.includes(errorCode))fail('PHASE4_OPERATION_ERROR_REQUIRED');
    if(outcome==='AMBIGUOUS'&&!['TIMEOUT','CONNECTION_LOST','MALFORMED_SUCCESS','PROCESS_RESTART','UNKNOWN_ACCEPTANCE'].includes(ambiguityReason))fail('PHASE4_AMBIGUITY_REASON_REQUIRED');
    return core.runMaintenance(control,executionMode,async()=>{
      const args=[control.userId,executionMode,attemptId];
      const a=(await client.execute({sql:`SELECT attempt_id,message_id,state,provider_message_id,provider_status_class FROM outbound_delivery_attempts
        WHERE user_id=? AND execution_mode=? AND attempt_id=?`,args})).rows[0];
      if(!a)fail('PHASE4_ATTEMPT_NOT_FOUND');
      const m=(await client.execute({sql:`SELECT message_id,message_class,question_request_id,reservation_id,state,revision,content_state FROM outbound_messages
        WHERE user_id=? AND execution_mode=? AND message_id=?`,args:[control.userId,executionMode,a.message_id]})).rows[0];
      if(!m)fail('PHASE4_PARENT_NOT_FOUND');
      const at=timestamp(),late=a.state==='AMBIGUOUS'&&outcome==='DELIVERED';
      if(late&&a.provider_status_class==='ACCEPTED') {
        if(providerMessageId!==a.provider_message_id)fail('PHASE4_TRANSPORT_REPLAY_CONFLICT');
        return {state:a.state,messageId:a.message_id,replayed:true};
      }
      if(late&&a.provider_message_id!==null&&providerMessageId!==a.provider_message_id)fail('PHASE4_TRANSPORT_REPLAY_CONFLICT');
      if(a.state!=='DELIVERY_STARTED'&&!late) {
        if(a.state!==outcome)fail('PHASE4_ATTEMPT_TERMINAL');
        if(providerMessageId!==null&&a.provider_message_id!==providerMessageId)fail('PHASE4_TRANSPORT_REPLAY_CONFLICT');
        return {state:a.state,messageId:a.message_id,replayed:true};
      }
      await client.execute({sql:`UPDATE outbound_delivery_attempts SET state=?,completed_at=COALESCE(completed_at,?),provider_message_id=COALESCE(provider_message_id,?),
        provider_status_class=?,error_code=?,ambiguity_reason=COALESCE(ambiguity_reason,?) WHERE user_id=? AND execution_mode=? AND attempt_id=?`,
        args:[late?'AMBIGUOUS':outcome,at,providerMessageId,outcome==='DELIVERED'?'ACCEPTED':outcome==='AMBIGUOUS'?'UNCERTAIN':'DEFINITE_NON_ACCEPTANCE',errorCode,ambiguityReason,...args]});
      if(m.state==='DELIVERY_STARTED')await client.execute({sql:`UPDATE outbound_messages SET state=?,provider_message_id=?,revision=revision+1,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=?`,args:[outcome,providerMessageId,at,control.userId,executionMode,m.message_id,m.revision]});
      else if(late)await client.execute({sql:`UPDATE outbound_messages SET provider_message_id=COALESCE(provider_message_id,?),revision=revision+1,updated_at=?
        WHERE user_id=? AND execution_mode=? AND message_id=? AND state='AMBIGUOUS'`,args:[providerMessageId,at,control.userId,executionMode,m.message_id]});
      if(outcome!=='FAILED_DEFINITE')await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CONSUMED',consumed_outcome=?,consumed_at=?
        WHERE user_id=? AND execution_mode=? AND reservation_id=? AND state='RESERVED'`,args:[outcome,at,control.userId,executionMode,m.reservation_id]});
      if(m.message_class==='CONTEXT_QUESTION')await slotHooks.settle(control.userId,executionMode,m,outcome);
      if(m.message_class==='CONTEXT_QUESTION'||m.content_state==='REDACTED') {
        if(outcome==='FAILED_DEFINITE') {
          await client.execute({sql:`UPDATE outbound_messages SET state='FAILED_TERMINAL',terminal_reason='PROVIDER_DEFINITE_NON_ACCEPTANCE',revision=revision+1,updated_at=?
            WHERE user_id=? AND execution_mode=? AND message_id=? AND state='FAILED_DEFINITE'`,args:[at,control.userId,executionMode,m.message_id]});
          await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='PROVIDER_DEFINITE_NON_ACCEPTANCE',closed_at=?
            WHERE user_id=? AND execution_mode=? AND reservation_id=? AND state='RESERVED'`,args:[at,control.userId,executionMode,m.reservation_id]});
        }
      }
      return {state:late?'AMBIGUOUS':outcome,messageId:m.message_id,replayed:false};
    });
  }
  async function recover(control,executionMode,{messageId,expectedRevision}) {
    if(executionMode!=='LIVE')fail('PHASE4_LIVE_REQUIRED');
    requireInteger(expectedRevision);
    return core.runMaintenance(control,executionMode,async()=>{
      const m=(await client.execute({sql:'SELECT state,revision,lease_expires_at,attempt_count FROM outbound_messages WHERE user_id=? AND execution_mode=? AND message_id=?',
        args:[control.userId,executionMode,messageId]})).rows[0];
      if(!m||m.revision!==expectedRevision)fail('PHASE4_OUTBOX_CAS_LOST');
      if(!m.lease_expires_at||m.lease_expires_at>timestamp())return {recovered:false,state:m.state};
      if(m.state==='CLAIMED') {
        await client.execute({sql:`UPDATE outbound_messages SET state='ELIGIBLE',lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=?
          WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=?`,args:[timestamp(),control.userId,executionMode,messageId,expectedRevision]});
        return {recovered:true,state:'ELIGIBLE'};
      }
      if(m.state==='DELIVERY_STARTED') {
        const a=(await client.execute({sql:`SELECT attempt_id FROM outbound_delivery_attempts WHERE user_id=? AND execution_mode=? AND message_id=? AND attempt_number=?`,
          args:[control.userId,executionMode,messageId,m.attempt_count]})).rows[0];
        if(!a)fail('PHASE4_ATTEMPT_NOT_FOUND');
        return settle(control,executionMode,{attemptId:a.attempt_id,outcome:'AMBIGUOUS',ambiguityReason:'PROCESS_RESTART',errorCode:'NETWORK_UNCERTAIN'});
      }
      return {recovered:false,state:m.state};
    });
  }
  async function closeFailed(control,executionMode,{messageId,expectedRevision}) {
    if(executionMode!=='LIVE')fail('PHASE4_LIVE_REQUIRED');
    requireInteger(expectedRevision);
    return core.runMaintenance(control,executionMode,async()=>{
      const row=(await client.execute({sql:`SELECT state,revision,reservation_id FROM outbound_messages WHERE user_id=? AND execution_mode=? AND message_id=?`,
        args:[control.userId,executionMode,messageId]})).rows[0];
      if(!row||row.revision!==expectedRevision||row.state!=='FAILED_DEFINITE')fail('PHASE4_OUTBOX_CAS_LOST');
      await client.execute({sql:`UPDATE outbound_messages SET state='FAILED_TERMINAL',terminal_reason='FAILED_TERMINAL',revision=revision+1,updated_at=?,
        lease_owner=NULL,lease_expires_at=NULL WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=?`,
        args:[timestamp(),control.userId,executionMode,messageId,expectedRevision]});
      await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='FAILED_TERMINAL',closed_at=?
        WHERE user_id=? AND execution_mode=? AND reservation_id=? AND state='RESERVED'`,args:[timestamp(),control.userId,executionMode,row.reservation_id]});
      return {state:'FAILED_TERMINAL'};
    });
  }
  async function retryDefinite(context,{messageId,expectedRevision}) {
    return core.run(context,async()=>{
      const {row}=await core.artifact(context,'outbound_messages',{message_id:messageId});
      if(row.state!=='FAILED_DEFINITE'||row.revision!==expectedRevision)fail('PHASE4_OUTBOX_CAS_LOST');
      await eligibility(context,row);
      const attempt=(await client.execute({sql:`SELECT state,error_code,completed_at FROM outbound_delivery_attempts
        WHERE user_id=? AND execution_mode=? AND message_id=? AND attempt_number=?`,args:[context.userId,context.executionMode,messageId,row.attempt_count]})).rows[0];
      if(row.message_class==='CONTEXT_QUESTION'||row.attempt_count>=TRANSPORT_MAX_ATTEMPTS
        ||attempt?.state!=='FAILED_DEFINITE'||!RETRYABLE.has(attempt.error_code))fail('PHASE4_DEFINITE_RETRY_NOT_ALLOWED');
      const next=new Date(Date.parse(attempt.completed_at)+60000*2**(row.attempt_count-1)).toISOString();
      await client.execute({sql:`UPDATE outbound_messages SET state='ELIGIBLE',next_attempt_at=?,revision=revision+1,updated_at=?
        WHERE user_id=? AND execution_mode=? AND message_id=? AND revision=?`,args:[next,timestamp(),...scope(context,messageId),expectedRevision]});
      return {nextAttemptAt:next,retryVersion:TRANSPORT_RETRY_VERSION};
    });
  }
  return {mode,destination,makeEligible,claim,start,settle,recover,retryDefinite,closeFailed};
}
