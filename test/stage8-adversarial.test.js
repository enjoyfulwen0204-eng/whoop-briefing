import {grantSourceConsent} from './stage8SourceConsentFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createStage8MorningPlan} from '../src/stage8MorningPlan.js';
import {selfQueryPerspective} from '../src/scopedHealthContext.js';
async function followed(f,app,klass='DAILY_SUMMARY'){
 await grantSourceConsent(f,{notificationClass:klass});
 await app.owner.configure(f.input,{subjectId:'b',notificationClass:klass,enabled:true,expectedRevision:0,operationKey:'synthetic-follow-'+klass});
 await f.core.initializeTenant('b','LIVE');const ctx=await f.core.capture('b',{executionMode:'LIVE'}),plans=createStage8MorningPlan({...f,preferences:f.stores.preferences});await plans.persist(ctx,await plans.build(ctx,{healthDate:'2026-09-19'}));
}
for(const text of ['What is HRV?','How is Alice’s recovery?','What is my wife’s sleep score?','HRV是什麼？','HRV là gì?','if my HRV decreases?'])test(`general/third-party perspective cannot open scope: ${text}`,()=>assert.equal(selfQueryPerspective({text,intent:'today_status'}).usePersonalData,false));
test('owner weekly and alerts refuse a fake completed LIVE generation with no authenticated producer',async t=>{
 const f=await stage8Fixture(t,{owner:true});t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 for(const klass of ['WEEKLY_SUMMARY','IMPORTANT_ALERT']){await grantSourceConsent(f,{notificationClass:klass});await f.app.owner.configure(f.input,{subjectId:'b',notificationClass:klass,enabled:true,expectedRevision:0,operationKey:klass});}
 await f.core.initializeTenant('b','LIVE');await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='b' AND execution_mode='LIVE'");
 for(const klass of ['WEEKLY_SUMMARY','IMPORTANT_ALERT'])assert.equal((await f.app.owner.dispatch(f.input,{subjectId:'b',notificationClass:klass})).status,'ANALYSIS_UPDATING');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,0);
});
test('owner flag revoked during final wording prevents provider IO and settles definite failure',async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;throw Error('NETWORK_FORBIDDEN');});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await followed(f,app);
 // Revoke at the first post-start check, rather than assuming query counts.
 const fences=f.db.assertRuntimeFences;t.mock.method(f.db,'assertRuntimeFences',async()=>{const started=(await f.db.raw.execute("SELECT 1 FROM owner_monitoring_outbox WHERE state='DELIVERY_STARTED'")).rows.length;if(started)f.environment.PHASE4_STAGE8_OWNER_MONITORING='off';return fences?.();});
 const result=await app.owner.dispatch(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(result.status,'FAILED_DEFINITE');assert.equal(sends,0);
});
test('source changes during accepted owner HTTP erase retained payload and preserve an ambiguous no-resend barrier',async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;
 t.mock.method(globalThis,'fetch',async()=>{sends++;await f.stores.queue.sourceChanged(await f.core.captureControl('b'),{reasonCode:'SOURCE_CHANGED'});return new Response(JSON.stringify({ok:true,result:{message_id:101,date:1,chat:{id:123,type:'private'}}}),{status:200});});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await followed(f,app);
 const result=await app.owner.dispatch(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(result.status,'AMBIGUOUS');assert.equal(result.providerOutcome,'DELIVERED');
 const row=(await f.db.raw.execute('SELECT * FROM owner_monitoring_outbox')).rows[0];assert.equal(row.content_state,'REDACTED');assert.equal(row.payload_json,null);assert.equal(sends,1);
 const next=await app.owner.dispatch(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(next.status,'NO_APPROVED_CURRENT_PLAN');assert.equal(sends,1);
});
test('recovery of DELIVERY_STARTED owner attempt records ambiguity without invoking provider',async t=>{
 const f=await stage8Fixture(t,{owner:true});t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await followed(f,app);
 const monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,now:f.now}),actor=await monitoring.authenticate(f.input),allowed=await monitoring.authorize(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),proposal=await monitoring.propose(actor,allowed.ticket);
 await monitoring.start(actor,{subjectId:'b',messageId:proposal.messageId,expectedRevision:0});const result=await app.owner.dispatch(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(result.status,'AMBIGUOUS');assert.equal(result.recovered,true);
});
