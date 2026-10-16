/** Operator-only compatibility for the exact still-running v33 release.
 * This never changes the application proof or accepts either of two formulas. */
import {createHash} from 'node:crypto';
import {configurationProof as targetConfigurationProof} from '../src/phase4ExecutionStore.js';
import {requireReleaseSha,runningReleaseSha} from '../src/phase4Release.js';
import {continuationScope} from '../src/phase4ContinuationScope.js';
const contract={"sourceSha":"ca4bff7b711737527ca6c4e306d4a3ef555c9f3b","sourceModuleSha256":"5177935d79bdb17780cc2b3bda0271e08a2758e7675086ff5e109f2b4901c230","canonicalFunctionSha256":"8161be176968b8522cb4bae1762392170981412bd16ef401d1f8bf8e87ff96c4","immutableBlobs":{"src/phase4ExecutionStore.js":"3359b0e93054ee4bf05e3ee074a00c5bebfd8ea2","src/phase4Release.js":"4148fd2b83b41f56dd8c10bd108da8d13fa639b4","src/phase4ContinuationScope.js":"b7a26409cdf1192deea9a5e522106b23ae14ee13"},"schemas":[33,34,35]};
export const CA4_SOURCE_PROOF=Object.freeze({...contract,immutableBlobs:Object.freeze(contract.immutableBlobs),schemas:Object.freeze(contract.schemas)});
const fail=(code='STAGE8_SOURCE_PROOF_COMPATIBILITY_REQUIRED')=>{throw Object.assign(Error(code),{code});};
const newFlags=['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS'];
// Byte-identical arrow function from the immutable ca4 source below. Its source
// text and dependency blobs are pinned and independently compared in tests.
const legacyCa4ConfigurationProof=(keys,config,environment,releaseSha=runningReleaseSha(environment))=>{
 const profile=['phase4-configuration-v2',requireReleaseSha(releaseSha),config.runtime,config.mode,
  (environment.PHASE4_PUBLIC_BETA_USER_IDS??'').split(',').filter(Boolean).map(x=>x.trim()).sort()];
 const pilot=['ID','USER_ID','START_AT','CONSENT_SHA256','COST_BOUND_ID'].map(name=>environment[`PHASE4_BETA_PILOT_${name}`]??'');
 // Preserve OFF/legacy proof semantics; pilot changes fence existing work.
 if(pilot.some(Boolean))profile.push(['beta-pilot-v1',...pilot]);
 const allowance=['ALLOWANCE_ID','STOP'].map(name=>environment[`PHASE4_BETA_PILOT_${name}`]??'');
 if(allowance.some(Boolean))profile.push(['beta-pilot-allowance-v1',...allowance]);
 if(environment.PHASE4_EXECUTION_PROFILE==='COMPANION_V33_RECOVERY')profile.push(['companion-recovery-profile-v1','COMPANION_V33_RECOVERY']);
 const companion=['STAGE7_COMPANION','STAGE7_COMPANION_USER_IDS','STAGE7_COACH_MIN_HOURS','STAGE7_COACH_MAX_HOURS','STAGE7_JOURNAL_GAP_HOURS'].map(name=>environment[name]??'');
 if(companion.some(Boolean))profile.push(['stage7-companion-configuration-v1',...companion]);
 if(environment.STAGE7_AUTOMATIC!==undefined)profile.push(['stage7-automatic-configuration-v1',environment.STAGE7_AUTOMATIC]);
 if(environment.BRIEFING_SCHEDULER_TOPOLOGY!==undefined){
  if(!['dual','cloudflare_morning_only'].includes(environment.BRIEFING_SCHEDULER_TOPOLOGY))fail('SCHEDULER_TOPOLOGY_INVALID');
  profile.push(['scheduler-topology-v1',environment.BRIEFING_SCHEDULER_TOPOLOGY]);
 }
 const scope=continuationScope(environment,config.runtime==='on'?'SHADOW':'OFF');
 if(scope)profile.push(['phase4-continuation-scope-v1',scope]);
 return keys.lookup(profile);
};
export function pausedSourceConfigurationProof(keys,config,environment,sourceSha,schema){
 if(sourceSha!==CA4_SOURCE_PROOF.sourceSha)return targetConfigurationProof(keys,config,environment,sourceSha);
 // The old service stays in maintenance throughout additive33→34→35. Schema
 // movement does not replace the running source binary or its proof contract.
 if(!CA4_SOURCE_PROOF.schemas.includes(schema)||environment.PHASE4_RELEASE_SHA!==sourceSha||config.runtime!=='off'||config.mode!=='off'
  ||newFlags.some(name=>(environment[name]??'off')!=='off')||![undefined,''].includes(environment.STAGE8_USER_IDS)
  ||(environment.PHASE4_EXECUTION_PROFILE??'PHASE4')!=='PHASE4')fail();
 if(createHash('sha256').update(legacyCa4ConfigurationProof.toString()).digest('hex')!==CA4_SOURCE_PROOF.canonicalFunctionSha256)fail();
 // Original pilot identity, allowance, cohort, automatic mode, topology and
 // continuation scope remain bound exactly as they were in this v33 binary.
 return legacyCa4ConfigurationProof(keys,config,environment,sourceSha);
}
