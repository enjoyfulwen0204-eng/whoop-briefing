import {TOPICS,JOURNAL_COPY,presentationLocale} from './stage7Registry.js';
import {completedWeeks} from './time.js';
import {t} from './localization.js';

export function summarizeJournalWeek({facts,history,topics,startDate,endDate,associations=[]}){
 const inRange=d=>typeof d==='string'&&d>=startDate&&d<=endDate;
 const current=facts.filter(f=>inRange(f.health_date)&&f.fact_status==='ACTIVE'&&f.content_state==='PRESENT');
 const dates=new Set(current.map(f=>f.health_date));
 const frequency=Object.fromEntries(TOPICS.map(category=>[category,new Set(current.filter(f=>f.category===category&&f.exposure_state==='EXPOSED').map(f=>f.health_date)).size]));
 const coverage=Object.fromEntries(topics.map(category=>[category,new Set(current.filter(f=>f.category===category&&['EXPOSED','CONFIRMED_UNEXPOSED'].includes(f.exposure_state)).map(f=>f.health_date)).size]));
 const asked=history.filter(h=>inRange(h.target_date)),responses={YES:0,NO:0,NOT_SURE:0,SKIPPED:0,NO_RESPONSE:0,NOT_ASKED:7-new Set(asked.map(h=>h.target_date)).size};
 for(const h of asked)responses[['YES','NO','NOT_SURE','SKIPPED'].includes(h.selected_choice)?h.selected_choice:'NO_RESPONSE']++;
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
   const state=await core.assertControl(actor.control),week=completedWeeks(core.now(),state.timezone).last,prefs=await companion.preferences(actor),facts=await companion.ownFacts(actor);
   if(facts.length===500)throw Error('STAGE7_WEEKLY_HISTORY_BOUNDS');
   const history=(await core.client.execute({sql:"SELECT target_date,selected_choice FROM quick_action_interactions WHERE user_id=? AND kind='DAILY' AND target_date>=? AND target_date<=? AND content_state='PRESENT'",args:[actor.control.userId,week.startDate,week.endDate]})).rows;
   const associations=[];
   await stores.withContext(actor.control.userId,{executionMode:'SHADOW'},async context=>{
    const typed=await stores.betaSummary.readCurrent(context,{asOfUtc:core.timestamp()});
    for(const insight of typed.insights.filter(i=>i.status==='SUPPORTED')){
     const verified=await stores.insights.read(context,insight.resultId,{asOfUtc:core.timestamp()});
     for(const id of JSON.parse(verified.revision.supporting_evidence_ids_json)){
      const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:id}),p=JSON.parse(item.row.provenance_json??'{}');
      if(TOPICS.includes(p.factor)&&p.method==='EXPOSED_VS_CONFIRMED_UNEXPOSED'&&item.row.causal_status==='ASSOCIATION_ONLY')associations.push({factor:p.factor,metric:p.outcome_metric,ref:item.ref});
     }
    }
   });
   const summary=summarizeJournalWeek({facts,history,topics:JSON.parse(prefs.topics_json),startDate:week.startDate,endDate:week.endDate,associations});
   return {...renderJournalWeek(summary,await db.getLocale(actor.control.userId)),sourceFactIds:facts.filter(f=>f.health_date>=week.startDate&&f.health_date<=week.endDate).map(f=>f.privacy_artifact_id)};
  });
 }
 async function prepare(actor,{automatic=false}={}){
  if(automatic)return {status:'ROLLOUT_NOT_APPROVED'};
  return core.transaction(async()=>{
   const state=await core.assertControl(actor.control),prefs=await companion.preferences(actor),result=await build(actor);
   const semantic=core.keys.lookup(['weekly-journal-v1',actor.control.userId,result.summary.startDate,'weekly-review-v1']);
   let row=(await core.client.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[actor.control.userId,semantic]})).rows[0];
   if(!row){
    const at=core.timestamp();row={user_id:actor.control.userId,delivery_id:core.newId(),semantic_key:semantic,kind:'WEEKLY',execution_mode:'SHADOW',state:'PROPOSED',payload_json:JSON.stringify({text:result.text}),
     lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,created_at:at,updated_at:at,expires_at:new Date(core.now().getTime()+7*86400000).toISOString(),...companion.interactions.privacyFields(state)};
    await companion.interactions.insert('journal_prompt_deliveries',row);await companion.interactions.link('journal_prompt_deliveries',row);
    for(const id of result.sourceFactIds)await companion.interactions.link('journal_prompt_deliveries',row,'JOURNAL_FACT',id);
   }
   return {text:result.text,deliveryId:row.delivery_id,summary:result.summary};
  });
 }
 return {build,prepare};
}
