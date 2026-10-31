import {proactiveQuota,proactiveSlotAllowed} from './proactiveQuota.js';
import {isProactiveJournalDelivery} from './stage7ProactiveJournal.js';
import {TOPICS,JOURNAL_COPY,presentationLocale} from './stage7Registry.js';
import {completedWeeks,localDate,localWeekday,localHour,localMidnightUtc,addDays} from './time.js';
import {t} from './localization.js';
import {WEEKLY} from './config.js';
import {captureStage7Enrollment,assertStage7Enrollment} from './stage7Enrollment.js';
import {confirmedMorningReceipt} from './confirmedMorningReceipt.js';
import {companionEngagementBusy} from './companionEngagementGuard.js';
import {COMPANION_DEFAULTS,inStage7QuietHours as inCompanionQuietHours} from './companionTimingPolicy.js';
import {readableRow,fail} from './phase4Core.js';

export const JOURNAL_WEEK_TIMEZONE='Asia/Taipei';
export function journalWeeklyWindow(instant){
 const day=localDate(instant,JOURNAL_WEEK_TIMEZONE);
 return localWeekday(day)<=WEEKLY.CATCHUP_DAYS&&localHour(instant,JOURNAL_WEEK_TIMEZONE)>=9;
}
const AUTOMATIC_WEEKLY_VERSION='stage7-weekly-auto-v1';
const hasRecords=summary=>summary.daysRecorded>0||['YES','NO','NOT_SURE','SKIPPED'].some(choice=>summary.responses[choice]>0);

