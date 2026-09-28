import { canonicalInstant } from './phase4Time.js';
import { normalizeInsightIdentity } from './phase4InsightStore.js';
import { normalizeBodyEnergyRequest } from './bodyEnergyStore.js';

// Paths belong to an operation's domain contract. JSON payloads inherit no
// meaning from property names; all undeclared arrays preserve their order.
const sets={
  analyzeMetric:['baselineSources'],
  analyzeAssociationFamily:['hypotheses','hypotheses/*/outcomeSources','hypotheses/*/journalFactSources',
    'hypotheses/*/coverageSources','hypotheses/*/comparisonHealthDates'],
  EPISODE_REVISE:['sourceRefs'], EPISODE_REVERSE:['prior/sourceRefs'],
  INSIGHT_CREATE:['supportingEvidenceIds'], INSIGHT_TRANSITION:['supportingEvidenceIds','contradictingEvidenceIds'],
};
const episodeTimes=['opened_at','resolved_at','expires_at','last_observed_at','first_observed_at',
  'last_material_change_at','stabilization_started_at','window_start_utc','window_end_utc'];
const timePaths={
  analyzeMetric:['asOfUtc'], analyzeAssociationFamily:['asOfUtc'],
  explainEpisode:['asOfUtc'], expireEpisode:['asOfUtc'], expireInsight:['asOfUtc'],
  INSIGHT_CREATE:['semanticAt','expiresAt'], INSIGHT_TRANSITION:['semanticAt','expiresAt'],
  EPISODE_OPEN:['semanticAt',...episodeTimes.map(key=>`data/${key}`)],
  EPISODE_REVISE:['semanticAt','patch/last_observed_at'],
  EPISODE_REFRESH:['semanticAt',...episodeTimes.map(key=>`projection/${key}`)],
  EPISODE_REVERSE:['semanticAt','prior/semanticAt','prior/patch/last_observed_at','opposite/semanticAt',
    ...episodeTimes.map(key=>`opposite/data/${key}`)],
};
export const isRequestSet=(kind,path)=>(sets[kind]??[]).includes(path);
export const isRequestTime=(kind,path)=>(timePaths[kind]??[]).includes(path);
export const isJournalRequestSet=(kind,path)=>kind==='analyzeAssociationFamily'
  && ['hypotheses/*/journalFactSources','hypotheses/*/coverageSources'].includes(path);
export function normalizeRequestAliases(kind,request) {
  if(kind==='INSIGHT_CREATE')return {...request,identity:normalizeInsightIdentity(request.identity)};
  if(kind==='BODY_ENERGY_COMPUTE')return normalizeBodyEnergyRequest({...request,
    ...(request.asOfUtc==null?{}:{asOfUtc:canonicalInstant(request.asOfUtc)})});
  return request;
}

// Evidence admission and dependency capture use the same domain boundary;
// evidence-like names in arbitrary explanation JSON are ordinary content.
export function requestEvidenceIds(kind,request) {
  const projection=value=>[value?.latest_evidence_item_id,value?.explanation_evidence_item_id];
  const episode=value=>[value?.evidenceItemId,...projection(value?.data),...projection(value?.patch),...projection(value?.projection)];
  const ids=kind==='INSIGHT_CREATE'?request.supportingEvidenceIds??[]
    :kind==='INSIGHT_TRANSITION'?[...(request.supportingEvidenceIds??[]),...(request.contradictingEvidenceIds??[])]
    :kind==='EPISODE_REVERSE'?[...episode(request.prior),...episode(request.opposite)]
    :kind?.startsWith('EPISODE_')?episode(request):[];
  return ids.filter(value=>value!==null&&value!==undefined);
}
