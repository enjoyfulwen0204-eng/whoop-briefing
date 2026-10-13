import {createStage8MorningRuntime} from './stage8MorningRuntime.js';
import {createDb} from './db.js';
import {loadEnv} from './config.js';
import {runForUser} from './index.js';
import {publicBetaConfiguration,publicBetaKeys} from './publicBetaConfig.js';
import {configurationProof} from './phase4ExecutionStore.js';
import {runningReleaseSha} from './phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {mapWithConcurrency} from './concurrency.js';
import {GLOBAL_SCOPE,USER_STATUS} from './schema.js';
import {createBodyEnergyRuntime,bodyEnergyConfiguration} from './bodyEnergyRuntime.js';
import {MORNING_READINESS_HEARTBEAT,morningServiceSlotOrdinal} from './schedulerPolicy.js';
import {HEARTBEAT_COMPONENT} from './guardianPolicy.js';

export const MORNING_READINESS_PATH='/internal/briefing/readiness';
export const MORNING_READINESS_KIND='MORNING_READINESS_V1';
export const MORNING_READINESS_BUDGET_MS=90_000;
const fail=code=>{throw Object.assign(Error(code),{code});};
export function validateMorningReadinessRequest(request){
 if(!request||Object.keys(request).sort().join(',')!=='configProof,executionMode,kind,releaseSha,requestId,triggerSource'
  ||request.kind!==MORNING_READINESS_KIND||request.triggerSource!=='cloudflare'
  ||!['OFF','SHADOW'].includes(request.executionMode)||!/^[a-f0-9]{40}$/.test(request.releaseSha??'')
  ||!/^[a-f0-9]{64}$/.test(request.configProof??'')||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/.test(request.requestId??''))fail('READINESS_REQUEST_INVALID');
 return request;
}

/** Signed scheduler readiness. This is not a SYNC phase and grants no DRAIN
 * handoff. Existing runtime, user ownership and report/transport claims govern
 * the daily work; optional pilot authority is neither read nor consumed. */
export async function runMorningReadiness({request,environment=process.env,db:providedDb,env:providedEnv,
 keys:providedKeys,deps={},now=()=>new Date(),budgetMs=MORNING_READINESS_BUDGET_MS}={}){
 validateMorningReadinessRequest(request);
 if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>MORNING_READINESS_BUDGET_MS)fail('READINESS_BUDGET_INVALID');
 const startedAtMs=Date.now();
 const env=providedEnv??loadEnv(),keys=providedKeys??publicBetaKeys(environment);
 const config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 if(request.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 const proof=()=>configurationProof(keys,publicBetaConfiguration(environment),environment,releaseSha);
 if(request.configProof!==proof()||request.executionMode!==(config.runtime==='on'?'SHADOW':'OFF'))fail('EXECUTION_CONFIG_CHANGED');
 const db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 const budget=createExecutionBudget({budgetMs,startedAtMs});
 let stopFollowing;
 try {
  if(db.raw?.protocol==='ws')fail('READINESS_TRANSPORT_UNSUPPORTED');
  return await withExecutionBudget(budget,()=>budget.run(async()=>{
   let admission=await db.admitRuntime({source:'cloudflare',fresh:true});
   const fence=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);
    if(runningReleaseSha(environment)!==releaseSha||request.configProof!==proof())fail('EXECUTION_CONFIG_CHANGED');};
   fence();stopFollowing=followRuntimeRenewal(db.raw,admission,keys,db.transaction,value=>{admission=value;});
   return db.withRuntimeFence(fence,async()=>{
    let bodyEnergy=deps.bodyEnergy;
    if(!bodyEnergy&&bodyEnergyConfiguration(environment).publication==='on')
     bodyEnergy=(await createBodyEnergyRuntime({db,keys,admission,environment,env})).bodyEnergy;
    const morning=deps.morning??await createStage8MorningRuntime({db,keys,admission,environment,env,now});
    const users=await db.listSchedulableUsers({activeStatus:USER_STATUS.ACTIVE});
    // Rotate the start at the coarse deployed slot so slow accounts cannot
    // permanently starve later accounts; retries keep canonical daily claims.
    const at=now(),offset=users.length?morningServiceSlotOrdinal(at)%users.length:0;
    const ordered=[...users.slice(offset),...users.slice(0,offset)];
    const results=await mapWithConcurrency(ordered,env.maxUserConcurrency,user=>{
     fence();return (deps.runUser??runForUser)({db,env,user,now:now(),readinessOnly:true,
      deps:{...deps,bodyEnergy,morning,executionBudget:budget,presentationClock:now}});
    });
    fence();
    const failed=results.filter(r=>!r.ok||r.value?.errors?.length).length;
    const sent=results.filter(r=>r.ok&&r.value?.daily?.status==='sent').length;
    const summary={users:users.length,failed,sent,durationMs:Date.now()-startedAtMs};
    if(!users.length||failed<users.length){
     const detail=`kind=${MORNING_READINESS_KIND};users=${users.length};failed=${failed};sent=${sent}`;
     await db.recordHeartbeat(GLOBAL_SCOPE,MORNING_READINESS_HEARTBEAT,{now:now(),detail});
     await db.recordHeartbeat(GLOBAL_SCOPE,HEARTBEAT_COMPONENT.CRON,{now:now(),detail});
    }
    fence();return {status:failed===users.length&&users.length?503:200,
     body:{ok:!users.length||failed<users.length,kind:MORNING_READINESS_KIND,source:'cloudflare',
      releaseSha,readinessChecked:true,syncComplete:false,drainAuthorized:false,result:summary}};
   });
  }));
 } finally {stopFollowing?.();budget.close();if(!providedDb)db.close();}
}
