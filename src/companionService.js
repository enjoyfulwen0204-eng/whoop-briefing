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
export const COMPANION_BUDGET_MS=45000;
const fail=code=>{throw Object.assign(Error(code),{code});};
export function validateCompanionRequest(request){
 if(!request||Object.keys(request).sort().join(',')!=='configProof,executionMode,kind,releaseSha,requestId,triggerSource'
  ||request.kind!==COMPANION_KIND||request.triggerSource!=='cloudflare'
  ||!['OFF','SHADOW'].includes(request.executionMode)||!/^[a-f0-9]{40}$/.test(request.releaseSha??'')
  ||!/^[a-f0-9]{64}$/.test(request.configProof??'')||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(request.requestId??''))fail('COMPANION_REQUEST_INVALID');
 return request;
}
/** Post-morning work reuses confirmed report receipts and durable delivery
 * identities. This service cannot enter SYNC, DRAIN, WHOOP refresh or an AI call. */
export async function runCompanionService({request,environment=process.env,db:providedDb,env:providedEnv,
 keys:providedKeys,now=()=>new Date(),deps={},budgetMs=COMPANION_BUDGET_MS}={}){
 validateCompanionRequest(request);
 if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>COMPANION_BUDGET_MS)fail('COMPANION_BUDGET_INVALID');
 const startedAtMs=Date.now(),keys=providedKeys??publicBetaKeys(environment),config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 const proof=()=>configurationProof(keys,publicBetaConfiguration(environment),environment,releaseSha);
 if(request.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 if(request.configProof!==proof()||request.executionMode!==(config.runtime==='on'?'SHADOW':'OFF'))fail('EXECUTION_CONFIG_CHANGED');
 const cohort=stage7Configuration(environment),base={kind:COMPANION_KIND,source:'cloudflare',releaseSha,drainAuthorized:false};
 if(cohort.mode==='off'||!cohort.automatic)return {status:200,body:{ok:true,...base,enabled:false,checked:0}};
 const env=providedEnv??loadEnv(),db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 const budget=createExecutionBudget({budgetMs,startedAtMs});let unfollow;
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  let admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const fence=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);if(proof()!==request.configProof)fail('EXECUTION_CONFIG_CHANGED');};
  unfollow=followRuntimeRenewal(db.raw,admission,keys,db.transaction,value=>{admission=value;});
  return db.withRuntimeFence(fence,async()=>{
   const runtime=await (deps.createRuntime??createStage7Runtime)({db,keys,env,environment,admission,now});
   let checked=0,failed=0;const outcomes={};
   for(const id of cohort.userIds){
    fence();const user=await db.getUser(id);
    if(!user||user.status!=='ACTIVE'||(await db.getOnboarding(id))?.state!=='READY')continue;
    const chatId=await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:user.lifecycleGeneration});if(!chatId)continue;
    try{
     const result=await runtime.tick({user,chatId});checked++;
     const statuses=[result.status,result.daily,result.coach,result.weekly].filter(Boolean);
     for(const status of statuses)outcomes[status]=(outcomes[status]??0)+1;
     if(statuses.some(status=>['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS'].includes(status)))failed++;
    }catch{fence();failed++;}
   }
   fence();if(!failed)await db.recordHeartbeat('global','companion_v1',{now:now(),detail:`checked=${checked}`});
   return {status:failed?503:200,body:{ok:failed===0,...base,enabled:true,checked,failed,outcomes}};
  });
 }));}finally{unfollow?.();budget.close();if(!providedDb)db.close();}
}
