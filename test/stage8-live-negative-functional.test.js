import {grantSourceConsent} from './stage8SourceConsentFixture.js';
import {assertStage8Recovery} from '../src/stage8Policy.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';import {createSyntheticStage8SubjectAlertProvider,createStage8SubjectAlertProvider} from '../src/stage8SubjectAlerts.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';import {createStage7DecisionStore} from '../src/stage7DecisionStore.js';
test('genuine insufficient-data LIVE computation finalizes legitimate empty typed results without weekly/important claims or delivery',async t=>{
 const started=performance.now(),cpu=process.cpuUsage(),f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const admission=await f.db.admitRuntime(),provider=createSyntheticStage8SubjectAlertProvider({db:f.db}),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:provider});
 let result;for(let i=0;i<20;i++){result=await producer.run({userId:'a',requestId:`empty-genuine-${i}`});if(result.publication.status==='CURRENT')break;}assert.equal(result.publication.status,'CURRENT');assert.equal(provider.calls.length,0);
 const reader=createStage8DerivedReader({...f,admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({...f,admission,derivedReader:reader}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'What patterns do I have?'});
 for(const kind of ['BODY_ENERGY','INSIGHTS','EPISODES'])await t.test(`valid signed ${kind} empty result`,async()=>{const value=await scopes.derived(scope,kind);assert.equal(value.status,'CURRENT');assert.equal(value.items.length,0);});
 await t.test('no alert-family cutover is invented by source execution',async()=>{assert.equal((await f.db.raw.execute('SELECT count(*) n FROM tenant_delivery_modes')).rows[0].n,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);});
 await t.test('unbranded caller provider is rejected before computation',async()=>{await assert.rejects(createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:{send(){throw Error('MUST_NOT_EXECUTE');}}}),/SUBJECT_ALERT_AUTHORITY/);});
 await t.test('existing Stage7 SHADOW decision entry cannot produce LIVE',async()=>{await f.core.initializeTenant('a','LIVE');await f.stores.withContext('a',{executionMode:'LIVE'},ctx=>assert.rejects(createStage7DecisionStore(f).evaluate(ctx,{episodeId:'fake',semanticEventId:'fake',triggerKey:'fake'}),/SHADOW_DECISION_REQUIRED/));});
 await t.test('automatic subject delivery remains off by default',async()=>{assert.equal(createStage8SubjectAlertProvider({...f,admission,environment:{},env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},eligible:()=>true}),null);});
 await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('b','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-01',1)");await f.db.linkTelegram({userId:'b',chatId:'10002'});
 await f.db.ensureOnboarding('b',{state:'READY',now:f.core.now()});
 const owner=await createOwnerMonitoring({...f,ownerId:'b',enabled:()=>true}),actor=await owner.authenticate({user:await f.db.getUser('b'),chatId:'10002'});
 for(const [notificationClass,status] of [['WEEKLY_SUMMARY','NO_QUALIFYING_CONTENT'],['IMPORTANT_ALERT','NO_APPROVED_CURRENT_ALERT']])await t.test(`legitimate ${notificationClass} no-result`,async()=>{await grantSourceConsent(f,{ownerId:'b',subjectId:'a',notificationClass});await owner.configure(actor,{subjectId:'a',notificationClass,enabled:true,expectedRevision:0,operationKey:`empty-follow-${notificationClass}`});assert.equal((await owner.authorize(actor,{subjectId:'a',notificationClass})).status,status);});
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,0);
 t.diagnostic(JSON.stringify({kind:'EMPTY_SYNTHETIC_COST',durationMs:performance.now()-started,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),resource:process.resourceUsage()}));
});

test('new automatic switches stay off in both ordered recovery profiles',()=>{for(const profile of ['RC2_V32_ROLLBACK','COMPANION_V33_RECOVERY'])for(const field of ['STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS'])assert.throws(()=>assertStage8Recovery({PHASE4_EXECUTION_PROFILE:profile,[field]:'on'}),/RECOVERY_STAGE8_FEATURES_OFF_REQUIRED/);});
