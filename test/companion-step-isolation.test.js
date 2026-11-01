import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import {runCompanionStep} from '../src/companionStep.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';

// This test process uses only synthetic tenants. Never substitute production IDs
// or relax the actual production rollout policy.
registerHooks({load(url,context,next){
 if(url.endsWith('/src/stage7Cohort.js'))return {format:'module',source:'export const isApprovedStage7Three=ids=>["a","a,b"].includes(ids.join(","));',shortCircuit:true};
 return next(url,context);
}});
const {createStage7Runtime}=await import('../src/stage7Runtime.js');
const {runCompanionService,COMPANION_KIND}=await import('../src/companionService.js');
const at=new Date('2026-10-31T11:10:00Z'),day='2026-10-31';
const environment={STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on',STAGE7_COMPANION_USER_IDS:'a',BODY_ENERGY_ON_DEMAND:'on'};
async function fixture(t){
 const f=await syntheticStage7V33Fixture(t,{now:()=>new Date(at)});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:at});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:at});
 await f.db.ensureOnboarding('a',{state:'READY',now:at});
 const env={telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},app=await createStage7Runtime({db:f.db,keys:f.keys,environment,env,now:f.core.now});
 const user=await f.db.getUser('a'),actor=await app.companion.interactions.authenticate({user,chatId:'123'});
 await f.core.transaction(async()=>{const p=await app.companion.preferences(actor);await app.companion.changePreferences(actor,p,{coach_enabled:1});});
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily',?,'synthetic',?,?,?,'DELIVERED',11)",args:[day,at.toISOString(),at.toISOString(),user.lifecycleGeneration]});
 await confirmedLegacyBrief({...f,companion:app.companion,user},{day});
 await f.db.raw.execute("UPDATE report_runs SET sleep_id='synthetic-missing-original-sleep' WHERE user_id='a'");
 const logs=[];t.mock.method(console,'log',line=>{if(typeof line==='string'&&line.includes('companion_'))logs.push(JSON.parse(line));});
 let networkCalls=0;t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN');});
 const releaseSha=runningReleaseSha(environment),request={kind:COMPANION_KIND,requestId:'synthetic-step-isolation-0001',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha),triggerSource:'cloudflare',executionMode:'OFF'};
 const service=()=>runCompanionService({db:f.db,keys:f.keys,environment,env,now:f.core.now,request,deps:{createRuntime:async()=>app}});
 return {...f,app,user,logs,service,networkCalls:()=>networkCalls,input:{user,chatId:'123'}};
}

test('original Coach Sleep/Recovery missing: actual runtime skips Coach, service returns 200, no send or receipt rewrite',async t=>{
 const f=await fixture(t),before=(await f.db.raw.execute("SELECT * FROM report_runs WHERE user_id='a'")).rows,claims=(await f.db.raw.execute("SELECT * FROM report_claims WHERE user_id='a'")).rows;
 const result=await f.app.tick(f.input);
 assert.deepEqual(result,{health:'no_health_data',low:'DISABLED',daily:'DISABLED',weekly:'DISABLED',coach:'SKIPPED',insight:'NO_NEW_ASSOCIATION'});
 assert.equal(f.db.processingTransactionActive(),false);
 const response=await f.service();
 assert.equal(response.status,200);assert.equal(response.body.failed,0);assert.equal(response.body.checked,1);
 assert.equal(response.body.outcomes.SKIPPED,1);assert.equal(response.body.outcomes.DISABLED,3);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM report_runs WHERE user_id='a'")).rows,before);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM report_claims WHERE user_id='a'")).rows,claims);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,0);
 assert.equal(f.networkCalls(),0);
 assert.deepEqual(f.logs.filter(x=>x.event==='companion_step_skipped'),Array.from({length:2},()=>({event:'companion_step_skipped',step:'coach',code:'PHASE4_SOURCE_NOT_FOUND',user:f.keys.lookup(['companion-diagnostic-user-v1','a'])})));
 assert.equal(f.logs.some(x=>x.event==='companion_user_failed'),false);
});

