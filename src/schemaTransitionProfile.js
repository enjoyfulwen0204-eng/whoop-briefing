import {requirePhase4Keys} from './phase4Keys.js';
import {runningReleaseSha} from './phase4Release.js';

export const SCHEMA_TRANSITION_PROFILE='STAGE8_SCHEMA_TRANSITION';
export const SCHEMA_TRANSITION_SOURCE_SHA='ca4bff7b711737527ca6c4e306d4a3ef555c9f3b';
const issued=new WeakMap();
const fail=code=>{throw Object.assign(Error(code),{code});};
const offFields=Object.freeze([
 'PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF',
 'STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER',
 'BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS','PHASE4_BETA_SHADOW_RUNTIME',
]);
const boundFields=Object.freeze(['PHASE4_EXECUTION_PROFILE','PHASE4_RELEASE_SHA','RENDER_GIT_COMMIT',
 ...offFields,'PHASE4_PUBLIC_BETA_MODE','PHASE4_PUBLIC_BETA_USER_IDS','STAGE8_USER_IDS']);
const selected=environment=>JSON.stringify(boundFields.map(name=>environment[name]??null));

/** Compatibility is not an activation grant. Existing Stage7, Morning Brief,
 * Settings and their original automatic-delivery policy remain unchanged. */
export function assertSchemaTransitionProfile(environment={}){
 if(environment.PHASE4_EXECUTION_PROFILE!==SCHEMA_TRANSITION_PROFILE)fail('SCHEMA_TRANSITION_PROFILE_REQUIRED');
 if(offFields.some(name=>(environment[name]??'off')!=='off')
  ||(environment.PHASE4_PUBLIC_BETA_MODE??'off')!=='off'
  ||(environment.PHASE4_PUBLIC_BETA_USER_IDS??'')!==''
  ||(environment.STAGE8_USER_IDS??'')!=='')fail('SCHEMA_TRANSITION_NEW_FEATURES_OFF_REQUIRED');
 return SCHEMA_TRANSITION_PROFILE;
}

/** Explicit server composition only. A profile string, JSON, request or
 * admission option is never a33 capability. The issuer verifies this actual
 * checkout and binds the original frozen source, keys and static OFF policy.
 * Root must separately qualify the release, service/Worker and owner window. */
export function createSchemaTransitionRuntimeProfile({environment,keys}={}){
 requirePhase4Keys(keys);assertSchemaTransitionProfile(environment);
 const releaseSha=runningReleaseSha(environment),configuration=selected(environment),profile=Object.freeze({});
 issued.set(profile,{environment,keys,releaseSha,configuration});return profile;
}
export function schemaTransitionRuntimeProfileFor({environment,keys}={}){
 if(environment?.PHASE4_EXECUTION_PROFILE!==SCHEMA_TRANSITION_PROFILE)return undefined;
 return createSchemaTransitionRuntimeProfile({environment,keys});
}
export function requireSchemaTransitionRuntimeProfile(profile,keys){
 const held=issued.get(profile);
 if(!held||held.keys!==keys)fail('SCHEMA_TRANSITION_TRUSTED_PROFILE_REQUIRED');
 requirePhase4Keys(keys);assertSchemaTransitionProfile(held.environment);
 if(selected(held.environment)!==held.configuration)fail('SCHEMA_TRANSITION_CONFIGURATION_CHANGED');
 return Object.freeze({sourceSha:SCHEMA_TRANSITION_SOURCE_SHA,releaseSha:held.releaseSha});
}
export function bindSchemaTransitionRuntimeProfile(profile,keys,client){
 requireSchemaTransitionRuntimeProfile(profile,keys);const held=issued.get(profile);
 if(held.client!==undefined&&held.client!==client)fail('SCHEMA_TRANSITION_CONNECTION_PROFILE_CHANGED');
 held.client=client;
}
