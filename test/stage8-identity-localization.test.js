import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {fetchWhoopProfile} from '../src/whoop.js';
import {createSettings} from '../src/bot/settings.js';
import {journalCard} from '../src/stage7Cards.js';
import {TOPICS} from '../src/stage7Registry.js';
import {COACH_COPY} from '../src/companionCoach.js';
const message=name=>({chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:name}});
const tap=(reply,action)=>({data:reply.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action)).callback_data});
test('Telegram provenance is authenticated, idempotent, explicit-name subordinate, and physically erasable',async t=>{
 const f=await stage8Fixture(t),identity=f.app.identity,initial=await f.db.getProfileRevision('a');
 await assert.rejects(identity.recordTelegram({...f.input,message:{...message('Forged'),from:{id:456,first_name:'Forged'}}}),/UNAUTHENTICATED/);
 await identity.recordTelegram({...f.input,message:message('Verified Telegram')});assert.equal(await identity.resolve('a'),'Verified Telegram');assert.equal(await identity.resolve('b'),'');
 await identity.recordTelegram({...f.input,message:message('Verified Telegram')});assert.equal(await f.db.getProfileRevision('a'),initial+1);
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now});let card=await settings({...f.input,text:'/name'});card=await settings({...f.input,text:'Explicit Name'});await settings({...f.input,callback:tap(card,'save')});
 await identity.recordTelegram({...f.input,message:message('Other Telegram')});assert.equal(await identity.resolve('a'),'Explicit Name');
 await assert.rejects(identity.erase({user:await f.db.getUser('b'),chatId:'123'}),/ACTOR_CHANGED/);
 await identity.erase(f.input);assert.equal(await identity.resolve('a'),'');
 const rows=(await f.db.raw.execute("SELECT * FROM recipient_identity_sources WHERE user_id='a'")).rows;assert.ok(rows.length);assert.ok(rows.every(r=>r.content_state==='REDACTED'&&r.telegram_first_name===null&&r.explicit_display_name===null&&r.whoop_first_name===null));
 await assert.rejects(f.db.raw.execute("UPDATE recipient_identity_sources SET content_state='PRESENT' WHERE user_id='a'"),/no_rehydration/);
});
test('WHOOP profile capability binds identity and auth generation; reauthorization cannot inherit name',async t=>{
 const f=await stage8Fixture(t);await f.db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id='synthetic-a' WHERE user_id='a'");
 const profile=await fetchWhoopProfile({accessToken:'SYNTHETIC_NOT_A_TOKEN',fetchImpl:async()=>new Response(JSON.stringify({user_id:'synthetic-a',first_name:'Verified WHOOP'}),{status:200})});
 await assert.rejects(f.app.identity.recordWhoop({user:f.user,profile:{...profile},expectedAuthGeneration:1}),/PROVENANCE_REQUIRED/);
 await f.app.identity.recordWhoop({user:f.user,profile,expectedAuthGeneration:1});assert.equal(await f.app.identity.resolve('a'),'Verified WHOOP');
 await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");assert.equal(await f.app.identity.resolve('a'),'');
 await assert.rejects(f.app.identity.recordWhoop({user:f.user,profile,expectedAuthGeneration:1}),/AUTH_CHANGED/);
});
test('Telegram relink cannot inherit old provenance and pending purge blocks capture',async t=>{
 const f=await stage8Fixture(t);await f.app.identity.recordTelegram({...f.input,message:message('Bound Name')});
 await f.db.raw.execute("UPDATE user_telegram SET linked_at='2026-09-19T01:11:00.000Z' WHERE user_id='a'");assert.equal(await f.app.identity.resolve('a'),'');
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");await assert.rejects(f.app.identity.recordTelegram({...f.input,message:message('New Name')}),/PRIVACY_FENCED/);
});
for(const locale of ['zh-TW','vi','en'])test(`all Journal, Coach and owner Settings choices contain icons and localized words in ${locale}`,async t=>{
 const f=await stage8Fixture(t,{owner:true});await f.db.setLocale('a',locale);
 const check=label=>{assert.match(label,/\p{S}/u);assert.match(label,/\p{L}/u);assert.doesNotMatch(label,/undefined/);};
 for(const category of [null,...TOPICS])for(const state of ['ISSUED','CONFIRM','COMPLETED','NOT_SURE','SKIPPED','NOTE',...(category==='caffeine'?['AWAITING_DETAIL']:[])]){
  const card=journalCard({kind:'QUICK',category,state,target_date:'2026-09-18',selected_choice:'YES'},{locale});for(const row of card.buttons)for(const b of row)check(b.label);
 }
 const prefs={daily_enabled:0,weekly_enabled:0,revision:1,topics_json:'[]',excluded_topics_json:'[]',coach_topics_json:'[]',coach_enabled:0};
 for(const row of journalCard({kind:'PREFERENCES'},{locale,preferences:prefs}).buttons)for(const b of row)check(b.label);
 for(const key of ['topics','today','week','free','skip','pause','preferences'])for(const label of [].concat(COACH_COPY[locale][key]))check(label);
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now});let card=await settings({...f.input,text:'/settings'});for(const b of card.replyMarkup.inline_keyboard.flat())check(b.text);
 card=await settings({...f.input,callback:tap(card,'owner')});const subject=card.replyMarkup.inline_keyboard[0][0];check(subject.text);assert.doesNotMatch(subject.text,/^👤 \d+$/);
 card=await settings({...f.input,callback:tap(card,'subject0')});assert.ok(card.text.includes(subject.text));for(const b of card.replyMarkup.inline_keyboard.flat())check(b.text);
});
test('OAuth verified profile carries exact saved authorization generation to recipient capture',async t=>{
 const f=await stage8Fixture(t);await f.db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id='synthetic-a' WHERE user_id='a'");
 const {prepareAuthorization,completeAuthorization}=await import('../src/oauthFlow.js');
 const {state}=await prepareAuthorization({db:f.db,userId:'a',clientId:'synthetic',redirectUri:'https://synthetic.invalid/cb',now:f.now()});
 const result=await completeAuthorization({db:f.db,rawState:state,code:'synthetic',now:f.now(),exchange:async()=>({accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date('2026-12-01'),scope:'offline read:profile'}),verifyIdentity:args=>fetchWhoopProfile({...args,fetchImpl:async()=>new Response(JSON.stringify({user_id:'synthetic-a',first_name:'OAuth Name'}),{status:200})})});
 assert.equal(result.authGeneration,2);await f.app.identity.recordWhoop({user:f.user,profile:result.verifiedProfile,expectedAuthGeneration:result.authGeneration});assert.equal(await f.app.identity.resolve('a'),'OAuth Name');
});
test('real update processor captures private first-name once before composing persisted replies',async t=>{
 const f=await stage8Fixture(t),{createUpdateProcessor}=await import('../src/bot/updateProcessor.js');
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:chat=>f.db.resolveUserByChatId(chat),authenticatedIdentity:f.app.captureIdentity,handleMessage:async()=>({text:'Synthetic'}),sendReply:async()=>({sent:true,messageId:12})});
 const update={update_id:84001,message:{...message('Processor Name'),message_id:1,text:'/status'}};await processor.processUpdate(update);await processor.processUpdate(update);
 assert.equal(await f.app.identity.resolve('a'),'Processor Name');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM recipient_identity_sources')).rows[0].n,1);
});
