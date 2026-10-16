import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {captureStage7Enrollment,assertStage7Enrollment} from '../src/stage7Enrollment.js';
import {createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {createStage7Dispatcher} from '../src/stage7Dispatcher.js';
import {createStage7ProductionProvider} from '../src/stage7TransportAuthority.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';

async function fixture(t){
 const f=await stage7Fixture(t);
 await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 const row={schedule_json:JSON.stringify({enrollment:await captureStage7Enrollment({...f,actor})})};
 return {...f,actor,row};
}
test('unchanged READY enrollment permits the existing synthetic provider; no production capability is granted',async t=>{
 const f=await fixture(t),provider=createSyntheticJournalTelegram();
 await assertStage7Enrollment(f);await provider.send({text:'Synthetic navigation'});
 assert.equal(provider.calls.length,1);
});
for(const change of ['not-ready','ready-ABA','profile-ABA','reauthorize-ABA','unbound'])test(`selected enrollment rejects ${change} before provider IO`,async t=>{
 const f=await fixture(t),provider=createSyntheticJournalTelegram();
 // Render precedes the final authority recheck, as in automatic dispatch.
 const menu=await f.command();assert.ok(menu.replyMarkup);
 if(change==='not-ready')await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");
 if(change==='ready-ABA'){
  await f.db.setOnboardingState('a','SYNCING',{now:new Date('2026-09-19T00:00:01Z')});
  await f.db.setOnboardingState('a','READY',{now:new Date('2026-09-19T00:00:02Z')});
 }
 if(change==='profile-ABA'){
  await f.db.updateUser('a',{displayName:'Changed'},{now:f.core.now()});
  await f.db.updateUser('a',{displayName:'Synthetic'},{now:f.core.now()});
 }
 if(change==='reauthorize-ABA'){
  for(let n=0;n<2;n++)await f.db.saveTokens('a',{accessToken:'synthetic-next',refreshToken:'synthetic-next',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now(),bumpAuthGeneration:true});
  f.actor=await f.companion.interactions.authenticate({user:await f.db.getUser('a'),chatId:'123'});
 }
 if(change==='unbound')f.row={schedule_json:null};
 await assert.rejects(async()=>{await assertStage7Enrollment(f);await provider.send({text:'Synthetic navigation'});},/STAGE7_ENROLLMENT_FENCED/);
 assert.equal(provider.calls.length,0);
});
test('existing transport records a final enrollment rejection as definite non-send with zero API calls',async t=>{
 const f=await fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('SYNTHETIC_PROVIDER_MUST_NOT_BE_CALLED');});
 await f.core.transaction(async()=>{
  const p=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,p,{daily_enabled:1});
  await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-19','synthetic',?,?,1,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp()]});
 });
 await confirmedLegacyBrief(f);
 const proposal=await f.companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-09-19'});
 // This exercises the existing pre-provider fence/receipt classification with
 // an owned in-memory DB. It grants no automatic rollout or cohort exception.
 const admission=await f.db.admitRuntime(),provider=createStage7ProductionProvider({...f,admission,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},userIds:['a'],beforeSend:async()=>{
  const row=(await f.db.raw.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE delivery_id=?',args:[proposal.deliveryId]})).rows[0];
  await assertStage7Enrollment({...f,row});
 }});
 const dispatcher=createStage7Dispatcher({...f,provider}),card=f.companion.card;
 f.companion.card=async(...args)=>{const result=await card(...args);await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");return result;};
 const result=await dispatcher.dispatch({user:f.user,chatId:'123',deliveryId:proposal.deliveryId});
 assert.equal(result.status,'FAILED_DEFINITE');assert.equal(calls,0);
 assert.equal((await f.db.raw.execute('SELECT state FROM journal_delivery_attempts')).rows[0].state,'FAILED_DEFINITE');
});
