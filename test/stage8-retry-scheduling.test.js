import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';
import {runCompanionService,COMPANION_KIND} from '../src/companionService.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
const ack=()=>new Response(JSON.stringify({ok:true,result:{message_id:123,date:1,chat:{id:123,type:'private'}}}),{status:200});
const reject=status=>new Response(JSON.stringify({ok:false,error_code:status,description:'Synthetic nonacceptance'}),{status});
const follow=(f,app)=>app.owner.configure(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'synthetic-follow'});
async function morning(t,response){const f=await stage8Fixture(t);let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;return response(sends);});
 const environment={...f.environment,STAGE8_MORNING_BRIEF:'on'},runtime=await createStage8MorningRuntime({...f,environment,env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');await runtime.store.requestCutover(await runtime.core.captureControl('a'),{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 const input={userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}};return {...f,runtime,input,sends:()=>sends};}
test('signed companion service prepares followed subject source plan and dispatches without Stage7, SYNC or permits',async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;t.mock.method(globalThis,'fetch',(url)=>{assert.match(String(url),/botSYNTHETIC_NOT_A_TOKEN\/sendMessage$/);sends++;return ack();});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await follow(f,app);f.setTime('2026-09-19T01:10:00Z');
 const environment={...f.environment,STAGE7_COMPANION:'off',STAGE7_COMPANION_USER_IDS:'a'},releaseSha=runningReleaseSha(),request={kind:COMPANION_KIND,requestId:'synthetic-owner-schedule-001',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha),triggerSource:'cloudflare',executionMode:'OFF'};
 const result=await runCompanionService({...f,environment,env:f.env,request,now:f.now});assert.equal(result.status,200);assert.equal(result.body.ownerChecked,1);assert.equal(sends,1);
 await runCompanionService({...f,environment,env:f.env,request:{...request,requestId:'synthetic-owner-schedule-002'},now:f.now});assert.equal(sends,1);
 assert.equal((await f.db.raw.execute("SELECT last_completed_generation FROM phase4_computation_state WHERE user_id='b' AND execution_mode='LIVE'")).rows[0].last_completed_generation,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
});
test('Owner definite retry uses same semantic identity, durable exponential backoff and exhaustion',async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;return reject(429);});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await follow(f,app);f.setTime('2026-09-19T01:10:00Z');
 let result=await app.owner.tick(f.input);assert.equal(result.results[0].status,'FAILED_DEFINITE');await app.owner.tick(f.input);assert.equal(sends,1);
 f.setTime('2026-09-19T01:10:30Z');await app.owner.tick(f.input);assert.equal(sends,2);
 f.setTime('2026-09-19T01:11:00Z');await app.owner.tick(f.input);assert.equal(sends,2);
 f.setTime('2026-09-19T01:11:30Z');await app.owner.tick(f.input);assert.equal(sends,3);
 const restarted=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});result=await restarted.owner.tick(f.input);assert.equal(result.results[0].status,'SUPPRESSED');assert.equal(sends,3);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_attempts')).rows[0].n,3);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,1);
});
test('Owner uncertain acceptance never retries after restart; revoked subject cannot acquire a new plan',async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;throw Error('Synthetic network uncertainty');});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await follow(f,app);f.setTime('2026-09-19T01:10:00Z');
 assert.equal((await app.owner.tick(f.input)).results[0].status,'AMBIGUOUS');f.setTime('2026-09-19T01:11:00Z');const restarted=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});await restarted.owner.tick(f.input);assert.equal(sends,1);
 await app.owner.configure(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:false,expectedRevision:1,operationKey:'synthetic-disable'});assert.equal((await app.owner.tick(f.input)).checked,0);
});
test('Morning 429 retries after backoff and consumes original reservation on success',async t=>{
 const f=await morning(t,n=>n===1?reject(429):ack());assert.equal((await f.runtime.daily(f.input)).status,'FAILED_DEFINITE');assert.equal((await f.runtime.daily(f.input)).status,'RETRY_WAIT');assert.equal(f.sends(),1);
 f.setTime('2026-09-20T02:11:00Z');assert.equal((await f.runtime.daily(f.input)).status,'sent');assert.equal(f.sends(),2);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_semantic_reservations')).rows[0].n,1);assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CONSUMED');
});
test('Morning definite failures exhaust three attempts and close reservation',async t=>{
 const f=await morning(t,()=>reject(429));await f.runtime.daily(f.input);f.setTime('2026-09-20T02:11:00Z');await f.runtime.daily(f.input);f.setTime('2026-09-20T02:13:00Z');await f.runtime.daily(f.input);
 assert.equal((await f.runtime.daily(f.input)).status,'FAILED_TERMINAL');assert.equal(f.sends(),3);assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
});
test('Morning expired failure closes prior date without resend; ambiguous remains permanently consumed',async t=>{
 const f=await morning(t,()=>reject(429));await f.runtime.daily(f.input);f.setTime('2026-09-21T03:00:00Z');await f.runtime.store.expirePending(await f.runtime.core.captureControl('a'));
 assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');assert.equal((await f.db.raw.execute('SELECT state FROM outbound_messages')).rows[0].state,'FAILED_TERMINAL');assert.equal(f.sends(),1);
});

