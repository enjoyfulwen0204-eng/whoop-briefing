import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CA4_SOURCE_PROOF,pausedSourceConfigurationProof} from '../scripts/stage8-source-configuration-proof.mjs';
import {validatePausedProviders,PRODUCTION_CONTROL} from '../scripts/stage8-production-control.mjs';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {requireReleaseSha,runningReleaseSha} from '../src/phase4Release.js';
import {continuationScope} from '../src/phase4ContinuationScope.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {fixtureKeys} from './localDb.js';
const SHA='a'.repeat(40),OLD=CA4_SOURCE_PROOF.sourceSha;
const environment=()=>({PHASE4_RELEASE_SHA:OLD,PHASE4_EXECUTION_PROFILE:'PHASE4',PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex'),
 TURSO_DATABASE_URL:'libsql://'+PRODUCTION_CONTROL.host,PHASE4_BETA_PILOT_USER_ID:'synthetic-owner',STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'synthetic-a,synthetic-b,synthetic-c',STAGE7_AUTOMATIC:'on',BRIEFING_SCHEDULER_TOPOLOGY:'cloudflare_morning_only',BRIEFING_CONTINUATION_SCOPE:'sync',BRIEFING_CONTINUATION_DISCOVERY:'on'});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function immutableSource(){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 const bytes=execFileSync('git',['show',OLD+':src/phase4ExecutionStore.js'],{cwd:new URL('../',import.meta.url),env,timeout:3000,stdio:['ignore','pipe','ignore']});
 assert.equal(digest(bytes),CA4_SOURCE_PROOF.sourceModuleSha256);
 assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),CA4_SOURCE_PROOF.immutableBlobs['src/phase4ExecutionStore.js']);
 const text=bytes.toString(),from=text.indexOf('export const configurationProof=')+'export const configurationProof='.length,to=text.indexOf('\nexport const requestIdentity',from),arrow=text.slice(from,to).trim().replace(/;$/,'');
 assert.equal(digest(arrow),CA4_SOURCE_PROOF.canonicalFunctionSha256);
 // Execute only the exact immutable source bytes checked above; never caller
 // text, provider JSON or a mutable branch. Production uses the compiled copy.
 return Function('requireReleaseSha','runningReleaseSha','continuationScope','fail','return '+arrow)(requireReleaseSha,runningReleaseSha,continuationScope,code=>{throw Object.assign(Error(code),{code});});
}
test('compiled ca4 formula matches immutable Git blob/function and unchanged dependency bytes; all selectors sanitized',async()=>{
 const original=immutableSource(),base=environment(),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 for(const name of ['src/phase4Release.js','src/phase4ContinuationScope.js']){
  const bytes=execFileSync('git',['show',OLD+':'+name],{cwd:new URL('../',import.meta.url),env,timeout:3000,stdio:['ignore','pipe','ignore']});
  assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),CA4_SOURCE_PROOF.immutableBlobs[name]);assert.deepEqual(await readFile(new URL('../'+name,import.meta.url)),bytes);
 }
 for(const patch of [{},{STAGE7_AUTOMATIC:'off'},{STAGE7_COMPANION_USER_IDS:'other-synthetic-cohort'},{PHASE4_BETA_PILOT_USER_ID:'other-synthetic-owner'},
  {PHASE4_BETA_PILOT_ID:'synthetic-pilot',PHASE4_BETA_PILOT_START_AT:'2026-10-16',PHASE4_BETA_PILOT_CONSENT_SHA256:'c'.repeat(64),PHASE4_BETA_PILOT_COST_BOUND_ID:'synthetic-bound'},
  {PHASE4_BETA_PILOT_ALLOWANCE_ID:'synthetic-allowance',PHASE4_BETA_PILOT_STOP:'on'}, {BRIEFING_CONTINUATION_SCOPE:'off'}, {BRIEFING_SCHEDULER_TOPOLOGY:'dual'}]){
  const e={...base,...patch},config=publicBetaConfiguration(e);for(const schema of [33,34,35])assert.equal(pausedSourceConfigurationProof(fixtureKeys,config,e,OLD,schema),original(fixtureKeys,config,e,OLD));
 }
 const invalid={...base,BRIEFING_SCHEDULER_TOPOLOGY:'invalid'};
 assert.throws(()=>original(fixtureKeys,publicBetaConfiguration(invalid),invalid,OLD),error=>error.code==='SCHEDULER_TOPOLOGY_INVALID');
 assert.throws(()=>pausedSourceConfigurationProof(fixtureKeys,publicBetaConfiguration(invalid),invalid,OLD,33),error=>error.code==='SCHEDULER_TOPOLOGY_INVALID');
 assert.ok(Object.isFrozen(CA4_SOURCE_PROOF.schemas));assert.ok(Object.isFrozen(CA4_SOURCE_PROOF.immutableBlobs));
});
test('exact source/schema/disabled-new-feature boundary rejects incompatible legacy claims and binds original pilot/cohort',()=>{
 const base=environment(),beta=publicBetaConfiguration(base),old=pausedSourceConfigurationProof(fixtureKeys,beta,base,OLD,33);
 assert.notEqual(old,configurationProof(fixtureKeys,beta,base,OLD),'future formula at old SHA is never accepted as an alternative');
 for(const key of ['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS'])
  for(const value of ['on','invalid'])assert.throws(()=>pausedSourceConfigurationProof(fixtureKeys,beta,{...base,[key]:value},OLD,33),/SOURCE_PROOF_COMPATIBILITY/);
 for(const schema of [undefined,32,36])assert.throws(()=>pausedSourceConfigurationProof(fixtureKeys,beta,base,OLD,schema),/SOURCE_PROOF_COMPATIBILITY/);
 for(const patch of [{PHASE4_RELEASE_SHA:SHA},{STAGE8_USER_IDS:'synthetic-owner'},{PHASE4_EXECUTION_PROFILE:'STAGE8_V35_RECOVERY'},{PHASE4_EXECUTION_PROFILE:'RC2_V32_ROLLBACK'}])assert.throws(()=>pausedSourceConfigurationProof(fixtureKeys,beta,{...base,...patch},OLD,33),/SOURCE_PROOF_COMPATIBILITY/);
 for(const patch of [{PHASE4_BETA_PILOT_USER_ID:'other-synthetic-owner'},{STAGE7_COMPANION_USER_IDS:'other-synthetic-cohort'}])assert.notEqual(pausedSourceConfigurationProof(fixtureKeys,beta,{...base,...patch},OLD,33),old);
 const explicitOff={...base,...Object.fromEntries(['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS'].map(key=>[key,'off']))};
 assert.equal(pausedSourceConfigurationProof(fixtureKeys,beta,explicitOff,OLD,35),old);
});
function paused(e,proof){return {
 service:{id:PRODUCTION_CONTROL.render,repo:'https://github.com/'+PRODUCTION_CONTROL.repo,autoDeploy:'no',serviceDetails:{maintenanceMode:{enabled:true},envSpecificDetails:{startCommand:'npm run bot:webhook'},plan:'0.5c-512mb'}},
 deploys:[{deploy:{id:'dep-synthetic',status:'live',commit:{id:OLD}}}],variables:Object.entries(e).map(([key,value])=>({envVar:{key,value}})),
 settings:{success:true,result:{bindings:Object.entries({BRIEFING_RELEASE_SHA:OLD,BRIEFING_CONFIG_PROOF:proof,BRIEFING_ENDPOINT_URL:PRODUCTION_CONTROL.origin+'/internal/briefing/run',BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONTINUATION_SCOPE:'sync',BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_COMPANION_ENABLED:'on'}).map(([name,text])=>({type:'plain_text',name,text}))}},
 schedules:{success:true,result:{schedules:[]}},workflow:{id:PRODUCTION_CONTROL.workflow,path:'.github/workflows/briefing.yml',state:'disabled_manually'},activeRuns:Array.from({length:5},()=>({total_count:0,workflow_runs:[]}))};}
