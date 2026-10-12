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
  if(fields.some(k=>!['daily_enabled','weekly_enabled','topics_json','excluded_topics_json'].includes(k)))fail('STAGE7_PREFERENCE_FIELDS');
  for(const key of ['topics_json','excluded_topics_json'])if(Object.hasOwn(patch,key)){const values=JSON.parse(patch[key]);if(!Array.isArray(values)||values.some(v=>!TOPICS.includes(v))||new Set(values).size!==values.length)fail('STAGE7_PREFERENCE_TOPICS');}
  for(const key of ['daily_enabled','weekly_enabled'])if(Object.hasOwn(patch,key)&&![0,1].includes(patch[key]))fail('STAGE7_PREFERENCE_VALUE');
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
  if(callback){
   const pre=await transaction(async()=>{
    const actor=await interactions.authenticate({user,chatId,callback,allowPendingPurge:true});
    const resolved=await interactions.resolve(actor,callback,{recovery:true});
    return resolved&&resolved.row.logical_fact_id&&['confirm','undo','NOT_SURE','SKIPPED'].includes(resolved.action)?{actor,...resolved}:null;
   });
   if(pre){
    if(pre.action==='confirm'){if(!onAccept)fail('STAGE7_ACCEPT_ADAPTER_REQUIRED');await onAccept(pre.actor,pre.row,pre.receipt);}
    else{if(!onUndo)fail('STAGE7_UNDO_ADAPTER_REQUIRED');await onUndo(pre.actor,pre.row,pre.receipt);}
    return transaction(async()=>{
     let row=await interactions.read(user.id,pre.row.interaction_id);
     if(pre.action==='undo')return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))].removed,editMessageId:row.message_id,replyMarkup:{inline_keyboard:[]}};
     if(['NOT_SURE','SKIPPED'].includes(pre.action)){row=await interactions.update(pre.actor,row,{state:pre.action,selected_choice:pre.action,logical_fact_id:null,fact_revision:null,answered_at:timestamp()});}
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
    const recent=(await client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND state IN ('COMPLETED','NOT_SURE','SKIPPED') AND content_state='PRESENT' ORDER BY created_at DESC LIMIT 10",args:[user.id]})).rows;
    const buttons=recent.map(r=>[{text:`✏️ ${r.target_date} · ${c.topics[TOPICS.indexOf(r.category)]}`,action:`open:${r.interaction_id}`}]);
    return renderCustom(actor,row,{text:facts.length?facts.slice(0,10).map(f=>`${f.health_date} · ${labelForCategory(f.category,presentationLocale(locale))} · ${f.exposure_state==='CONFIRMED_UNEXPOSED'?c.no:c.yes}`).join('\n'):c.empty,buttons});
   }
   if(action.startsWith('open:')){
    const entry=await interactions.read(user.id,action.slice(5));
    if(!readableRow(entry)||entry.lifecycle_generation!==actor.state.lifecycle_generation||entry.auth_generation!==actor.state.auth_generation||entry.timezone!==actor.state.timezone)return interactions.expired(actor);
    row=await interactions.update(actor,entry,{expires_at:new Date(core.now().getTime()+15*60000).toISOString()});return card(actor,row);
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
    if(action==='toggleDaily')patch={daily_enabled:prefs.daily_enabled?0:1};
    else if(action==='toggleWeekly')patch={weekly_enabled:prefs.weekly_enabled?0:1};
    else if(action.startsWith('topic:')&&TOPICS.includes(action.slice(6))){const values=new Set(JSON.parse(prefs.topics_json));const topic=action.slice(6);values.has(topic)?values.delete(topic):values.add(topic);patch={topics_json:JSON.stringify([...values].sort())};}
    else if(action.startsWith('exclude:')&&TOPICS.includes(action.slice(8))){const values=new Set(JSON.parse(prefs.excluded_topics_json));const topic=action.slice(8);values.has(topic)?values.delete(topic):values.add(topic);patch={excluded_topics_json:JSON.stringify([...values].sort())};}
    if(patch){await changePreferences(actor,prefs,patch);row=await interactions.update(actor,row,{});return card(actor,row);}
   }
   if(action.startsWith('category:')&&row.category===null&&TOPICS.includes(action.slice(9))){
    const category=action.slice(9);row=await interactions.update(actor,row,{category,registry_id:registryQuestion(category),question_identity:registryQuestion(category),state:'ISSUED'});
   }else if(['YES','NO','NOT_SURE','SKIPPED'].includes(action)&&['ISSUED','EDITING'].includes(row.state)){
    if(['NOT_SURE','SKIPPED'].includes(action)){
     if(row.logical_fact_id)fail('STAGE7_RETRACT_BEFORE_UNCERTAINTY');
     row=await interactions.update(actor,row,{state:action,selected_choice:action,answered_at:timestamp()});
    }else row=await interactions.update(actor,row,{selected_choice:action,detail_choice:null,state:action==='YES'&&DETAILS[row.category]?'AWAITING_DETAIL':'CONFIRM'});
   }else if(row.state==='AWAITING_DETAIL'&&(action==='skipDetail'||DETAILS[row.category]?.includes(action.slice(7))&&action.startsWith('detail:'))){
    row=await interactions.update(actor,row,{detail_choice:action==='skipDetail'?null:action.slice(7),state:'CONFIRM'});
   }else if(action==='edit'&&['COMPLETED','NOT_SURE','SKIPPED'].includes(row.state)){
    const issued=await interactions.issue(actor,{category:row.category,targetDate:row.target_date});
    await interactions.bind(actor,issued.row.interaction_id,row.message_id);
    await interactions.update(actor,row,{});
    row=await interactions.update(actor,await interactions.read(user.id,issued.row.interaction_id),{state:'EDITING',logical_fact_id:row.logical_fact_id,fact_revision:row.fact_revision});
   }
   else if(action==='note'&&row.state==='CONFIRM')row=await interactions.update(actor,row,{state:'NOTE'});
   else if(action==='confirm'&&row.state==='CONFIRM'){
    if(!onAccept)fail('STAGE7_ACCEPT_ADAPTER_REQUIRED');
    await onAccept(actor,row,resolved.receipt);row=await interactions.read(user.id,row.interaction_id);
   }else if(action==='undo'&&['COMPLETED','NOT_SURE','SKIPPED'].includes(row.state)){
    if(row.logical_fact_id&&!onUndo)fail('STAGE7_UNDO_ADAPTER_REQUIRED');
    if(onUndo)await onUndo(actor,row,resolved.receipt);row=await interactions.update(actor,await interactions.read(user.id,row.interaction_id),{state:'UNDONE',selected_choice:null,detail_choice:null,note:null});
   }else if(action==='back'){
    row=await interactions.update(actor,row,{state:row.state==='NOTE'?'CONFIRM':'ISSUED',selected_choice:row.state==='NOTE'?row.selected_choice:null,detail_choice:null});
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
   const rows=(await client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND chat_id=? AND state='NOTE' AND expires_at>? ORDER BY created_at DESC LIMIT 2",args:[user.id,String(chatId),timestamp()]})).rows;
   if(rows.length!==1)return null;const row=rows[0];
   if(!readableRow(row)||row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation||row.timezone!==actor.state.timezone)return null;
   let note;try{note=normalizeJournalNote(text);}catch{return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(user.id))].invalidNote};}
   return card(actor,await interactions.update(actor,row,{note,state:'CONFIRM'}));
  });
 }
 async function prepareAfterBrief({user,chatId,healthDay,signal=null,metricSeries=[]}){
  return transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId}),prefs=await preferences(actor);
   if(!prefs.daily_enabled)return {status:'DISABLED'};
   if(actor.state.auth_generation<1)return {status:'AUTHORIZATION_FENCED'};
   if(healthDay!==localDate(core.now(),actor.state.timezone))return {status:'NOT_CURRENT_DAY'};
   const proof=(await client.execute({sql:"SELECT * FROM report_claims WHERE user_id=? AND report_type='daily' AND local_date=? AND delivery_state='DELIVERED' AND telegram_message_id IS NOT NULL AND lifecycle_generation=?",args:[user.id,healthDay,actor.state.lifecycle_generation]})).rows[0];
   if(!proof)return {status:'BRIEF_NOT_CONFIRMED'};
   const semantic=core.keys.lookup(['daily-journal-v1',user.id,healthDay,DAILY_POLICY_VERSION]);
   const dayKey=core.keys.lookup(['journal-day-v1',user.id,healthDay]);
   const priorDay=(await client.execute({sql:'SELECT interaction_id FROM quick_action_interactions WHERE user_id=? AND day_key=?',args:[user.id,dayKey]})).rows[0];
   if(priorDay){const existing=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND interaction_id=?',args:[user.id,priorDay.interaction_id]})).rows[0];return {status:'EXISTING',deliveryId:existing?.delivery_id??null};}
   const previous=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[user.id,semantic]})).rows[0];
   if(previous)return {status:'EXISTING',deliveryId:previous.delivery_id};
   const pending=(await client.execute({sql:"SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN' UNION ALL SELECT 1 FROM phase4_question_interaction_slots WHERE user_id=? AND state IN ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')",args:[user.id,user.id]})).rows.length;
   if(pending)return {status:'INTERACTION_BUSY'};
   const targetDate=addDays(healthDay,-1),facts=await ownFacts(actor),history=(await client.execute({sql:"SELECT category,target_date FROM quick_action_interactions WHERE user_id=? AND kind='DAILY' AND content_state='PRESENT' ORDER BY created_at DESC LIMIT 60",args:[user.id]})).rows;
   const selected=selectDailyQuestion({topics:TOPICS,trackingTopics:JSON.parse(prefs.topics_json),excludedTopics:JSON.parse(prefs.excluded_topics_json),history,knownFacts:facts,healthDay,targetDate,signal,metricSeries});
   if(!selected)return {status:'NO_APPROPRIATE_QUESTION'};
   const issued=await interactions.issue(actor,{kind:'DAILY',semanticKey:semantic,dayKey,category:selected.category,targetDate,reason:selected.reason,diagnostics:selected}),reply=await card(actor,issued.row),at=timestamp();
   const delivery={user_id:user.id,delivery_id:core.newId(),interaction_id:issued.row.interaction_id,semantic_key:semantic,kind:'DAILY',execution_mode:'SHADOW',state:'PROPOSED',payload_json:JSON.stringify(reply),
    lifecycle_generation:actor.state.lifecycle_generation,auth_generation:actor.state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,created_at:at,updated_at:at,expires_at:issued.row.expires_at,...interactions.privacyFields(actor.state)};
   await interactions.insert('journal_prompt_deliveries',delivery);await interactions.link('journal_prompt_deliveries',delivery);
   await interactions.link('journal_prompt_deliveries',delivery,'quick_action_interactions',issued.row.privacy_artifact_id);
   return {status:'PROPOSED',deliveryId:delivery.delivery_id,interactionId:issued.row.interaction_id,selection:selected};
  });
 }
 return {handle,handleNote,prepareAfterBrief,preferences,changePreferences,interactions,ownFacts,card};
}
