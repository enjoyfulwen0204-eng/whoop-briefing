import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage8SourceConsent} from '../src/stage8SourceConsent.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createSettings} from '../src/bot/settings.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8MorningPlan} from '../src/stage8MorningPlan.js';
import {createStage8OwnerDispatcher} from '../src/stage8OwnerDispatcher.js';

async function fixture(t){
 const now=()=>new Date('2026-09-19T01:10:00Z'),f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 for(const [uid,chat] of [['a','123'],['b','456']]){
  await f.db.linkTelegram({userId:uid,chatId:chat,now:now()});await f.db.setLocale(uid,'en',{now:now()});
  await f.db.saveTokens(uid,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-'+uid});
  await f.db.ensureOnboarding(uid,{state:'READY',now:now()});
 }
 const consent=await createStage8SourceConsent({...f,ownerId:'a',enabled:()=>true,now}),monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,now});
 const source={user:await f.db.getUser('b'),chatId:'456'},owner={user:await f.db.getUser('a'),chatId:'123'};
 const actor=await monitoring.authenticate(owner);
 let op=0;
 const change=async(enable,klass='DAILY_SUMMARY')=>{
  const view=await consent.read(source),value=view.classes[klass];
  return consent.update(source,{notificationClass:klass,enabled:enable,expectedRevision:value.revision,authority:value.authority,operationKey:'synthetic-source-'+(++op)});
 };
 return {...f,now,consent,monitoring,source,owner,actor,change};
}
test('owner enrollment/follow cannot create source consent or expose an unconsented subject',async t=>{
 const f=await fixture(t);
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);assert.deepEqual(await f.monitoring.enrolled(f.actor),[]);
 await assert.rejects(f.monitoring.configure(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'owner-only'}),/SOURCE_CONSENT_REQUIRED/);
 await assert.rejects(f.monitoring.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),/SOURCE_CONSENT_REQUIRED/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_subscriptions')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,0);
});
test('authenticated source grant is class-specific and remains separate from owner follow; revoke and regrant advance retained audit',async t=>{
 const f=await fixture(t),view=await f.change(true);assert.equal(view.classes.DAILY_SUMMARY.revision,1);
 assert.ok(await f.consent.check('b','DAILY_SUMMARY'));assert.equal(await f.consent.check('b','IMPORTANT_ALERT'),null);
 assert.equal((await f.monitoring.enrolled(f.actor)).length,1);assert.deepEqual(await f.monitoring.subscriptions(f.actor),[]);
 await assert.rejects(f.monitoring.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),/SUBSCRIPTION_FENCED/);
 await f.monitoring.configure(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'explicit-owner-follow'});
 assert.equal((await f.monitoring.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'})).status,'NO_CURRENT_SYNTHESIS');
 await f.change(false);assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
 assert.deepEqual(await f.monitoring.enrolled(f.actor),[]);assert.deepEqual(await f.monitoring.subscriptions(f.actor),[]);
 await assert.rejects(f.monitoring.pending(f.actor,'b','DAILY_SUMMARY'),/SOURCE_CONSENT_REQUIRED/);
 const next=await f.change(true);assert.equal(next.classes.DAILY_SUMMARY.revision,3);
 const records=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8-source-consent:%'")).rows;
 assert.equal(records.filter(r=>r.key.includes(':revision:')).length,3);
 for(const r of records){assert.ok(!r.key.includes(':b:'));assert.doesNotMatch(r.value,/access_token|health_date|telegram_chat_id|recovery_score/);}
});
test('source actor, private callback and displayed dual-principal authority are required',async t=>{
 const f=await fixture(t),view=await f.consent.read(f.source),value=view.classes.DAILY_SUMMARY,request={notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,authority:value.authority,operationKey:'synthetic'};
 await assert.rejects(f.consent.update({...f.source,chatId:'123'},request),/SELF_ACTOR_REQUIRED/);
 await assert.rejects(f.consent.update(f.owner,request),/SELF_ACTOR_REQUIRED/);
 await assert.rejects(f.consent.update({...f.source,callback:{from:{id:123},message:{chat:{id:456,type:'private'}}}},request),/SELF_ACTOR_REQUIRED/);
 await assert.rejects(f.consent.update(f.source,{...request,notificationClass:'IMPORTANT_ALERT'}),/DISPLAY_FENCED/);
 await f.db.updateUser('a',{displayName:'Changed'},{now:f.now()});await f.db.updateUser('a',{displayName:'Synthetic'},{now:f.now()});
 await assert.rejects(f.consent.update(f.source,request),/DISPLAY_FENCED/);
});
test('concurrent stale Settings cannot overwrite newer consent and operation replay cannot revive a revoked grant',async t=>{
 const f=await fixture(t),view=await f.consent.read(f.source),value=view.classes.DAILY_SUMMARY;
 const request={notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,authority:value.authority,operationKey:'grant-once'};
 await f.consent.update(f.source,request);
 await assert.rejects(f.consent.update(f.source,{...request,enabled:false,operationKey:'stale-other'}),/CONSENT_CAS/);
 await f.change(false);await f.consent.update(f.source,request);
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
 assert.equal((await f.consent.read(f.source)).classes.DAILY_SUMMARY.revision,2);
});
for(const mutation of ['source-profile','owner-profile','source-auth','owner-auth','source-enrollment','owner-enrollment'])test(`current consent is fenced by ${mutation} ABA`,async t=>{
 const f=await fixture(t);await f.change(true);const uid=mutation.startsWith('source')?'b':'a';
 if(mutation.endsWith('profile')){await f.db.updateUser(uid,{displayName:'Changed'},{now:f.now()});await f.db.updateUser(uid,{displayName:'Synthetic'},{now:f.now()});}
 if(mutation.endsWith('auth'))await f.db.saveTokens(uid,{accessToken:'synthetic-next',refreshToken:'synthetic-next',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-'+uid},{bumpAuthGeneration:true});
 if(mutation.endsWith('enrollment')){await f.db.setOnboardingState(uid,'SYNCING',{now:f.now()});await f.db.setOnboardingState(uid,'READY',{now:f.now()});}
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
});
test('tampered or rolled-back signed consent heads fail closed; retained events prevent old grant resurrection',async t=>{
 const f=await fixture(t);await f.change(true);
 const head=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8-source-consent:v1:%:head'")).rows[0];
 await f.change(false);await f.db.setState(head.key,head.value,{now:f.now()});
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
 const corrupt=JSON.parse(head.value);corrupt.enabled=false;await f.db.setState(head.key,JSON.stringify(corrupt),{now:f.now()});
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
});
test('source Settings use localized explicit class grants/revokes with icons, nonce replay protection and no owner menu',async t=>{
 const f=await fixture(t),app={config:{ownerId:'a'},eligible:()=>true,sourceConsent:f.consent,owner:{}},settings=createSettings({db:f.db,stage8:app,now:f.now});
 for(const [locale,title] of [['zh-TW','健康分享'],['en','Health sharing'],['vi','chia sẻ']]){
  await f.db.setLocale('b',locale,{now:f.now()});let card=await settings({...f.source,text:'/settings'});
  const tap=async(action,replay=null)=>{
   const data=replay??card.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action)).callback_data;
   const result=await settings({...f.source,callback:{id:'synthetic',data,from:{id:456,is_bot:false},message:{message_id:7,chat:{id:456,type:'private'}}}});card=result;return data;
  };
  assert.ok(!card.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data.endsWith('.owner')));
  await tap('sharing');assert.ok(card.text.includes(title));
  for(const button of card.replyMarkup.inline_keyboard.flat())assert.match(button.text,/\p{Extended_Pictographic}/u);
  const used=await tap('share_daily_on');assert.ok(await f.consent.check('b','DAILY_SUMMARY'));
  await tap('share_daily_off');assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
  await tap(null,used);assert.ok(!card.replyMarkup);assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
 }
});
async function preparedOwnerCopy(t){
 const now=()=>new Date('2026-09-19T01:10:00Z'),f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 for(const [uid,chat] of [['a','123'],['b','456']]){
  const input=bodyInput({days:2});input.userId=uid;
  for(const group of [...Object.values(input.sources),input.access,input.sync,input.capabilities])for(const value of group)value.user_id=uid;
  await seedBodyInput(f.db,input);await f.db.linkTelegram({userId:uid,chatId:chat,now:now()});await f.db.setLocale(uid,'en',{now:now()});await f.db.ensureOnboarding(uid,{state:'READY',now:now()});
 }
 const consent=await createStage8SourceConsent({...f,ownerId:'a',enabled:()=>true,now}),monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,sourceConsent:consent,now});
 const source={user:await f.db.getUser('b'),chatId:'456'},owner={user:await f.db.getUser('a'),chatId:'123'},actor=await monitoring.authenticate(owner);
 let op=0;const change=async enable=>{const value=(await consent.read(source)).classes.DAILY_SUMMARY;return consent.update(source,{notificationClass:'DAILY_SUMMARY',enabled:enable,expectedRevision:value.revision,authority:value.authority,operationKey:'copy-consent-'+(++op)});};
 await change(true);await monitoring.configure(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'explicit-copy-follow'});
 await f.core.initializeTenant('b','LIVE');const ctx=await f.core.capture('b',{executionMode:'LIVE'}),plans=createStage8MorningPlan({...f,preferences:f.stores.preferences});await plans.persist(ctx,await plans.build(ctx,{healthDate:'2026-09-19'}));
 const approved=await monitoring.authorize(actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(approved.status,'APPROVED');
 const proposal=await monitoring.propose(actor,approved.ticket);
 return {...f,now,consent,monitoring,source,owner,actor,change,proposal};
}
for(const started of [false,true])test(`source revoke retracts populated owner copies and preserves ${started?'inflight provider truth':'unsent barriers'}`,async t=>{
 const f=await preparedOwnerCopy(t);let attempt;
 if(started)attempt=await f.monitoring.start(f.actor,{subjectId:'b',messageId:f.proposal.messageId,expectedRevision:0});
 await f.change(false);
 const auth=(await f.db.raw.execute('SELECT * FROM owner_monitoring_authorizations')).rows[0],out=(await f.db.raw.execute('SELECT * FROM owner_monitoring_outbox')).rows[0];
 assert.equal(auth.claims_json,null);assert.equal(auth.scope_json,null);assert.equal(auth.content_state,'REDACTED');assert.equal(auth.content_digest_salt,null);
 assert.equal(out.payload_json,null);assert.equal(out.content_state,'REDACTED');assert.equal(out.state,started?'AMBIGUOUS':'SUPPRESSED');
 await assert.rejects(f.monitoring.validate(f.actor,'b',f.proposal.messageId),/SOURCE_CONSENT_REQUIRED/);
 if(started){
  await f.monitoring.settle({subjectId:'b',messageId:f.proposal.messageId,attemptId:attempt.attemptId,outcome:'DELIVERED',providerMessageId:'999'});
  assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows[0].state,'DELIVERED');
  assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_outbox')).rows[0].state,'AMBIGUOUS');
 }
 await f.change(true);
 const next=await f.monitoring.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),same=await f.monitoring.propose(f.actor,next.ticket);
 assert.equal(same.messageId,f.proposal.messageId);assert.equal(same.status,started?'AMBIGUOUS':'SUPPRESSED');
});
test('withdrawal during the last runtime-fence await prevents provider IO and preserves a definite attempt outcome',async t=>{
 const f=await preparedOwnerCopy(t);let calls=0,validations=0,armed=false;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('SYNTHETIC_PROVIDER_MUST_NOT_BE_CALLED');});
 const boundary={...f.monitoring,validate:async(...args)=>{const result=await f.monitoring.validate(...args);if(++validations===3)armed=true;return result;}};
 const original=f.db.assertRuntimeFences;t.mock.method(f.db,'assertRuntimeFences',async()=>{if(armed){armed=false;await f.change(false);}return original?.();});
 const dispatcher=createStage8OwnerDispatcher({db:f.db,monitoring:boundary,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},enabled:()=>true,now:f.now});
 const result=await dispatcher.dispatch(f.owner,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});
 assert.equal(calls,0);assert.equal(result.providerOutcome,'FAILED_DEFINITE');
 assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows[0].state,'FAILED_DEFINITE');
});
test('only a consent store issued for the same connection, keys and recipient can authorize owner monitoring',async t=>{
 const f=await fixture(t);
 await assert.rejects(createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,sourceConsent:{check:async()=>({revision:1})}}),/SOURCE_CONSENT_STORE_REQUIRED/);
 await assert.rejects(createOwnerMonitoring({...f,ownerId:'b',enabled:()=>true,sourceConsent:f.consent}),/SOURCE_CONSENT_STORE_REQUIRED/);
});
test('turning owner monitoring off denies new grants and still permits authenticated source withdrawal',async t=>{
 const f=await fixture(t);await f.change(true);
 const stopped=await createStage8SourceConsent({...f,ownerId:'a',enabled:()=>false,now:f.now}),view=await stopped.read(f.source),value=view.classes.DAILY_SUMMARY;
 assert.equal(view.canGrant,false);assert.equal(await stopped.check('b','DAILY_SUMMARY'),null);
 await assert.rejects(stopped.update(f.source,{notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:value.revision,authority:value.authority,operationKey:'disabled-new-grant'}),/NOT_READY/);
 await stopped.update(f.source,{notificationClass:'DAILY_SUMMARY',enabled:false,expectedRevision:value.revision,authority:value.authority,operationKey:'explicit-disabled-withdrawal'});
 assert.equal(await f.consent.check('b','DAILY_SUMMARY'),null);
});
