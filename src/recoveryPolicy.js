/** Local recovery artifact policy. No environment-file loading or migration grant. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {runningReleaseSha} from './phase4Release.js';
import {assertSchemaTransitionProfile} from './schemaTransitionProfile.js';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
const scope=new AsyncLocalStorage();
const fail=code=>{throw Object.assign(Error(code),{code});};
export const RECOVERY_PRODUCTION_HOST='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
const bound=['PHASE4_RELEASE_SHA','RENDER_GIT_COMMIT','PHASE4_LOOKUP_KEY','PHASE4_AUDIT_KEY',
 'PHASE4_EXECUTION_PROFILE','PHASE4_EXECUTION_PHASE','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN',
 'KHOS_RUNTIME_SUPERVISOR','KHOS_MAINTENANCE_INGRESS_MODE','BRIEFING_CONTINUATION_SCOPE',
 'PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS',
 'STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION',
 'BODY_ENERGY_ALERTS','PHASE4_BETA_SHADOW_RUNTIME','PHASE4_PUBLIC_BETA_MODE','PHASE4_PUBLIC_BETA_USER_IDS','STAGE8_USER_IDS'];
export function assertRecoveryConfiguration(environment){
 if(!environment?.PHASE4_RELEASE_SHA||!environment.RENDER_GIT_COMMIT)fail('RECOVERY_RELEASE_PINS_REQUIRED');
 runningReleaseSha(environment);assertSchemaTransitionProfile(environment);phase4AuthorityKeys(environment);
 if(!['off',undefined].includes(environment.KHOS_RUNTIME_SUPERVISOR)
  ||!['off',undefined].includes(environment.KHOS_MAINTENANCE_INGRESS_MODE)
  ||!['SYNC',undefined].includes(environment.PHASE4_EXECUTION_PHASE)
  ||environment.BRIEFING_CONTINUATION_SCOPE!=='sync')fail('RECOVERY_ROLE_CONFLICT');
 let url;try{url=new URL(environment.TURSO_DATABASE_URL);}catch{fail('RECOVERY_DATABASE_IDENTITY_REQUIRED');}
 if(!['libsql:','https:'].includes(url.protocol)||url.hostname!==RECOVERY_PRODUCTION_HOST||url.username||url.password||url.port
  ||!['','/'].includes(url.pathname)||url.search||url.hash||!environment.TURSO_AUTH_TOKEN)fail('RECOVERY_DATABASE_IDENTITY_REQUIRED');
 return true;
}
export function requireRecoveryScope(kind){
 const held=scope.getStore();
 if(!['business','database','scheduler'].includes(kind)||!held)fail('RECOVERY_EXPLICIT_ENTRY_REQUIRED');
 assertRecoveryConfiguration(held.environment);
 if(bound.some(name=>process.env[name]!==held.environment[name]))fail('RECOVERY_CONFIGURATION_CHANGED');
 return held.environment;
}
/** Only the fixed business factory is selected, after all local policy checks.
 * Its original trusted profile and full v33 Admission still run before listen. */
export async function startRecoveryBusiness(environment,{listen=true}={}){
 if(typeof listen!=='boolean')fail('RECOVERY_LISTEN_OPTION_INVALID');
 const frozen=Object.freeze({...environment});assertRecoveryConfiguration(frozen);
 return scope.run({environment:frozen},async()=>{
  const {main}=await import('./bot/webhook.js');
  return main({environment:frozen,listen});
 });
}
