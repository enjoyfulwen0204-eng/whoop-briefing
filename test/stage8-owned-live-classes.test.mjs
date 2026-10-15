import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createSyntheticStage8SubjectAlertProvider} from '../src/stage8SubjectAlerts.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
test('owned receiver computes and signs DAILY/IMPORTANT sources with explicit dual principals, replay and negative weekly',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()}),input=bodyInput({asOf:Date.now()-1000,days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?10:60+i%5;
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 // Explicit synthetic existing subject-family cutover, exactly as the accepted
 // IMPORTANT fixture; no alert/evidence/publication result is inserted here.
 await f.db.raw.execute("INSERT INTO tenant_delivery_modes(user_id,execution_mode,message_family,mode,lifecycle_generation,auth_generation,changed_at,reason_code,cutover_boundary,timezone) VALUES('a','LIVE','EPISODE_NOTIFICATION','PHASE4',1,1,'2026-10-01','CUTOVER_COMMITTED','2026-10-01','Asia/Taipei')");
 const control=await f.stores.captureControl('a'),preferences=await f.stores.preferences.read(control);
 await f.stores.preferences.update(control,preferences.preference_version,{notifications_paused:0,morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:'00:00'});
 const admission=await f.db.admitRuntime(),provider=createSyntheticStage8SubjectAlertProvider({db:f.db,outcomes:['DELIVERED']}),
  producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:uid=>uid==='a',subjectAlertProvider:provider});
 let last;
 // Existing authenticated post-sync policy permits at most64 ordinal legs.
 // The per-leg runtime deadlines/math remain the original server defaults.
 for(let leg=0;leg<64;leg++){
  last=await producer.run({userId:'a',requestId:`owned-classes-${leg}`});
  console.log('OWNED_CLASSES_PROGRESS',JSON.stringify({leg,...last}));
  assert.equal(last.result.jobsFailed,0);if(last.publication.status==='CURRENT')break;
 }
 assert.equal(last.publication.status,'CURRENT');assert.equal(provider.calls.length,1);
 const reader=createStage8DerivedReader({...f,admission,eligible:uid=>uid==='a'}),scopes=await createScopedHealthContext({...f,admission,derivedReader:reader}),
  scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'How is my recovery?'});
 const episodes=await scopes.derived(scope,'EPISODES');assert.equal(episodes.status,'CURRENT');assert.ok(episodes.items.length>0);
 const body=await scopes.derived(scope,'BODY_ENERGY');assert.equal(body.status,'CURRENT');assert.ok(body.items.length>0);assert.ok(body.items.every(i=>i.estimated===true&&Number.isInteger(i.value)&&i.value>=0&&i.value<=100));
 await f.core.initializeTenant('b','LIVE');await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('b','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-01',1)");await f.db.linkTelegram({userId:'b',chatId:'10002'});
 const owner=await createOwnerMonitoring({...f,ownerId:'b',enabled:()=>true}),actor=await owner.authenticate({user:await f.db.getUser('b'),chatId:'10002'});
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_subscriptions')).rows[0].n,0);
 for(const notificationClass of ['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY']){
  await assert.rejects(owner.authorize(actor,{subjectId:'a',notificationClass}),/SUBSCRIPTION/);
  await owner.configure(actor,{subjectId:'a',notificationClass,enabled:true,expectedRevision:0,operationKey:`explicit-owned-${notificationClass}`});
 }
 assert.equal((await owner.prepareDaily(actor,'a')).status,'CURRENT_PLAN');
 for(const notificationClass of ['DAILY_SUMMARY','IMPORTANT_ALERT']){
  const approved=await owner.authorize(actor,{subjectId:'a',notificationClass});assert.equal(approved.status,'APPROVED');
  const proposed=await owner.propose(actor,approved.ticket),value=await owner.validate(actor,'a',proposed.messageId);assert.equal(proposed.status,'PROPOSED');
  assert.ok(value.payload.claims.length>0);assert.ok(value.payload.claims.every(c=>c.kind===(notificationClass==='DAILY_SUMMARY'?'SOURCE_FACT_SUMMARY':'APPROVED_IMPORTANT_ALERT')));
  const again=await owner.authorize(actor,{subjectId:'a',notificationClass});assert.equal((await owner.propose(actor,again.ticket)).messageId,proposed.messageId);
 }
 assert.equal((await owner.authorize(actor,{subjectId:'a',notificationClass:'WEEKLY_SUMMARY'})).status,'NO_QUALIFYING_CONTENT');
 const receipts=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
 const restart=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:uid=>uid==='a',subjectAlertProvider:provider});
 assert.equal((await restart.run({userId:'a',requestId:'owned-classes-0'})).publication.status,'CURRENT');assert.equal(provider.calls.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,receipts);
 await owner.configure(actor,{subjectId:'a',notificationClass:'IMPORTANT_ALERT',enabled:false,expectedRevision:1,operationKey:'revoke-owned-important'});
 await assert.rejects(owner.authorize(actor,{subjectId:'a',notificationClass:'IMPORTANT_ALERT'}),/SUBSCRIPTION/);
 await assert.rejects(producer.run({userId:'b',requestId:'owned-peer-denied'}),/PRODUCING_AUTHORITY|PRINCIPAL_FENCED/);
});
