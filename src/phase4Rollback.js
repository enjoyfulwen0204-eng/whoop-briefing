import {publicBetaConfiguration} from './publicBetaConfig.js';
export function executionProfile(environment={}){
 const profile=environment.PHASE4_EXECUTION_PROFILE??'PHASE4';
 if(!['PHASE4','RC2_V32_ROLLBACK'].includes(profile))throw Object.assign(Error('EXECUTION_PROFILE_INVALID'),{code:'EXECUTION_PROFILE_INVALID'});
 if(profile==='RC2_V32_ROLLBACK'){
  const config=publicBetaConfiguration(environment);
  if(config.runtime!=='off'||config.mode!=='off'||(environment.PHASE4_PUBLIC_BETA_USER_IDS??'').trim())
   throw Object.assign(Error('ROLLBACK_OFF_OFF_REQUIRED'),{code:'ROLLBACK_OFF_OFF_REQUIRED'});
 }
 return profile;
}
