import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8MorningStore} from '../src/stage8MorningStore.js';
import {createStage7Companion} from '../src/stage7Companion.js';
import {confirmedMorningReceipt} from '../src/confirmedMorningReceipt.js';
import {captureStage7Enrollment,assertStage7Enrollment,sameStage7Enrollment} from '../src/stage7Enrollment.js';
import {createStage8PresentationSender} from '../src/stage8PresentationSender.js';
import {createStage7PresentationSender} from '../src/stage7PresentationSender.js';
import {createStage5PresentationSender} from '../src/stage5PresentationReader.js';
import {readPhaseProgress} from '../src/phase4ExecutionStore.js';

test('always-installed presentation boundaries suppress saved Stage5/7/8 capabilities while disabled',async()=>{
 let sent=0;const base=async input=>{if(input.beforeSend&&!await input.beforeSend())return {sent:false};sent++;return {sent:true};};
 const send=createStage8PresentationSender(null,createStage7PresentationSender(null,createStage5PresentationSender(null,base)));
 for(const guard of ['stage8ReplyGuard','stage5PresentationGuard','stage7ReplyGuard','stage7InteractionId','stage7View','stage7CoachContextGuard']){
  assert.equal((await send({reply:{text:'saved private reply',[guard]:{signature:'saved'}}})).sent,false);
 }
 assert.equal(sent,0);assert.equal((await send({reply:'ordinary'})).sent,true);assert.equal(sent,1);
 assert.equal((await send({reply:'ordinary',beforeSend:async()=>false})).sent,false);assert.equal(sent,1,'prior send fences remain authoritative');
});

for(const targetVersion of [34,35])test(`v${targetVersion} actual DELIVERED Morning receipt authorizes one linked Journal proposal`,async t=>{
 let at=new Date('2026-09-19T00:00:00Z');const now=()=>new Date(at),f=await syntheticPhase4Fixture(t,{targetVersion,now});
 await seedBodyInput(f.db,bodyInput({days:2}));await f.db.linkTelegram({userId:'a',chatId:'123',now:now()});await f.db.setLocale('a','en',{now:now()});
 await f.db.ensureOnboarding('a',{state:'READY',now:now()});await f.core.initializeTenant('a','LIVE');
 const store=createStage8MorningStore({...f,preferences:f.stores.preferences,enabled:uid=>uid==='a'}),control=await f.core.captureControl('a');
 await store.requestCutover(control,{expectedRevision:0});at=new Date('2026-09-20T02:10:00Z');
 const ready=await store.prepare(control);assert.equal(ready.status,'READY');const context=await store.context(control);
 await store.transport.makeEligible(context,{messageId:ready.messageId,expectedRevision:ready.revision});
 const lease=await store.transport.claim(context,{messageId:ready.messageId,owner:'synthetic-dispatcher'}),attempt=await store.transport.start(context,lease);
 const user=await f.db.getUser('a'),companion=createStage7Companion({...f}),actor=await companion.interactions.authenticate({user,chatId:'123'});
 assert.equal(await confirmedMorningReceipt({...f,actor,day:'2026-09-20'}),null,'started delivery is not an acknowledgement');
 await store.transport.settle(control,'LIVE',{attemptId:attempt.attemptId,outcome:'DELIVERED',providerMessageId:'101'});
 const receipt=await confirmedMorningReceipt({...f,actor,day:'2026-09-20'});assert.equal(receipt.reportType,'outbound_messages');assert.ok(Number.isSafeInteger(receipt.briefAt));
 await f.db.transaction(async()=>{const prefs=await companion.preferences(actor);await companion.changePreferences(actor,prefs,{daily_enabled:1});});
 const input={user,chatId:'123',healthDay:'2026-09-20'},first=await companion.prepareAfterBrief(input);assert.equal(first.status,'PROPOSED');
 assert.equal((await companion.prepareAfterBrief(input)).status,'EXISTING');
 const delivery=(await f.db.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];
 assert.equal(delivery.delivery_id,first.deliveryId);await assertStage7Enrollment({...f,actor,row:delivery});
 assert.equal((await f.db.raw.execute({sql:"SELECT count(*) n FROM phase4_source_links WHERE user_id='a' AND artifact_type='journal_prompt_deliveries' AND artifact_id=? AND source_type='outbound_messages' AND source_id=? AND unlinked_at IS NULL",args:[delivery.privacy_artifact_id,receipt.reportSource]})).rows[0].n,1);
 const peer=await companion.interactions.authenticate({user:await f.db.getUser('b'),chatId:'456'}).catch(()=>null);
 assert.equal(peer,null,'unbound peer cannot obtain the actor capability');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 assert.equal((await readPhaseProgress(f.db,'STAGE6_DRAIN','cloudflare')).state,'NOT_ENTERED');
});

