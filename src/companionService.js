import {createStage8Runtime,stage8Configuration} from './stage8Runtime.js';
import {createDb} from './db.js';
import {loadEnv} from './config.js';
import {publicBetaConfiguration,publicBetaKeys} from './publicBetaConfig.js';
import {configurationProof} from './phase4ExecutionStore.js';
import {runningReleaseSha} from './phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {createStage7Runtime,stage7Configuration} from './stage7Runtime.js';
import {validateMorningReadinessRequest} from './morningReadiness.js';
export const COMPANION_PATH='/internal/briefing/companion';
export const COMPANION_KIND='COMPANION_V1';
export function validateCompanionRequest(request){if(request?.kind!==COMPANION_KIND)throw Error('COMPANION_REQUEST_INVALID');validateMorningReadinessRequest({...request,kind:'MORNING_READINESS_V1'});return request;}
/** Separate post-morning service budget. Never owns ordinary briefing claims,
 * WHOOP refresh, pilot entry, reanalysis or an AI call on scheduler ticks. */
export async function runCompanionService({request,environment=process.env,db:providedDb,env:providedEnv,keys:providedKeys,now=()=>new Date(),deps={},budgetMs=45000}={}){
 validateCompanionRequest(request);if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>45000)throw Error('COMPANION_BUDGET_INVALID');
 const startedAtMs=Date.now(),env=providedEnv??loadEnv(),keys=providedKeys??publicBetaKeys(environment),config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 const proof=()=>configurationProof(keys,publicBetaConfiguration(environment),environment,releaseSha);
 if(request.releaseSha!==releaseSha)throw Error('RELEASE_CHECKOUT_MISMATCH');
 if(request.configProof!==proof()||request.executionMode!==(config.runtime==='on'?'SHADOW':'OFF'))throw Error('EXECUTION_CONFIG_CHANGED');
 const cohort=stage7Configuration(environment),stage8Config=stage8Configuration(environment),ownerEnabled=stage8Config.enabled&&environment.PHASE4_STAGE8_OWNER_MONITORING==='on';if(cohort.mode==='off'&&!ownerEnabled)return {status:200,body:{ok:true,kind:COMPANION_KIND,source:'cloudflare',releaseSha,enabled:false,drainAuthorized:false}};
 const db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys}),budget=createExecutionBudget({budgetMs,startedAtMs});let unfollow;
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  let admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const fence=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);if(proof()!==request.configProof)throw Error('EXECUTION_CONFIG_CHANGED');};
  unfollow=followRuntimeRenewal(db.raw,admission,keys,db.transaction,value=>{admission=value;});
  return db.withRuntimeFence(fence,async()=>{
   const ownerRuntime=ownerEnabled?await createStage8Runtime({db,keys,env,environment,now}):null;
   const runtime=await (deps.createRuntime??createStage7Runtime)({db,keys,env,environment,admission,now});let checked=0;
   for(const id of runtime?cohort.userIds:[]){fence();const user=await db.getUser(id);if(!user||user.status!=='ACTIVE'||(await db.getOnboarding?.(id))?.state!=='READY')continue;
    const chatId=await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:user.lifecycleGeneration});if(!chatId)continue;
    await runtime.tick({user,chatId});checked++;
   }
   let ownerChecked=0;
   if(ownerRuntime?.owner){const user=await db.getUser(stage8Config.userIds[0]),chatId=user&&await db.getActiveChatIdForUser(user.id,{expectedLifecycleGeneration:user.lifecycleGeneration});if(chatId){fence();ownerChecked=(await ownerRuntime.owner.tick({user,chatId})).checked;}}
   fence();await db.recordHeartbeat('global','companion_v1',{now:now(),detail:`checked=${checked}`});
   return {status:200,body:{ok:true,kind:COMPANION_KIND,source:'cloudflare',releaseSha,enabled:true,checked,ownerChecked,drainAuthorized:false}};
  });
 }));}finally{unfollow?.();budget.close();if(!providedDb)db.close();}
}
