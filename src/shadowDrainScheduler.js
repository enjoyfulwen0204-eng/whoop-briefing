import { requireTriggerSource,stage6SchedulerDecision } from './schedulerPolicy.js';
import { readPhaseProgress } from './phase4ExecutionStore.js';

/** Shared entry point for authorized server composition, including event and
 * manual calls. Absence of an explicitly injected worker leaves production OFF. */
export async function runPhase4Stage6({db,worker,triggerSource='manual',now=new Date(),userId=null,budget,onProgress}={}) {
  requireTriggerSource(triggerSource);
  const stopped=(outcome,role)=>({outcome,triggerSource,role,jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,
    completion:'PARTIAL',stopReason:outcome});
  if(!worker)return stopped('DISABLED');
  const progress=triggerSource==='github'&&db.raw?await readPhaseProgress(db,'STAGE6_DRAIN','cloudflare'):null;
  const cloudflareHeartbeat=progress?.complete&&['PARTIAL','COMPLETE','NO_WORK'].includes(progress.state)
    ?{lastOkAt:new Date(progress.complete.updatedAt).toISOString()}:null;
  const decision=stage6SchedulerDecision({source:triggerSource,now,cloudflareHeartbeat});
  if(!decision.drain)return stopped('POLICY_DEFERRED',decision.role);
  return {...await worker.drain({triggerSource,userId,onProgress,...(budget?{budget}:{})}),role:decision.role};
}
