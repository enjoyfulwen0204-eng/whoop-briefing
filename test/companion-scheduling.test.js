import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {fixtureKeys} from './localDb.js';
import {createStage7Runtime,stage7Configuration} from '../src/stage7Runtime.js';
import {COMPANION_PATH,COMPANION_KIND,runCompanionService,validateCompanionRequest} from '../src/companionService.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import worker,{invokeCompanion,COMPANION_CRON} from '../cloudflare/briefing-scheduler/worker.js';

const manual={STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'};
const automatic={...manual,STAGE7_AUTOMATIC:'on'};
const requestFor=environment=>{
 const releaseSha=runningReleaseSha(environment);
 return {kind:COMPANION_KIND,requestId:'synthetic-companion-request-01',releaseSha,
  configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),triggerSource:'cloudflare',executionMode:'OFF'};
};
async function fixture(t,environment=manual){
 let at=Date.parse('2026-09-19T00:00:00.000Z');
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(at)});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});
 await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const runtime=await createStage7Runtime({db:f.db,keys:fixtureKeys,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},environment,now:f.core.now});
 const user=await f.db.getUser('a'),input={user,chatId:'123'},actor=await runtime.companion.interactions.authenticate(input);
 return {...f,runtime,input,actor,setTime:iso=>{at=Date.parse(iso);}};
}
async function propose(f){
 await f.core.transaction(async()=>{
  const p=await f.runtime.companion.preferences(f.actor);await f.runtime.companion.changePreferences(f.actor,p,{daily_enabled:1});
  await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-19','synthetic',?,?,1,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp()]});
 });
 await confirmedLegacyBrief({...f,companion:f.runtime.companion,user:f.input.user});
 return f.runtime.companion.prepareAfterBrief({...f.input,healthDay:'2026-09-19'});
}
test('automatic service is a separate default-off stop and its flag is bound into the signed configuration',async()=>{
 assert.equal(stage7Configuration(manual).automatic,false);
 assert.throws(()=>stage7Configuration(automatic),/APPROVED_THREE_REQUIRED/);
 for(const ids of ['a','a,b','a,b,c','a,a,b'])assert.throws(()=>stage7Configuration({...manual,STAGE7_AUTOMATIC:'on',STAGE7_COMPANION_USER_IDS:ids}));
 assert.throws(()=>stage7Configuration({...manual,STAGE7_AUTOMATIC:'invalid'}),/CONFIG_INVALID/);
 assert.throws(()=>stage7Configuration({STAGE7_AUTOMATIC:'on'}),/CONFIG_INVALID/);
 assert.notEqual(requestFor(manual).configProof,requestFor(automatic).configProof);
 for(const environment of [{},manual]){
  const result=await runCompanionService({request:requestFor(environment),environment,keys:fixtureKeys,db:new Proxy({},{get(){throw Error('DB_MUST_NOT_BE_USED');}})});
  assert.equal(result.body.enabled,false);assert.equal(result.body.drainAuthorized,false);
 }
});
test('signed companion route has its own strict identity and cannot enter a SYNC or DRAIN phase',async()=>{
 let calls=0;const secret='synthetic-companion-secret-32-characters',request=requestFor(automatic),body=JSON.stringify(request),timestamp=String(Date.now());
 const endpoint=createBriefingEndpoint({secret,runPhase(){throw Error('SYNC_FORBIDDEN');},runCompanion:async()=>{calls++;return {status:200,body:{ok:true,kind:COMPANION_KIND}};}});
 const req={url:COMPANION_PATH,method:'POST',headers:{'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':request.requestId,
  'x-briefing-signature':signTriggerRequest({timestamp,requestId:request.requestId,method:'POST',path:COMPANION_PATH,body},secret)}};
 assert.equal((await endpoint(req,body)).status,200);assert.equal((await endpoint(req,body)).status,200);assert.equal(calls,1);
 assert.equal((await endpoint({...req,headers:{...req.headers,'x-briefing-signature':'bad'}},body)).status,401);
 for(const changed of [{...request,phase:'SYNC'},{...request,kind:'MORNING_READINESS_V1'},{...request,subject:'b'}])assert.throws(()=>validateCompanionRequest(changed),/REQUEST_INVALID/);
 await assert.rejects(runCompanionService({request:{...request,releaseSha:'f'.repeat(40)},environment:automatic,keys:fixtureKeys}),/RELEASE_CHECKOUT_MISMATCH/);
 await assert.rejects(runCompanionService({request:{...request,configProof:'f'.repeat(64)},environment:automatic,keys:fixtureKeys}),/EXECUTION_CONFIG_CHANGED/);
});
test('Worker companion transport is disabled by default; when enabled it signs one bounded request and never retries',async()=>{
 const request=requestFor(automatic),env={BRIEFING_COMPANION_ENABLED:'on',BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'s'.repeat(32),BRIEFING_RELEASE_SHA:request.releaseSha,BRIEFING_CONFIG_PROOF:request.configProof,BRIEFING_EXECUTION_MODE:'OFF'};
 let calls=0;
 assert.deepEqual(await invokeCompanion({}, {fetchImpl(){throw Error('PROVIDER_FORBIDDEN');}}),{enabled:false});
 await invokeCompanion(env,{fetchImpl:async(url,options)=>{
  calls++;assert.equal(new URL(url).pathname,COMPANION_PATH);assert.equal(options.redirect,'manual');
  const body=JSON.parse(options.body);validateCompanionRequest(body);
  assert.equal(options.headers['x-briefing-signature'],signTriggerRequest({timestamp:options.headers['x-briefing-timestamp'],requestId:body.requestId,method:'POST',path:COMPANION_PATH,body:options.body},env.BRIEFING_TRIGGER_SECRET));
  return new Response(JSON.stringify({ok:true,kind:COMPANION_KIND,source:'cloudflare',releaseSha:request.releaseSha,drainAuthorized:false,enabled:true}),{status:200});
 }});assert.equal(calls,1);
 await assert.rejects(invokeCompanion(env,{fetchImpl:async()=>{calls++;return new Response('{}',{status:503});}}),/companion_failed/);assert.equal(calls,2);
});
test('companion-only hourly scheduled events cannot enter the SYNC endpoint',async t=>{
 const request=requestFor(automatic),env={BRIEFING_COMPANION_ENABLED:'on',BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'s'.repeat(32),BRIEFING_RELEASE_SHA:request.releaseSha,BRIEFING_CONFIG_PROOF:request.configProof,BRIEFING_EXECUTION_MODE:'OFF'};
 let calls=0,pending;
 t.mock.method(globalThis,'fetch',async url=>{calls++;assert.equal(new URL(url).pathname,COMPANION_PATH);return new Response(JSON.stringify({ok:true,kind:COMPANION_KIND,source:'cloudflare',releaseSha:request.releaseSha,drainAuthorized:false,enabled:true}),{status:200});});
 worker.scheduled({cron:COMPANION_CRON},env,{waitUntil:p=>{pending=p;}});await pending;assert.equal(calls,1);
 worker.scheduled({cron:COMPANION_CRON},{...env,BRIEFING_COMPANION_ENABLED:'off'},{waitUntil:p=>{pending=p;}});await pending;assert.equal(calls,1);
});



