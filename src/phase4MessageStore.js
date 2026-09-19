import { fail } from './phase4Core.js';
import { FOLLOWUP_KINDS, MESSAGE_FAMILIES } from './phase4V24Schema.js';
import { canonicalJson } from './phase4EntityStore.js';
import { phase4Destination } from './phase4TransportStore.js';

const identityField={MORNING_BRIEF_V1:'local_health_date',EPISODE_NOTIFICATION:'episode_semantic_event_id',
  CONTEXT_QUESTION:'question_request_id',ANSWER_FOLLOWUP:'answer_event_id'};
export function semanticReservationKey(userId,family,identity,followupKind) {
  if(typeof userId!=='string'||!userId||!MESSAGE_FAMILIES.includes(family)||typeof identity!=='string'||!identity)
    fail('PHASE4_SEMANTIC_IDENTITY_REQUIRED');
  if(family==='MORNING_BRIEF_V1' && (!/^\d{4}-\d{2}-\d{2}$/.test(identity)
    || !Number.isFinite(Date.parse(identity)) || new Date(identity).toISOString().slice(0,10)!==identity))fail('PHASE4_HEALTH_DATE_REQUIRED');
  if(family==='ANSWER_FOLLOWUP' && !FOLLOWUP_KINDS.includes(followupKind))fail('PHASE4_FOLLOWUP_KIND_REQUIRED');
  return JSON.stringify([userId,family,identity,...(family==='ANSWER_FOLLOWUP'?[followupKind]:[])]);
}