test('Morning permanent 403 closes original reservation without provider resend',async t=>{
 const f=await morning(t,()=>reject(403));assert.equal((await f.runtime.daily(f.input)).status,'FAILED_DEFINITE');assert.equal((await f.runtime.daily(f.input)).status,'FAILED_TERMINAL');assert.equal(f.sends(),1);
});
test('Owner tick checks at most six subscriptions and never manufactures LIVE analysis for other classes',async t=>{
 const f=await stage8Fixture(t,{owner:true});t.mock.method(globalThis,'fetch',()=>{throw Error('PROVIDER_FORBIDDEN');});
 for(const [id,chat] of [['c','789'],['d','987']]){
  await f.db.createUser({id,displayName:'Synthetic peer',timezone:'Asia/Taipei',status:'ACTIVE'});await f.db.linkTelegram({userId:id,chatId:chat,now:f.now()});await f.db.ensureOnboarding(id,{state:'READY'});
  await f.db.saveTokens(id,{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-'+id},{now:f.now(),bumpAuthGeneration:true});
 }
 for(const subjectId of ['b','c','d'])for(const notificationClass of ['DAILY_SUMMARY','WEEKLY_SUMMARY','IMPORTANT_ALERT'])await f.app.owner.configure(f.input,{subjectId,notificationClass,enabled:true,expectedRevision:0,operationKey:subjectId+notificationClass});
 const result=await f.app.owner.tick(f.input);assert.equal(result.checked,6);assert.equal(result.results.length,6);const second=await f.app.owner.tick(f.input);assert.ok(new Set([...result.results,...second.results].map(r=>r.subjectId+r.notificationClass)).size===9);assert.ok(result.results.every(r=>r.status!=='DELIVERED'));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
});
test('Morning expired frozen plan closes a failed retry without another send or generation claim',async t=>{
 const f=await morning(t,()=>reject(429));await f.runtime.daily(f.input);f.setTime('2026-09-20T04:10:00Z');
 assert.equal((await f.runtime.daily(f.input)).status,'FAILED_TERMINAL');assert.equal(f.sends(),1);assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
});
test('scheduled Owner recovery marks started attempt ambiguous before revoked-subject plan reads',async t=>{
 const f=await stage8Fixture(t,{owner:true}),{createOwnerMonitoring}=await import('../src/stage8OwnerMonitoring.js');let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;throw Error('PROVIDER_FORBIDDEN');});
 await follow(f,f.app);const monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,now:f.now}),actor=await monitoring.authenticate(f.input);await monitoring.prepareDaily(actor,'b');
 const approved=await monitoring.authorize(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),proposal=await monitoring.propose(actor,approved.ticket);await monitoring.start(actor,{subjectId:'b',messageId:proposal.messageId,expectedRevision:0});
 const metadata=await monitoring.pending(actor,'b','DAILY_SUMMARY');assert.equal(metadata.payload_json,undefined);
 await f.db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='b'");
 const result=await f.app.owner.tick(f.input);assert.equal(result.results[0].status,'AMBIGUOUS');assert.equal(sends,0);assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows[0].state,'AMBIGUOUS');
});

test('Morning reauthorization closes the old failed semantic reservation without retrying old authority',async t=>{
 const f=await morning(t,()=>reject(429));await f.runtime.daily(f.input);await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
 f.setTime('2026-09-20T02:11:00Z');assert.equal((await f.runtime.daily(f.input)).status,'FAILED_TERMINAL');assert.equal(f.sends(),1);assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
});
