import {fail,readableRow} from './phase4Core.js';
import {localDate} from './time.js';
import {selectCompanionInvitation,inCompanionQuietHours} from './companionTimingPolicy.js';
import {companionEngagementBusy} from './companionEngagementGuard.js';
import {COACH_TOPICS} from './companionCoach.js';
/** Coarse provider ticks select once, then read one due-state row. No LLM,
 * history synchronization or reanalysis is reachable from this service. */
export function createCompanionInvitation({core,stores,db,companion,coach,configuration}){
 const {client,transaction,timestamp,keys}=core,{interactions}=companion;
 const identity=(uid,day)=>keys.lookup(['coach-invitation-day-v1',uid,day]);
 async function wakeAuthority(actor,day){
  const uid=actor.control.userId;
  const row=(await client.execute({sql:`SELECT r.sleep_id,r.sent_at,r.privacy_artifact_id report_source,c.telegram_message_id FROM report_claims c
   JOIN report_runs r ON r.user_id=c.user_id AND r.report_type=c.report_type AND r.local_date=c.local_date AND r.status='SENT'
   AND r.telegram_message_id=c.telegram_message_id WHERE c.user_id=? AND c.report_type='daily' AND c.local_date=?
   AND c.delivery_state='DELIVERED' AND c.lifecycle_generation=? AND c.telegram_message_id IS NOT NULL
   AND r.content_state='PRESENT' AND r.source_linkage_state='COMPLETE' LIMIT 1`,args:[uid,day,actor.state.lifecycle_generation]})).rows[0];
  if(!row||!row.sleep_id||!row.report_source)return null;
  return stores.withContext(uid,{executionMode:'SHADOW'},async context=>{
   const sleep=(await stores.root(context,'sleep',String(row.sleep_id))).row,recovery=(await stores.root(context,'recovery',String(row.sleep_id))).row;
   const wakeAt=Date.parse(sleep.end_at),briefAt=Date.parse(row.sent_at);
   if(sleep.nap!==0||sleep.score_state!=='SCORED'||recovery.score_state!=='SCORED'||recovery.user_calibrating===1
    ||!Number.isSafeInteger(wakeAt)||!Number.isSafeInteger(briefAt)||localDate(new Date(wakeAt),actor.state.timezone)!==day||briefAt<wakeAt)return null;
   return {sleepId:String(row.sleep_id),wakeAt,briefAt,reportSource:row.report_source,
    occasionKey:keys.lookup(['coach-wake-occasion-v1',uid,String(row.sleep_id)]),
    wakeProof:keys.lookup(['coach-wake-source-v1',uid,sleep.id,sleep.end_at,sleep.updated_at,recovery.updated_at])};
  });
 }
 async function prepare({user,chatId}){
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId}),uid=user.id,day=localDate(core.now(),actor.state.timezone),semantic=identity(uid,day);
   const prior=(await client.execute({sql:'SELECT delivery_id,state FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[uid,semantic]})).rows[0];
   if(prior)return {status:prior.state,deliveryId:prior.delivery_id};
   const prefs=await companion.preferences(actor);
   if(!prefs.coach_enabled)return {status:'DISABLED'};
   let topics=JSON.parse(prefs.coach_topics_json??'[]').filter(t=>COACH_TOPICS.includes(t));
   const wake=await wakeAuthority(actor,day);if(!wake)return {status:'BRIEF_WAKE_NOT_CONFIRMED'};
   if(topics.includes('exercise')){const workout=(await client.execute({sql:"SELECT id FROM whoop_workouts WHERE user_id=? AND score_state='SCORED' AND start_at>=? AND end_at<=? ORDER BY start_at DESC LIMIT 1",args:[uid,new Date(core.now().getTime()-7*86400000).toISOString(),timestamp()]})).rows[0];
    let eligible=false;if(workout)await stores.withContext(uid,{executionMode:'SHADOW'},async context=>{const value=(await stores.root(context,'workout',String(workout.id))).row;eligible=Number.isFinite(value.strain);});
    if(!eligible)topics=topics.filter(v=>v!=='exercise');
   }
   // One authentic wake cannot create two invitations through a timezone edit.
   const previousWake=(await client.execute({sql:"SELECT 1 FROM journal_prompt_deliveries WHERE user_id=? AND kind='COACH' AND occasion_key=? LIMIT 1",args:[uid,wake.occasionKey]})).rows.length;
   if(previousWake)return {status:'OCCASION_RESERVED'};
   const journal=(await client.execute({sql:`SELECT d.delivery_id,d.privacy_artifact_id,a.settled_at FROM journal_prompt_deliveries d
    JOIN quick_action_interactions q ON q.user_id=d.user_id AND q.interaction_id=d.interaction_id
    JOIN journal_delivery_attempts a ON a.user_id=d.user_id AND a.delivery_id=d.delivery_id AND a.state='DELIVERED'
    WHERE d.user_id=? AND d.kind='DAILY' AND q.day_key=? AND d.state='DELIVERED' ORDER BY a.attempt_number DESC LIMIT 1`,args:[uid,keys.lookup(['journal-day-v1',uid,day])]})).rows[0];
   if(prefs.daily_enabled&&!journal)return {status:'JOURNAL_NOT_CONFIRMED'};
   // With Journal disabled, a conservative 2h gap after Brief replaces the
   // absent card anchor. It never enables Journal or creates a fake delivery.
   const journalAt=journal?Date.parse(journal.settled_at):wake.briefAt;
   const selection=selectCompanionInvitation({now:core.now().getTime(),...wake,journalAt,healthDay:day,timezone:actor.state.timezone,
    seed:keys.lookup(['coach-slot-seed-v1',uid,day]),quietStart:prefs.quiet_start,quietEnd:prefs.quiet_end,config:configuration});
   const state=topics.length&&selection.state==='SCHEDULED'?'PROPOSED':'SUPPRESSED',at=timestamp();
   const schedule={...selection,healthDay:day,timezone:actor.state.timezone,profileRevision:actor.profileRevision,...wake,journalAt,
    journalDeliveryId:journal?.delivery_id??null,topic:topics.length?topics[Number.parseInt(semantic.slice(0,8),16)%topics.length]:null};
   const row={user_id:uid,delivery_id:core.newId(),interaction_id:null,semantic_key:semantic,occasion_key:wake.occasionKey,kind:'COACH',execution_mode:'SHADOW',state,
    payload_json:null,schedule_json:JSON.stringify(schedule),due_at:selection.selectedAt?new Date(selection.selectedAt).toISOString():null,
    lifecycle_generation:actor.state.lifecycle_generation,auth_generation:actor.state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,
    created_at:at,updated_at:at,expires_at:new Date(selection.expiresAt).toISOString(),...interactions.privacyFields(actor.state)};
   await interactions.insert('journal_prompt_deliveries',row);await interactions.link('journal_prompt_deliveries',row);
   for(const type of ['sleep','recovery'])await interactions.link('journal_prompt_deliveries',row,type,wake.sleepId);
   await interactions.link('journal_prompt_deliveries',row,'report_runs',wake.reportSource);
   if(journal)await interactions.link('journal_prompt_deliveries',row,'journal_prompt_deliveries',journal.privacy_artifact_id);
   return {status:state,deliveryId:row.delivery_id};
  });
 }
 async function due(actor,row){
  if(row.kind!=='COACH'||!readableRow(row))return {status:'SUPPRESSED'};
  const d=JSON.parse(row.schedule_json??'null'),now=core.now().getTime(),prefs=await companion.preferences(actor);
  if(!d||!prefs.coach_enabled||row.preference_revision!==prefs.revision||row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation
   ||row.chat_id!==actor.chat||d.profileRevision!==actor.profileRevision||d.timezone!==actor.state.timezone||d.healthDay!==localDate(core.now(),actor.state.timezone)
   ||!COACH_TOPICS.includes(d.topic)||!JSON.parse(prefs.coach_topics_json??'[]').includes(d.topic)||now>d.expiresAt||now<d.wakeAt)return {status:'SUPPRESSED'};
  if(now<d.selectedAt)return {status:'NOT_DUE'};
  if(inCompanionQuietHours(now,actor.state.timezone,prefs.quiet_start,prefs.quiet_end)||await companionEngagementBusy({core,db,actor,excludeInteractionId:row.interaction_id}))return {status:'SUPPRESSED'};
  const wake=await wakeAuthority(actor,d.healthDay);
  if(!wake||wake.occasionKey!==d.occasionKey||wake.wakeProof!==d.wakeProof||wake.wakeAt!==d.wakeAt||wake.briefAt!==d.briefAt)return {status:'SUPPRESSED'};
  if(d.journalDeliveryId){const delivered=(await client.execute({sql:"SELECT 1 FROM journal_prompt_deliveries WHERE user_id=? AND delivery_id=? AND state='DELIVERED' AND content_state='PRESENT' LIMIT 1",args:[actor.control.userId,d.journalDeliveryId]})).rows.length;if(!delivered)return {status:'SUPPRESSED'};}
  let interaction=row.interaction_id?await interactions.read(actor.control.userId,row.interaction_id):null;
  if(!interaction){const reply=await coach.issue(actor,{semanticKey:keys.lookup(['coach-invitation-card-v1',row.semantic_key]),automatic:true,topic:d.topic});
   interaction=await interactions.read(actor.control.userId,reply.stage7InteractionId);
   await client.execute({sql:'UPDATE journal_prompt_deliveries SET interaction_id=? WHERE user_id=? AND delivery_id=? AND interaction_id IS NULL',args:[interaction.interaction_id,actor.control.userId,row.delivery_id]});
   await interactions.link('journal_prompt_deliveries',row,'quick_action_interactions',interaction.privacy_artifact_id);
  }
  if(!readableRow(interaction)||interaction.kind!=='COACH'||interaction.state!=='ISSUED'||interaction.expires_at<=timestamp())return {status:'SUPPRESSED'};
  return {status:'READY',interaction,card:await coach.card(actor,interaction)};
 }
 return {prepare,due,wakeAuthority};
}
