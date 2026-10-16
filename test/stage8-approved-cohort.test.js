import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {stage8Configuration,createStage8Runtime} from '../src/stage8Runtime.js';
import {isApprovedStage7Three} from '../src/stage7Cohort.js';

test('Stage8 retains singleton support, explicit owner identity and default-off monitoring',async()=>{
 const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'owner',STAGE8_USER_IDS:'owner'};
 assert.deepEqual(stage8Configuration(environment),{enabled:true,ownerId:'owner',userIds:['owner']});
 assert.equal(Object.isFrozen(stage8Configuration(environment).userIds),true);
 for(const users of ['owner,peer','owner,peer,third','owner,owner,owner','owner,peer,third,fourth'])
  assert.throws(()=>stage8Configuration({...environment,STAGE8_USER_IDS:users}),/COHORT_REQUIRED/);
 assert.equal(isApprovedStage7Three(['owner','peer','third']),false,'synthetic identities cannot widen the real immutable cohort');
 assert.throws(()=>stage8Configuration({...environment,PHASE4_BETA_PILOT_USER_ID:'outsider'}),/COHORT_REQUIRED/);
 const db=new Proxy({},{get(){throw Error('DATABASE_FORBIDDEN');}});
 assert.equal(await createStage8Runtime({db,environment:{}}),null);
});

test('approved three-subject configuration keeps the explicit owner independent of list order',()=>{
 // Mock only the pre-reviewed cohort decision in an isolated process: no
 // Production identities are placed in this test or substituted in runtime.
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock} from 'node:test';import assert from 'node:assert/strict';
  mock.module('./src/stage7Cohort.js',{namedExports:{isApprovedStage7Three:ids=>JSON.stringify([...ids].sort())===JSON.stringify(['a','b','c'])}});
  const {stage8Configuration}=await import('./src/stage8Runtime.js');
  const env={PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'b',STAGE8_USER_IDS:'c,a,b'};
  const config=stage8Configuration(env);
  assert.equal(config.ownerId,'b');assert.deepEqual(config.userIds,['c','a','b']);
  assert.equal(Object.isFrozen(config),true);assert.equal(Object.isFrozen(config.userIds),true);
  assert.throws(()=>stage8Configuration({...env,PHASE4_BETA_PILOT_USER_ID:'outsider'}),/COHORT_REQUIRED/);
  assert.throws(()=>stage8Configuration({...env,STAGE8_USER_IDS:'c,a,outsider'}),/COHORT_REQUIRED/);
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('companion owner dispatch uses the explicit owner even when the subject list starts with a peer',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';
  let ticks=0;
  mock.module('./src/stage8Runtime.js',{namedExports:{
   stage8Configuration:()=>({enabled:true,ownerId:'b',userIds:['c','a','b']}),
   createStage8Runtime:async()=>({owner:{tick:async({user,chatId})=>{assert.equal(user.id,'b');assert.equal(String(chatId),'456');ticks++;return {checked:1};}}})
  }});
  const {syntheticPhase4Fixture}=await import('./test/phase4Fixture.js');
  const {runCompanionService}=await import('./src/companionService.js');
  const {runningReleaseSha}=await import('./src/phase4Release.js');
  const {configurationProof}=await import('./src/phase4ExecutionStore.js');
  const {publicBetaConfiguration}=await import('./src/publicBetaConfig.js');
  test('real bounded companion composition preserves owner principal',async t=>{
   const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.db.linkTelegram({userId:'b',chatId:'456'});await f.db.ensureOnboarding('b',{state:'READY'});
   const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_STAGE8_OWNER_MONITORING:'on',PHASE4_BETA_PILOT_USER_ID:'b',STAGE8_USER_IDS:'c,a,b'},releaseSha=runningReleaseSha({});
   const request={kind:'COMPANION_V1',requestId:'owner-order-fixture-0001',triggerSource:'cloudflare',executionMode:'OFF',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha)};
   const response=await runCompanionService({request,db:f.db,keys:f.keys,environment,env:{},deps:{createRuntime:async()=>null}});
   assert.equal(response.status,200);assert.equal(response.body.ownerChecked,1);assert.equal(ticks,1);
  });
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
