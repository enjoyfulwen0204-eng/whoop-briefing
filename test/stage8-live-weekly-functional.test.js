import test from 'node:test';import assert from 'node:assert/strict';
import {register} from 'node:module';
register(new URL('./stage6FamilyDiagnosticLoader.mjs',import.meta.url));
const {setup}=await import('./stage5AssociationFixture.js');
const {createStage8LiveProducer}=await import('../src/stage8LiveProducer.js');
const {createOwnerMonitoring}=await import('../src/stage8OwnerMonitoring.js');
const {createStage8DerivedReader}=await import('../src/stage8DerivedReader.js');
const {createScopedHealthContext}=await import('../src/scopedHealthContext.js');
test('qualified two-window historical LIVE computation yields typed SUPPORTED weekly synthesis without fabricated associations',async t=>{
 globalThis.__familyFailureDiagnostics=[];
 const started=performance.now(),cpu=process.cpuUsage(),at=Date.now()-1000;
 const f=await setup(t,{days:60,targetVersion:35,wallClock:at,inputAsOf:at,liveClock:true,ownedConnection:true});await f.stores.release(f.context);
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:uid=>uid==='a'});
 let result,zero=0;for(let leg=0;leg<64;leg++){
  const begin=performance.now();result=await producer.run({userId:'a',requestId:`weekly-genuine-leg-${leg}`});
  console.log('WEEKLY_SYNTHETIC_LEG',JSON.stringify({leg,durationMs:performance.now()-begin,...result,resources:{cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS}}));
  assert.equal(result.result.jobsFailed,0,JSON.stringify(globalThis.__familyFailureDiagnostics));
  zero=result.result.outcome==='BUDGET_EXHAUSTED'&&!result.result.itemsProcessed&&!result.result.unitsCommitted?zero+1:0;
  assert.ok(zero<3,'three consecutive unchanged-budget zero-progress legs are an unresolved capacity blocker');
  if(result.publication.status==='CURRENT')break;
 }
 assert.equal(result.publication.status,'CURRENT');
 const reader=createStage8DerivedReader({...f,admission,eligible:uid=>uid==='a'}),scopes=await createScopedHealthContext({...f,admission,derivedReader:reader}),user=await f.db.getUser('a');
 const scope=await scopes.open({user,chatId:'10001',text:'What patterns are supported?'}),value=await scopes.derived(scope,'INSIGHTS');
 assert.equal(value.status,'CURRENT');assert.ok(value.items.length>0);assert.ok(value.items.every(i=>i.nonCausal===true));
 await f.core.initializeTenant('b','LIVE');
 // Separate Owner principal and explicit follow; source/subject are never copied.
 await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('b','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-01',1)");await f.db.linkTelegram({userId:'b',chatId:'10002'});
 const owner=await createOwnerMonitoring({...f,ownerId:'b',enabled:()=>true}),actor=await owner.authenticate({user:await f.db.getUser('b'),chatId:'10002'});
 await owner.configure(actor,{subjectId:'a',notificationClass:'WEEKLY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'explicit-weekly-follow'});
 const approved=await owner.authorize(actor,{subjectId:'a',notificationClass:'WEEKLY_SUMMARY'});assert.equal(approved.status,'APPROVED');
 const proposed=await owner.propose(actor,approved.ticket);assert.equal(proposed.status,'PROPOSED');
 const again=await owner.authorize(actor,{subjectId:'a',notificationClass:'WEEKLY_SUMMARY'});assert.equal((await owner.propose(actor,again.ticket)).messageId,proposed.messageId);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,1);
 t.diagnostic(JSON.stringify({durationMs:performance.now()-started,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),resource:process.resourceUsage()}));
});
