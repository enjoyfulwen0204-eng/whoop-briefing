import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createRouter} from '../src/bot/router.js';
import {urgentReply,assessUrgency} from '../src/bot/triage.js';
import {executionProfile} from '../src/phase4Rollback.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {fixtureKeys} from './localDb.js';
import {STAGE8_CONFIGURATION_FIELDS} from '../src/stage8Policy.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';
for(const locale of ['zh-TW','vi','en'])test(`enabled Stage8 urgent collision precedes scope, model and Body in ${locale}`,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);
 const bodyEnergy=new Proxy({},{get(){throw Error('BODY_FORBIDDEN');}}),router=createRouter({db:f.db,stage8:f.app,bodyEnergy,coachFor(){throw Error('MODEL_FORBIDDEN');},now:f.now});
 for(const text of ['我心跳很快又呼吸困難，今天我的恢復如何？','我喝酒後胸痛又喘不過氣，今天我的 HRV 多少？']){
  assert.equal(assessUrgency(text).urgent,true);assert.equal(await router.handle({...f.input,text}),urgentReply(locale));
  assert.equal((await f.app.handle({...f.input,text})).text,urgentReply(locale));
 }
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,0);
 assert.match((await router.handle({...f.input,text:'my HRV today'})).text,/HRV: 50\.0/);
});
for(const profile of ['RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY'])test(`recovery ${profile} rejects all active Stage8 and cutover gates before IO`,async()=>{
 const db=new Proxy({},{get(){throw Error('DATABASE_FORBIDDEN');}});
 for(const name of ['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','PHASE4_DELIVERY_CUTOVER']){
  const environment={PHASE4_EXECUTION_PROFILE:profile,[name]:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a'};
  assert.throws(()=>executionProfile(environment),/RECOVERY_STAGE8/);
  await assert.rejects(createStage8Runtime({db,environment}),/RECOVERY_STAGE8/);
  await assert.rejects(createStage8MorningRuntime({db,environment}),/RECOVERY_STAGE8/);
 }
 assert.equal(executionProfile({PHASE4_EXECUTION_PROFILE:profile}),profile);
});
test('configuration proof fences every Stage8 flag, cohort, profile and cutover setting',()=>{
 const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_MORNING_BRIEF:'on',STAGE8_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_DELIVERY_CUTOVER:'off'};
 const proof=e=>configurationProof(fixtureKeys,publicBetaConfiguration(e),e,'a'.repeat(40)),base=proof(environment);
 for(const name of STAGE8_CONFIGURATION_FIELDS)assert.notEqual(proof({...environment,[name]:environment[name]==='on'?'off':'changed'}),base,name);
});
test('configuration change during bounded Morning poll prevents persistence and provider IO',async t=>{
 const f=await stage8Fixture(t);let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;throw Error('PROVIDER_FORBIDDEN');});
 const environment={...f.environment,STAGE8_MORNING_BRIEF:'on'},runtime=await createStage8MorningRuntime({...f,environment,env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');await runtime.store.requestCutover(await runtime.core.captureControl('a'),{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 await assert.rejects(runtime.daily({userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>{environment.PHASE4_DELIVERY_CUTOVER='on';return {sleeps:[],recoveries:[]};}}}),/CONFIGURATION_CHANGED/);
 assert.equal(sends,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM morning_readiness_refreshes')).rows[0].n,0);
});
test('changed cohort fences already signed Stage8 replies',async t=>{
 const f=await stage8Fixture(t),reply=await f.app.handle({...f.input,text:'my HRV today'});let sends=0;
 f.environment.STAGE8_USER_IDS='b';f.environment.PHASE4_BETA_PILOT_USER_ID='b';
 assert.equal((await f.app.sendReply(()=>{sends++;},{userId:'a',chatId:'123',reply})).sent,false);assert.equal(sends,0);
});
