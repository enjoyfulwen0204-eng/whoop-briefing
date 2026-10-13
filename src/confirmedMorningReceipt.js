import {readableRow} from './phase4Core.js';
import {canonicalJson} from './phase4EntityStore.js';
/** Receipt authority only: it proves a same-user confirmed send. It neither
 * makes historical health current nor promotes SHADOW calculations to LIVE. */
export async function confirmedMorningReceipt({core,actor,day}){
 const {client,keys}=core,uid=actor.control.userId;
 if(core.schemaVersion===34){
  const row=(await client.execute({sql:`SELECT m.*,a.request_hash,a.attempt_number,a.completed_at,a.provider_message_id ack_id,p.plan_json,p.plan_hmac,p.plan_id,
    p.content_state plan_content,p.source_linkage_state plan_linkage,p.health_content_redacted_at plan_redacted
   FROM outbound_messages m JOIN outbound_semantic_reservations r ON r.user_id=m.user_id AND r.execution_mode=m.execution_mode AND r.reservation_id=m.reservation_id
   JOIN outbound_delivery_attempts a ON a.user_id=m.user_id AND a.execution_mode=m.execution_mode AND a.message_id=m.message_id AND a.attempt_number=m.attempt_count
   JOIN morning_brief_plans p ON p.user_id=m.user_id AND p.execution_mode=m.execution_mode AND p.plan_id=json_extract(m.payload_json,'$.morningPlanId')
   WHERE m.user_id=? AND m.execution_mode='LIVE' AND m.message_class='MORNING_BRIEF_V1' AND r.local_health_date=?
   AND m.state='DELIVERED' AND a.state='DELIVERED' AND r.state='CONSUMED' AND r.consumed_outcome='DELIVERED'
   AND m.lifecycle_generation=? AND m.auth_generation=? LIMIT 1`,args:[uid,day,actor.state.lifecycle_generation,actor.state.auth_generation]})).rows[0];
  if(row){
   if(!readableRow(row)||row.plan_content!=='PRESENT'||row.plan_linkage!=='COMPLETE'||row.plan_redacted||!row.ack_id||row.ack_id!==row.provider_message_id)return null;
   const binding=(await client.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[uid]})).rows;
   if(binding.length!==1||String(binding[0].telegram_chat_id)!==actor.chat||row.destination_binding_id!==keys.lookup(['destination-binding-v1',uid,binding[0].telegram_chat_id,binding[0].linked_at]))return null;
   if(row.request_hash!==keys.digest(row.content_digest_salt,JSON.stringify([row.payload_hash,row.destination_binding_id,row.attempt_number]))
    ||row.payload_hash!==keys.digest(row.content_digest_salt,canonicalJson([row.payload_text,row.payload_json]))
    ||row.plan_hmac!==keys.lookup(['morning-plan-v1',uid,'LIVE',row.plan_id,row.plan_json]))return null;
   const plan=JSON.parse(row.plan_json);if(plan.healthDate!==day||plan.timezone!==actor.state.timezone)return null;
   return {sleepId:plan.wakeAt===null?null:plan.proofs.find(p=>p.type==='sleep')?.id??null,briefAt:Date.parse(row.completed_at),reportSource:row.privacy_artifact_id,reportType:'outbound_messages'};
  }
 }
 const row=(await client.execute({sql:`SELECT r.sleep_id,r.sent_at,r.privacy_artifact_id report_source,c.telegram_message_id FROM report_claims c
  JOIN report_runs r ON r.user_id=c.user_id AND r.report_type=c.report_type AND r.local_date=c.local_date AND r.status='SENT'
  AND r.telegram_message_id=c.telegram_message_id WHERE c.user_id=? AND c.report_type='daily' AND c.local_date=?
  AND c.delivery_state='DELIVERED' AND c.lifecycle_generation=? AND c.telegram_message_id IS NOT NULL
  AND r.content_state='PRESENT' AND r.source_linkage_state='COMPLETE' LIMIT 1`,args:[uid,day,actor.state.lifecycle_generation]})).rows[0];
 return row?{sleepId:row.sleep_id?String(row.sleep_id):null,briefAt:Date.parse(row.sent_at),reportSource:row.report_source,reportType:'report_runs'}:null;
}
