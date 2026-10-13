import {publicBetaConfiguration} from './publicBetaConfig.js';
export function executionProfile(environment={}){
 const profile=environment.PHASE4_EXECUTION_PROFILE??'PHASE4';
 if(!['PHASE4','RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY'].includes(profile))throw Object.assign(Error('EXECUTION_PROFILE_INVALID'),{code:'EXECUTION_PROFILE_INVALID'});
 if(profile==='RC2_V32_ROLLBACK'||profile==='COMPANION_V33_RECOVERY'){
  const config=publicBetaConfiguration(environment);
  if(profile==='COMPANION_V33_RECOVERY'&&((environment.STAGE7_COMPANION??'off')!=='off'||(environment.BODY_ENERGY_PUBLICATION??'off')!=='off'||(environment.BODY_ENERGY_ALERTS??'off')!=='off'))throw Object.assign(Error('RECOVERY_FEATURES_OFF_REQUIRED'),{code:'RECOVERY_FEATURES_OFF_REQUIRED'});
  if(config.runtime!=='off'||config.mode!=='off'||(environment.PHASE4_PUBLIC_BETA_USER_IDS??'').trim())
   throw Object.assign(Error('ROLLBACK_OFF_OFF_REQUIRED'),{code:'ROLLBACK_OFF_OFF_REQUIRED'});
 }
 return profile;
}