test('actual paused-provider validator uses only exact old proof throughout schema33→34→35; no replacement proof fallback',()=>{
 const e=environment(),beta=publicBetaConfiguration(e),old=pausedSourceConfigurationProof(fixtureKeys,beta,e,OLD,33);
 for(const schema of [33,34,35]){assert.equal(validatePausedProviders(paused(e,old),OLD,fixtureKeys,schema).proof,old);assert.throws(()=>validatePausedProviders(paused(e,configurationProof(fixtureKeys,beta,e,OLD)),OLD,fixtureKeys,schema),/BINDINGS_UNPROVEN/);}
 assert.throws(()=>validatePausedProviders(paused(e,old),OLD,fixtureKeys,32),/SOURCE_PROOF_COMPATIBILITY/);
});
test('future source proof remains the authoritative unchanged candidate formula and fences every new flag, owner, cohort and recovery profile',()=>{
 const base={...environment(),PHASE4_RELEASE_SHA:SHA},beta=publicBetaConfiguration(base),proof=pausedSourceConfigurationProof(fixtureKeys,beta,base,SHA,35);
 assert.equal(proof,configurationProof(fixtureKeys,beta,base,SHA));
 for(const key of ['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER'])assert.notEqual(pausedSourceConfigurationProof(fixtureKeys,beta,{...base,[key]:'on'},SHA,35),proof);
 for(const patch of [{PHASE4_BETA_PILOT_USER_ID:'other-synthetic-owner'},{STAGE8_USER_IDS:'synthetic-a'},{STAGE7_COMPANION_USER_IDS:'other-synthetic-cohort'},{PHASE4_EXECUTION_PROFILE:'STAGE8_V35_RECOVERY'}])assert.notEqual(pausedSourceConfigurationProof(fixtureKeys,beta,{...base,...patch},SHA,35),proof);
});
