import {buildNotifyMessage} from './proactiveMessages.js';
import {buildQuestionText} from './questionEngine.js';
import {presentationLocale,JOURNAL_COPY} from './stage7Registry.js';
import {validateEvidenceConfidence} from './phase4Intelligence.js';
import {createPhase4EntityStore} from './phase4EntityStore.js';
import {stage7Decision,STAGE7_METRIC_POLICY,temporalRelevance,DECISION_POLICY_VERSION,COUNTERFACTUAL_VERSION,QUESTION_UTILITY_VERSION,counterfactualDecisionImpact,evaluateNonQuestion} from './stage7DecisionPolicy.js';
import {addPrivacyLink} from './phase4V22Backfill.js';
import {PHASE4_METRICS,INTELLIGENCE_VERSIONS} from './phase4IntelligenceRegistry.js';
import {TOPICS,registryQuestion} from './stage7Registry.js';
import {localDate,addDays,localMidnightUtc} from './time.js';
import {fail} from './phase4Core.js';

/** New Phase 4 decision path; does not invoke legacy cap/downgrade policy. */
export function createStage7DecisionStore({core,stores}){
 const entities=createPhase4EntityStore(core);
 async function evaluate(context,{episodeId,semanticEventId,triggerKey}){
  if(context.executionMode!=='SHADOW'||![33,34].includes(core.schemaVersion))fail('STAGE7_SHADOW_DECISION_REQUIRED');
  if(typeof triggerKey!=='string'||!triggerKey||triggerKey.length>128)fail('STAGE7_TRIGGER_REQUIRED');
  return core.run(context,async()=>{
   const key=core.keys.lookup(['stage7-decision',context.userId,context.executionMode,semanticEventId,triggerKey]);
   const replay=(await core.client.execute({sql:'SELECT decision_id FROM phase4_proactive_decisions WHERE user_id=? AND execution_mode=? AND deterministic_decision_key=?',args:[context.userId,context.executionMode,key]})).rows[0];
   if(replay)return {...await core.artifact(context,'phase4_proactive_decisions',{decision_id:replay.decision_id}),created:false};
   const episode=await stores.readArtifact(context,'observation_episodes',{episode_id:episodeId}),event=await stores.readArtifact(context,'episode_semantic_events',{episode_semantic_event_id:semanticEventId});
   if(event.row.episode_id!==episodeId||event.row.resulting_revision!==episode.row.revision||!Object.hasOwn(PHASE4_METRICS,episode.row.subject_key))fail('STAGE7_EPISODE_EVENT_MISMATCH');
   const evidence=await stores.readArtifact(context,'evidence_items',{evidence_item_id:episode.row.latest_evidence_item_id});
   const {state,computation}=await core.assertContext(context),at=core.timestamp(),metric=episode.row.subject_key;
   const prefs=(await core.client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[context.userId]})).rows[0];
   const onboarding=(await core.client.execute({sql:'SELECT state FROM user_onboarding WHERE user_id=?',args:[context.userId]})).rows[0];
   const destination=(await core.client.execute({sql:"SELECT 1 FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[context.userId]})).rows.length===1;
   const reservation=(await core.client.execute({sql:"SELECT 1 FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode=? AND message_family='EPISODE_NOTIFICATION' AND episode_semantic_event_id=?",args:[context.userId,context.executionMode,semanticEventId]})).rows.length;
   let confidence=0;try{const c=JSON.parse(evidence.row.provenance_json??'{}').confidence;validateEvidenceConfidence(c);confidence=c.score;}catch{/* missing authority is not favorable */}
   const age=core.now().getTime()-Date.parse(episode.row.last_observed_at);
   const invalidations=(await core.client.execute({sql:"SELECT 1 FROM phase4_invalidations WHERE user_id=? AND execution_mode=? AND scope_kind<>'NONE'",args:[context.userId,context.executionMode]})).rows.length;
   const gates={tenant:true,lifecycle:state.status==='ACTIVE'&&onboarding?.state==='READY',authorization:state.auth_generation>0,paused:!prefs||Boolean(prefs.notifications_paused),destination,
    current:computation.last_completed_generation===context.inputGeneration&&!invalidations,quality:['LIMITED','AVAILABLE'].includes(evidence.row.quality),confidence:confidence>=.5,freshness:episode.row.expires_at>at&&age>=0&&age<=PHASE4_METRICS[metric].stalenessLimitMs,expectedMore:true};
   const policy=STAGE7_METRIC_POLICY[metric],polarity=PHASE4_METRICS[metric].polarity,
    concerning=polarity==='HIGHER_IS_BETTER'?episode.row.direction==='LOWER':polarity==='LOWER_IS_BETTER'?episode.row.direction==='HIGHER':polarity==='CONTEXT_DEPENDENT'?episode.row.direction==='HIGHER':true,
    timely=concerning&&(episode.row.severity>=policy.notificationSeverity||episode.row.state==='ESCALATED');
   const notification={material:['OPENED','ESCALATED','EXPLAINED','MATERIAL_ESCALATION'].includes(event.row.event_kind),novel:!reservation,unreserved:!reservation,
    actionable:policy.notificationAllowed&&Boolean(policy.actionKey),truthful:gates.quality&&gates.confidence,timely,delayReducesAction:timely};
   const targetDate=addDays(localDate(new Date(episode.row.last_observed_at),context.timezone),-1),facts=await stores.journal.list(context,{limit:500});
   if(facts.length===500)fail('STAGE7_DECISION_HISTORY_BOUNDS');
   const sourceRefs=[evidence.ref,event.ref,episode.ref];
   for(const fact of facts)sourceRefs.push((await stores.root(context,'JOURNAL_FACT',fact.privacy_artifact_id)).ref);
   const start=localMidnightUtc(targetDate,context.timezone).toISOString(),end=localMidnightUtc(addDays(targetDate,1),context.timezone).toISOString(),coverage=[];
   const coverageIds=(await core.client.execute({sql:"SELECT coverage_window_id FROM journal_coverage_windows WHERE user_id=? AND status='ACTIVE' AND content_state='PRESENT' AND window_start_utc<? AND window_end_utc>? LIMIT 501",args:[context.userId,end,start]})).rows;
   if(coverageIds.length>500)fail('STAGE7_DECISION_HISTORY_BOUNDS');
   for(const {coverage_window_id:id} of coverageIds){const value=await stores.root(context,'JOURNAL_COVERAGE',id);coverage.push(value.row);sourceRefs.push(value.ref);}
   const slot=(await core.client.execute({sql:'SELECT * FROM phase4_question_interaction_slots WHERE user_id=? AND execution_mode=?',args:[context.userId,context.executionMode]})).rows[0];
   const past=(await core.client.execute({sql:"SELECT q.* FROM context_questions q WHERE user_id=? AND execution_mode=? AND content_state='PRESENT' AND created_at>? ORDER BY created_at LIMIT 1001",args:[context.userId,context.executionMode,new Date(core.now().getTime()-30*86400000).toISOString()]})).rows;
   if(past.length>1000)fail('STAGE7_DECISION_HISTORY_BOUNDS');
   const delivered=Number((await core.client.execute({sql:"SELECT count(*) n FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode=? AND message_family='CONTEXT_QUESTION' AND state='CONSUMED' AND consumed_at>?",args:[context.userId,context.executionMode,new Date(core.now().getTime()-7*86400000).toISOString()]})).rows[0].n);
   const associations=new Map(),typed=await stores.betaSummary.readCurrent(context,{asOfUtc:at});
   for(const insight of typed.insights.filter(i=>i.status==='SUPPORTED')){
    const current=await stores.insights.read(context,insight.resultId,{asOfUtc:at});
    for(const id of JSON.parse(current.revision.supporting_evidence_ids_json)){
     const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:id}),p=JSON.parse(item.row.provenance_json??'{}');
     if(p.outcome_metric===metric&&p.lag_days===1&&TOPICS.includes(p.factor)&&item.row.direction===episode.row.direction&&item.row.causal_status==='ASSOCIATION_ONLY'){
      associations.set(p.factor,{evidenceId:id});sourceRefs.push(item.ref,current.ref);
     }
    }
   }
   const candidates=TOPICS.map(category=>{
    const association=associations.get(category),base={...gates,expectedMore:Boolean(association)||!gates.current||!gates.quality||!gates.confidence||!gates.freshness,valid:true,qualityReady:gates.quality&&gates.confidence,...notification};
    const signatures={YES:evaluateNonQuestion({...base,explained:Boolean(association)}),NO:evaluateNonQuestion({...base,explained:false}),UNKNOWN:evaluateNonQuestion({...base,explained:false})};
    const categoryCoverage=coverage.filter(c=>JSON.parse(c.factor_keys_json).includes(category)),known=facts.some(f=>f.category===category&&f.health_date===targetDate)||categoryCoverage.some(c=>c.window_start_utc<=start&&c.window_end_utc>=end),
     partial=!known&&(facts.some(f=>f.category===category&&f.event_at<end&&f.event_end_at>start)||categoryCoverage.length>0);
    const categoryPast=past.filter(q=>q.factor_question_kind===category),sameAnswered=categoryPast.some(q=>q.status==='RESOLVED'&&q.target_window_start_utc===localMidnightUtc(targetDate,context.timezone).toISOString()),recentCategory=categoryPast.some(q=>Date.parse(q.created_at)>core.now().getTime()-14*86400000);
    return {key:registryQuestion(category),category,registered:true,current:gates.current,known,
     open:['RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER'].includes(slot?.state)||categoryPast.some(q=>q.target_window_start_utc===start&&q.target_window_end_utc===end),sensitivity:0,
     components:{U:known||!association?0:1,D:counterfactualDecisionImpact(signatures),R:association?1:0,A:1,T:temporalRelevance(core.now().getTime()-Date.parse(episode.row.last_material_change_at)),K:known?1:partial?.5:0,P:sameAnswered?1:recentCategory?.5:0,F:Math.min(1,delivered/3)},
     sourceVersions:{context:'journal-taxonomy-v1',gap:'supported-association-factor-gap-v1',episode:INTELLIGENCE_VERSIONS.algorithm,history:'question-slot-v1',fatigue:'semantic-reservation-v1',template:'journal-buttons-v1',temporal:'last-material-change-v1',association:association?.evidenceId??'CONFIRMED_ABSENT'},signatures};
   });
   gates.expectedMore=!gates.current||!gates.quality||!gates.confidence||!gates.freshness||candidates.some(c=>c.components.U>0&&!c.known);
   const selected=stage7Decision({metric,gates,notification,candidates});
   const decision={deterministic_decision_key:key,policy_version:DECISION_POLICY_VERSION,metric_registry_version:INTELLIGENCE_VERSIONS.registry,
    evidence_version:INTELLIGENCE_VERSIONS.evidenceContract,template_version:'journal-buttons-v1',gate_results_json:gates,candidate_diagnostics_json:candidates,
    branch_signatures_json:candidates.map(c=>({key:c.key,signatures:c.signatures})),counterfactual_evaluator_version:COUNTERFACTUAL_VERSION,decision_reason:selected.reason,expires_at:episode.row.expires_at,episode_semantic_event_id:semanticEventId};
   async function linkHistory(result){
    const descendants=[['phase4_proactive_decisions',(await core.client.execute({sql:'SELECT privacy_artifact_id FROM phase4_proactive_decisions WHERE user_id=? AND execution_mode=? AND decision_id=?',args:[context.userId,context.executionMode,result.decisionId??result.row.decision_id]})).rows[0]]];
    if(result.questionRequestId)descendants.push(['context_questions',(await core.client.execute({sql:'SELECT privacy_artifact_id FROM context_questions WHERE user_id=? AND execution_mode=? AND question_request_id=?',args:[context.userId,context.executionMode,result.questionRequestId]})).rows[0]]);
    for(const q of past)for(const [table,row] of descendants)await addPrivacyLink(core.client,{userId:context.userId,mode:context.executionMode,table,artifactId:row.privacy_artifact_id,sourceType:'context_questions',sourceId:q.privacy_artifact_id,sourceMode:context.executionMode,at});
    return result;
   }
   if(selected.action==='ASK_ONE_HIGHEST_VALUE_QUESTION'){
    const category=selected.winner.category;
    const result=await stores.slots.acquire(context,{question:{episode_id:episodeId,episode_revision:episode.row.revision,factor_question_kind:category,
      target_window_start_utc:localMidnightUtc(targetDate,context.timezone).toISOString(),target_window_end_utc:localMidnightUtc(addDays(targetDate,1),context.timezone).toISOString(),
      question_template_version:'journal-factor-v1',policy_version:DECISION_POLICY_VERSION,question_utility_version:QUESTION_UTILITY_VERSION,counterfactual_evaluator_version:COUNTERFACTUAL_VERSION,
      utility_score:selected.winner.utility,eligibility_threshold:.6,...selected.winner.components},decision:{...decision,selected_question_key:selected.winner.key},expectedRevision:slot?.revision??0,sourceRefs});
    if(!result.decisionId)fail('STAGE7_QUESTION_SEMANTIC_RESERVED');
    return linkHistory({...await core.artifact(context,'phase4_proactive_decisions',{decision_id:result.decisionId}),...result,action:selected.action});
   }
   return linkHistory(await entities.append(context,'phase4_proactive_decisions',{...decision,action:selected.action,episode_id:episodeId,episode_revision:episode.row.revision},sourceRefs));
  });
 }
 async function propose(context,{decisionId}){
  return core.run(context,async()=>{
   const decision=await core.artifact(context,'phase4_proactive_decisions',{decision_id:decisionId});
   if(decision.row.policy_version!==DECISION_POLICY_VERSION||!['NOTIFY','ASK_ONE_HIGHEST_VALUE_QUESTION'].includes(decision.row.action))fail('STAGE7_DECISION_CANNOT_PROPOSE');
   const episode=await stores.readArtifact(context,'observation_episodes',{episode_id:decision.row.episode_id});
   const locale=presentationLocale((await core.client.execute({sql:'SELECT locale FROM user_locales WHERE user_id=?',args:[context.userId]})).rows[0]?.locale);
   const metric={recovery_score:'recovery',sleep_debt_minutes:'sleep_debt',cycle_strain:'previous_day_strain'}[episode.row.subject_key]??episode.row.subject_key;
   const signal={metric,direction:episode.row.direction==='LOWER'?'low':'high',level:episode.row.severity>=3?'STRONG':'NOTABLE'};
   let semantic,payload,questionId=null;
   if(decision.row.action==='NOTIFY'){
    semantic={family:'EPISODE_NOTIFICATION',identity:decision.row.episode_semantic_event_id};payload=buildNotifyMessage(signal,locale);
   }else{
    questionId=decision.row.question_request_id;
    const question=await core.artifact(context,'context_questions',{question_request_id:questionId});
    semantic={family:'CONTEXT_QUESTION',identity:questionId};
    payload=buildQuestionText({category:question.row.factor_question_kind,signal,locale});
    payload+=`\n🗓 ${JOURNAL_COPY[locale].target}: ${localDate(new Date(question.row.target_window_start_utc),context.timezone)}`;
   }
   const proposal=await stores.messages.propose(context,{semantic,message:{decision_id:decisionId,episode_id:decision.row.episode_id,
    ...(questionId?{question_request_id:questionId}:{episode_semantic_event_id:decision.row.episode_semantic_event_id}),payload_text:payload,payload_json:{locale,template:'stage7-registered-proposal-v1'},expires_at:decision.row.expires_at},sourceRefs:[decision.ref,episode.ref]});
   if(questionId&&proposal.row)await stores.slots.bindProposal(context,{questionRequestId:questionId,messageId:proposal.row.message_id});
   return proposal;
  });
 }
 return {evaluate,propose};
}
