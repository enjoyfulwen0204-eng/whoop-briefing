import {createMorningFollowups} from './morningFollowups.js';
import {createCompanionProgress} from './companionProgress.js';
import {familyConfiguration,FAMILY_CLASSES} from './familySharingStore.js';
import {onDemandBodyEnabled} from './onDemandBodyEnergy.js';
import {runCompanionStep,withCompanionProgress,deferCompanionAtBoundary,CompanionBudgetDeferred} from './companionStep.js';
import {notifyPrediction} from './predictionNotification.js';
import {createTelegram} from './telegram.js';
import {createFamilySharing} from './familySharing.js';
import {createStage8Runtime,stage8Configuration} from './stage8Runtime.js';
import {SCHEMA_TRANSITION_PROFILE,assertSchemaTransitionProfile,schemaTransitionRuntimeProfileFor} from './schemaTransitionProfile.js';
import {createDb} from './db.js';
import {loadEnv} from './config.js';
import {publicBetaConfiguration,publicBetaKeys} from './publicBetaConfig.js';
import {configurationProof} from './phase4ExecutionStore.js';
import {runningReleaseSha} from './phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {createStage7Runtime,stage7Configuration} from './stage7Runtime.js';

export const COMPANION_PATH='/internal/briefing/companion';
export const COMPANION_KIND='COMPANION_V1';
export const EXTRAS_PATH='/internal/briefing/extras';
export const EXTRAS_KIND='EXTRAS_V1';
export const COMPANION_BUDGET_MS=45000;
// Sequential slots for the existing UTC cron: */10 0-3, then hourly 04-23.
// A plain ten-minute counter would advance by six at each hourly tick and
// permanently favor the same first user in a three-person cohort.
export function companionUserOrder(userIds,at){
 if(!userIds.length)return [];
 const hour=at.getUTCHours(),slot=Math.floor(at.getTime()/86400000)*44+
  (hour<4?hour*6+Math.floor(at.getUTCMinutes()/10):24+hour-4);
 const start=((slot%userIds.length)+userIds.length)%userIds.length;
 return [...userIds.slice(start),...userIds.slice(0,start)];
}
const fail=code=>{throw Object.assign(Error(code),{code});};
const diagnosticFailureStates=new Set(['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS','UNKNOWN','FENCED']);
const diagnosticCode=error=>{
 const value=typeof error?.code==='string'?error.code:typeof error?.name==='string'?error.name:'UNKNOWN';
 return /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(value)?value:'REDACTED_CODE';
};
// Diagnostics must never change delivery, fencing or failure-count semantics.
const diagnosticLog=value=>{try{console.log(JSON.stringify(value));}catch{}};
const diagnosticUser=(keys,id)=>{try{return keys.lookup(['companion-diagnostic-user-v1',id]);}catch{return 'UNKNOWN';}};
const diagnosticFailure=(keys,id,step,status,error)=>diagnosticLog({event:'companion_user_failed',user:diagnosticUser(keys,id),step,status,code:diagnosticCode(error)});
export const validateCompanionRequest=request=>validateRequest(request,COMPANION_KIND);
export const validateExtrasRequest=request=>validateRequest(request,EXTRAS_KIND);
function validateRequest(request,kind){
 if(!request||Object.keys(request).sort().join(',')!=='configProof,executionMode,kind,releaseSha,requestId,triggerSource'
  ||request.kind!==kind||request.triggerSource!=='cloudflare'
  ||!['OFF','SHADOW'].includes(request.executionMode)||!/^[a-f0-9]{40}$/.test(request.releaseSha??'')
  ||!/^[a-f0-9]{64}$/.test(request.configProof??'')||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(request.requestId??''))fail('COMPANION_REQUEST_INVALID');
 return request;
}
/** Post-morning work reuses confirmed report receipts and durable delivery
 * identities. This service cannot enter SYNC, DRAIN, WHOOP refresh or an AI call. */
