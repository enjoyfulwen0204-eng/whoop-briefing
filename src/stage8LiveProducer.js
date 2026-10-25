import {STAGE8_LIVE_DRAIN_BUDGET} from './stage8LiveDrainPolicy.js';
import {subjectAlertExecutionId} from './stage8SubjectAlertManifest.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {createStage8SubjectAlerts} from './stage8SubjectAlerts.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {currentDurableExecution} from './phase4ExecutionContext.js';
import {createPhase4QueueStore} from './phase4QueueStore.js';
import {liveScopeDigest} from './stage8LiveProducerAuthority.js';
import {runningReleaseSha} from './phase4Release.js';
import {authorizeStage8LiveProducer,liveProducerConfiguration} from './stage8LiveProducerAuthority.js';
import {buildPhase4Core} from './phase4Core.js';
import {createPhase4Stage6} from './phase4Reanalysis.js';
import {createStage8LiveExecutionRunner} from './stage8LiveExecution.js';
import {publishStage8Live,verifyStage8LivePublication} from './stage8LivePublication.js';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {readOnlyProcessingCheck} from './processingTransaction.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
/** Server composition only. No request may supply source results, receipts,
 * execution mode, SQL, transport, credentials, consent or follow relationships. */
export async function createStage8LiveProducer({db,keys,admission,userIds,enabled,eligible,environment={},subjectAlertProvider=null}){
 if(!Array.isArray(userIds)||!userIds.length||userIds.length>100||new Set(userIds).size!==userIds.length
  ||userIds.some(id=>typeof id!=='string'||!id||id.length>128)||typeof enabled!=='function'||typeof eligible!=='function')fail('STAGE8_LIVE_CONFIGURATION_REQUIRED');
 const cohort=Object.freeze([...userIds].sort()),releaseSha=runningReleaseSha(environment),
  configProof=keys.lookup(['stage8-live-server-config-v1',releaseSha,35,cohort,'phase4-stage5-canonical-v1']);
 const pins=JSON.stringify([environment.PHASE4_RELEASE_SHA,environment.RENDER_GIT_COMMIT,environment.GITHUB_ACTIONS]);
 const policy=()=>enabled()&&JSON.stringify([environment.PHASE4_RELEASE_SHA,environment.RENDER_GIT_COMMIT,environment.GITHUB_ACTIONS])===pins;
 const permitted=id=>policy()&&cohort.includes(id)&&eligible(id);
 const capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha,configProof,enabled:policy,eligible:permitted});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,
  processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,
   afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},
  authorizeMode(mode,client,id){if(mode!=='LIVE'||client!==db.raw||!permitted(id))fail('STAGE8_LIVE_PRINCIPAL_FENCED');}});
 const contextLeases=new AsyncLocalStorage();
 const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});
 async function ready(id){
  liveProducerConfiguration(capability,db.raw,keys,id);
  const row=(await db.raw.execute({sql:`SELECT u.status,o.state,COALESCE(t.auth_generation,0) auth_generation,p.pending_purge_count
   FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
   LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`,args:[id]})).rows[0];
  if(!row||row.status!=='ACTIVE'||row.state!=='READY'||row.auth_generation<1||row.pending_purge_count!==0)fail('STAGE8_LIVE_PRINCIPAL_FENCED');
 }
 const capture=async id=>{await ready(id);const ctx=await core.capture(id,{executionMode:'LIVE',providerRequired:true});contextLeases.getStore()?.push(ctx);return ctx;};
 const assertContext=async ctx=>{if(runningReleaseSha(environment)!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');await ready(ctx.userId);return core.assertContext(ctx);};
 const execute=createStage8LiveExecutionRunner({db,keys,capability,capture,assertContext,
  work:async(userId)=>{const v=await worker.drain({userId,triggerSource:'manual',budget:STAGE8_LIVE_DRAIN_BUDGET});return {outcome:v.outcome,itemsProcessed:v.processedItems,jobsCompleted:v.completedJobs,jobsFailed:v.failedJobs,remainingJobs:v.remainingJobs,unitsCommitted:v.unitsCommitted};}});
 const alerts=subjectAlertProvider?await createStage8SubjectAlerts({core,stores:composePhase4Stores(core),db,capability,provider:subjectAlertProvider}):null;
 const executeAlerts=alerts?createStage8LiveExecutionRunner({db,keys,capability,capture,assertContext,work:async(_uid,ctx)=>alerts.produce(ctx)}):null;
 async function prepareFreshGeneration(userId){
  await db.transaction(async()=>{
   await ready(userId);const ctx=await capture(userId),at=Date.now();
   const publication=(await db.raw.execute({sql:'SELECT expires_at FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[userId,ctx.inputGeneration]})).rows[0];
   const executions=(await db.raw.execute({sql:`SELECT e.generation,e.state,e.created_at,e.finalized_at,e.canonical_request_json FROM stage8_live_execution_producers p
    JOIN stage8_live_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id=? AND p.input_generation=? LIMIT 4097`,args:[userId,ctx.inputGeneration]})).rows;
   if(executions.length>4096)fail('STAGE8_LIVE_PUBLICATION_FENCED');
   const damaged=executions.some(e=>e.generation>1||e.state==='FINALIZED_FAILURE'||e.state!=='FINALIZED_SUCCESS'&&e.created_at+45000<=at
    ||e.finalized_at>e.created_at+45000||JSON.parse(e.canonical_request_json).tenantScope!==liveScopeDigest(keys,ctx));
   if(!damaged&&!(publication&&(publication.expires_at<=at||!await verifyStage8LivePublication(core,ctx))))return;
   // Real new analysis cutoff; source generation is never fabricated. The
   // canonical FULL scan must compute/ACK this new generation from source.
   await db.raw.execute({sql:`UPDATE phase4_computation_state SET input_generation=input_generation+1,revision=revision+1,updated_at=?
    WHERE user_id=? AND execution_mode='LIVE' AND input_generation=?`,args:[new Date().toISOString(),userId,ctx.inputGeneration]});
   await createPhase4QueueStore(core).markFull(userId,'LIVE',ctx.inputGeneration+1,ctx.purgeGeneration,'REPAIR_REQUIRED');
   await ready(userId);
  });
 }
 async function runWork({userId,requestId}={}){
  if(runningReleaseSha(environment)!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
  if(requestId!==undefined&&(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{8,128}$/.test(requestId)))fail('STAGE8_LIVE_REQUEST_INVALID');
  await ready(userId);await core.initializeTenant(userId,'LIVE');await worker.rolloutAlgorithm({userId});
  const executionId=requestId?keys.lookup(['stage8-live-request-v1',userId,requestId]):null;
  const prior=executionId&&(await db.raw.execute({sql:'SELECT 1 FROM stage8_live_executions WHERE execution_id=?',args:[executionId]})).rows.length;
  if(!prior)await prepareFreshGeneration(userId);
  const result=await db.withRuntimeFence(readOnlyProcessingCheck(()=>ready(userId)),()=>execute({userId,...(requestId?{requestId:executionId}:{})}));
  const ctx=await capture(userId),{computation}=await core.assertContext(ctx);
  let publication={status:'ANALYSIS_UPDATING'};
  if(computation.last_completed_generation===ctx.inputGeneration){
   const prior=(await db.raw.execute({sql:'SELECT 1 FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[userId,ctx.inputGeneration]})).rows.length;
   // Original canonical job executions are finalized before the separately
   // signed subject-alert execution. First aggregate publication follows both.
   if(executeAlerts&&!prior)await db.withRuntimeFence(readOnlyProcessingCheck(()=>ready(userId)),()=>executeAlerts({userId,requestId:subjectAlertExecutionId(keys,ctx)}));
   publication={status:'CURRENT',...await db.withRuntimeFence(readOnlyProcessingCheck(()=>ready(userId)),()=>publishStage8Live(core,ctx,capability))};
  }
  await assertContext(ctx);return Object.freeze({...result,publication});
 }
 async function run(request){
  if(currentDurableExecution())fail('STAGE8_LIVE_SEPARATE_EXECUTION_REQUIRED');
  const parent=currentExecutionBudget();parent?.assert();const startedAtMs=Date.now();
  const contexts=[],budget=createExecutionBudget({startedAtMs,budgetMs:Math.max(1,Math.min(45000,parent?.remainingMs()??45000)),signal:parent?.signal,
   localAuthority(){parent?.assert();liveProducerConfiguration(capability,db.raw,keys,request?.userId);}});
  let result,failure,failed=false;
  try{result=await contextLeases.run(contexts,()=>withExecutionBudget(budget,async()=>{budget.assert();const value=await runWork(request);budget.assert();return value;}));}
  catch(error){failed=true;failure=error;}
  finally{budget.cancel();budget.close();}
  // Only release the already captured non-health context leases after work has
  // settled. This separate bounded cleanup grants no computation or publication
  // authority, and an error must never hide the original timeout/unknown ACK.
  const cleanup=createExecutionBudget({budgetMs:5000});
  try{await withExecutionBudget(cleanup,async()=>{for(const ctx of contexts)await core.transaction(()=>core.contextRegistry.release(ctx),{readOnly:true});});}
  catch(error){if(!failed){failed=true;failure=error;}}
  finally{cleanup.cancel();cleanup.close();}
  if(failed)throw failure;return result;
 }
 return Object.freeze({run});
}
