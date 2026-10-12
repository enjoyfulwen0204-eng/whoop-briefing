import {buildNotifyMessage} from './proactiveMessages.js';
import {buildQuestionText} from './questionEngine.js';
import {presentationLocale} from './stage7Registry.js';
import {validateEvidenceConfidence} from './phase4Intelligence.js';
import {createPhase4EntityStore} from './phase4EntityStore.js';
import {stage7Decision,DECISION_POLICY_VERSION,COUNTERFACTUAL_VERSION,QUESTION_UTILITY_VERSION,counterfactualDecisionImpact,evaluateNonQuestion} from './stage7DecisionPolicy.js';
import {PHASE4_METRICS,INTELLIGENCE_VERSIONS} from './phase4IntelligenceRegistry.js';
import {TOPICS,registryQuestion} from './stage7Registry.js';
import {localDate,addDays,localMidnightUtc} from './time.js';
import {fail} from './phase4Core.js';

/** New Phase 4 decision path; does not invoke legacy cap/downgrade policy. */
export function createStage7DecisionStore({core,stores}){
 const entities=createPhase4EntityStore(core);
 async function evaluate(context,{episodeId,semanticEventId,triggerKey}){
  if(context.executionMode!=='SHADOW'||core.schemaVersion!==33)fail('STAGE7_SHADOW_DECISION_REQUIRED');
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
   const gates={tenant:true,lifecycle:state.status==='ACTIVE'&&onboarding?.state==='READY',authorization:state.auth_generation>0,paused:Boolean(prefs?.notifications_paused),destination,
    current:computation.last_completed_generation===context.inputGeneration,quality:['LIMITED','AVAILABLE'].includes(evidence.row.quality),confidence:confidence>=.5,freshness:episode.row.expires_at>at&&age>=0&&age<=PHASE4_METRICS[metric].stalenessLimitMs,expectedMore:true};
   const notification={material:['OPENED','ESCALATED','EXPLAINED','MATERIAL_ESCALATION'].includes(event.row.event_kind),novel:!reservation,unreserved:!reservation,
    actionable:Boolean(event.row.recommended_action_key),truthful:episode.row.explained_status==='EXPLAINED',timely:episode.row.state==='ESCALATED',delayReducesAction:episode.row.state==='ESCALATED'};
   const targetDate=addDays(localDate(new Date(episode.row.last_observed_at),context.timezone),-1),facts=await stores.journal.list(context,{limit:500});
   const slot=(await core.client.execute({sql:'SELECT * FROM phase4_question_interaction_slots WHERE user_id=? AND execution_mode=?',args:[context.userId,context.executionMode]})).rows[0];
   const past=(await core.client.execute({sql:'SELECT factor_question_kind,created_at FROM context_questions WHERE user_id=? AND execution_mode=? AND created_at>?',args:[context.userId,context.executionMode,new Date(core.now().getTime()-3*86400000).toISOString()]})).rows;
   const associations=new Map(),typed=await stores.betaSummary.readCurrent(context,{asOfUtc:at});
   for(const insight of typed.insights.filter(i=>i.status==='SUPPORTED')){
    const current=await stores.insights.read(context,insight.resultId,{asOfUtc:at});
    for(const id of JSON.parse(current.revision.supporting_evidence_ids_json)){
     const item=await stores.readArtifact(context,'evidence_items',{evidence_item_id:id}),p=JSON.parse(item.row.provenance_json??'{}');
     if(p.outcome_metric===metric&&TOPICS.includes(p.factor)&&item.row.causal_status==='ASSOCIATION_ONLY')associations.set(p.factor,{confidence:p.confidence.score,evidenceId:id});
    }
   }
   const candidates=TOPICS.map(category=>{
    const association=associations.get(category),base={...gates,valid:true,qualityReady:gates.quality&&gates.confidence,...notification};
    const signatures={YES:evaluateNonQuestion({...base,explained:Boolean(association)}),NO:evaluateNonQuestion({...base,explained:false}),UNKNOWN:evaluateNonQuestion({...base,explained:false})};
    const known=facts.some(f=>f.category===category&&f.health_date===targetDate);
    return {key:registryQuestion(category),category,registered:true,current:gates.current,known,
     open:['RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER'].includes(slot?.state)||past.some(q=>q.factor_question_kind===category),sensitivity:0,
     components:{U:known?0:1,D:counterfactualDecisionImpact(signatures),R:association?.confidence??0,A:1,T:.5,K:known?1:0,P:gates.paused?1:0,F:Math.min(1,past.length/3)},
     sourceVersions:{context:'journal-taxonomy-v1',episode:INTELLIGENCE_VERSIONS.algorithm,history:'question-slot-v1',template:'journal-buttons-v1',association:association?.evidenceId??'CONFIRMED_ABSENT'},signatures};
   });
   const selected=stage7Decision({metric,gates,notification,candidates});
   const decision={deterministic_decision_key:key,policy_version:DECISION_POLICY_VERSION,metric_registry_version:INTELLIGENCE_VERSIONS.registry,
    evidence_version:INTELLIGENCE_VERSIONS.evidenceContract,template_version:'journal-buttons-v1',gate_results_json:gates,candidate_diagnostics_json:candidates,
    branch_signatures_json:candidates.map(c=>({key:c.key,signatures:c.signatures})),counterfactual_evaluator_version:COUNTERFACTUAL_VERSION,decision_reason:selected.reason,expires_at:episode.row.expires_at};
   if(selected.action==='ASK_ONE_HIGHEST_VALUE_QUESTION'){
    const category=selected.winner.category;
    const result=await stores.slots.acquire(context,{question:{episode_id:episodeId,episode_revision:episode.row.revision,factor_question_kind:category,
      target_window_start_utc:localMidnightUtc(targetDate,context.timezone).toISOString(),target_window_end_utc:localMidnightUtc(addDays(targetDate,1),context.timezone).toISOString(),
      question_template_version:'journal-factor-v1',policy_version:DECISION_POLICY_VERSION,question_utility_version:QUESTION_UTILITY_VERSION,counterfactual_evaluator_version:COUNTERFACTUAL_VERSION,
      utility_score:selected.winner.utility,eligibility_threshold:.6,...selected.winner.components},decision,expectedRevision:slot?.revision??0,sourceRefs:[evidence.ref,event.ref,episode.ref]});
    return {...result,action:selected.action};
   }
   return entities.append(context,'phase4_proactive_decisions',{...decision,action:selected.action,episode_id:episodeId,episode_revision:episode.row.revision,episode_semantic_event_id:semanticEventId},[episode.ref,event.ref,evidence.ref]);
  });
 }
 async function propose(context,{decisionId}){
  return core.run(context,async()=>{
   const decision=await core.artifact(context,'phase4_proactive_decisions',{decision_id:decisionId});
   if(decision.row.policy_version!==DECISION_POLICY_VERSION||!['NOTIFY','ASK_ONE_HIGHEST_VALUE_QUESTION'].includes(decision.row.action))fail('STAGE7_DECISION_CANNOT_PROPOSE');
   const episode=await stores.readArtifact(context,'observation_episodes',{episode_id:decision.row.episode_id});
   const locale=presentationLocale((await core.client.execute({sql:'SELECT locale FROM user_locales WHERE user_id=?',args:[context.userId]})).rows[0]?.locale);
   const metric={recovery_score:'recovery',sleep_debt_minutes:'sleep_debt',cycle_strain:'previous_day_strain'}[episode.row.subject_key]??episode.row.subject_key;
   const signal={metric,direction:episode.row.direction==='LOWER'?'down':'up',level:episode.row.severity>=3?'STRONG':'NOTABLE'};
   let semantic,payload,questionId=null;
   if(decision.row.action==='NOTIFY'){
    semantic={family:'EPISODE_NOTIFICATION',identity:decision.row.episode_semantic_event_id};payload=buildNotifyMessage(signal,locale);
   }else{
    questionId=decision.row.question_request_id;
    const question=await core.artifact(context,'context_questions',{question_request_id:questionId});
    semantic={family:'CONTEXT_QUESTION',identity:questionId};payload=buildQuestionText({category:question.row.factor_question_kind,signal,locale});
   }
   return stores.messages.propose(context,{semantic,message:{decision_id:decisionId,episode_id:decision.row.episode_id,
    ...(questionId?{question_request_id:questionId}:{episode_semantic_event_id:decision.row.episode_semantic_event_id}),payload_text:payload,expires_at:decision.row.expires_at},sourceRefs:[decision.ref,episode.ref]});
  });
 }
 return {evaluate,propose};
}
