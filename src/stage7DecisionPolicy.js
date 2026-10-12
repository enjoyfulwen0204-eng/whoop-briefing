import {DECISION_ACTIONS} from './phase4V24Schema.js';
import {PHASE4_METRICS} from './phase4IntelligenceRegistry.js';
export const DECISION_POLICY_VERSION='stage7-decision-v1';
export const QUESTION_UTILITY_VERSION='question_utility_v1';
export const COUNTERFACTUAL_VERSION='counterfactual_decision_impact_v1';
export const STAGE7_METRIC_POLICY=Object.freeze(Object.fromEntries(Object.keys(PHASE4_METRICS).map(metric=>[metric,Object.freeze({priority:'QUESTION',notificationAllowed:metric!=='body_energy',
 actionKey:metric==='body_energy'?null:['sleep_performance','sleep_duration_minutes','sleep_efficiency'].includes(metric)?'REVIEW_SLEEP_ROUTINE':'CONSIDER_LIGHTER_LOAD',
 notificationSeverity:3,interpretationVersion:'personal-baseline-wellness-v1'})])));
export function temporalRelevance(ageMs){return ageMs<0||!Number.isFinite(ageMs)?0:ageMs<=86400000?1:ageMs<=3*86400000?.75:ageMs<=7*86400000?.5:ageMs<=30*86400000?.25:0;}
const nonQuestionActions=['NO_NOTIFICATION','NOTIFY','DEFER_OBSERVATION'];
export function counterfactualDecisionImpact({YES,NO,UNKNOWN}){
 for(const branch of [YES,NO,UNKNOWN])if(!branch||!nonQuestionActions.includes(branch.action)||!['INELIGIBLE','CANDIDATE','REPEATED','INSIGHT_SUPPORTING'].includes(branch.evidence_eligibility)||!['EXPLAINED','UNEXPLAINED'].includes(branch.episode_explained_status))throw Error('STAGE7_BRANCH_SIGNATURE_REQUIRED');
 const differs=(a,b)=>a.evidence_eligibility!==b.evidence_eligibility||a.episode_explained_status!==b.episode_explained_status;
 if(YES.action!==NO.action)return 1;
 if(YES.action!==UNKNOWN.action)return .75;
 if(differs(YES,NO))return .5;
 if(differs(YES,UNKNOWN))return .25;
 return 0;
}
export function questionUtility(components){
 const names=['U','D','R','A','T','K','P','F'];
 if(!components||names.some(k=>!Number.isFinite(components[k])||components[k]<0||components[k]>1)||components.A===0)return null;
 const {U,D,R,A,T,K,P,F}=components;
 return Math.max(0,Math.min(1,.25*U+.30*D+.15*R+.15*A+.15*T-.20*K-.15*P-.10*F));
}
/** Pure, non-recursive leaf; receives only frozen data, has no store/LLM/IO. */
export function evaluateNonQuestion({valid,current,qualityReady,expectedMore,material,novel,actionable,truthful,timely,explained=false}){
 const action=!valid?'NO_NOTIFICATION':!current||!qualityReady?expectedMore?'DEFER_OBSERVATION':'NO_NOTIFICATION':
  material&&novel&&actionable&&truthful&&timely&&!explained?'NOTIFY':expectedMore&&!material?'DEFER_OBSERVATION':'NO_NOTIFICATION';
 return {action,evidence_eligibility:current&&qualityReady?'CANDIDATE':'INELIGIBLE',episode_explained_status:explained?'EXPLAINED':'UNEXPLAINED'};
}
export function stage7Decision({metric,gates,notification,candidates=[]}){
 const policy=STAGE7_METRIC_POLICY[metric];if(!policy)throw Error('STAGE7_METRIC_POLICY_REQUIRED');
 let action,reason,winner=null;
 if(gates.tenant!==true||gates.lifecycle!==true||gates.authorization!==true){action='NO_NOTIFICATION';reason='AUTHORITY_FENCED';}
 else if(gates.paused===true||gates.destination!==true){action='NO_NOTIFICATION';reason='DELIVERY_FENCED';}
 else if(gates.current!==true||gates.quality!==true||gates.confidence!==true||gates.freshness!==true){action=gates.expectedMore===true?'DEFER_OBSERVATION':'NO_NOTIFICATION';reason='EVIDENCE_NOT_READY';}
 else{
  const ranked=candidates.map(c=>({...c,utility:questionUtility(c.components)})).filter(c=>c.registered===true&&c.current===true&&c.known!==true&&c.open!==true&&c.utility!==null&&c.utility>=.60)
   .sort((a,b)=>b.utility-a.utility||b.components.D-a.components.D||b.components.U-a.components.U||a.sensitivity-b.sensitivity||a.key.localeCompare(b.key));
  winner=ranked[0]??null;
  const notify=policy.notificationAllowed&&['material','novel','actionable','truthful','timely','unreserved'].every(k=>notification[k]===true);
  if(notify&&(!winner||notification.delayReducesAction===true||winner.components.D<.75)){action='NOTIFY';reason='MATERIAL_NOVEL_ACTION';winner=null;}
  else if(winner){action='ASK_ONE_HIGHEST_VALUE_QUESTION';reason='HIGHEST_UTILITY';}
  else{action=gates.expectedMore===true?'DEFER_OBSERVATION':'NO_NOTIFICATION';reason='NO_USEFUL_ACTION';}
 }
 if(!DECISION_ACTIONS.includes(action))throw Error('STAGE7_EXHAUSTIVE_DECISION');
 return Object.freeze({action,reason,winner,policyVersion:DECISION_POLICY_VERSION});
}
