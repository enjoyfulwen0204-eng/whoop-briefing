import {looksLikeQuestion} from './bot/conversation.js';
import {captureStage7Enrollment} from './stage7Enrollment.js';
import {confirmedMorningReceipt} from './confirmedMorningReceipt.js';
import {companionEngagementBusy} from './companionEngagementGuard.js';
import {COACH_TOPICS} from './companionCoach.js';
import {inCompanionQuietHours} from './companionTimingPolicy.js';
import {labelForCategory} from './journal.js';
import {createStage7InteractionStore} from './stage7InteractionStore.js';
import {selectDailyQuestion} from './questionEngine.js';
import {readableRow,fail} from './phase4Core.js';
import {TOPICS,DETAILS,DAILY_POLICY_VERSION,registryQuestion,normalizeJournalNote,JOURNAL_COPY,presentationLocale} from './stage7Registry.js';
import {isJournalCallback} from './stage7Cards.js';
import {localDate,addDays,localMidnightUtc} from './time.js';

export function createStage7Companion({core,stores,db,onAccept=null,onUndo=null,onWeekly=null,...options}){
 const interactions=createStage7InteractionStore({core,db,...options}),{client,transaction,timestamp}=core;
 async function preferences(actor){
  const state=await core.assertControl(actor.control);
  let row=(await client.execute({sql:'SELECT * FROM journal_tracking_preferences WHERE user_id=?',args:[actor.control.userId]})).rows[0];
  if(!row){
   const at=timestamp();row={user_id:actor.control.userId,lifecycle_generation:state.lifecycle_generation,created_at:at,updated_at:at,...interactions.privacyFields(state)};
   await interactions.insert('journal_tracking_preferences',row);await interactions.link('journal_tracking_preferences',row);
   row=(await client.execute({sql:'SELECT * FROM journal_tracking_preferences WHERE user_id=?',args:[actor.control.userId]})).rows[0];
  }
  if(!readableRow(row))fail('STAGE7_PREFERENCE_FENCED');
  if(row.lifecycle_generation!==state.lifecycle_generation){await client.execute({sql:'UPDATE journal_tracking_preferences SET lifecycle_generation=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?',args:[state.lifecycle_generation,timestamp(),actor.control.userId,row.revision]});row=(await client.execute({sql:'SELECT * FROM journal_tracking_preferences WHERE user_id=?',args:[actor.control.userId]})).rows[0];}
  return row;
 }
 async function changePreferences(actor,expected,patch){
  const state=await core.assertControl(actor.control),fields=Object.keys(patch);
  if(fields.some(k=>!['daily_enabled','weekly_enabled','topics_json','excluded_topics_json','coach_enabled','coach_topics_json','quiet_start','quiet_end'].includes(k)))fail('STAGE7_PREFERENCE_FIELDS');
  for(const key of ['topics_json','excluded_topics_json'])if(Object.hasOwn(patch,key)){const values=JSON.parse(patch[key]);if(!Array.isArray(values)||values.some(v=>!TOPICS.includes(v))||new Set(values).size!==values.length)fail('STAGE7_PREFERENCE_TOPICS');}
  if(Object.hasOwn(patch,'coach_topics_json')){const v=JSON.parse(patch.coach_topics_json);if(!Array.isArray(v)||v.some(x=>!COACH_TOPICS.includes(x))||new Set(v).size!==v.length)fail('STAGE7_PREFERENCE_TOPICS');}
  for(const key of ['quiet_start','quiet_end'])if(Object.hasOwn(patch,key))inCompanionQuietHours(core.now(),state.timezone,patch[key],patch[key]);
  for(const key of ['daily_enabled','weekly_enabled','coach_enabled'])if(Object.hasOwn(patch,key)&&![0,1].includes(patch[key]))fail('STAGE7_PREFERENCE_VALUE');
  const result=await client.execute({sql:`UPDATE journal_tracking_preferences SET ${fields.map(k=>`${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND lifecycle_generation=?`,args:[...fields.map(k=>patch[k]),timestamp(),actor.control.userId,expected.revision,state.lifecycle_generation]});
  if(result.rowsAffected!==1)fail('STAGE7_PREFERENCE_CONFLICT');return preferences(actor);
 }
 async function ownFacts(actor,range={}){
  return stores.withContext(actor.control.userId,{executionMode:'SHADOW'},context=>stores.journal.list(context,{limit:500,...range}));
 }
 async function card(actor,row){return interactions.render(actor,row,row.kind==='PREFERENCES'?await preferences(actor):null);}
 async function handle({text,chatId,user,callback=null,requestKey=null}){
  const command=typeof text==='string'&&/^\/journal(?:@[A-Za-z0-9_]+)?\s*$/i.test(text.trim());
  if(callback&&!isJournalCallback(callback.data))return null;
  if(!command&&!callback)return null;
  // Coach navigation never enters the lifestyle answer state machine.
  if(callback){const actor=await interactions.authenticate({user,chatId,callback,allowPendingPurge:true}),resolved=await interactions.resolve(actor,callback,{recovery:true});if(resolved?.row.kind==='COACH')return null;}
  if(callback){
   const pre=await transaction(async()=>{
    const actor=await interactions.authenticate({user,chatId,callback,allowPendingPurge:true});
    const resolved=await interactions.resolve(actor,callback,{recovery:true});
    return resolved&&resolved.row.logical_fact_id&&['confirm','undo','NOT_SURE','SKIPPED'].includes(resolved.action)?{actor,...resolved}:null;
   });
   if(pre){
    let missingResult=null;
    if(pre.action==='confirm'){if(!onAccept)fail('STAGE7_ACCEPT_ADAPTER_REQUIRED');await onAccept(pre.actor,pre.row,pre.receipt);}
    else{if(!onUndo)fail('STAGE7_UNDO_ADAPTER_REQUIRED');missingResult=await onUndo(pre.actor,pre.row,pre.receipt,['NOT_SURE','SKIPPED'].includes(pre.action)?{missingChoice:pre.action}:{});}
    return transaction(async()=>{
     const row=await interactions.read(user.id,missingResult?.interaction_id??pre.row.interaction_id);
     if(pre.action==='undo')return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))].removed,editMessageId:row.message_id,replyMarkup:{inline_keyboard:[]}};
     return card(pre.actor,row);
    });
   }
  }
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId,callback});
   if(command){
    const issued=await interactions.issue(actor,{...(requestKey?{semanticKey:core.keys.lookup(['stage7-command',user.id,requestKey])}:{}),targetDate:addDays(localDate(core.now(),actor.state.timezone),-1)});return card(actor,issued.row);
   }
   const resolved=await interactions.resolve(actor,callback);if(!resolved)return interactions.expired(actor);
   let {row,action}=resolved;
   if(action==='recent'){
    const locale=await db.getLocale(user.id),c=JOURNAL_COPY[presentationLocale(locale)],facts=await ownFacts(actor);
    // Only registered own entries have editable server handles. Never expose IDs.
    const recent=(await client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND category IS NOT NULL AND (state IN ('NOT_SURE','SKIPPED') OR kind='DAILY' AND state='ISSUED' AND expires_at>?) AND content_state='PRESENT' ORDER BY created_at DESC LIMIT 10",args:[user.id,timestamp()]})).rows;
    const buttons=[...facts.filter(f=>f.provenance_mode==='TRUSTED_REGISTRY').slice(0,10).map(f=>[{text:`✏️ ${f.health_date} · ${c.topics[TOPICS.indexOf(f.category)]}`,action:`fact:${f.logical_fact_id}`}]),...recent.map(r=>[{text:`✏️ ${r.target_date} · ${c.topics[TOPICS.indexOf(r.category)]}`,action:`open:${r.interaction_id}`}])];
    return renderCustom(actor,row,{text:facts.length?facts.slice(0,10).map(f=>`${f.health_date} · ${labelForCategory(f.category,presentationLocale(locale))} · ${f.exposure_state==='CONFIRMED_UNEXPOSED'?c.no:c.yes}`).join('\n'):c.empty,buttons});
   }
   if(action.startsWith('open:')||action.startsWith('fact:')){
    let fact=null;
    if(action.startsWith('fact:'))fact=await stores.withContext(user.id,{executionMode:'SHADOW'},async context=>(await stores.journal.read(context,action.slice(5)))?.row);
    const entry=action.startsWith('fact:')?fact:await interactions.read(user.id,action.slice(5));
    if(!readableRow(entry)||!TOPICS.includes(entry.category))return interactions.expired(actor);
    if(entry.logical_fact_id&&!fact)fact=await stores.withContext(user.id,{executionMode:'SHADOW'},async context=>(await stores.journal.read(context,entry.logical_fact_id))?.row);
    if(entry.logical_fact_id&&fact?.provenance_mode!=='TRUSTED_REGISTRY')return interactions.expired(actor);
    // A newly authenticated history view receives new capabilities. An old
    // card's authority is never refreshed. Its original health-day interval is
    // distinct from the current timezone used to fence these new callbacks.
    const recordedTimezone=fact?.recorded_timezone??JSON.parse(entry.diagnostics_json??'null')?.recordedTimezone??entry.timezone;
    const fresh=await interactions.issue(actor,{category:fact?.category??entry.category,targetDate:fact?.health_date??entry.target_date,recordedTimezone,
     diagnostics:fact?null:{retractInteractionId:JSON.parse(entry.diagnostics_json??'null')?.retractInteractionId??entry.interaction_id,
      answerAnchor:JSON.parse(entry.diagnostics_json??'null')?.answerAnchor??{id:entry.interaction_id,revision:entry.revision}}});
    await interactions.bind(actor,fresh.row.interaction_id,row.message_id);await interactions.update(actor,row,{});
    row=await interactions.update(actor,await interactions.read(user.id,fresh.row.interaction_id),{state:fact?'COMPLETED':entry.state,selected_choice:fact?.answer_polarity??entry.selected_choice,
     detail_choice:fact?fact.subtype?.replace(/^last_intake_/,'')??null:entry.detail_choice,note:fact?fact.note:entry.note,logical_fact_id:fact?.logical_fact_id??null,fact_revision:fact?.revision??null,answered_at:fact?.answered_at??entry.answered_at});
    if(fact)await interactions.link('quick_action_interactions',row,'JOURNAL_FACT',fact.privacy_artifact_id);
    else await interactions.link('quick_action_interactions',row,'quick_action_interactions',entry.privacy_artifact_id);
    return card(actor,row);
   }
   if(action==='skipToday'){
    const healthDay=localDate(core.now(),actor.state.timezone),dayKey=core.keys.lookup(['journal-day-v1',user.id,healthDay]);
    let day=(await client.execute({sql:'SELECT * FROM quick_action_interactions WHERE user_id=? AND day_key=?',args:[user.id,dayKey]})).rows[0];
    if(!day){day=(await interactions.issue(actor,{kind:'DAILY',semanticKey:core.keys.lookup(['daily-journal-v1',user.id,healthDay,DAILY_POLICY_VERSION]),dayKey,targetDate:addDays(healthDay,-1),reason:'USER_SKIP'})).row;}
    if(day.state!=='COMPLETED')await interactions.update(actor,day,{state:'SKIPPED',selected_choice:'SKIPPED',answered_at:timestamp()});
    return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))].skipToday,editMessageId:row.message_id,replyMarkup:{inline_keyboard:[]}};
   }
   if(action==='weekly')return onWeekly?{...await onWeekly(actor),editMessageId:row.message_id,replyMarkup:{inline_keyboard:[]}}:interactions.expired(actor);
   if(action==='preferences'){
    const issued=await interactions.issue(actor,{kind:'PREFERENCES'});await interactions.bind(actor,issued.row.interaction_id,row.message_id);return card(actor,await interactions.read(user.id,issued.row.interaction_id));
   }
   if(row.kind==='PREFERENCES'){
    const prefs=await preferences(actor);let patch;
    if(action!=='cancel'){
     const parts=action.split(':'),kind=parts[1],value=Number(parts.at(-2)),revision=Number(parts.at(-1));
     if(parts[0]!=='prefs'||![0,1].includes(value)||!Number.isSafeInteger(revision)||revision!==prefs.revision)return interactions.expired(actor);
     if(parts.length===4&&['daily','weekly','coach'].includes(kind))patch={[`${kind}_enabled`]:value};
     else if(parts.length===5&&kind==='coachTopic'&&COACH_TOPICS.includes(parts[2])){const values=new Set(JSON.parse(prefs.coach_topics_json??'[]'));value?values.add(parts[2]):values.delete(parts[2]);patch={coach_topics_json:JSON.stringify([...values].sort())};}
     else if(parts.length===5&&kind==='quiet'&&['22-08','23-07','21-09'].includes(parts[2])){const [quiet_start,quiet_end]=parts[2].split('-').map(v=>v+':00');patch={quiet_start,quiet_end};}
     else if(parts.length===5&&['topic','exclude'].includes(kind)&&TOPICS.includes(parts[2])){
      const field=kind==='topic'?'topics_json':'excluded_topics_json',values=new Set(JSON.parse(prefs[field]));value?values.add(parts[2]):values.delete(parts[2]);patch={[field]:JSON.stringify([...values].sort())};
     }else return interactions.expired(actor);
    }
    if(patch){await changePreferences(actor,prefs,patch);row=await interactions.update(actor,row,{});return card(actor,row);}
   }
   if(action.startsWith('category:')&&row.category===null&&TOPICS.includes(action.slice(9))){
    const category=action.slice(9);row=await interactions.update(actor,row,{category,registry_id:registryQuestion(category),question_identity:registryQuestion(category),state:'ISSUED'});
   }else if(['YES','NO','NOT_SURE','SKIPPED'].includes(action)&&['ISSUED','EDITING'].includes(row.state)){
    if(['NOT_SURE','SKIPPED'].includes(action)){
     if(row.logical_fact_id)fail('STAGE7_RETRACT_BEFORE_UNCERTAINTY');
     row=await interactions.completeMissing(actor,row,action);
    }else row=await interactions.update(actor,row,{selected_choice:action,detail_choice:null,state:action==='YES'&&DETAILS[row.category]?'AWAITING_DETAIL':'CONFIRM'});
   }else if(row.state==='AWAITING_DETAIL'&&(action==='skipDetail'||DETAILS[row.category]?.includes(action.slice(7))&&action.startsWith('detail:'))){
    row=await interactions.update(actor,row,{detail_choice:action==='skipDetail'?null:action.slice(7),state:'CONFIRM'});
   }else if(action==='edit'&&['COMPLETED','NOT_SURE','SKIPPED'].includes(row.state)){
    const priorDiagnostics=JSON.parse(row.diagnostics_json??'null');
    const issued=await interactions.issue(actor,{category:row.category,targetDate:row.target_date,recordedTimezone:priorDiagnostics?.recordedTimezone??row.timezone,
     diagnostics:row.logical_fact_id?null:{retractInteractionId:priorDiagnostics?.retractInteractionId??priorDiagnostics?.answerAnchor?.id??row.interaction_id,
      answerAnchor:priorDiagnostics?.answerAnchor??{id:row.interaction_id,revision:row.revision+1}}});
    await interactions.bind(actor,issued.row.interaction_id,row.message_id);
    await interactions.update(actor,row,{});
    row=await interactions.update(actor,await interactions.read(user.id,issued.row.interaction_id),{state:'EDITING',logical_fact_id:row.logical_fact_id,fact_revision:row.fact_revision});
    if(row.logical_fact_id){const fact=await stores.withContext(user.id,{executionMode:'SHADOW'},async context=>(await stores.journal.read(context,row.logical_fact_id)).row);await interactions.link('quick_action_interactions',row,'JOURNAL_FACT',fact.privacy_artifact_id);}
    else await interactions.link('quick_action_interactions',row,'quick_action_interactions',resolved.row.privacy_artifact_id);
   }
   else if(action==='note'&&row.category!==null&&['ISSUED','EDITING','CONFIRM'].includes(row.state))row=await interactions.update(actor,row,{state:'NOTE'});
   else if(action==='confirm'&&row.state==='CONFIRM'){
    if(!onAccept)fail('STAGE7_ACCEPT_ADAPTER_REQUIRED');
    await onAccept(actor,row,resolved.receipt);row=await interactions.read(user.id,row.interaction_id);
   }else if(action==='undo'&&['COMPLETED','NOT_SURE','SKIPPED'].includes(row.state)){
    if(row.logical_fact_id&&!onUndo)fail('STAGE7_UNDO_ADAPTER_REQUIRED');
    if(onUndo)await onUndo(actor,row,resolved.receipt);row=await interactions.update(actor,await interactions.read(user.id,row.interaction_id),{state:'UNDONE',selected_choice:null,detail_choice:null,note:null});
   }else if(action==='back'){
    row=await interactions.update(actor,row,{state:row.state==='NOTE'&&['YES','NO'].includes(row.selected_choice)?'CONFIRM':'ISSUED',selected_choice:row.state==='NOTE'?row.selected_choice:null,detail_choice:null});
   }else if(action==='cancel')row=await interactions.update(actor,row,{state:'CANCELLED',selected_choice:null,detail_choice:null,note:null});
   else if(row.kind!=='PREFERENCES')return interactions.expired(actor);
   if(['CANCELLED','UNDONE'].includes(row.state))return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))][row.state==='UNDONE'?'removed':'cancelled'],editMessageId:row.message_id,replyMarkup:{inline_keyboard:[]}};
   return card(actor,row);
  });
 }
 async function renderCustom(actor,row,card){
  // Persist opaque actions exactly as normal card tokens, no client identities.
  const reply=await interactions.render(actor,row);reply.text=card.text;
  const markup=[];for(const buttons of card.buttons){const list=[];for(const b of buttons){list.push(await interactions.button(actor,row,b));}markup.push(list);}reply.replyMarkup={inline_keyboard:markup};reply.stage7View='RECENT';return reply;
 }
 async function handleNote({text,user,chatId}){
  if(typeof text!=='string'||text.trim().startsWith('/'))return null;
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId});
   if((await client.execute({sql:"SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN' UNION ALL SELECT 1 FROM phase4_question_interaction_slots WHERE user_id=? AND state IN ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')",args:[user.id,user.id]})).rows.length)return null;
   const rows=(await client.execute({sql:`SELECT q.* FROM quick_action_interactions q WHERE q.user_id=? AND q.chat_id=? AND q.expires_at>?
    AND (q.state='NOTE' OR q.state='ISSUED' AND q.selected_choice IS NULL AND q.message_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM journal_prompt_deliveries d WHERE d.user_id=q.user_id AND d.interaction_id=q.interaction_id AND d.state='DELIVERED'
        AND json_valid(d.schedule_json) AND json_extract(d.schedule_json,'$.source')='legacy-proactive-journal-v1'))
    ORDER BY q.created_at DESC LIMIT 2`,args:[user.id,String(chatId),timestamp()]})).rows;
   if(rows.length!==1)return null;const row=rows[0];
   // A direct answer may add context to the original dated question, but is
   // never parsed as a YES/NO fact. Unrelated questions keep normal routing.
   if(row.state==='ISSUED'&&(looksLikeQuestion(text)||/^(why|how|what|when|where|which|can|could|should|is|are|do|does)\b|^(tại sao|vì sao|thế nào|làm sao|khi nào|có phải)\b/iu.test(text.trim())))return null;
   if(!readableRow(row)||row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation||row.timezone!==actor.state.timezone||JSON.parse(row.diagnostics_json??'null')?.profileRevision!==actor.profileRevision)return null;
   let note;try{note=normalizeJournalNote(text);}catch{return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))].invalidNote};}
   return card(actor,await interactions.update(actor,row,{note,state:['YES','NO'].includes(row.selected_choice)?'CONFIRM':'ISSUED'}));
  });
 }
 async function prepareContextQuestion({user,chatId,healthDate}){
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId});
   if(!/^\d{4}-\d{2}-\d{2}$/.test(healthDate??''))return null;
   const targetDate=addDays(healthDate,-1);
   if(localMidnightUtc(addDays(targetDate,1),actor.state.timezone)>core.now())return null;
   if(await companionEngagementBusy({core,db,actor,includeConversation:false}))return null;
   const issued=await interactions.issue(actor,{targetDate,semanticKey:core.keys.lookup(['reactive-context-journal-v1',user.id,healthDate,localDate(core.now(),actor.state.timezone),actor.state.lifecycle_generation,actor.state.auth_generation,actor.profileRevision])});
   return card(actor,issued.row);
  });
 }
 async function prepareAfterBrief({user,chatId,healthDay,signal=null,metricSeries=[]}){
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId}),prefs=await preferences(actor);
   if(!prefs.daily_enabled)return {status:'DISABLED'};
   if(inCompanionQuietHours(core.now(),actor.state.timezone,prefs.quiet_start,prefs.quiet_end))return {status:'QUIET_HOURS'};
   if(actor.state.auth_generation<1)return {status:'AUTHORIZATION_FENCED'};
   if(healthDay!==localDate(core.now(),actor.state.timezone))return {status:'NOT_CURRENT_DAY'};
   const semantic=core.keys.lookup(['daily-journal-v1',user.id,healthDay,DAILY_POLICY_VERSION]);
   const dayKey=core.keys.lookup(['journal-day-v1',user.id,healthDay]);
   const priorDay=(await client.execute({sql:'SELECT interaction_id FROM quick_action_interactions WHERE user_id=? AND day_key=?',args:[user.id,dayKey]})).rows[0];
   if(priorDay){const existing=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND interaction_id=?',args:[user.id,priorDay.interaction_id]})).rows[0];return {status:'EXISTING',deliveryId:existing?.delivery_id??null};}
   const previous=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[user.id,semantic]})).rows[0];
   if(previous)return {status:'EXISTING',deliveryId:previous.delivery_id};
   // Retained daily barriers suppress duplicates even after source erasure.
   const proof=await confirmedMorningReceipt({core,actor,day:healthDay});
   if(!proof)return {status:'BRIEF_NOT_CONFIRMED'};
   const occasion=proof.sleepId?core.keys.lookup(['journal-wake-occasion-v1',user.id,proof.sleepId]):null;
   if(occasion){const existing=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND occasion_key=?',args:[user.id,occasion]})).rows[0];if(existing)return {status:'EXISTING',deliveryId:existing.delivery_id};}
   const pending=await companionEngagementBusy({core,db,actor});
   if(pending)return {status:'INTERACTION_BUSY'};
   const targetDate=addDays(healthDay,-1),facts=await ownFacts(actor,{fromDate:addDays(targetDate,-179),toDate:targetDate}),history=(await client.execute({sql:"SELECT privacy_artifact_id,category,target_date FROM quick_action_interactions WHERE user_id=? AND (kind='DAILY' OR json_extract(diagnostics_json,'$.dailyAnswerKey') IS NOT NULL AND state IN ('COMPLETED','NOT_SURE','SKIPPED')) AND content_state='PRESENT' ORDER BY created_at DESC LIMIT 60",args:[user.id]})).rows;
   if(facts.length===500)fail('STAGE7_DAILY_HISTORY_BOUNDS');
   // Use already-computed, receipt-verified current evidence. No WHOOP sync or
   // new physiological computation runs after the briefing. Explicit inputs are
   // internal synthetic/server composition only, never Telegram payloads.
   const contextSources=[];
   if(!signal)await stores.withContext(user.id,{executionMode:'SHADOW'},async context=>{
    const typed=await stores.betaSummary.readCurrent(context,{asOfUtc:timestamp()});
    for(const entry of [...typed.episodes].sort((a,b)=>b.severity-a.severity||a.metricKey.localeCompare(b.metricKey))){
     const episode=await stores.readArtifact(context,'observation_episodes',{episode_id:entry.resultId});
     const age=core.now().getTime()-Date.parse(episode.row.last_observed_at);
     if(age<0||age>48*3600000||entry.severity<2)continue;
     const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:episode.row.latest_evidence_item_id});
     if(!['LIMITED','AVAILABLE'].includes(item.row.quality))continue;
     signal={metric:entry.metricKey,level:entry.severity>=3?'STRONG':'NOTABLE',health_date:healthDay};
     contextSources.push(item.row.privacy_artifact_id);break;
    }
   });
   const selected=selectDailyQuestion({topics:TOPICS,trackingTopics:JSON.parse(prefs.topics_json),excludedTopics:JSON.parse(prefs.excluded_topics_json),history,knownFacts:facts,healthDay,targetDate,signal,metricSeries});
   if(!selected)return {status:'NO_APPROPRIATE_QUESTION'};
   const issued=await interactions.issue(actor,{kind:'DAILY',semanticKey:semantic,dayKey,category:selected.category,targetDate,reason:selected.reason,diagnostics:selected}),reply=await card(actor,issued.row),at=timestamp();
   // Every copied selection statistic is a descendant of all inputs, including
   // observations that suppressed an option. Deletion/correction scrubs it.
   for(const fact of facts)await interactions.link('quick_action_interactions',issued.row,'JOURNAL_FACT',fact.privacy_artifact_id);
   for(const previous of history)await interactions.link('quick_action_interactions',issued.row,'quick_action_interactions',previous.privacy_artifact_id);
   for(const id of contextSources)await interactions.link('quick_action_interactions',issued.row,'evidence_items',id);
   const delivery={user_id:user.id,delivery_id:core.newId(),interaction_id:issued.row.interaction_id,semantic_key:semantic,occasion_key:occasion,kind:'DAILY',execution_mode:'SHADOW',state:'PROPOSED',payload_json:JSON.stringify(reply),
    schedule_json:JSON.stringify({enrollment:await captureStage7Enrollment({core,db,actor})}),
    lifecycle_generation:actor.state.lifecycle_generation,auth_generation:actor.state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,created_at:at,updated_at:at,expires_at:issued.row.expires_at,...interactions.privacyFields(actor.state)};
   await interactions.insert('journal_prompt_deliveries',delivery);await interactions.link('journal_prompt_deliveries',delivery);
   await interactions.link('journal_prompt_deliveries',delivery,proof.reportType,proof.reportSource);
   await interactions.link('journal_prompt_deliveries',delivery,'quick_action_interactions',issued.row.privacy_artifact_id);
   return {status:'PROPOSED',deliveryId:delivery.delivery_id,interactionId:issued.row.interaction_id,selection:selected};
  });
 }
 return {handle,handleNote,prepareContextQuestion,prepareAfterBrief,preferences,changePreferences,interactions,ownFacts,card};
}
