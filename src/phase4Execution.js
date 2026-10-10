import {discoverPhaseContinuation} from './phase4Continuation.js';
import { loadEnv } from './config.js';
import { createDb } from './db.js';
import { runBriefing } from './index.js';
import { publicBetaConfiguration, publicBetaKeys } from './publicBetaConfig.js';
import { authorizePublicBetaRuntime, createPublicBetaRuntime } from './publicBeta.js';
import { runPhase4Stage6 } from './shadowDrainScheduler.js';
import { deliverPublicBetaSummary } from './publicBetaSummaryDelivery.js';
import { createExecutionBudget, SYNC_BUDGET_MS, withExecutionBudget } from './executionBudget.js';
import { syncAuthorizesDrain } from './syncResult.js';
import {isContinuationRequest, validatePhaseRequest,validatePhaseBody,configurationProof,claimPhaseRequest,settlePhaseRequest,requireSyncHandoff,recordPhaseEvent,abortPhaseExecution,projectPhaseCompletion,noteIndeterminateExecution,observedPhaseWorkCommit,EXECUTION_WORK_MAX_AGE_MS,reconcileExecution,requestIdentity } from './phase4ExecutionStore.js';
import { log } from './logger.js';
import { runningReleaseSha, cliTriggerSource, isGitHubContext } from './phase4Release.js';
import {withDurableExecution,requireSettledOperation} from './phase4ExecutionContext.js';
import {executionProfile} from './phase4Rollback.js';
import { requireRuntimeAdmission, followRuntimeRenewal } from './runtimeAdmission.js';
export const ADMISSION_BUDGET_MS=30_000;
export const SYNC_SOURCE_BUDGETS=Object.freeze({cloudflare:120_000,github:SYNC_BUDGET_MS,manual:SYNC_BUDGET_MS,event:120_000});
export const DRAIN_SOURCE_BUDGETS=Object.freeze({cloudflare:45_000,github:90_000,manual:45_000,event:25_000});
export const PHASE_SETTLEMENT_MS=15_000;
export function phaseResponse(record) {
 const {startedAt,updatedAt,...publicRecord}=record;
 const complete=record.settlementState==='FINALIZED_SUCCESS'&&syncAuthorizesDrain(record);
 const ok=record.phase==='SYNC'?complete:record.settlementState==='FINALIZED_SUCCESS'&&['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED'].includes(record.outcome);
 const status=record.outcome==='COMMIT_INDETERMINATE'?503:record.continuationState==='STALE_REQUEST'?410:record.resumable===true?202:ok?200:record.outcome==='TIMEOUT'?504:record.outcome==='CANCELLED'?499:record.outcome==='PARTIAL'?207:424;
 return {status,body:{ok,phase:record.phase,source:record.source,result:publicRecord,
   ...(record.phase==='SYNC'?{syncComplete:complete,drainAuthorized:complete&&record.executionMode==='SHADOW'&&typeof record.handoff==='string',handoff:record.handoff}:{}),
   bodyEnergy:'NOT_AUTHORIZED_NOT_PRESENTED'}};
}
/** Both CLI jobs and signed HTTP phases share one admitted/fenced composition. */
export async function runExecutionPhase({request,body=JSON.stringify(request),now,environment=process.env,
 db:providedDb,keys:providedKeys,env:providedEnv,deps={},budgetMs,overallBudgetMs,signal}={}) {
 const phaseStartedAt=Date.now(),started=performance.now();
 if(Number(process.versions.node.split('.')[0])<22)throw new Error('NODE_22_REQUIRED');
 validatePhaseRequest(request);
 validatePhaseBody(request,body);
 const profile=executionProfile(environment);
 if(request.legacyBodyDigest&&profile!=='RC2_V32_ROLLBACK')throw Object.assign(Error('EXECUTION_REQUEST_INVALID'),{code:'EXECUTION_REQUEST_INVALID'});
 if(isGitHubContext(environment)&&request.triggerSource!==cliTriggerSource(environment))throw Object.assign(new Error('GITHUB_SOURCE_UNSUPPORTED'),{code:'GITHUB_SOURCE_UNSUPPORTED'});
 const config=publicBetaConfiguration(environment),keys=providedKeys??publicBetaKeys(environment),env=providedEnv??loadEnv();
 const releaseSha=runningReleaseSha(environment);
 if(request.releaseSha!==releaseSha)throw Object.assign(new Error('RELEASE_CHECKOUT_MISMATCH'),{code:'RELEASE_CHECKOUT_MISMATCH'});
 const proof=configurationProof(keys,config,environment,releaseSha),mode=config.runtime==='on'?'SHADOW':'OFF';
 if(request.configProof!==proof||request.executionMode!==mode)throw Object.assign(new Error('EXECUTION_CONFIG_CHANGED'),{code:'EXECUTION_CONFIG_CHANGED'});
 const db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 // The installed WebSocket driver can silently replace its private connection
 // after errors/age. A phase permits only the HTTP or file runtime boundary;
 // it cannot prove a no-reconnect lifetime for that WebSocket transport.
 if(db.raw?.protocol==='ws') {
   if(!providedDb)db.close();
   throw Object.assign(Error('PHASE_RUNTIME_TRANSPORT_UNSUPPORTED'),{code:'PHASE_RUNTIME_TRANSPORT_UNSUPPORTED'});
 }
 const sourceLimit=request.phase==='SYNC'?SYNC_SOURCE_BUDGETS[request.triggerSource]:DRAIN_SOURCE_BUDGETS[request.triggerSource];
 const limit=budgetMs??sourceLimit,wholeLimit=ADMISSION_BUDGET_MS+limit+PHASE_SETTLEMENT_MS;
 if(limit>sourceLimit||(overallBudgetMs!==undefined&&overallBudgetMs>wholeLimit))throw new Error('PHASE_BUDGET_INVALID');
 const overall=createExecutionBudget({budgetMs:overallBudgetMs??wholeLimit,signal,startedAtMs:phaseStartedAt});
 const admissionBudget=createExecutionBudget({budgetMs:ADMISSION_BUDGET_MS,signal:overall.signal});let budget,stopFollowing;
 try {
   let admission=await admissionBudget.run(()=>db.admitRuntime({source:request.triggerSource,fresh:true}));
   const checkAdmission=()=>requireRuntimeAdmission(db.raw,admission,keys,db.transaction);
   checkAdmission();
   stopFollowing=followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
   const admissionFence=()=>{checkAdmission();overall.assert();admissionBudget.assert();};
   const replay=request.phase==='STAGE6_DRAIN'?await db.withRuntimeFence(admissionFence,()=>admissionBudget.run(()=>reconcileExecution(db,request,requestIdentity(body)))):null;
   const finalizedReplay=['FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(replay?.state);
   const continuation=request.phase==='STAGE6_DRAIN'&&!finalizedReplay?await db.withRuntimeFence(admissionFence,()=>admissionBudget.run(()=>requireSyncHandoff(db,request,keys))):null;
   const reconciliationOnly=Boolean(continuation?.reconciliationResult);
   const claim=await db.withRuntimeFence(admissionFence,()=>admissionBudget.run(()=>claimPhaseRequest(db,request,body,{keys,deadlineAt:overall.deadlineAt,maxWorkAgeMs:EXECUTION_WORK_MAX_AGE_MS,reconciliationOnly,serializeScope:isContinuationRequest(request)})));
   if(claim.cached){overall.assert();admissionBudget.assert();
     try{await admissionBudget.run(()=>projectPhaseCompletion(db,request,claim.cached));}catch{}
     overall.assert();admissionBudget.assert();return phaseResponse({...claim.cached,settlementState:claim.row.state});}
   // Production continuations retain the original phase observation date.
   // Explicit now is an isolated-fixture clock and is never accepted from HTTP.
   const explicitFixtureNow=now!==undefined;
   now ??= new Date(claim.startedAt);
   const presentationClock=explicitFixtureNow?()=>new Date(now):()=>new Date();
   admissionBudget.close();
   overall.assert();
   const workLimit=claim.workCommitted||reconciliationOnly?limit:Math.max(0,Math.min(limit,claim.workDeadlineAt-Date.now()));
   if(workLimit<=0)throw Object.assign(Error('EXECUTION_STALE_REQUEST'),{code:'EXECUTION_STALE_REQUEST'});
   budget=createExecutionBudget({budgetMs:workLimit,signal:overall.signal});
   const fence=async()=>{checkAdmission();overall.assert();budget.assert();};
   if(!claim.workCommitted)await db.withRuntimeFence(fence,()=>budget.run(()=>recordPhaseEvent(db,{phase:request.phase,releaseSha,source:request.triggerSource,event:'start',outcome:'PENDING',identity:claim.identity,executionSeq:claim.executionSeq})));
   const executionContext={claim,keys,presentationClock,pending:new Set(),indeterminate:false,authority:{assert:()=>{checkAdmission();overall.assert();budget.assert();}}};
   let result,presentationRuntime;
   try {
     result=continuation?.reconciliationResult??(claim.workCommitted?claim.result:await withDurableExecution(executionContext,()=>withExecutionBudget(budget,()=>db.withRuntimeFence(fence,()=>budget.run(async()=>{
       if(request.phase==='SYNC') {
         log.info('sync_start',{source:request.triggerSource,release_sha:releaseSha,phase:'SYNC'});
         const summary=await (deps.runBriefing??runBriefing)({now,triggerSource:request.triggerSource,deps:{...deps,db,env,
           runtimeAdmission:admission,executionBudget:budget,keepConnectionOpen:true,phase4Stage6:undefined,betaPresentation:undefined}});
         budget.assert();
         if(summary.coordinationPending)executionContext.coordinationPending=true;
         if(executionContext.coordinationPending)throw Object.assign(Error('SYNC_SCOPE_BUSY'),{code:'SYNC_SCOPE_BUSY'});
         const outcome=summary.syncComplete===true?summary.syncOutcome??'COMPLETE_SUCCESS':summary.syncOutcome??'PARTIAL';
         return {outcome,users:summary.users??0,failed:summary.failed??0,durationMs:performance.now()-started};
       }
       if(config.runtime!=='on')return {outcome:'DISABLED',durationMs:performance.now()-started};
       const runtime=presentationRuntime=deps.runtime??await createPublicBetaRuntime({db,keys,admission,executionMode:'SHADOW',
         runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'}),presentationPolicy:config.policy});
       const progress=async({event,...counts})=>recordPhaseEvent(db,{phase:request.phase,releaseSha,source:request.triggerSource,event,
         identity:claim.identity,outcome:'PENDING',...counts});
       const drained=await runPhase4Stage6({db,worker:runtime.phase4Stage6,triggerSource:request.triggerSource,now,onProgress:progress});
       budget.assert();
       return {outcome:drained.outcome,jobsConsidered:drained.jobsConsidered,itemsAttempted:drained.itemsAttempted,
         itemsProcessed:drained.processedItems,jobsCompleted:drained.completedJobs,jobsFailed:drained.failedJobs,remainingJobs:drained.remainingJobs,completion:drained.completion,stopReason:drained.stopReason,
         durationMs:performance.now()-started};
     })))));
   } catch(error) {
     if(error?.definiteCommitRejection&&/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error.code??''))executionContext.coordinationPending=true;
     let budgetCode;try{budget.assert();}catch(e){budgetCode=e.code;}
     result={outcome:executionContext.pending.size||executionContext.indeterminate||error?.code==='COMMIT_INDETERMINATE'?'COMMIT_INDETERMINATE':budgetCode==='SYNC_CANCELLED'||error?.code==='SYNC_CANCELLED'?'CANCELLED':budgetCode==='SYNC_TIMEOUT'||error?.code==='SYNC_TIMEOUT'?'TIMEOUT':'FAILED',
       durationMs:performance.now()-started};
   }
   // Local authority prevents submission. Submitted SQL is durably
   // reconcilable; cancellation does not establish whether it committed.
   const originalAuthority={assert:()=>{
     executionContext.authority.assert();
     const currentRelease=runningReleaseSha(environment),currentConfig=publicBetaConfiguration(environment);
     if(currentRelease!==releaseSha)throw Object.assign(Error('RELEASE_CHECKOUT_MISMATCH'),{code:'RELEASE_CHECKOUT_MISMATCH'});
     if(configurationProof(keys,currentConfig,environment,currentRelease)!==proof||(currentConfig.runtime==='on'?'SHADOW':'OFF')!==mode)
       throw Object.assign(Error('EXECUTION_CONFIG_CHANGED'),{code:'EXECUTION_CONFIG_CHANGED'});
     if(isGitHubContext(environment)&&cliTriggerSource(environment)!==request.triggerSource)throw Object.assign(Error('GITHUB_SOURCE_UNSUPPORTED'),{code:'GITHUB_SOURCE_UNSUPPORTED'});
   }};
   let record;
   try {
     originalAuthority.assert();
     if(['TIMEOUT','CANCELLED'].includes(result.outcome))throw Object.assign(Error(result.outcome),{code:result.outcome==='TIMEOUT'?'SYNC_TIMEOUT':'SYNC_CANCELLED'});
     if(executionContext.coordinationPending)throw Object.assign(Error('SYNC_SCOPE_BUSY'),{code:'SYNC_SCOPE_BUSY'});
     withDurableExecution(executionContext,()=>requireSettledOperation());
     if(result.outcome==='COMMIT_INDETERMINATE')throw Object.assign(Error('COMMIT_INDETERMINATE'),{code:'COMMIT_INDETERMINATE'});
     const settlement=createExecutionBudget({budgetMs:Math.min(PHASE_SETTLEMENT_MS,overall.remainingMs()),signal:budget.signal});
     try{record=await withDurableExecution({...executionContext,receipts:false},()=>withExecutionBudget(settlement,()=>settlement.run(()=>settlePhaseRequest(db,request,claim,result,keys,originalAuthority))));
       originalAuthority.assert();}
     finally{settlement.close();}
   } catch(error) {
     if(error?.definiteCommitRejection&&/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error.code??''))executionContext.coordinationPending=true;
     let authorityError=error;try{originalAuthority.assert();}catch(expired){authorityError=expired;}
     const outcome=error?.code==='COMMIT_INDETERMINATE'||executionContext.pending.size||executionContext.indeterminate?'COMMIT_INDETERMINATE':
       authorityError?.code==='SYNC_CANCELLED'?'CANCELLED':authorityError?.code==='SYNC_TIMEOUT'?'TIMEOUT':'FAILED';
     const workCommitted = observedPhaseWorkCommit(claim);
     const staleRequest=!workCommitted&&outcome!=='COMMIT_INDETERMINATE'&&Date.now()-claim.startedAt>=EXECUTION_WORK_MAX_AGE_MS;
     const resumable = !staleRequest&&(workCommitted || executionContext.coordinationPending || ['TIMEOUT','CANCELLED','COMMIT_INDETERMINATE'].includes(outcome));
     record={resumable, ...(staleRequest?{continuationState:'STALE_REQUEST'}:resumable?{continuationState:workCommitted?'WORK_COMMITTED_UNFINALIZED':outcome==='COMMIT_INDETERMINATE'?'COMMIT_UNCERTAIN':'INCOMPLETE_RESUMABLE',retryAfterMs:15_000}:{}),phase:request.phase,releaseSha,source:request.triggerSource,executionMode:mode,...result,outcome,
       ...(request.phase==='STAGE6_DRAIN'?{completion:'PARTIAL',stopReason:'FAILURE'}:{})};
     // Best effort non-success cleanup, never finalizes uncertain work. A
     // submitted COMMIT is reconciled on the next fresh admitted invocation.
     const cleanupMs=Math.min(PHASE_SETTLEMENT_MS,overall.remainingMs());
     if(cleanupMs>0){
       const cleanup=createExecutionBudget({budgetMs:cleanupMs});
       try{await cleanup.run(()=>outcome==='COMMIT_INDETERMINATE'?noteIndeterminateExecution(db,claim):abortPhaseExecution(db,claim,outcome,{resumable:resumable||staleRequest}));}
       catch(error){log.warn('phase4_cleanup_pending',{phase:request.phase,code:error?.code??'CLEANUP_UNCONFIRMED'});}finally{cleanup.close();}
     }
   }
       if(request.phase==='STAGE6_DRAIN'&&record.settlementState==='FINALIZED_SUCCESS'&&config.mode!=='off'&&presentationRuntime?.betaPresentation) {
         const users=await db.listSchedulableUsers({activeStatus:'ACTIVE'});
         for(const user of users){budget.assert();await (deps.deliverBetaSummary??deliverPublicBetaSummary)({db,env,user,
           presentation:presentationRuntime.betaPresentation,now:new Date(),...(deps.makeTelegram?{makeTelegram:deps.makeTelegram}:{})});}
       }
   log.info(request.phase==='SYNC'?'sync_complete':'stage6_drain_complete',{source:request.triggerSource,release_sha:releaseSha,phase:request.phase,
     outcome:record.outcome,duration_ms:record.durationMs,jobs_considered:record.jobsConsidered,items_attempted:record.itemsAttempted,
     jobs_completed:record.jobsCompleted,jobs_failed:record.jobsFailed,items_processed:record.itemsProcessed,work_receipts:record.workReceipts,remaining_jobs:record.remainingJobs,stop_reason:record.stopReason});
   log.info('phase4_run_complete',{source:request.triggerSource,release_sha:releaseSha,phase:request.phase,outcome:record.outcome,duration_ms:performance.now()-started});
   if(!record.resumable&&!['TIMEOUT','CANCELLED','FAILED','COMMIT_INDETERMINATE'].includes(record.outcome))originalAuthority.assert();
   const response=phaseResponse(record);
   if(!record.resumable&&!['TIMEOUT','CANCELLED','FAILED','COMMIT_INDETERMINATE'].includes(record.outcome)){originalAuthority.assert();JSON.stringify(response.body);originalAuthority.assert();}
   return response;
 } catch(error){
   if(error?.code==='COMMIT_INDETERMINATE')return phaseResponse({phase:request.phase,releaseSha,source:request.triggerSource,executionMode:mode,outcome:'COMMIT_INDETERMINATE'});
   if(!['SYNC_TIMEOUT','SYNC_CANCELLED'].includes(error?.code))throw error;
   return phaseResponse({phase:request.phase,releaseSha,source:request.triggerSource,executionMode:mode,outcome:error.code==='SYNC_TIMEOUT'?'TIMEOUT':'CANCELLED'});
 } finally {budget?.cancel();stopFollowing?.();overall.close();admissionBudget.close();budget?.close();if(!providedDb)db.close();}
}

/** Authenticated entry composition; the discovery store cannot construct capabilities. */
export async function discoverExecutionContinuation({query,db:providedDb,keys:providedKeys,environment=process.env,env:providedEnv,signal}={}) {
 const keys=providedKeys??publicBetaKeys(environment),config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 const env=providedDb?null:providedEnv??loadEnv();
 const db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 try {return await discoverPhaseContinuation({query,db,keys,releaseSha,mode:config.runtime==='on'?'SHADOW':'OFF',
  configProof:configurationProof(keys,config,environment,releaseSha),signal});}
 finally {if(!providedDb)db.close();}
}
