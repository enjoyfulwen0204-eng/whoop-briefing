import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { schedulerProviderState,requireTriggerSource } from './schedulerPolicy.js';
import { log,describeError } from './logger.js';

export const SCHEDULER_POLICY=Object.freeze({
  cloudflare:Object.freeze({role:'morning_primary',component:HEARTBEAT_COMPONENT.CLOUDFLARE,
    healthyAgeMs:30*60000,alertableAgeMs:30*60000,notify:true}),
  github:Object.freeze({role:'background_and_fallback',component:HEARTBEAT_COMPONENT.GITHUB,
    healthyAgeMs:3*3600000,alertableAgeMs:3*3600000,notify:true}),
});
export const SCHEDULER_ALERT_COOLDOWN_HOURS=24;
export const SCHEDULER_ALERT_TYPE='scheduler_primary_stale';
export const providerState=schedulerProviderState;
export function aggregateSchedulerState(cloudflare,github) {
  if(cloudflare.state==='not_expected')return github.state==='healthy'?'healthy':'outage';
  if(['healthy','startup_grace'].includes(cloudflare.state))return 'healthy';
  return github.ageMs!==null&&github.ageMs<=3*3600000?'degraded':'outage';
}
export async function readSchedulerHealth({db,now=new Date()}) {
  const [cf,gh]=await Promise.all([
    db.getHeartbeat(GLOBAL_SCOPE,HEARTBEAT_COMPONENT.CLOUDFLARE),
    db.getHeartbeat(GLOBAL_SCOPE,HEARTBEAT_COMPONENT.GITHUB),
  ]);
  const cloudflare=providerState(cf,'cloudflare',now),github=providerState(gh,'github',now);
  return {cloudflare,github,overall:aggregateSchedulerState(cloudflare,github)};
}
/** Evaluation requires a running invocation. Total scheduler silence needs
 * external monitoring; this function does not create a background watcher. */
export async function checkPeerScheduler({db,source,systemTelegram,now=new Date()}) {
  try {
    requireTriggerSource(source);
    const health=await readSchedulerHealth({db,now});
    if(source==='event'||source==='manual')return {...health,peer:null,alerted:false,recovered:false};
    const peer=source==='cloudflare'?health.github:health.cloudflare;
    const expected=health.cloudflare.expected?health.cloudflare:health.github;
    const alertType=expected.provider==='cloudflare'?SCHEDULER_ALERT_TYPE:'scheduler_github_stale';
    let alerted=false,recovered=false;
    log.info('scheduler_watchdog_state',{source,peer:peer.provider,peer_state:peer.state,overall:health.overall});
    if(expected.state==='stale')alerted=await systemTelegram.notifyError(alertType,
      `The expected ${expected.provider} scheduler has no recent successful completion.`,
      {cooldownHours:SCHEDULER_ALERT_COOLDOWN_HOURS});
    // A quiet interval or a manual/event call cannot clear a recorded outage.
    const own=health[source],ownAlert=source==='cloudflare'?SCHEDULER_ALERT_TYPE:'scheduler_github_stale';
    if(own.state==='healthy'&&typeof db.hasErrorNotify==='function'&&await db.hasErrorNotify(GLOBAL_SCOPE,ownAlert)) {
      await db.clearErrorNotify(GLOBAL_SCOPE,ownAlert);recovered=true;
      try {await systemTelegram.send('✅ 簡報排程已恢復正常，後續會照常檢查。');}
      catch(error){log.warn('scheduler_recovery_notify_failed',{error:describeError(error)});}
    }
    return {...health,peer:peer.provider,alerted,recovered};
  } catch(error) {
    log.warn('scheduler_watchdog_failed',{source,error:describeError(error)});
    return {overall:'unknown',peer:null,alerted:false,recovered:false};
  }
}