for(const step of ['daily','weekly'])test(`${step} recoverable failure does not prevent later steps in actual tick`,async t=>{
 const f=await fixture(t),target=step==='daily'?f.app.companion:f.app.companion.weekly,method=step==='daily'?'prepareAfterBrief':'prepare';
 t.mock.method(target,method,()=>f.db.transaction(async()=>{throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_SOURCE_DELETED'});}));
 const result=await f.app.tick(f.input);
 assert.equal(result[step],'SKIPPED');assert.equal(result.coach,'SKIPPED');
 assert.equal(result.low,'DISABLED');assert.equal(result[step==='daily'?'weekly':'daily'],'DISABLED');
 assert.deepEqual(f.logs.filter(x=>x.event==='companion_step_skipped').map(x=>x.step),[step,'coach']);
 assert.equal(f.networkCalls(),0);
});

test('nonrecoverable Coach failure remains a failed user and HTTP 503',async t=>{
 const f=await fixture(t);
 t.mock.method(f.app.invitations,'prepare',async()=>{throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_OPERATION_RECEIPT_INTEGRITY'});});
 const response=await f.service();assert.equal(response.status,503);assert.equal(response.body.failed,1);
 assert.equal(f.logs.some(x=>x.event==='companion_step_skipped'),false);
 assert.equal(f.logs.find(x=>x.event==='companion_user_failed').code,'PHASE4_OPERATION_RECEIPT_INTEGRITY');
 assert.equal(f.networkCalls(),0);assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE_SENTINEL/);
});

test('low step and exact recoverable allowlist: one call, sanitized skip, no retry',async t=>{
 const source=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
 const codes=name=>source(name).match(/const recoverable=new Set\(\[([^\]]+)\]\)/)[1].match(/PHASE4_[A-Z_]+|CONTENT_REDACTED/g);
 assert.deepEqual(codes('companionStep.js'),codes('stage8MorningIntelligence.js'));
 const logs=[];t.mock.method(console,'log',value=>logs.push(JSON.parse(value)));let calls=0;
 const args={db:{processingTransactionActive:()=>false},keys:{lookup:()=>'synthetic-hash'},userId:'synthetic-private',step:'low'};
 for(const code of codes('companionStep.js'))assert.deepEqual(await runCompanionStep({...args,run:async()=>{calls++;throw Object.assign(Error('PRIVATE_SENTINEL'),{code});}}),{status:'SKIPPED'});
 assert.equal(calls,codes('companionStep.js').length);assert.equal(logs.filter(x=>x.event==='companion_step_skipped').length,calls);assert.equal(logs.filter(x=>x.event==='companion_step_timing').length,calls);
 assert.ok(logs.every(x=>x.step==='low'&&x.user==='synthetic-hash'));
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_SENTINEL|synthetic-private/);
});

test('active or unknown transaction cannot be swallowed; no skip log',async t=>{
 let logs=0;t.mock.method(console,'log',()=>logs++);
 const error=Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_SOURCE_NOT_FOUND'});
 for(const db of [{},{processingTransactionActive:()=>true}])await assert.rejects(runCompanionStep({db,keys:{},userId:'synthetic',step:'coach',run:async()=>{throw error;}}),e=>e===error);
 assert.equal(logs,0);
});

test('uncertain returned delivery states remain unchanged and are not retried',async()=>{
 for(const status of ['DELIVERY_STARTED','AMBIGUOUS','UNKNOWN','FAILED_DEFINITE','FENCED']){
  let calls=0;const original={status,deliveryId:'synthetic-original'};
  assert.equal(await runCompanionStep({db:{},keys:{},userId:'a',step:'coach',run:async()=>{calls++;return original;}}),original);assert.equal(calls,1);
 }
});

test('diagnostic failure cannot grant delivery or prevent a safe skip',async t=>{
 t.mock.method(console,'log',()=>{throw Error('LOG_FAILED');});
 assert.deepEqual(await runCompanionStep({db:{processingTransactionActive:()=>false},keys:{lookup:()=>'synthetic'},userId:'a',step:'coach',run:async()=>{throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_SOURCE_NOT_CURRENT'});}}),{status:'SKIPPED'});
});


test('actual admitted service visits every eligible user once and rotates the first at consecutive hourly ticks',async t=>{
 const f=await fixture(t),env={...environment,STAGE7_COMPANION_USER_IDS:'a,b'};
 await f.db.saveTokens('b',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-b'},{now:at});
 await f.db.linkTelegram({userId:'b',chatId:'456',now:at});await f.db.ensureOnboarding('b',{state:'READY',now:at});
 const releaseSha=runningReleaseSha(env),request={kind:COMPANION_KIND,requestId:'synthetic-rotation-request-01',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(env),env,releaseSha),triggerSource:'cloudflare',executionMode:'OFF'};
 const orders=[];
 for(const timestamp of ['2026-10-31T11:10:00Z','2026-10-31T12:10:00Z']){
  const order=[];const result=await runCompanionService({db:f.db,keys:f.keys,environment:env,env:{},request,now:()=>new Date(timestamp),deps:{createRuntime:async()=>({tick:async({user})=>{order.push(user.id);return {daily:'DISABLED'};}})}});
  assert.equal(result.status,200);assert.equal(result.body.checked,2);assert.equal(result.body.failed,0);assert.deepEqual([...order].sort(),['a','b']);orders.push(order);
 }
 assert.notEqual(orders[0][0],orders[1][0]);assert.equal(f.networkCalls(),0);
});
