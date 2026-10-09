import {currentDurableExecution} from './phase4ExecutionContext.js';
// Explicit semantic operation + immutable business facts. No SQL/table discovery.
// Only the keyed digest is persisted; arguments and health/token bytes never are.
const transient=new Set(['now','clock','owner']);
function invalidFacts(){const error=Object.assign(Error('EXECUTION_WORK_STEP_REQUIRED'),{code:'EXECUTION_WORK_STEP_REQUIRED'});
 const execution=currentDurableExecution();if(execution&&!execution.workRejected)execution.workRejected=error;throw error;}
function canonical(value){
 if(value===undefined)return null;
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!transient.has(k)).map(k=>[k,canonical(value[k])]));
 if(typeof value==='function'||typeof value==='symbol')invalidFacts();
 return value;
}
export function workStepOptions(kind,facts,{discardResult=false,replay}={}){
 const execution=currentDurableExecution();if(!execution||execution.receipts===false)return {};
 if(typeof kind!=='string'||!kind||facts===undefined)invalidFacts();
 return {workStep:execution.keys.lookup(['phase4-logical-work-v1',kind,canonical(facts)]),discardResult,...(replay?{replay}:{})};
}
// Explicit server API operations. A key includes the semantic arguments, not a
// callback's name or its SQL target. Unknown generic transactions remain closed.
export const EXECUTION_API_WORK=Object.freeze(`withAnswerOwnership processTelegramOperation mutateForWhoopEvent mutateForReconciliation releaseTelegramReply markDeliveryStarted markDelivered markDeliveryFailed markDeliveryAmbiguous markDeliverySuppressed setTelegramUpdateConversation abandonStaleConversationUpdates saveTokens recordRun claimReport renewClaim authorizeReportDelivery markClaimSent markClaimAmbiguous releaseClaim releaseClaimAfterFailedSend claimErrorNotify claimErrorNotifyOwned releaseErrorNotify clearErrorNotify recordBriefingEvaluation clearUserErrorNotify claimGlobalErrorNotify claimUserErrorNotify createUser transitionUserLifecycle updateUser linkTelegram claimTelegramChat retireUnsafeTelegramLinks revokeTelegramLink createLinkCode redeemLinkCode createOAuthState consumeOAuthState setLocale claimLocalePrompt releaseLocalePrompt upsertSleeps upsertRecoveries upsertCycles upsertWorkouts upsertBodyMeasurement relinkRecoveryDates saveSyncState saveCapabilities deleteWhoopResource recordWhoopEvent claimWhoopEvent settleWhoopEvent upsertTombstone recordTombstoneBlock claimReconciliation openPendingWindow settleReconciliation openReconciliationRun closeReconciliationRun recordDiscrepancy recordTombstoneVerdict setState setUpdateOffset claimTelegramUpdate markTelegramUpdateProcessing releaseTelegramUpdate completeTelegramUpdate abandonTelegramUpdate pruneTelegramUpdates addJournalEvent deleteJournalEvent openPendingQuestion resolvePendingQuestion cancelPendingQuestion expirePendingQuestion recordAiUsage saveHealthspanMetrics saveHealthspanSnapshot savePrediction recordPredictionActual savePredictionModel createInsight supersedeInsight reconfirmInsight updateInsightStatus createExperiment updateExperiment setProactiveState setProactiveEnabled claimProactiveEvent markProactiveEventSent releaseSuppressedProactiveEvent resolveProactiveEvent resolveProactiveEventIfUnresolved recordHeartbeat ensureOnboarding ensureOnboardingDerived ensureOnboardingDerivedForAll setOnboardingState setReadyIfEligible recordResourceAccess recordAuthLinkIssued resetAuthLinkBudget recordBootstrapAttempt resetBootstrapAttempts failBootstrapIfExhausted markAnalyticsDirty claimAnalyticsWork setAnalyticsRange advanceAnalyticsRange mutateForAnalytics settleAnalyticsWork releaseAnalyticsWork saveAnalyticsDailyState openAnalyticsRun closeAnalyticsRun`.split(' '));
const callbackApis=new Set(['withAnswerOwnership','processTelegramOperation','mutateForWhoopEvent','mutateForReconciliation','mutateForAnalytics']);
function callbackFacts(name,args){
 if(name==='withAnswerOwnership')return [args[0],args[1]?.eventId];
 if(name==='processTelegramOperation')return [args[0],args[1]?.ownerUserId,args[1]?.nonHealthOperation];
 if(name==='mutateForWhoopEvent')return [args[0]];
 if(!args[0]?.workIdentity)invalidFacts();
 return [args[0]];
}
export function bindExecutionApi(api,transaction){
 for(const name of EXECUTION_API_WORK){const operation=api[name];if(typeof operation!=='function')throw Error(`EXECUTION_API_CONTRACT_MISSING:${name}`);
  api[name]=(...args)=>{
   const execution=currentDurableExecution();if(!execution||execution.receipts===false)return operation.apply(api,args);
   if(name==='claimWhoopEvent'){
    const values=[{...args[0],now:args[0]?.now??new Date()}],o=values[0],now=o.now.toISOString();
    return transaction(()=>operation.apply(api,values),{discardResult:true,workStepFrom:async client=>{
      const row=(await client.execute({sql:`SELECT id,attempt_count FROM whoop_webhook_events
        WHERE (state='RECEIVED' OR (state='RETRY' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
          OR (state='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?))
         AND attempt_count<? ORDER BY id LIMIT 1`,args:[now,now,Number.isFinite(o.maxAttempts)?o.maxAttempts:Number.MAX_SAFE_INTEGER]})).rows[0];
      return row?workStepOptions('whoop.event-claim',[row.id,row.attempt_count+1]).workStep:null;
    }});
   }
   // Lease grants belong to their actual owner. Business mutation receipts
   // intentionally omit transient owners; reusing that identity for a grant
   // would return an old `true` without acquiring the successor's lease.
   const ownerBound=new Set(['claimReconciliation','claimAnalyticsWork','openReconciliationRun','settleReconciliation','settleAnalyticsWork','releaseAnalyticsWork']);
   const facts=ownerBound.has(name)?[args,String(args[0]?.owner??'')]:callbackApis.has(name)?callbackFacts(name,args):args;
   const grants=new Set(['claimReport','claimLocalePrompt','claimErrorNotify','claimErrorNotifyOwned','claimGlobalErrorNotify','claimUserErrorNotify','authorizeReportDelivery']);
   return transaction(()=>operation.apply(api,args),workStepOptions(`api:${name}`,facts,{discardResult:true,
     ...(name==='claimReconciliation'?{replay:async()=>{
       await api.assertAccountActive(args[0].userId,args[0].lifecycleGeneration);
       return api.holdsReconciliation({...args[0],now:new Date()});
     }}:{}),
     ...(grants.has(name)?{replay:()=>name==='claimReport'?{claimed:false}:false}:{})}));
  };
 }
 return api;
}
