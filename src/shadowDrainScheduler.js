import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { requireTriggerSource,stage6SchedulerDecision } from './schedulerPolicy.js';

/** Shared entry point for authorized server composition, including event and
 * manual calls. Absence of an explicitly injected worker leaves production OFF. */
export async function runPhase4Stage6({db,worker,triggerSource='manual',now=new Date(),userId=null,budget}={}) {
  requireTriggerSource(triggerSource);
  if(!worker)return {outcome:'DISABLED',triggerSource};
  const cloudflareHeartbeat=triggerSource==='github'
    ?await db.getHeartbeat(GLOBAL_SCOPE,HEARTBEAT_COMPONENT.CLOUDFLARE):null;
  const decision=stage6SchedulerDecision({source:triggerSource,now,cloudflareHeartbeat});
  if(!decision.drain)return {outcome:'POLICY_DEFERRED',triggerSource,role:decision.role};
  return {...await worker.drain({triggerSource,userId,...(budget?{budget}:{})}),role:decision.role};
}