export const runCompanionService=args=>runService(args,false);
export const runExtrasService=args=>runService(args,true);
async function runService({request,environment=process.env,db:providedDb,env:providedEnv,
 keys:providedKeys,now=()=>new Date(),deps={},budgetMs=COMPANION_BUDGET_MS}={},extras=false){
 if(environment.PHASE4_EXECUTION_PROFILE===SCHEMA_TRANSITION_PROFILE)assertSchemaTransitionProfile(environment);
 validateRequest(request,extras?EXTRAS_KIND:COMPANION_KIND);
 if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>COMPANION_BUDGET_MS)fail('COMPANION_BUDGET_INVALID');
 const startedAtMs=Date.now(),keys=providedKeys??publicBetaKeys(environment),config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 const proof=()=>configurationProof(keys,publicBetaConfiguration(environment),environment,releaseSha);
 if(request.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 if(request.configProof!==proof()||request.executionMode!==(config.runtime==='on'?'SHADOW':'OFF'))fail('EXECUTION_CONFIG_CHANGED');
 const cohort=stage7Configuration(environment),stage8Config=stage8Configuration(environment),ownerEnabled=!extras&&stage8Config.enabled&&environment.PHASE4_STAGE8_OWNER_MONITORING==='on',automatic=cohort.mode==='on'&&cohort.automatic,base={kind:extras?EXTRAS_KIND:COMPANION_KIND,source:'cloudflare',releaseSha,drainAuthorized:false};
 if(!automatic&&!ownerEnabled)return {status:200,body:{ok:true,...base,enabled:false,checked:0}};
 const env=providedEnv??loadEnv(),db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys,
  runtimeProfile:schemaTransitionRuntimeProfileFor({environment,keys})});
 const budget=createExecutionBudget({budgetMs,startedAtMs});let unfollow;
 let checked=0,failed=0;const userDurations=[];
 const familyConfig=extras?familyConfiguration(environment):null;
 const familyIds=familyConfig?.enabled?familyConfig.ids:[];
 const plannedIds=[...new Set([...(automatic?cohort.userIds:[]),...familyIds])];
 const normalSteps=['daily','weekly','insight','coach',...(onDemandBodyEnabled(environment)?['low']:[])];
 const familySteps=FAMILY_CLASSES.map(c=>'family_'+c);
 const progress=createCompanionProgress(plannedIds.map(id=>[diagnosticUser(keys,id),[
  ...(automatic&&cohort.userIds.includes(id)?extras?['prediction','brief_update','no_sleep']:normalSteps:[]),...(familyIds.includes(id)?familySteps:[])]]));
 const observe=progress.observe;let finalSummary;
 const summary=()=>progress.snapshot();
 try{return await withCompanionProgress(observe,()=>withExecutionBudget(budget,()=>budget.run(async()=>{
  let admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const fence=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);if(proof()!==request.configProof)fail('EXECUTION_CONFIG_CHANGED');};
  unfollow=followRuntimeRenewal(db.raw,admission,keys,db.transaction,value=>{admission=value;});
  return db.withRuntimeFence(fence,async()=>{
   const family=extras&&(deps.createFamily??createFamilySharing)({db,keys,environment,env,now});
   if(family){
    const familyStarted=Date.now();
    try{
     deferCompanionAtBoundary(db);
     const result=await family.tick();
     for(const row of result.results){observe(row);
      const timing=userDurations.find(u=>u.user===row.user);if(timing)timing.duration_ms+=row.duration_ms;else userDurations.push({user:row.user,duration_ms:row.duration_ms});
      if(['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS','UNKNOWN'].includes(row.status)){failed++;diagnosticLog({event:'companion_user_failed',user:row.user,step:row.step,status:row.status,code:'UNKNOWN'});}}
     progress.addDeferred(result.deferredSteps);
     for(const id of familyIds)progress.finishSteps(diagnosticUser(keys,id),familySteps);
    }catch(error){if(error instanceof CompanionBudgetDeferred)throw error;diagnosticLog({event:'companion_user_failed',user:'FAMILY',step:'family',status:'EXCEPTION',code:diagnosticCode(error)});fence();failed++;}
    finally{diagnosticLog({event:'companion_family_summary',duration_ms:Date.now()-familyStarted});}
   }
   deferCompanionAtBoundary(db);
   const runtime=automatic&&!extras?await (deps.createRuntime??createStage7Runtime)({db,keys,env,environment,admission,now}):null;
   for(const id of companionUserOrder(automatic?cohort.userIds:[],now())){
    deferCompanionAtBoundary(db);
    const userStartedAtMs=Date.now();let userDeferred=false;
    try{
    fence();progress.start(diagnosticUser(keys,id));const user=await db.getUser(id);
    if(!user||user.status!=='ACTIVE'||(await db.getOnboarding(id))?.state!=='READY')continue;
    const chatId=await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:user.lifecycleGeneration});if(!chatId)continue;
    try{
     const awaitLocale=extras?await db.getLocale(id):null;
     let result;
     if(extras){
      const input={db,keys,user:{...user,reportChatId:chatId},telegram:createTelegram({botToken:env.telegramBotToken,chatId,db,locale:awaitLocale,dryRun:env.dryRun}),locale:awaitLocale,now};
      const step=(name,run)=>runCompanionStep({db,keys,userId:id,step:name,run});
      const prediction=await step('prediction',()=> (deps.notifyPrediction??notifyPrediction)(input));
      const followups=(deps.createMorningFollowups??createMorningFollowups)(input);
      const briefUpdate=await step('brief_update',()=>followups.briefUpdate());
      const noSleep=await step('no_sleep',()=>followups.noSleep());
      result={prediction:prediction.status,brief_update:briefUpdate.status,no_sleep:noSleep.status};
     }else result=await runtime.tick({user,chatId});
     const statuses=[result.status,result.daily,result.coach,result.weekly,result.low,result.insight,result.brief_update,result.no_sleep,result.prediction].filter(Boolean);
     for(const [step,status] of Object.entries(result))if(typeof status==='string'&&step!=='health')observe({user:diagnosticUser(keys,id),step,status});
     for(const [step,status] of [['exception',result.status],['daily',result.daily],['coach',result.coach],['weekly',result.weekly],['low',result.low],['insight',result.insight],['brief_update',result.brief_update],['no_sleep',result.no_sleep],['prediction',result.prediction]])
      if(diagnosticFailureStates.has(status))diagnosticFailure(keys,id,step,status,result.error);
     if(statuses.some(status=>['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS','UNKNOWN'].includes(status)))failed++;
    }catch(error){if(error instanceof CompanionBudgetDeferred){userDeferred=true;throw error;}diagnosticFailure(keys,id,'exception','EXCEPTION',error);fence();failed++;}
    }finally{if(!userDeferred&&budget.remainingMs()>0&&!budget.signal.aborted)progress.finish(diagnosticUser(keys,id));const user=diagnosticUser(keys,id),duration_ms=Date.now()-userStartedAtMs,existing=userDurations.find(row=>row.user===user);if(existing)existing.duration_ms+=duration_ms;else userDurations.push({user,duration_ms});}
   }
   let ownerChecked=0;
   if(ownerEnabled){
    const ownerStartedAtMs=Date.now();
    try{
     fence();const ownerRuntime=await (deps.createStage8Runtime??createStage8Runtime)({db,keys,env,environment,now});
     const user=await db.getUser(stage8Config.ownerId);
     if(user?.status==='ACTIVE'&&(await db.getOnboarding(user.id))?.state==='READY'){
      const chatId=await db.getActiveChatIdForUser(user.id,{expectedLifecycleGeneration:user.lifecycleGeneration});
      if(chatId&&ownerRuntime?.owner){
       const result=await ownerRuntime.owner.tick({user,chatId});ownerChecked=result.checked;
       for(const row of result.results??[])if(diagnosticFailureStates.has(row.status))diagnosticFailure(keys,stage8Config.ownerId,'owner',row.status,row.error);
       if(result.results?.some(row=>['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS','FENCED'].includes(row.status)))failed++;
      }
     }
    }catch(error){diagnosticFailure(keys,stage8Config.ownerId,'owner','EXCEPTION',error);fence();failed++;}
    finally{userDurations.push({user:diagnosticUser(keys,stage8Config.ownerId),step:'owner',duration_ms:Date.now()-ownerStartedAtMs});}
   }
   fence();deferCompanionAtBoundary(db);checked=summary().checked;if(!failed)await db.recordHeartbeat('global',extras?'extras_v1':'companion_v1',{now:now(),detail:`checked=${checked}`});
   return {status:failed?503:200,body:{ok:failed===0,...base,enabled:true,ownerChecked,failed,...summary()}};
  });
 })));
 }catch(error){
  const deferred=error instanceof CompanionBudgetDeferred;
  if(!deferred&&(error?.code!=='SYNC_TIMEOUT'||budget.remainingMs()>0&&!budget.signal.aborted))throw error;
  // A hard deadline remains a failed HTTP call. Do not describe an in-flight
  // send/commit as safely deferred, and never retry it from this summary.
  finalSummary=progress.freeze(true);failed=Math.max(failed,finalSummary.failedUsers);
  if(deferred&&failed===0&&Object.keys(finalSummary.interruptedSteps).length===0)
   return {status:200,body:{ok:true,...base,enabled:true,reason:'DEFERRED_BUDGET',failed:0,...finalSummary}};
  return {status:503,body:{ok:false,...base,enabled:true,error:'SYNC_TIMEOUT',failed,...finalSummary}};
 }finally{
  finalSummary??=progress.freeze();
  try{unfollow?.();budget.close();if(!providedDb)db.close();}
  finally{diagnosticLog({event:extras?'extras_tick_summary':'companion_tick_summary',failed,...finalSummary,duration_ms:Date.now()-startedAtMs,users:userDurations});}
 }
}
