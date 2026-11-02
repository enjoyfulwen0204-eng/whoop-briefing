import {randomUUID} from 'node:crypto';
import {processAnalyticsForUser} from './analyticsWorker.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {requireRecoveryScope} from './recoveryPolicy.js';
import {assertSchemaTransitionProfile} from './schemaTransitionProfile.js';
import {publicBetaConfiguration} from './publicBetaConfig.js';
import {configurationProof} from './phase4ExecutionStore.js';
import {runningReleaseSha} from './phase4Release.js';
import {stage7Configuration,createStage7Runtime} from './stage7Runtime.js';
import {localDate} from './time.js';
import {updateAssociationMemory} from './associationMemory.js';

export const ANALYTICS_PATH='/internal/briefing/analytics';
export const ANALYTICS_KIND='NIGHT_ANALYTICS_V1';
export const ANALYTICS_BUDGET_MS=90000;
const fail=code=>{throw Object.assign(Error(code),{code});};
export function validateAnalyticsRequest(r){
 if(!r||Object.keys(r).sort().join(',')!=='configProof,executionMode,kind,releaseSha,requestId,triggerSource'
  ||r.kind!==ANALYTICS_KIND||r.triggerSource!=='cloudflare'||r.executionMode!=='OFF'
  ||!/^[a-f0-9]{40}$/.test(r.releaseSha??'')||!/^[a-f0-9]{64}$/.test(r.configProof??'')
  ||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(r.requestId??''))fail('ANALYTICS_REQUEST_INVALID');
 return r;
}
// The signed request arrives after the scheduled SYNC/companion, not at :10
// exactly. Never accept a daytime/manual analytics invocation.
export const nightAnalyticsWindow=at=>[19,20,21].includes(at.getUTCHours())&&at.getUTCMinutes()>=10&&at.getUTCMinutes()<25;
export function assertAnalyticsBinding(request,{releaseSha,configProof,at}){
 validateAnalyticsRequest(request);
 if(request.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 if(request.configProof!==configProof)fail('EXECUTION_CONFIG_CHANGED');
 if(!nightAnalyticsWindow(at))fail('ANALYTICS_WINDOW_CLOSED');
}

export async function processNightAnalytics({db,keys,userIds,reader,budget,now=()=>new Date(),
 processUser=processAnalyticsForUser,updateMemory=updateAssociationMemory,emit=console.log}){
 const night=localDate(now(),'Asia/Taipei'),owner='night:'+randomUUID(),results=[];
 if(!userIds.length)return {results,deferred:false};
 const slot=now().getUTCHours()-19,start=((slot%userIds.length)+userIds.length)%userIds.length;
 const ordered=[...userIds.slice(start),...userIds.slice(0,start)];
 for(const id of ordered){
  if(budget.remainingMs()<25000)return {results,deferred:true};
  const user=await db.getUser(id);
  if(user?.status!=='ACTIVE'||(await db.getOnboarding(id))?.state!=='READY')continue;
  for(const step of ['LIGHT','HEAVY','MEMORY']){
   if(budget.remainingMs()<25000)return {results,deferred:true};
   budget.assert();const started=Date.now();let status='FAILED';
   const key='night-analysis:'+keys.lookup(['night-analysis-v1',id,user.lifecycleGeneration,night,step]);
   const marker=JSON.stringify({date:night,version:'night-analysis-v1'});
   try{
    if(await db.getState(key)===marker){status='ALREADY_COMPLETED';continue;}
    if(step==='MEMORY'){
     const view=await reader.inspect(id);
     if(!view){status='DEFERRED_BUDGET';break;}
     const result=await updateMemory({db,user,reader,view,now:now()});status=result.status;
    }else{
     // force bypasses only dirty/cadence selection. Original atomic claim,
     // lease, lifecycle, generation, purge and output fences still apply.
     const result=await processUser({db,userId:id,cls:step.toLowerCase(),owner,now,force:true});status=result.result;
    }
    budget.assert();
    if(status==='SUCCESS')await db.setState(key,marker,{now:now()});
    else break;
   }finally{
    results.push({step,status});
    emit(JSON.stringify({event:'night_analytics_step',user:keys.lookup(['companion-diagnostic-user-v1',id]),step,status,duration_ms:Date.now()-started}));
   }
  }
 }
 return {results,deferred:results.some(r=>['PARTIAL','SKIPPED','DEFERRED_BUDGET'].includes(r.status))};
}

export async function runNightAnalytics({request,environment=process.env,db,keys,env,now=()=>new Date(),deps={}}){
 requireRecoveryScope('scheduler');assertSchemaTransitionProfile(environment);validateAnalyticsRequest(request);
 const releaseSha=runningReleaseSha(environment),proof=()=>configurationProof(keys,publicBetaConfiguration(environment),environment,releaseSha);
 assertAnalyticsBinding(request,{releaseSha,configProof:proof(),at:now()});
 const budget=createExecutionBudget({budgetMs:ANALYTICS_BUDGET_MS});let unfollow;
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  let admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const fence=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);if(request.configProof!==proof())fail('EXECUTION_CONFIG_CHANGED');};
  unfollow=followRuntimeRenewal(db.raw,admission,keys,db.transaction,value=>{admission=value;});
  return db.withRuntimeFence(fence,async()=>{
   const runtime=await (deps.createRuntime??createStage7Runtime)({db,keys,env,environment,admission,now});
   if(!runtime)fail('ANALYTICS_READER_UNAVAILABLE');
   const result=await processNightAnalytics({db,keys,userIds:stage7Configuration(environment).userIds,reader:runtime.associations,budget,now,...deps});
   const failed=result.results.filter(r=>['FAILED','FENCED'].includes(r.status)).length;
   return {status:failed?503:200,body:{ok:failed===0,kind:ANALYTICS_KIND,source:'cloudflare',releaseSha,drainAuthorized:false,failed,...result}};
  });
 }));}finally{unfollow?.();budget.close();}
}
