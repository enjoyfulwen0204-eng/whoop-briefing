/** Stage 8 release controls are server configuration, never request authority. */
export const STAGE8_CONFIGURATION_FIELDS=Object.freeze([
 'PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS',
 'STAGE8_USER_IDS','PHASE4_BETA_PILOT_USER_ID','PHASE4_DELIVERY_CUTOVER','PHASE4_EXECUTION_PROFILE',
]);
export function stage8ConfigurationValues(environment){return STAGE8_CONFIGURATION_FIELDS.map(name=>environment[name]??'');}
export function assertStage8Recovery(environment){
 if(['RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY'].includes(environment.PHASE4_EXECUTION_PROFILE)
  &&['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','PHASE4_DELIVERY_CUTOVER'].some(name=>(environment[name]??'off')!=='off'))
  throw Object.assign(Error('RECOVERY_STAGE8_FEATURES_OFF_REQUIRED'),{code:'RECOVERY_STAGE8_FEATURES_OFF_REQUIRED'});
}
export function stage8ConfigurationFence(environment){
 assertStage8Recovery(environment);const captured=JSON.stringify(stage8ConfigurationValues(environment));
 return ()=>{assertStage8Recovery(environment);if(JSON.stringify(stage8ConfigurationValues(environment))!==captured)throw Error('STAGE8_CONFIGURATION_CHANGED');};
}