export function createPhase4MessageStore(core,entities) {
  const {client,timestamp}=core;
  async function reserve(context,{family,identity,followupKind=null}) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    const key=semanticReservationKey(context.userId,family,identity,followupKind);
    const previous=(await client.execute({sql:`SELECT * FROM outbound_semantic_reservations
      WHERE user_id=? AND execution_mode=? AND message_family=? AND semantic_key=?`,args:[context.userId,context.executionMode,family,key]})).rows[0];
    if(previous)return {row:{...previous},created:false};
    const parent=family==='EPISODE_NOTIFICATION'?['episode_semantic_events','episode_semantic_event_id']:
      family==='CONTEXT_QUESTION'?['context_questions','question_request_id']:
      family==='ANSWER_FOLLOWUP'?['structured_answer_events','answer_event_id']:null;
    if(parent) {
      const p=await core.artifact(context,parent[0],{[parent[1]]:identity});
      if(family==='ANSWER_FOLLOWUP' && p.row.selected_followup_kind!==followupKind)fail('PHASE4_FOLLOWUP_PARENT_MISMATCH');
    }
    const id=core.newId();
    await client.execute({sql:`INSERT INTO outbound_semantic_reservations(user_id,execution_mode,reservation_id,message_family,
      semantic_key,${identityField[family]},followup_kind,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      args:[context.userId,context.executionMode,id,family,key,identity,followupKind,timestamp()]});
    return {row:{...(await client.execute({sql:'SELECT * FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode=? AND reservation_id=?',
      args:[context.userId,context.executionMode,id]})).rows[0]},created:true};
  }
  async function propose(context,{semantic,message,sourceRefs=[]}) {
    return core.run(context,async()=>{
      if(!message || Object.keys(message).some(k=>['message_id','idempotency_key','message_class','reservation_id','state','revision',
        'attempt_count','lease_owner','lease_expires_at','terminal_reason','provider_message_id','payload_hash','destination_binding_id'].includes(k)))fail('PHASE4_MESSAGE_FIELDS_REQUIRED');
      if(context.executionMode==='LIVE')message={...message,destination_binding_id:await phase4Destination(core,context)};
      const reservation=await reserve(context,semantic),r=reservation.row;
      if(!reservation.created) {
        if(r.state!=='RESERVED')return {created:false,reservation:r,terminal:true};
        if(r.message_id) {
          const old=await core.artifact(context,'outbound_messages',{message_id:r.message_id});
          for(const [field,value] of Object.entries(message)) {
            const normalized=field.endsWith('_json')&&value!==null?canonicalJson(typeof value==='string'?JSON.parse(value):value):value;
            if(old.row[field]!==normalized)fail('PHASE4_FROZEN_MESSAGE_CONFLICT');
          }
          return {...old,created:false,reservation:r};
        }
      }
      const reference=identityField[semantic.family];
      if(reference!=='local_health_date' && message[reference]!==semantic.identity)fail('PHASE4_MESSAGE_SEMANTIC_PARENT_MISMATCH');
      if(semantic.family==='ANSWER_FOLLOWUP' && message.followup_kind!==semantic.followupKind)fail('PHASE4_FOLLOWUP_PARENT_MISMATCH');
      if(message.decision_id) {
        const decision=(await core.artifact(context,'phase4_proactive_decisions',{decision_id:message.decision_id})).row;
        if(!['NOTIFY','ASK_ONE_HIGHEST_VALUE_QUESTION'].includes(decision.action))fail('PHASE4_DECISION_CANNOT_PROPOSE');
        if((semantic.family==='CONTEXT_QUESTION')!==(decision.action==='ASK_ONE_HIGHEST_VALUE_QUESTION'))fail('PHASE4_DECISION_FAMILY_MISMATCH');
        if(reference!=='local_health_date' && decision[reference]!==semantic.identity)fail('PHASE4_DECISION_SEMANTIC_PARENT_MISMATCH');
      } else if(semantic.family!=='MORNING_BRIEF_V1')fail('PHASE4_MESSAGE_DECISION_REQUIRED');
      if(context.executionMode==='SHADOW' && message.destination_binding_id!=null)fail('PHASE4_SHADOW_DESTINATION_FORBIDDEN');
      const record=await entities.append(context,'outbound_messages',{...message,idempotency_key:r.semantic_key,
        message_class:r.message_family,reservation_id:r.reservation_id,state:'PROPOSED'},sourceRefs);
      await client.execute({sql:`UPDATE outbound_semantic_reservations SET message_id=?
        WHERE user_id=? AND execution_mode=? AND reservation_id=? AND state='RESERVED' AND message_id IS NULL`,
        args:[record.row.message_id,context.userId,context.executionMode,r.reservation_id]});
      return {...record,reservation:{...r,message_id:record.row.message_id}};
    });
  }
  async function readReservation(control,mode,{family,identity,followupKind}) {
    return core.runControl(control,mode,async()=>{
      const key=semanticReservationKey(control.userId,family,identity,followupKind);
      const row=(await client.execute({sql:'SELECT * FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode=? AND message_family=? AND semantic_key=?',
        args:[control.userId,mode,family,key]})).rows[0];return row?{...row}:null;
    });
  }
  async function simulate(context,messageId,outcome) {
    if(context.executionMode!=='SHADOW'||!['DELIVERED','AMBIGUOUS','SUPPRESSED'].includes(outcome))fail('PHASE4_SHADOW_SIMULATION_REQUIRED');
    return core.run(context,async()=>{
      const {row}=await core.artifact(context,'outbound_messages',{message_id:messageId});
      const at=timestamp(),reason=outcome==='SUPPRESSED'?'SHADOW_SIMULATION':`SHADOW_SIMULATED_${outcome}`;
      if(row.state==='SUPPRESSED' && row.terminal_reason===reason)return {outcome,simulated:true};
      if(!['PROPOSED','ELIGIBLE'].includes(row.state))fail('PHASE4_SIMULATION_STATE_CONFLICT');
      await client.execute({sql:`UPDATE outbound_messages SET state='SUPPRESSED',terminal_reason=?,revision=revision+1,updated_at=?
        WHERE user_id=? AND execution_mode='SHADOW' AND message_id=? AND revision=?`,args:[reason,at,context.userId,messageId,row.revision]});
      if(outcome==='SUPPRESSED')await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='SUPPRESSED',closed_at=?
        WHERE user_id=? AND execution_mode='SHADOW' AND reservation_id=? AND state='RESERVED'`,args:[at,context.userId,row.reservation_id]});
      else await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CONSUMED',consumed_outcome=?,consumed_at=?
        WHERE user_id=? AND execution_mode='SHADOW' AND reservation_id=? AND state='RESERVED'`,args:[outcome,at,context.userId,row.reservation_id]});
      return {outcome,simulated:true};
    });
  }
  return {reserve,propose,readReservation,simulate};
}
