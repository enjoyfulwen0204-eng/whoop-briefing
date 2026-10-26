// Diagnostic-only call timing. Exact source anchors; no SQL, result or fence change.
let root;
export function initialize(data){root=data.root;}
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);if(!url.startsWith(root)||result.format!=='module')return result;
 let source=String(result.source);
 const replace=(before,after)=>{if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('RAW_REPLAY_PROFILE_SOURCE_MISMATCH');source=source.replace(before,after);};
 const measure=(phase,key,expression)=>`globalThis.__stage6RawReplayProfile.measure('${phase}',${key},()=>${expression})`;
 if(url===root+'phase4Reanalysis.js'){
  const raw='stores.intelligence.metricPreparationUnitFromCurrentRaw(context,metricKey,source)';replace(raw,measure('RAW_PREPARATION','metricKey',raw));
  const family='metricsV30(context,request,lease,assertBudget,{preparedDefault:[32,33,34,35].includes(core.schemaVersion)})';replace(family,measure('METRIC_FAMILIES','metricKey',family));
  const association='()=>associations(context,metricKey,analysisAsOf)';replace(association,'()=>'+measure('ASSOCIATIONS','metricKey','associations(context,metricKey,analysisAsOf)'));
 }
 if(url===root+'phase4IntelligenceStore.js'){
  replace('async function metricPreparation(context,request,currentBody=null) {',"async function metricPreparation(context,request,currentBody=null) {return globalThis.__stage6RawReplayProfile.measure('METRIC_PLAN',request.metricKey,async()=>{");
  replace('return {request,contract,sourceSet,baseline,quality,baseIdentity,priorQualifying,observationCalculation,plan};\n  }', 'return {request,contract,sourceSet,baseline,quality,baseIdentity,priorQualifying,observationCalculation,plan};\n  });}');
  const recorded='ownedPurpose?withOwnedBodyMetricObservations(core,context,ownedPurpose,\n          ()=>recordedMetricPreparation(context,request)):recordedMetricPreparation(context,request)';
  replace(recorded,measure('RECORDED_METRIC','request.metricKey','('+recorded+')'));
 }
 return {...result,source};
}
