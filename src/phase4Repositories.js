import { fail, requireInteger } from './phase4Core.js';
import { createPhase4QueueStore } from './phase4QueueStore.js';
import { createPhase4EntityStore } from './phase4EntityStore.js';
import { createPhase4PrivacyStore } from './phase4PrivacyStore.js';
import { createPhase4EpisodeStore } from './phase4EpisodeStore.js';
import { createPhase4MessageStore } from './phase4MessageStore.js';
import { createPhase4SlotStore } from './phase4SlotStore.js';
import { createPhase4ExperimentStore } from './phase4ExperimentStore.js';
import { createPhase4InsightStore } from './phase4InsightStore.js';
import { createPhase4TransportStore } from './phase4TransportStore.js';
import { createBodyEnergyStore } from './bodyEnergyStore.js';

/** Composition is internal to the server factory and the synthetic fixture;
 * it does not issue execution contexts or accept request-owned authority. */
export function composePhase4Stores(core) {
  const {client,transaction,timestamp}=core;
  const queue=createPhase4QueueStore(core);
  const entities=createPhase4EntityStore(core),privacy=createPhase4PrivacyStore(core,queue);
  const episodes=createPhase4EpisodeStore(core,entities);
  const messages=createPhase4MessageStore(core,entities),slots=createPhase4SlotStore(core,entities,messages);
  const experiments=createPhase4ExperimentStore(core,privacy,queue);
  async function initializeTenant(userId,mode) {
    return transaction(async()=>{
      const result=await core.initializeTenant(userId,mode);
      if(result.created && mode==='LIVE') {
        const state=await core.userState(userId);
        await queue.markFull(userId,mode,1,state.purge_generation,'ALGORITHM_CHANGED');
      }
      return result;
    });
  }
  async function preferences(control) {
    return transaction(async()=>{
      await core.assertControl(control);
      await client.execute({sql:`INSERT INTO user_notification_preferences(user_id,created_at,updated_at)
        VALUES (?,?,?) ON CONFLICT DO NOTHING`,args:[control.userId,timestamp(),timestamp()]});
      return {...(await client.execute({sql:'SELECT * FROM user_notification_preferences WHERE user_id=?',args:[control.userId]})).rows[0]};
    });
  }
  async function updatePreferences(control,expectedVersion,patch) {
    requireInteger(expectedVersion);
    const allowed=['notifications_paused','morning_brief_mode','morning_brief_local_time','after_wake_delay_minutes','fallback_local_time'];
    if(!patch || !Object.keys(patch).length || Object.keys(patch).some(k=>!allowed.includes(k)))fail('PHASE4_INVALID_PREFERENCE_PATCH');
    return transaction(async()=>{
      await core.assertControl(control);
      await preferences(control);
      const entries=Object.entries(patch);
      const result=await client.execute({sql:`UPDATE user_notification_preferences SET ${entries.map(([k])=>`${k}=?`).join(',')},
        preference_version=preference_version+1,updated_at=? WHERE user_id=? AND preference_version=?`,
      args:[...entries.map(([,v])=>v),timestamp(),control.userId,expectedVersion]});
      if(result.rowsAffected!==1)fail('PHASE4_PREFERENCE_CAS_LOST');
      if(patch.notifications_paused===1)await slots.pauseExisting(control);
      await core.assertControl(control);return preferences(control);
    });
  }
  return Object.freeze({initializeTenant,capture:core.capture,captureControl:core.captureControl,capturePrivacyControl:core.capturePrivacyControl,
    assertCurrent:context=>core.assertContext(context),root:core.root,readArtifact:core.artifact,
    release:context=>transaction(()=>core.contextRegistry.release(context)),
    cache:Object.freeze({
      get:(context,key)=>core.run(context,()=>structuredClone(core.contextRegistry.get(context,key))),
      set:(context,key,value)=>core.run(context,()=>{core.contextRegistry.set(context,key,value);}),
    }),
    privacy:Object.freeze({admit:privacy.admit,redact:privacy.redact,complete:privacy.complete,status:privacy.status}),
    episodes:Object.freeze(episodes),
    insights:Object.freeze(createPhase4InsightStore(core,entities)),
    messages:Object.freeze({propose:messages.propose,readReservation:messages.readReservation,simulate:messages.simulate}),
    slots:Object.freeze(Object.fromEntries(Object.entries(slots).filter(([name])=>!['pauseExisting','transportStart','transportSettle'].includes(name)))),
    transport:Object.freeze(createPhase4TransportStore(core,entities,{start:slots.transportStart,settle:slots.transportSettle})),
    experiments:Object.freeze(experiments),
    bodyEnergy:createBodyEnergyStore(core,entities,queue),
    decisions:Object.freeze({append:(context,data,refs)=>entities.append(context,'phase4_proactive_decisions',data,refs)}),
    evidence:Object.freeze({
      start:(context,data,refs)=>entities.append(context,'evidence_runs',{...data,state:'STARTED'},refs),
      complete:entities.completeEvidence,
      addItem:(context,data,refs)=>entities.append(context,'evidence_items',data,refs),
    }),
    queue:Object.freeze({sourceChanged:queue.sourceChanged,read:queue.read,claim:queue.claim,complete:queue.complete,fail:queue.fail}),
    preferences:Object.freeze({read:preferences,update:updatePreferences})});
}