test('daily quiet hours prevent preparation and defer an existing proposal without consuming its delivery identity',async t=>{
 const f=await fixture(t),proposal=await propose(f);assert.equal(proposal.status,'PROPOSED');
 f.setTime('2026-09-19T14:00:00Z');
 assert.equal((await f.runtime.companion.prepareAfterBrief({...f.input,healthDay:'2026-09-19'})).status,'QUIET_HOURS');
 assert.equal((await f.runtime.dispatcher.dispatch({...f.input,deliveryId:proposal.deliveryId})).status,'QUIET_HOURS');
 const row=(await f.db.raw.execute({sql:'SELECT state,attempt_count FROM journal_prompt_deliveries WHERE delivery_id=?',args:[proposal.deliveryId]})).rows[0];
 assert.equal(row.state,'PROPOSED');assert.equal(row.attempt_count,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
});





test('automatic singleton is rejected before database access; legacy manual singleton remains usable',async t=>{
 await assert.rejects(runCompanionService({request:requestFor(automatic),environment:automatic,keys:fixtureKeys,db:new Proxy({},{get(){throw Error('DB_MUST_NOT_BE_USED');}})}),/APPROVED_THREE_REQUIRED/);
 const f=await fixture(t);assert.equal((await f.runtime.tick(f.input)).status,'AUTOMATIC_DISABLED');
 assert.ok(await f.runtime.stage7Inbound({...f.input,text:'/journal',updateId:1}));
});
