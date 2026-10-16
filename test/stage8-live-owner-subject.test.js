import {grantSourceConsent} from './stage8SourceConsentFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
test('separately authorized subject LIVE computation does not grant Coach peer access or fabricate Owner follows/alerts',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});
 for(const [uid,chat] of [['a','10001'],['b','10002']]){
  const input=bodyInput({asOf:Date.now()-1000,days:uid==='b'?7:0});input.userId=uid;
  for(const group of [...Object.values(input.sources),input.access,input.sync,input.capabilities])for(const row of group)row.user_id=uid;
  await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding(uid,{state:'READY'});await f.db.linkTelegram({userId:uid,chatId:chat,now:new Date()});
 }
 const control=await f.stores.captureControl('b'),preferences=await f.stores.preferences.read(control);
 await f.stores.preferences.update(control,preferences.preference_version,{morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:'00:00'});
 await f.core.initializeTenant('a','LIVE');let authorized=true;
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['b'],enabled:()=>authorized,eligible:uid=>uid==='b'});
 let result;for(let i=0;i<30;i++){result=await producer.run({userId:'b',requestId:`subject-b-leg-${i}`});if(result.publication.status==='CURRENT')break;}
 assert.equal(result.publication.status,'CURRENT');
 const monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true}),actor=await monitoring.authenticate({user:await f.db.getUser('a'),chatId:'10001'});
 await t.test('no follow is created by computation',async()=>{assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_subscriptions')).rows[0].n,0);await assert.rejects(monitoring.authorize(actor,{subjectId:'b',notificationClass:'WEEKLY_SUMMARY'}),/SUBSCRIPTION|SOURCE_CONSENT_REQUIRED/);});
 for(const notificationClass of ['DAILY_SUMMARY','WEEKLY_SUMMARY','IMPORTANT_ALERT']){await grantSourceConsent(f,{notificationClass});await monitoring.configure(actor,{subjectId:'b',notificationClass,enabled:true,expectedRevision:0,operationKey:`follow-${notificationClass}`});}
 await t.test('daily uses real current subject source plan',async()=>{assert.equal((await monitoring.prepareDaily(actor,'b')).status,'CURRENT_PLAN');assert.equal((await monitoring.authorize(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'})).status,'APPROVED');});
 await t.test('weekly and important respect qualifying-evidence and existing-alert policies',async()=>{assert.equal((await monitoring.authorize(actor,{subjectId:'b',notificationClass:'WEEKLY_SUMMARY'})).status,'NO_QUALIFYING_CONTENT');assert.equal((await monitoring.authorize(actor,{subjectId:'b',notificationClass:'IMPORTANT_ALERT'})).status,'NO_APPROVED_CURRENT_ALERT');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);});
 await t.test('self-only runtime rejects another subject despite separate producer authorization',async()=>{const app=await createStage8Runtime({...f,environment:{PHASE4_STAGE8_RUNTIME:'on',STAGE8_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_LIVE_ANALYSIS:'on'},env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'}});await assert.rejects(app.analysis.run({userId:'b',requestId:'peer-self-runtime'}),/PRODUCING_AUTHORITY|PRINCIPAL_FENCED/);const user=await f.db.getUser('a'),scope=await app.scopes.open({user,chatId:'10001',text:'What is my friend Bo HRV?'});assert.equal(scope.permitted,false);});
 await t.test('revoked follow does not retain daily authorization',async()=>{await monitoring.configure(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:false,expectedRevision:1,operationKey:'revoke-daily'});await assert.rejects(monitoring.authorize(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),/SUBSCRIPTION|SOURCE_CONSENT_REQUIRED/);});
 authorized=false;await assert.rejects(producer.run({userId:'b',requestId:'revoked-subject-grant'}),/PRODUCING_AUTHORITY/);
});