export function summarizeJournalWeek({facts,history,topics,startDate,endDate,associations=[]}){
 const inRange=d=>typeof d==='string'&&d>=startDate&&d<=endDate;
 const current=facts.filter(f=>inRange(f.health_date)&&f.fact_status==='ACTIVE'&&f.content_state==='PRESENT');
 const dates=new Set(current.map(f=>f.health_date));
 const frequency=Object.fromEntries(TOPICS.map(category=>[category,new Set(current.filter(f=>f.category===category&&f.exposure_state==='EXPOSED').map(f=>f.health_date)).size]));
 const coverage=Object.fromEntries(topics.map(category=>[category,new Set(current.filter(f=>f.category===category&&['EXPOSED','CONFIRMED_UNEXPOSED'].includes(f.exposure_state)).map(f=>f.health_date)).size]));
 const asked=history.filter(h=>inRange(h.target_date)),responses={YES:0,NO:0,NOT_SURE:0,SKIPPED:0,NO_RESPONSE:0,NOT_ASKED:7-new Set(asked.map(h=>h.target_date)).size};
 for(const h of asked){
  const accepted=h.answered_at&&(['YES','NO'].includes(h.selected_choice)?h.state==='COMPLETED':['NOT_SURE','SKIPPED'].includes(h.selected_choice)&&h.state===h.selected_choice);
  responses[accepted?h.selected_choice:'NO_RESPONSE']++;
 }
 const next=topics.filter(c=>coverage[c]<4).sort((a,b)=>coverage[a]-coverage[b]||a.localeCompare(b))[0]??null;
 return {startDate,endDate,daysRecorded:dates.size,frequency,coverage,responses,next,associations,sampling:'ADAPTIVE_OBSERVATIONAL'};
}
export function renderJournalWeek(summary,locale){
 const l=presentationLocale(locale),c=JOURNAL_COPY[l],name=category=>c.topics[TOPICS.indexOf(category)];
 const lines=[`🗓 ${c.weekTitle} · ${summary.startDate}–${summary.endDate}`,`📔 ${c.recorded}: ${summary.daysRecorded}/7`,
  ...Object.entries(summary.frequency).filter(([,n])=>n>0).map(([topic,n])=>`${c.observed}: ${name(topic)} · ${n}`),
  ...Object.entries(summary.coverage).map(([topic,n])=>`${c.coverage}: ${name(topic)} · ${n}/7`),
  `🤔 ${c.unsure}: ${summary.responses.NOT_SURE} · ⏭ ${c.skip}: ${summary.responses.SKIPPED}`,
  `${c.unknown}: ${summary.responses.NO_RESPONSE} · ${c.notAsked}: ${summary.responses.NOT_ASKED}`,c.missing];
 if(!summary.associations.length)lines.push(c.insufficient);
 for(const a of summary.associations)lines.push(`${c.association}: ${name(a.factor)} / ${t(l,`metric.${a.metric}`)}`);
 if(summary.next)lines.push(`🔎 ${c.next}: ${name(summary.next)}`);
 return {text:lines.join('\n'),summary};
}
export function createStage7WeeklyReview({core,stores,db,companion}){
 async function build(actor){
  return core.transaction(async()=>{
   const state=await core.assertControl(actor.control),week=completedWeeks(core.now(),JOURNAL_WEEK_TIMEZONE).last,prefs=await companion.preferences(actor),facts=await companion.ownFacts(actor,{fromDate:week.startDate,toDate:week.endDate});
   if(facts.length===500)throw Error('STAGE7_WEEKLY_HISTORY_BOUNDS');
   const history=(await core.client.execute({sql:"SELECT privacy_artifact_id,target_date,selected_choice,state,answered_at,revision FROM quick_action_interactions WHERE user_id=? AND (kind='DAILY' OR json_extract(diagnostics_json,'$.dailyAnswerKey') IS NOT NULL AND state IN ('COMPLETED','NOT_SURE','SKIPPED')) AND target_date>=? AND target_date<=? AND content_state='PRESENT' ORDER BY interaction_id LIMIT 501",args:[actor.control.userId,week.startDate,week.endDate]})).rows;
   if(history.length>500)fail('STAGE7_WEEKLY_HISTORY_BOUNDS');
   const associations=[];
   await stores.withContext(actor.control.userId,{executionMode:'SHADOW'},async context=>{
    const typed=await stores.betaSummary.readCurrent(context,{asOfUtc:core.timestamp()});
    for(const insight of typed.insights.filter(i=>i.status==='SUPPORTED')){
     const verified=await stores.insights.read(context,insight.resultId,{asOfUtc:core.timestamp()});
     for(const id of JSON.parse(verified.revision.supporting_evidence_ids_json)){
      const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:id}),p=JSON.parse(item.row.provenance_json??'{}');
      if(TOPICS.includes(p.factor)&&p.method==='EXPOSED_VS_CONFIRMED_UNEXPOSED'&&item.row.causal_status==='ASSOCIATION_ONLY')associations.push({factor:p.factor,metric:p.outcome_metric,evidencePrivacyId:item.row.privacy_artifact_id});
     }
    }
   });
   const summary=summarizeJournalWeek({facts,history,topics:JSON.parse(prefs.topics_json),startDate:week.startDate,endDate:week.endDate,associations});
   const rendered=renderJournalWeek(summary,await db.getLocale(actor.control.userId));
   return {...rendered,projectionDigest:core.keys.lookup(['stage7-weekly-projection-v1',actor.control.userId,rendered,facts,history]),sourceInteractionIds:history.map(h=>h.privacy_artifact_id),sourceEvidenceIds:associations.map(a=>a.evidencePrivacyId),sourceFactIds:facts.filter(f=>f.health_date>=week.startDate&&f.health_date<=week.endDate).map(f=>f.privacy_artifact_id)};
  });
 }
 async function readiness(actor){
  const state=await core.assertControl(actor.control),prefs=await companion.preferences(actor);
  if(!prefs.weekly_enabled)return {status:'DISABLED'};
  if(state.auth_generation<1)return {status:'AUTHORIZATION_FENCED'};
  const enrollment=await captureStage7Enrollment({core,db,actor});
  if(!enrollment)return {status:'ENROLLMENT_NOT_READY'};
  if(inCompanionQuietHours(core.now(),state.timezone,prefs.quiet_start,prefs.quiet_end))return {status:'QUIET_HOURS'};
  const today=localDate(core.now(),state.timezone);
  // The calendar is Taiwan-wide; quiet hours and the confirmed daily brief
  // still belong to the recipient. Keep the existing catch-up day count.
  if(!journalWeeklyWindow(core.now()))return {status:'NOT_DUE'};
  const paused=(await core.client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[actor.control.userId]})).rows[0];
  if(paused?.notifications_paused)return {status:'NOTIFICATIONS_PAUSED'};
  if(await companionEngagementBusy({core,db,actor}))return {status:'INTERACTION_BUSY'};
  const brief=await confirmedMorningReceipt({core,actor,day:today});
  if(!brief)return {status:'BRIEF_NOT_CONFIRMED'};
  return {status:'READY',state,prefs,enrollment,brief};
 }
 async function linkSources(actor,row,result,brief=null){
  for(const id of result.sourceFactIds)await companion.interactions.link('journal_prompt_deliveries',row,'JOURNAL_FACT',id);
  for(const id of result.sourceInteractionIds)await companion.interactions.link('journal_prompt_deliveries',row,'quick_action_interactions',id);
  for(const id of result.sourceEvidenceIds)await companion.interactions.link('journal_prompt_deliveries',row,'evidence_items',id);
  if(brief)await companion.interactions.link('journal_prompt_deliveries',row,brief.reportType,brief.reportSource);
 }
 async function optionalSlotAvailable(actor,row){
   const state=await core.assertControl(actor.control);
  const legacy=isProactiveJournalDelivery(row),eventId=legacy?JSON.parse(row.schedule_json).eventId:null;
  const counts=await proactiveQuota(core.client,{userId:actor.control.userId,timezone:state.timezone,now:core.now(),excludeDeliveryId:row?.delivery_id??null,excludeEventId:eventId});
  return proactiveSlotAllowed(counts,legacy?'ASK_CONTEXT':row?.kind??'WEEKLY');
 }
 async function prepare(actor,{automatic=false}={}){
  return core.transaction(async()=>{
   const ready=automatic?await readiness(actor):null;if(ready&&ready.status!=='READY')return ready;
   const state=ready?.state??await core.assertControl(actor.control),prefs=ready?.prefs??await companion.preferences(actor),result=await build(actor);
   if(automatic&&!hasRecords(result.summary))return {status:'NO_RECORDS'};
   const semantic=core.keys.lookup(['weekly-journal-v1',actor.control.userId,result.summary.startDate,'weekly-review-v1']);
   let row=(await core.client.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[actor.control.userId,semantic]})).rows[0];
   if(automatic&&row){
    if(!readableRow(row)||['DELIVERED','AMBIGUOUS','DELIVERY_STARTED','SUPPRESSED'].includes(row.state))return {status:row.state,deliveryId:null};
    if(row.attempt_count>=3)return {status:'RETRY_EXHAUSTED'};
    if(row.lifecycle_generation!==state.lifecycle_generation||row.auth_generation!==state.auth_generation||row.chat_id!==actor.chat)return {status:'FENCED'};
    // An unattempted manual review may reserve this same week. Bind it once
    // for automatic delivery; never replace an existing automatic enrollment.
    if(row.schedule_json){
     await assertStage7Enrollment({core,db,actor,row});
     if(JSON.parse(row.schedule_json)?.version!==AUTOMATIC_WEEKLY_VERSION||row.preference_revision!==prefs.revision)return {status:'FENCED'};
    }else if(row.attempt_count!==0)return {status:'FENCED'};
   }
   const schedule=automatic?JSON.stringify({version:AUTOMATIC_WEEKLY_VERSION,enrollment:ready.enrollment,weekStart:result.summary.startDate,weekEnd:result.summary.endDate,
    timezone:state.timezone,projectionDigest:result.projectionDigest,briefSource:ready.brief.reportSource,briefType:ready.brief.reportType}):null;
   const expiry=automatic?localMidnightUtc(addDays(result.summary.endDate,WEEKLY.CATCHUP_DAYS+1),JOURNAL_WEEK_TIMEZONE).toISOString():new Date(core.now().getTime()+7*86400000).toISOString();
   if(!row){
    const at=core.timestamp();row={user_id:actor.control.userId,delivery_id:core.newId(),semantic_key:semantic,kind:'WEEKLY',execution_mode:'SHADOW',state:'PROPOSED',payload_json:JSON.stringify({text:result.text}),
     schedule_json:schedule,lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,created_at:at,updated_at:at,expires_at:expiry,...companion.interactions.privacyFields(state)};
    await companion.interactions.insert('journal_prompt_deliveries',row);await companion.interactions.link('journal_prompt_deliveries',row);
    await linkSources(actor,row,result,ready?.brief);
   }else if(automatic){
    await core.client.execute({sql:"UPDATE journal_prompt_deliveries SET payload_json=?,schedule_json=?,preference_revision=?,expires_at=?,revision=revision+1,updated_at=? WHERE user_id=? AND delivery_id=? AND revision=? AND state IN ('PROPOSED','FAILED_DEFINITE')",args:[JSON.stringify({text:result.text}),schedule,prefs.revision,expiry,core.timestamp(),actor.control.userId,row.delivery_id,row.revision]});
    await linkSources(actor,row,result,ready.brief);
   }
   return {status:'PROPOSED',text:result.text,deliveryId:row.content_state==='REDACTED'?null:row.delivery_id,summary:result.summary,stage7View:'WEEKLY'};
  });
 }
 async function due(actor,row){
  return core.transaction(async()=>{
   const ready=await readiness(actor);if(ready.status!=='READY')return ready;
   const schedule=JSON.parse(row?.schedule_json??'null');
   if(!readableRow(row)||row.kind!=='WEEKLY'||row.execution_mode!=='SHADOW'||row.user_id!==actor.control.userId||row.chat_id!==actor.chat
    ||row.lifecycle_generation!==ready.state.lifecycle_generation||row.auth_generation!==ready.state.auth_generation
    ||row.preference_revision!==ready.prefs.revision||row.expires_at<=core.timestamp()||schedule?.version!==AUTOMATIC_WEEKLY_VERSION)return {status:'FENCED'};
   await assertStage7Enrollment({core,db,actor,row});
   const result=await build(actor);
   if(!hasRecords(result.summary)||schedule.weekStart!==result.summary.startDate||schedule.weekEnd!==result.summary.endDate||schedule.timezone!==ready.state.timezone
    ||schedule.projectionDigest!==result.projectionDigest||schedule.briefSource!==ready.brief.reportSource
    ||(schedule.briefType??'report_runs')!==ready.brief.reportType||JSON.parse(row.payload_json??'null')?.text!==result.text)return {status:'FENCED'};
   const sources=[['JOURNAL_FACT',result.sourceFactIds],['quick_action_interactions',result.sourceInteractionIds],['evidence_items',result.sourceEvidenceIds],[ready.brief.reportType,[ready.brief.reportSource]]];
   for(const [type,ids]of sources)for(const id of ids)if(!(await core.client.execute({sql:'SELECT 1 FROM phase4_source_links WHERE user_id=? AND artifact_type=? AND artifact_id=? AND source_type=? AND source_id=? AND unlinked_at IS NULL LIMIT 1',args:[actor.control.userId,'journal_prompt_deliveries',row.privacy_artifact_id,type,id]})).rows.length)return {status:'FENCED'};
   return {status:'READY',projectionDigest:result.projectionDigest,card:{text:result.text,replyMarkup:{inline_keyboard:[]}}};
  });
 }
 return {build,prepare,due,optionalSlotAvailable};
}