test('v35 monotonic enrollment fences same-clock READY ABA while untouched v33 schedule survives migration',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.db.linkTelegram({userId:'a',chatId:'123'});await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const companion=createStage7Companion({...f}),actor=await companion.interactions.authenticate({user:await f.db.getUser('a'),chatId:'123'});
 const selected=await captureStage7Enrollment({...f,actor});assert.equal(selected.enrollment_revision,0);
 const {enrollment_revision,...legacy}=selected;legacy.version='stage7-ready-enrollment-v1';
 assert.equal(sameStage7Enrollment(legacy,selected),true);
 await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");await f.db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='a'");
 const current=await captureStage7Enrollment({...f,actor});assert.equal(current.updated_at,selected.updated_at);assert.equal(current.enrollment_revision,2);
 assert.equal(sameStage7Enrollment(selected,current),false);assert.equal(sameStage7Enrollment(legacy,current),false);
});

test('actual presentation constructor retains the frozen SHADOW contract on34/35 without promoting completion',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';
  mock.module('./src/stage7Cohort.js',{namedExports:{isApprovedStage7Three:ids=>JSON.stringify([...ids].sort())===JSON.stringify(['a','b','c'])}});
  const {syntheticPhase4Fixture}=await import('./test/phase4Fixture.js');
  const {createStage5PresentationRuntime}=await import('./src/stage5PresentationReader.js');
  for(const targetVersion of [34,35])test('schema '+targetVersion,async t=>{
   const f=await syntheticPhase4Fixture(t,{targetVersion,now:()=>new Date()});await f.db.linkTelegram({userId:'a',chatId:'123'});
   await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'synthetic'});
   await f.db.ensureOnboarding('a',{state:'READY'});await f.db.setLocale('a','en');
   const user=await f.db.getUser('a'),runtime=await createStage5PresentationRuntime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'c,a,b'}});
   // No authentic producer exists: even apparently completed metadata must
   // remain an explicit no-verified-result response under the typed reader.
   await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='SHADOW'");
   const reply=await runtime.handle({user,chatId:'123',text:'/insights phase4'});assert.equal(reply.stage5PresentationStatus,'NO_VERIFIED_RESULTS');
   assert.match(reply.text,/SHADOW/);assert.equal(await runtime.verify({userId:'a',chatId:'123',reply}),true);
   assert.equal(await runtime.verify({userId:'b',chatId:'456',reply}),false);
   assert.deepEqual(await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.betaSummary.readCurrent(c,{asOfUtc:new Date().toISOString()})),{userId:'a',executionMode:'SHADOW',episodes:[],insights:[]});
   assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
   if(targetVersion===35){assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);}
   const prior=(await f.db.raw.execute("SELECT updated_at,enrollment_revision FROM user_onboarding WHERE user_id='a'")).rows[0];
   await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");await f.db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='a'");
   const next=(await f.db.raw.execute("SELECT updated_at,enrollment_revision FROM user_onboarding WHERE user_id='a'")).rows[0];
   assert.equal(next.updated_at,prior.updated_at);assert.equal(next.enrollment_revision,prior.enrollment_revision+2);
   assert.equal(await runtime.verify({userId:'a',chatId:'123',reply}),false,'same-clock onboarding ABA fences a saved presentation');
   let sends=0;assert.equal((await runtime.sendReply(async()=>{sends++;return {sent:true};},{userId:'a',chatId:'123',reply})).sent,false);assert.equal(sends,0);
  });
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('bounded automatic service continues peers after a tenant failure and cannot publish a success heartbeat',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';
  mock.module('./src/stage7Cohort.js',{namedExports:{isApprovedStage7Three:ids=>JSON.stringify([...ids].sort())===JSON.stringify(['a','b','c'])}});
  const {syntheticPhase4Fixture}=await import('./test/phase4Fixture.js');
  const {runCompanionService}=await import('./src/companionService.js');
  const {runningReleaseSha}=await import('./src/phase4Release.js');
  const {configurationProof}=await import('./src/phase4ExecutionStore.js');
  const {publicBetaConfiguration}=await import('./src/publicBetaConfig.js');
  test('synthetic approved cohort only',async t=>{
   const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.db.createUser({id:'c',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await f.core.initializeTenant('c','SHADOW');
   for(const [id,chatId] of [['a','123'],['b','456'],['c','789']]){await f.db.linkTelegram({userId:id,chatId});await f.db.ensureOnboarding(id,{state:'READY'});}
   const environment={STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on',STAGE7_COMPANION_USER_IDS:'a,b,c'},releaseSha=runningReleaseSha({});
   const request={kind:'COMPANION_V1',requestId:'synthetic-peer-failure-0001',releaseSha,triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha)},seen=[];
   const response=await runCompanionService({request,environment,db:f.db,env:{},keys:f.keys,deps:{createRuntime:async()=>({tick:async({user})=>{seen.push(user.id);if(user.id==='a')throw Error('SYNTHETIC_TENANT_FAILURE');return {daily:'DISABLED',coach:'DISABLED'};}})}});
   assert.deepEqual(seen,['a','b','c']);assert.equal(response.status,503);assert.equal(response.body.ok,false);assert.equal(response.body.failed,1);assert.equal(response.body.checked,2);
   assert.equal((await f.db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component='companion_v1'")).rows[0].n,0);
  });
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
