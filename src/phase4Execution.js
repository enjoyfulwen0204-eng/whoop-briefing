import { loadEnv } from './config.js';
import { createDb } from './db.js';
import { runBriefing } from './index.js';
import { publicBetaConfiguration, publicBetaKeys } from './publicBetaConfig.js';
import { authorizePublicBetaRuntime, createPublicBetaRuntime } from './publicBeta.js';
import { runPhase4Stage6 } from './shadowDrainScheduler.js';
import { deliverPublicBetaSummary } from './publicBetaSummaryDelivery.js';
import { createExecutionBudget, SYNC_BUDGET_MS, withExecutionBudget } from './executionBudget.js';
import { syncAuthorizesDrain } from './syncResult.js';
import { validatePhaseRequest,configurationProof,claimPhaseRequest,settlePhaseRequest,requireSyncHandoff,recordPhaseEvent } from './phase4ExecutionStore.js';
import { log } from './logger.js';
import { requireRuntimeAdmission } from './runtimeAdmission.js';
export const ADMISSION_BUDGET_MS=30_000;
export const SYNC_SOURCE_BUDGETS=Object.freeze({cloudflare:120_000,github:SYNC_BUDGET_MS,manual:SYNC_BUDGET_MS,event:120_000});
export const DRAIN_SOURCE_BUDGETS=Object.freeze({cloudflare:45_000,github:90_000,manual:45_000,event:25_000});
export const PHASE_SETTLEMENT_MS=15_000;
export function phaseResponse(record) {
 const {startedAt,updatedAt,...publicRecord}=record;
 const complete=syncAuthorizesDrain(record);
 const ok=record.phase==='SYNC'?complete:['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED'].includes(record.outcome);
 const status=ok?200:record.outcome==='TIMEOUT'?504:record.outcome==='CANCELLED'?499:record.outcome==='PARTIAL'?207:424;
 return {status,body:{ok,phase:record.phase,source:record.source,result:publicRecord,
   ...(record.phase==='SYNC'?{syncComplete:complete,drainAuthorized:complete&&record.executionMode==='SHADOW',handoff:record.handoff}:{}),
   bodyEnergy:'NOT_AUTHORIZED_NOT_PRESENTED'}};
}
/** Both CLI jobs and signed HTTP phases share one admitted/fenced composition. */
export async function runExecutionPhase({request,body=JSON.stringify(request),now=new Date(),environment=process.env,
 db:providedDb,keys:providedKeys,env:providedEnv,deps={},budgetMs,signal}={}) {
 if(Number(process.versions.node.split('.')[0])<22)throw new Error('NODE_22_REQUIRED');
 validatePhaseRequest(request);
 const config=publicBetaConfiguration(environment),keys=providedKeys??publicBetaKeys(environment),env=providedEnv??loadEnv();
 const proof=configurationProof(keys,config,environment),mode=config.runtime==='on'?'SHADOW':'OFF';
 if(request.configProof!==proof||request.executionMode!==mode)throw Object.assign(new Error('EXECUTION_CONFIG_CHANGED'),{code:'EXECUTION_CONFIG_CHANGED'});
 const db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 const admissionBudget=createExecutionBudget({budgetMs:ADMISSION_BUDGET_MS,signal});let budget;
 const started=performance.now();
 try {
   const admission=await admissionBudget.run(()=>db.admitRuntime({source:request.triggerSource}));
   const checkAdmission=()=>requireRuntimeAdmission(db.raw,admission,keys,db.transaction);
   checkAdmission();
   const admissionFence=()=>{checkAdmission();admissionBudget.assert();};
   const claim=await db.withRuntimeFence(admissionFence,()=>admissionBudget.run(()=>claimPhaseRequest(db,request,body)));
   if(claim.cached){admissionBudget.close();return phaseResponse(claim.cached);}
   if(request.phase==='STAGE6_DRAIN')await db.withRuntimeFence(admissionFence,()=>admissionBudget.run(()=>requireSyncHandoff(db,request,keys)));
   admissionBudget.close();
   const limit=request.phase==='SYNC'?SYNC_SOURCE_BUDGETS[request.triggerSource]:DRAIN_SOURCE_BUDGETS[request.triggerSource];
   budget=createExecutionBudget({budgetMs:budgetMs??limit,signal});
   const fence=async()=>{checkAdmission();budget.assert();};
   await db.withRuntimeFence(fence,()=>budget.run(()=>recordPhaseEvent(db,{phase:request.phase,source:request.triggerSource,event:'start',outcome:'PENDING',identity:claim.identity})));
   let result;
   try {
     result=await withExecutionBudget(budget,()=>db.withRuntimeFence(fence,()=>budget.run(async()=>{
       if(request.phase==='SYNC') {
         log.info('sync_start',{source:request.triggerSource,phase:'SYNC'});
         const summary=await (deps.runBriefing??runBriefing)({now,triggerSource:request.triggerSource,deps:{...deps,db,env,
           runtimeAdmission:admission,executionBudget:budget,keepConnectionOpen:true,phase4Stage6:undefined,betaPresentation:undefined}});
         budget.assert();
         const outcome=summary.syncComplete===true?summary.syncOutcome??'COMPLETE_SUCCESS':summary.syncOutcome??'PARTIAL';
         return {outcome,users:summary.users??0,failed:summary.failed??0,durationMs:performance.now()-started};
       }
       if(config.runtime!=='on')return {outcome:'DISABLED',durationMs:performance.now()-started};
       const runtime=deps.runtime??await createPublicBetaRuntime({db,keys,admission,executionMode:'SHADOW',
         runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'}),presentationPolicy:config.policy});
       const progress=async({event,...counts})=>recordPhaseEvent(db,{phase:request.phase,source:request.triggerSource,event,
         identity:claim.identity,outcome:'PENDING',...counts});
       const drained=await runPhase4Stage6({db,worker:runtime.phase4Stage6,triggerSource:request.triggerSource,now,onProgress:progress});
       budget.assert();
       if(config.mode!=='off' && runtime.betaPresentation && !['FAILED','POLICY_DEFERRED','DISABLED'].includes(drained.outcome)) {
         const users=await db.listSchedulableUsers({activeStatus:'ACTIVE'});
         for(const user of users){budget.assert();await (deps.deliverBetaSummary??deliverPublicBetaSummary)({db,env,user,
           presentation:runtime.betaPresentation,now:new Date(),...(deps.makeTelegram?{makeTelegram:deps.makeTelegram}:{})});}
       }
       return {outcome:drained.outcome,jobsConsidered:drained.jobsConsidered,itemsAttempted:drained.itemsAttempted,
         itemsProcessed:drained.processedItems,jobsCompleted:drained.completedJobs,jobsFailed:drained.failedJobs,remainingJobs:drained.remainingJobs,completion:drained.completion,stopReason:drained.stopReason,
         durationMs:performance.now()-started};
     })));
   } catch(error) {
     let budgetCode;try{budget.assert();}catch(e){budgetCode=e.code;}
     result={outcome:budgetCode==='SYNC_CANCELLED'||error?.code==='SYNC_CANCELLED'?'CANCELLED':budgetCode==='SYNC_TIMEOUT'||error?.code==='SYNC_TIMEOUT'?'TIMEOUT':'FAILED',
       durationMs:performance.now()-started};
   }
   // Durable outcome settlement has a separate finite margin and request-owner
   // CAS. Expired sync work retains its original fence and cannot write here.
   const settlement=createExecutionBudget({budgetMs:PHASE_SETTLEMENT_MS});
   let record;
   try{record=await db.withRuntimeFence(()=>{checkAdmission();settlement.assert();},()=>settlement.run(()=>settlePhaseRequest(db,request,claim,result,keys)));}
   finally{settlement.close();}
   log.info(request.phase==='SYNC'?'sync_complete':'stage6_drain_complete',{source:request.triggerSource,phase:request.phase,
     outcome:record.outcome,duration_ms:record.durationMs,jobs_considered:record.jobsConsidered,items_attempted:record.itemsAttempted,
     jobs_completed:record.jobsCompleted,jobs_failed:record.jobsFailed,items_processed:record.itemsProcessed,remaining_jobs:record.remainingJobs,stop_reason:record.stopReason});
   log.info('phase4_run_complete',{source:request.triggerSource,phase:request.phase,outcome:record.outcome,duration_ms:performance.now()-started});
   return phaseResponse(record);
 } finally {admissionBudget.close();budget?.close();if(!providedDb)db.close();}
}
