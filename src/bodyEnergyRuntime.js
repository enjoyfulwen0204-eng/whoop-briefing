import {createPhase4Foundation} from './phase4Foundation.js';
import {requireUserId} from './userContext.js';
import {authorizeBodyEnergyPublication} from './bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from './bodyEnergyIntegration.js';
import {createBodyEnergyAlertDelivery} from './bodyEnergyAlertDelivery.js';
export function bodyEnergyConfiguration(environment={}){
  const publication=environment.BODY_ENERGY_PUBLICATION??'off',alerts=environment.BODY_ENERGY_ALERTS??'off';
  if(!['off','on'].includes(publication)||!['off','on'].includes(alerts)||alerts==='on'&&publication!=='on')throw Error('BODY_ENERGY_CONFIG_INVALID');
  const ids=name=>{const raw=environment[name]??'';if(typeof raw!=='string')throw Error('BODY_ENERGY_CONFIG_INVALID');
    const values=raw?raw.split(',').map(id=>requireUserId(id.trim(),'bodyEnergyConfig')):[];
    if(values.length>2||new Set(values).size!==values.length)throw Error('BODY_ENERGY_CONTROLLED_COHORT_REQUIRED');return values;};
  const userIds=ids('BODY_ENERGY_USER_IDS'),notificationUserIds=ids('BODY_ENERGY_NOTIFICATION_USER_IDS');
  if(publication==='on'&&!userIds.length||notificationUserIds.some(id=>!userIds.includes(id))||alerts==='on'&&!notificationUserIds.length)
    throw Error('BODY_ENERGY_CONFIG_INVALID');
  return Object.freeze({publication,alerts,userIds:Object.freeze(userIds),notificationUserIds:Object.freeze(notificationUserIds),
    qualificationId:environment.BODY_ENERGY_QUALIFICATION_ID??null});
}
/** Approved server composition; no flag can supply the independent empirical
 * packet or grant. All Foundation/Stage 7 LIVE switches remain unchanged. */
export async function createBodyEnergyRuntime({db,keys,admission,environment={},env,now=()=>new Date()}={}){
  const config=bodyEnergyConfiguration(environment);
  const stores=await createPhase4Foundation({db,keys,admission:admission??await db.admitRuntime()});
  const publicationCapability=config.publication==='on'?authorizeBodyEnergyPublication({db,userIds:config.userIds,
    notificationUserIds:config.alerts==='on'?config.notificationUserIds:[],qualificationId:config.qualificationId}):null;
  const bodyEnergy=createBodyEnergyIntegration({db,stores,keys,publicationCapability,environment,now});
  const bodyEnergyAlerts=publicationCapability&&config.alerts==='on'
    ?createBodyEnergyAlertDelivery({db,stores,keys,publicationCapability,env,now}):null;
  return Object.freeze({bodyEnergy,bodyEnergyAlerts,publicationQualified:Boolean(publicationCapability),configuration:config});
}
