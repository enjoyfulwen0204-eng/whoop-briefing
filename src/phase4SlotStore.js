import { fail, requireInteger, readableRow } from './phase4Core.js';
import { SLOT_OCCUPIED, SLOT_CANCELLATION_REASONS } from './phase4V24Schema.js';

export const QUESTION_WINDOW_VERSION='question-slot-v1';
export const QUESTION_WINDOW_MS=30*60*1000;
const plusWindow=at=>new Date(Date.parse(at)+QUESTION_WINDOW_MS).toISOString();
const maxTime=(a,b)=>!a||a<b?b:a;
export function createPhase4SlotStore(core,entities,messages) {
  const {client,timestamp,keys}=core;
  async function row(userId,mode) {
    const result=(await client.execute({sql:'SELECT * FROM phase4_question_interaction_slots WHERE user_id=? AND execution_mode=?',args:[userId,mode]})).rows[0];
    return result?{...result}:null;
  }
  async function cas(userId,mode,current,patch) {
    const values={...patch,updated_at:timestamp(),revision:current.revision+1},fields=Object.keys(values);
    const changed=await client.execute({sql:`UPDATE phase4_question_interaction_slots SET ${fields.map(k=>`${k}=?`).join(',')}
      WHERE user_id=? AND execution_mode=? AND revision=? AND state=?`,
      args:[...fields.map(k=>values[k]),userId,mode,current.revision,current.state]});
    if(changed.rowsAffected!==1)fail('PHASE4_SLOT_CAS_LOST');return row(userId,mode);
  }
  async function acquire(context,{question,decision,message=null,sourceRefs=[],expectedRevision=0,revisitReceiptRef=null}) {
    requireInteger(expectedRevision);
    return core.run(context,async()=>{
      if(!question||!decision)fail('PHASE4_QUESTION_SELECTION_REQUIRED');
      if(context.executionMode==='LIVE' && !message)fail('PHASE4_LIVE_QUESTION_OUTBOX_REQUIRED');
      if(context.executionMode==='LIVE') {
        const mode=(await client.execute({sql:`SELECT mode,lifecycle_generation,auth_generation FROM tenant_delivery_modes
          WHERE user_id=? AND execution_mode='LIVE' AND message_family='CONTEXT_QUESTION'`,args:[context.userId]})).rows[0];
        if(mode?.mode!=='PHASE4'||mode.lifecycle_generation!==context.lifecycleGeneration||mode.auth_generation!==context.authGeneration)
          fail('PHASE4_DELIVERY_CUTOVER_REQUIRED');
      }
      if(context.executionMode==='LIVE' && (await client.execute({sql:`SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN'`,args:[context.userId]})).rows.length)
        fail('PHASE4_LEGACY_INTERACTION_OCCUPIED');
      if(context.executionMode==='LIVE'&&await unknownLegacySend(context.userId))fail('PHASE4_LEGACY_SEND_UNCLASSIFIED');
      if(['question_request_id','request_lookup_key','question_cycle_ordinal','question_cycle_source_key','selected_decision_id','status',
        'outbound_message_id','pending_question_id','logical_fact_id','answered_at'].some(k=>Object.hasOwn(question,k)))fail('PHASE4_QUESTION_FIELDS_REQUIRED');
      const {row:episode}=await core.artifact(context,'observation_episodes',{episode_id:question.episode_id});
      if(!['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'].includes(episode.state)||episode.revision!==question.episode_revision)
        fail('PHASE4_QUESTION_EPISODE_STALE');
      await client.execute({sql:`INSERT INTO phase4_question_interaction_slots(user_id,execution_mode,updated_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`,
        args:[context.userId,context.executionMode,timestamp()]});
      const slot=await row(context.userId,context.executionMode);
      const tuple=[context.userId,question.episode_id,question.factor_question_kind,question.target_window_start_utc,question.target_window_end_utc];
      const lookup=ordinal=>keys.lookup(['question-request-v1',...tuple,ordinal]);
      let ordinal=1,prior=null;
      for(;ordinal<=1000;ordinal++) {
        const existing=(await client.execute({sql:'SELECT * FROM context_questions WHERE user_id=? AND execution_mode=? AND request_lookup_key=?',
          args:[context.userId,context.executionMode,lookup(ordinal)]})).rows[0];
        if(!existing)break;prior=existing;
      }
      if(ordinal>1000)fail('PHASE4_QUESTION_CYCLE_LIMIT');
      if(prior && !revisitReceiptRef) {
        if(!readableRow(prior))fail('CONTENT_REDACTED');
        return {created:false,questionRequestId:prior.question_request_id,slot,
          terminal:!SLOT_OCCUPIED.includes(prior.status)};
      }
      if(SLOT_OCCUPIED.includes(slot.state))fail('PHASE4_QUESTION_SLOT_OCCUPIED');
      if(slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      let sourceKey=null;
      if(revisitReceiptRef) {
        if(!prior||SLOT_OCCUPIED.includes(prior.status))fail('PHASE4_REVISIT_NOT_TERMINAL');
        const [source]=await core.revalidateSources(context,[revisitReceiptRef]);
        if(source.type!=='TELEGRAM_OPERATION')fail('PHASE4_AUTHENTICATED_REVISIT_REQUIRED');
        const command=JSON.parse(source.row.result_json);
        if(command?.controlOperation!=='QUESTION_REVISIT'||command.questionRequestId!==prior.question_request_id)
          fail('PHASE4_AUTHENTICATED_REVISIT_REQUIRED');
        sourceKey=source.id;sourceRefs=[...sourceRefs,revisitReceiptRef];
      }
      const questionId=core.newId(),decisionId=core.newId(),at=timestamp();
      const selected=await entities.append(context,'context_questions',{...question,question_request_id:questionId,
        request_lookup_key:lookup(ordinal),question_cycle_ordinal:ordinal,question_cycle_source_key:sourceKey,
        selected_decision_id:decisionId,status:'RESERVED',expires_at:plusWindow(at)},sourceRefs);
      const d=await entities.append(context,'phase4_proactive_decisions',{...decision,decision_id:decisionId,
        action:'ASK_ONE_HIGHEST_VALUE_QUESTION',question_request_id:questionId,episode_id:question.episode_id,
        episode_revision:question.episode_revision},[selected.ref,...sourceRefs]);
      const semantic={family:'CONTEXT_QUESTION',identity:questionId};
      const proposal=message?await messages.propose(context,{semantic,message:{...message,decision_id:decisionId,question_request_id:questionId,
        episode_id:question.episode_id},sourceRefs:[d.ref,selected.ref,...sourceRefs]}):null;
      if(!proposal)await messages.reserve(context,semantic);
      const occupied=await cas(context.userId,context.executionMode,slot,{state:'RESERVED',origin:'PHASE4',question_request_id:questionId,
        outbound_message_id:proposal?.row.message_id??null,legacy_pending_question_id:null,legacy_operation_id:null,
        lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,reserved_at:at,
        delivery_started_at:null,delivered_at:null,answer_deadline:null,resolved_at:null,expired_at:null,ambiguous_at:null,cancellation_reason:null});
      if(proposal)await client.execute({sql:`UPDATE context_questions SET outbound_message_id=? WHERE user_id=? AND execution_mode=? AND question_request_id=?`,
        args:[proposal.row.message_id,context.userId,context.executionMode,questionId]});
      return {created:true,questionRequestId:questionId,decisionId,messageId:proposal?.row.message_id??null,slot:occupied};
    });
  }
  async function questionStatus(userId,mode,questionId,status,at=timestamp()) {
    const slot=await row(userId,mode);
    await client.execute({sql:`UPDATE context_questions SET status=?,updated_at=?,expires_at=COALESCE(?,expires_at)
      WHERE user_id=? AND execution_mode=? AND question_request_id=?`,
      args:[status,at,slot?.question_request_id===questionId?slot.answer_deadline:null,userId,mode,questionId]});
  }
  async function cancel(userId,mode,slot,reason) {
    if(!SLOT_CANCELLATION_REASONS.includes(reason))fail('PHASE4_SLOT_REASON_REQUIRED');
    if(slot?.state!=='RESERVED')return slot;
    const changed=await cas(userId,mode,slot,{state:'CANCELLED_PRE_SEND',cancellation_reason:reason});
    await questionStatus(userId,mode,slot.question_request_id,'CANCELLED_PRE_SEND');
    await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason=?,closed_at=?
      WHERE user_id=? AND execution_mode=? AND question_request_id=? AND state='RESERVED'`,
      args:[reason,timestamp(),userId,mode,slot.question_request_id]});
    if(slot.outbound_message_id) {
      const message=(await client.execute({sql:'SELECT state FROM outbound_messages WHERE user_id=? AND execution_mode=? AND message_id=?',
        args:[userId,mode,slot.outbound_message_id]})).rows[0];
      if(message && ['PROPOSED','ELIGIBLE','CLAIMED'].includes(message.state))await client.execute({sql:`UPDATE outbound_messages
        SET state='INVALIDATED',terminal_reason=?,revision=revision+1,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE user_id=? AND execution_mode=? AND message_id=?`,args:[reason,timestamp(),userId,mode,slot.outbound_message_id]});
    }
    return changed;
  }
  async function beginSimulation(context,{questionRequestId,expectedRevision}) {
    if(context.executionMode!=='SHADOW')fail('PHASE4_SHADOW_SIMULATION_REQUIRED');
    return core.run(context,async()=>{
      const slot=await row(context.userId,'SHADOW'),at=timestamp();
      if(!slot||slot.state!=='RESERVED'||slot.question_request_id!==questionRequestId||slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(plusWindow(slot.reserved_at)<=at)fail('PHASE4_RESERVATION_EXPIRED');
      const preferences=(await client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[context.userId]})).rows[0];
      if(preferences?.notifications_paused===1)fail('PHASE4_NOTIFICATIONS_PAUSED');
      await core.artifact(context,'context_questions',{question_request_id:questionRequestId});
      const next=await cas(context.userId,'SHADOW',slot,{state:'DELIVERY_STARTED',delivery_started_at:at,answer_deadline:plusWindow(at)});
      await questionStatus(context.userId,'SHADOW',questionRequestId,'DELIVERY_STARTED');return next;
    });
  }
  async function classifySimulation(control,mode,{questionRequestId,expectedRevision,outcome}) {
    if(mode!=='SHADOW'||!['DELIVERED','AMBIGUOUS','FAILED_DEFINITE'].includes(outcome))fail('PHASE4_SHADOW_SIMULATION_REQUIRED');
    return core.runMaintenance(control,mode,async()=>{
      const slot=await row(control.userId,mode),at=timestamp();
      if(!slot||slot.question_request_id!==questionRequestId||slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(slot.state==='AMBIGUOUS_WAIT'&&slot.answer_deadline<=at) {
        const expired=await cas(control.userId,mode,slot,{state:'EXPIRED',expired_at:at});
        await questionStatus(control.userId,mode,questionRequestId,'EXPIRED');return expired;
      }
      if(outcome==='AMBIGUOUS'&&slot.state==='AMBIGUOUS_WAIT')return slot;
      if(outcome==='DELIVERED'&&slot.state==='AWAITING_ANSWER')return slot;
      if(!['DELIVERY_STARTED','AMBIGUOUS_WAIT'].includes(slot.state))return slot; // late transport proof never reopens a terminal slot
      if(outcome==='FAILED_DEFINITE') {
        if(slot.state!=='DELIVERY_STARTED')return slot;
        const next=await cas(control.userId,mode,slot,{state:'CANCELLED_PRE_SEND',cancellation_reason:'PROVIDER_DEFINITE_NON_ACCEPTANCE'});
        await questionStatus(control.userId,mode,questionRequestId,'CANCELLED_PRE_SEND');
        await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='PROVIDER_DEFINITE_NON_ACCEPTANCE',closed_at=?
          WHERE user_id=? AND execution_mode=? AND question_request_id=? AND state='RESERVED'`,args:[at,control.userId,mode,questionRequestId]});
        return next;
      }
      const state=outcome==='DELIVERED'?'AWAITING_ANSWER':'AMBIGUOUS_WAIT';
      const next=await cas(control.userId,mode,slot,{state,answer_deadline:maxTime(slot.answer_deadline,plusWindow(at)),
        ...(outcome==='DELIVERED'?{delivered_at:at}:{ambiguous_at:at})});
      await questionStatus(control.userId,mode,questionRequestId,state);
      await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CONSUMED',consumed_outcome=?,consumed_at=?
        WHERE user_id=? AND execution_mode=? AND question_request_id=? AND state='RESERVED'`,args:[outcome,at,control.userId,mode,questionRequestId]});
      return next;
    });
  }
  async function expire(control,mode,{expectedRevision}) {
    return core.runMaintenance(control,mode,async()=>{
      const slot=await row(control.userId,mode),at=timestamp();
      if(!slot||slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(slot.state==='RESERVED')return plusWindow(slot.reserved_at)<=at?cancel(control.userId,mode,slot,'RESERVATION_EXPIRED'):slot;
      if(slot.state==='DELIVERY_STARTED' && slot.answer_deadline<=at) {
        // Recovery classifies uncertainty first. It cannot directly consume the
        // entire answer opportunity using the old start-time deadline.
        const next=await cas(control.userId,mode,slot,{state:'AMBIGUOUS_WAIT',ambiguous_at:at,answer_deadline:plusWindow(at)});
        await questionStatus(control.userId,mode,slot.question_request_id,'AMBIGUOUS_WAIT');
        await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CONSUMED',consumed_outcome='AMBIGUOUS',consumed_at=?
          WHERE user_id=? AND execution_mode=? AND question_request_id=? AND state='RESERVED'`,args:[at,control.userId,mode,slot.question_request_id]});
        return next;
      }
      if(['AMBIGUOUS_WAIT','AWAITING_ANSWER'].includes(slot.state)&&slot.answer_deadline<=at) {
        const next=await cas(control.userId,mode,slot,{state:'EXPIRED',expired_at:at});
        if(mode==='LIVE'&&slot.origin==='PHASE4')await client.execute({sql:`UPDATE pending_questions SET status='EXPIRED'
          WHERE user_id=? AND execution_mode='LIVE' AND context_question_id=? AND status='OPEN'`,args:[control.userId,slot.question_request_id]});
        await questionStatus(control.userId,mode,slot.question_request_id,'EXPIRED');return next;
      }
      return slot;
    });
  }
  async function answer(context,{questionRequestId,replyToQuestionRequestId,expectedRevision,answer,sourceRefs=[]}) {
    return core.run(context,async()=>{
      const slot=await row(context.userId,context.executionMode),at=timestamp();
      if(!slot||slot.question_request_id!==questionRequestId||slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(!['AMBIGUOUS_WAIT','AWAITING_ANSWER'].includes(slot.state)||slot.answer_deadline<=at)fail('PHASE4_ANSWER_WINDOW_CLOSED');
      if(replyToQuestionRequestId!==questionRequestId)fail('PHASE4_EXACT_QUESTION_REFERENCE_REQUIRED');
      if(!answer || Object.hasOwn(answer,'question_request_id') || answer.answer_revision!==1
        || (context.executionMode==='SHADOW' && (!String(answer.source_update_id).startsWith('shadow:')
          || answer.logical_fact_id!=null||answer.fact_revision!=null||answer.coverage_window_id!=null)))fail('PHASE4_ANSWER_AUTHORITY_REQUIRED');
      if(context.executionMode==='LIVE') {
        const refs=await core.revalidateSources(context,sourceRefs);
        if(!refs.some(s=>s.type==='TELEGRAM_OPERATION'&&s.id===String(answer.source_update_id)))fail('PHASE4_ANSWER_RECEIPT_REQUIRED');
      }
      const question=await core.artifact(context,'context_questions',{question_request_id:questionRequestId});
      const saved=await entities.append(context,'structured_answer_events',{...answer,question_request_id:questionRequestId,committed_at:at},[question.ref,...sourceRefs]);
      const next=await cas(context.userId,context.executionMode,slot,{state:'RESOLVED',resolved_at:at});
      await client.execute({sql:`UPDATE context_questions SET status='RESOLVED',answered_at=?,updated_at=? WHERE user_id=? AND execution_mode=? AND question_request_id=?`,
        args:[at,at,context.userId,context.executionMode,questionRequestId]});
      if(context.executionMode==='LIVE')await client.execute({sql:`UPDATE pending_questions SET status='ANSWERED',answered_at=?
        WHERE user_id=? AND execution_mode='LIVE' AND context_question_id=? AND status='OPEN'`,args:[at,context.userId,questionRequestId]});
      return {answer:saved,slot:next};
    });
  }
  async function reconcile(control,mode) {
    return core.runMaintenance(control,mode,async()=>{
      const slot=await row(control.userId,mode);if(!slot||slot.state!=='RESERVED')return slot;
      const state=await core.userState(control.userId);
      const prefs=(await client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[control.userId]})).rows[0];
      const reason=state.pending_purge_count?'CONTENT_REDACTED':state.status!=='ACTIVE'||state.lifecycle_generation!==slot.lifecycle_generation?'LIFECYCLE_CHANGED':
        state.auth_generation!==slot.auth_generation?'AUTH_CHANGED':prefs?.notifications_paused?'PAUSED':null;
      return reason?cancel(control.userId,mode,slot,reason):slot;
    });
  }
  async function pauseExisting(control) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    await core.assertControl(control);
    // Shared preferences may cancel existing reservations in both modes. This
    // purpose cannot create LIVE computations, acquire a slot or start a send.
    const slots=(await client.execute({sql:"SELECT * FROM phase4_question_interaction_slots WHERE user_id=? AND state='RESERVED'",args:[control.userId]})).rows;
    for(const slot of slots)await cancel(control.userId,slot.execution_mode,slot,'PAUSED');
  }
  async function transportStart(context,message,expectedRevision) {
    if(!core.processing.active()||context.executionMode!=='LIVE')fail('PHASE4_LIVE_TRANSACTION_REQUIRED');
    const slot=await row(context.userId,'LIVE'),at=timestamp();
    if(!slot||slot.state!=='RESERVED'||slot.origin!=='PHASE4'||slot.revision!==expectedRevision
      ||slot.question_request_id!==message.question_request_id||slot.outbound_message_id!==message.message_id)
      fail('PHASE4_SLOT_CAS_LOST');
    if(plusWindow(slot.reserved_at)<=at)fail('PHASE4_RESERVATION_EXPIRED');
    if((await client.execute({sql:"SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN'",args:[context.userId]})).rows.length)
      fail('PHASE4_LEGACY_INTERACTION_OCCUPIED');
    if(await unknownLegacySend(context.userId))fail('PHASE4_LEGACY_SEND_UNCLASSIFIED');
    await core.artifact(context,'context_questions',{question_request_id:slot.question_request_id});
    await cas(context.userId,'LIVE',slot,{state:'DELIVERY_STARTED',delivery_started_at:at,answer_deadline:plusWindow(at)});
    await questionStatus(context.userId,'LIVE',slot.question_request_id,'DELIVERY_STARTED');
  }
  async function transportSettle(userId,mode,message,outcome) {
    if(!core.processing.active()||mode!=='LIVE')fail('PHASE4_LIVE_TRANSACTION_REQUIRED');
    const slot=await row(userId,mode),at=timestamp();
    if(!slot||slot.question_request_id!==message.question_request_id||slot.outbound_message_id!==message.message_id)return;
    if(!['DELIVERY_STARTED','AMBIGUOUS_WAIT'].includes(slot.state))return;
    if(slot.state==='AMBIGUOUS_WAIT'&&slot.answer_deadline<=at) {
      await cas(userId,mode,slot,{state:'EXPIRED',expired_at:at});
      await questionStatus(userId,mode,slot.question_request_id,'EXPIRED');return;
    }
    if(outcome==='FAILED_DEFINITE') {
      if(slot.state!=='DELIVERY_STARTED')return;
      await cas(userId,mode,slot,{state:'CANCELLED_PRE_SEND',cancellation_reason:'PROVIDER_DEFINITE_NON_ACCEPTANCE'});
      await questionStatus(userId,mode,slot.question_request_id,'CANCELLED_PRE_SEND');return;
    }
    if(outcome==='AMBIGUOUS'&&slot.state==='AMBIGUOUS_WAIT')return;
    const state=outcome==='DELIVERED'?'AWAITING_ANSWER':'AMBIGUOUS_WAIT';
    await cas(userId,mode,slot,{state,answer_deadline:maxTime(slot.answer_deadline,plusWindow(at)),
      ...(outcome==='DELIVERED'?{delivered_at:at}:{ambiguous_at:at})});
    await questionStatus(userId,mode,slot.question_request_id,state);
  }
  async function unknownLegacySend(userId) {
    // There is no durable question-attempt lineage in these legacy rows.
    // An unresolved send is not evidence that the conversation slot is free.
    return Boolean((await client.execute({sql:`SELECT 1 FROM proactive_events WHERE user_id=? AND decision='ASK_CONTEXT'
      AND sent_at IS NULL AND outcome IS NULL UNION ALL SELECT 1 FROM telegram_operations WHERE owner_user_id=?
      AND delivery_state IN ('DELIVERY_STARTED','AMBIGUOUS') LIMIT 1`,args:[userId,userId]})).rows.length);
  }
  async function projectPending(context,{questionRequestId,expectedRevision}) {
    if(context.executionMode!=='LIVE')fail('PHASE4_LIVE_REQUIRED');
    return core.run(context,async()=>{
      const slot=await row(context.userId,'LIVE');
      if(!slot||slot.origin!=='PHASE4'||slot.state!=='AWAITING_ANSWER'||slot.question_request_id!==questionRequestId
        ||slot.revision!==expectedRevision||slot.answer_deadline<=timestamp())fail('PHASE4_SLOT_CAS_LOST');
      if(slot.lifecycle_generation!==context.lifecycleGeneration||slot.auth_generation!==context.authGeneration)fail('PHASE4_SLOT_GENERATION_STALE');
      const question=await core.artifact(context,'context_questions',{question_request_id:questionRequestId});
      const message=await core.artifact(context,'outbound_messages',{message_id:slot.outbound_message_id});
      const binding=(await client.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[context.userId]})).rows;
      if(binding.length!==1||message.row.destination_binding_id!==keys.lookup(['destination-binding-v1',context.userId,binding[0].telegram_chat_id,binding[0].linked_at]))
        fail('PHASE4_DESTINATION_CHANGED');
      const existing=(await client.execute({sql:`SELECT id,slot_revision,content_state,source_linkage_state,health_content_redacted_at FROM pending_questions
        WHERE user_id=? AND execution_mode='LIVE' AND context_question_id=?`,args:[context.userId,questionRequestId]})).rows;
      if(existing.length>1)fail('PHASE4_PENDING_PROJECTION_CONFLICT');
      if(existing.length) {
        if(!readableRow(existing[0]))fail('CONTENT_REDACTED');
        return {id:existing[0].id,created:false};
      }
      if((await client.execute({sql:"SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN'",args:[context.userId]})).rows.length)
        fail('PHASE4_LEGACY_INTERACTION_OCCUPIED');
      if(typeof message.row.payload_text!=='string'||!message.row.payload_text)fail('PHASE4_QUESTION_PAYLOAD_REQUIRED');
      const envelope=core.envelope(context,'pending_questions',[questionRequestId]);
      const record={...envelope,chat_id:binding[0].telegram_chat_id,question:message.row.payload_text,
        context_json:JSON.stringify({questionRequestId}),intent:'PHASE4_STRUCTURED_ANSWER',asked_at:slot.delivered_at,
        expires_at:slot.answer_deadline,status:'OPEN',context_question_id:questionRequestId,input_generation:context.inputGeneration,slot_revision:slot.revision};
      const fields=Object.keys(record),insert=await client.execute({sql:`INSERT INTO pending_questions(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>record[k])});
      const id=Number(insert.lastInsertRowid);
      await core.link(context,'pending_questions',envelope.privacy_artifact_id,[question.ref,message.ref]);
      await client.execute({sql:'UPDATE context_questions SET pending_question_id=? WHERE user_id=? AND execution_mode=\'LIVE\' AND question_request_id=?',args:[id,context.userId,questionRequestId]});
      return {id,created:true};
    });
  }
  async function syncLegacy(control,mode,{expectedRevision=0}={}) {
    if(mode!=='LIVE')fail('PHASE4_LEGACY_GUARD_LIVE_ONLY');
    requireInteger(expectedRevision);
    return core.runMaintenance(control,mode,async()=>{
      const uid=control.userId,at=timestamp();
      await client.execute({sql:'INSERT INTO phase4_question_interaction_slots(user_id,execution_mode,updated_at) VALUES (?,\'LIVE\',?) ON CONFLICT DO NOTHING',args:[uid,at]});
      let slot=await row(uid,mode);
      if(slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(SLOT_OCCUPIED.includes(slot.state)&&slot.origin==='PHASE4')return {blocked:true,reason:'PHASE4_OCCUPIED',slot};
      if(SLOT_OCCUPIED.includes(slot.state)&&slot.origin==='LEGACY') {
        const pending=(await client.execute({sql:'SELECT id,status,expires_at FROM pending_questions WHERE user_id=? AND id=?',args:[uid,slot.legacy_pending_question_id]})).rows[0];
        if(pending?.status==='ANSWERED'&&['AWAITING_ANSWER','AMBIGUOUS_WAIT'].includes(slot.state))
          slot=await cas(uid,mode,slot,{state:'RESOLVED',resolved_at:at});
        else if(['AWAITING_ANSWER','AMBIGUOUS_WAIT'].includes(slot.state)&&slot.answer_deadline<=at)
          slot=await cas(uid,mode,slot,{state:'EXPIRED',expired_at:at});
        else return {blocked:true,reason:'LEGACY_OCCUPIED',slot};
      }
      if(await unknownLegacySend(uid))return {blocked:true,reason:'UNCLASSIFIABLE_LEGACY_SEND',slot};
      const pending=(await client.execute({sql:`SELECT id,asked_at,expires_at FROM pending_questions
        WHERE user_id=? AND status='OPEN' AND context_question_id IS NULL AND expires_at>? ORDER BY id`,args:[uid,at]})).rows;
      if(pending.length>1)return {blocked:true,reason:'MULTIPLE_LEGACY_INTERACTIONS',slot};
      if(!pending.length)return {blocked:false,slot};
      const p=pending[0],state=await core.userState(uid);
      if(!Number.isFinite(Date.parse(p.asked_at))||!Number.isFinite(Date.parse(p.expires_at))||p.asked_at>=p.expires_at)
        return {blocked:true,reason:'UNCLASSIFIABLE_LEGACY_SEND',slot};
      slot=await cas(uid,mode,slot,{state:'RESERVED',origin:'LEGACY',question_request_id:null,outbound_message_id:null,
        legacy_pending_question_id:p.id,legacy_operation_id:null,lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,
        reserved_at:p.asked_at,delivery_started_at:null,delivered_at:null,answer_deadline:null,resolved_at:null,expired_at:null,ambiguous_at:null,cancellation_reason:null});
      slot=await cas(uid,mode,slot,{state:'DELIVERY_STARTED',delivery_started_at:p.asked_at,answer_deadline:p.expires_at});
      slot=await cas(uid,mode,slot,{state:'AWAITING_ANSWER',delivered_at:p.asked_at});
      return {blocked:true,reason:'LEGACY_OCCUPIED',slot};
    });
  }
  return {acquire,beginSimulation,classifySimulation,expire,answer,reconcile,
    syncLegacy,projectPending,
    pauseExisting,transportStart,transportSettle,read:(control,mode)=>core.runMaintenance(control,mode,()=>row(control.userId,mode))};
}
