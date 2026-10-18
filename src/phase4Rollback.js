import {assertStage8Recovery} from './stage8Policy.js';
import {publicBetaConfiguration} from './publicBetaConfig.js';
import {SCHEMA_TRANSITION_PROFILE,assertSchemaTransitionProfile} from './schemaTransitionProfile.js';
export function executionProfile(environment={}){
 assertStage8Recovery(environment);
 const profile=environment.PHASE4_EXECUTION_PROFILE??'PHASE4';
 if(profile===SCHEMA_TRANSITION_PROFILE)return assertSchemaTransitionProfile(environment);
 if(!['PHASE4','RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY','STAGE8_V35_RECOVERY'].includes(profile))throw Object.assign(Error('EXECUTION_PROFILE_INVALID'),{code:'EXECUTION_PROFILE_INVALID'});
 if(['RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY','STAGE8_V35_RECOVERY'].includes(profile)){
  const config=publicBetaConfiguration(environment);
  if(profile==='COMPANION_V33_RECOVERY'&&((environment.STAGE7_COMPANION??'off')!=='off'||(environment.BODY_ENERGY_PUBLICATION??'off')!=='off'||(environment.BODY_ENERGY_ALERTS??'off')!=='off'))throw Object.assign(Error('RECOVERY_FEATURES_OFF_REQUIRED'),{code:'RECOVERY_FEATURES_OFF_REQUIRED'});
  // Same-schema recovery keeps the separately authorized v33 companion path.
  // It grants no producer, Stage8 reader, cutover or Body Energy authority.
  if(profile==='STAGE8_V35_RECOVERY'&&((environment.STAGE7_AUTOMATIC??'off')!=='off'||(environment.BODY_ENERGY_PUBLICATION??'off')!=='off'||(environment.BODY_ENERGY_ALERTS??'off')!=='off'))throw Object.assign(Error('RECOVERY_FEATURES_OFF_REQUIRED'),{code:'RECOVERY_FEATURES_OFF_REQUIRED'});
  if(config.runtime!=='off'||config.mode!=='off'||(environment.PHASE4_PUBLIC_BETA_USER_IDS??'').trim())
   throw Object.assign(Error('ROLLBACK_OFF_OFF_REQUIRED'),{code:'ROLLBACK_OFF_OFF_REQUIRED'});
 }
 return profile;
}
