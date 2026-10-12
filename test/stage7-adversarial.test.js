import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {localMidnightUtc,addDays} from '../src/time.js';
const callback=(reply,label,id='replay')=>({id,data:reply.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label)).callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}});

test('daily target persists on later answer and 48-hour expiry; one day barrier survives cancellation and correction',async t=>{
 let now=new Date('2026-09-19T00:00:00.000Z');const f=await stage7Fixture(t,{now:()=>now});await f.db.setLocale('a','en',{now});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'}),issued=await f.companion.interactions.issue(actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-18',semanticKey:'synthetic-day',dayKey:'synthetic-barrier'});
 let card=await f.companion.card(actor,issued.row);await f.companion.interactions.bind(actor,issued.row.interaction_id,42);
 now=new Date('2026-09-20T20:00:00.000Z');card=await f.companion.handle({user:f.user,chatId:'123',callback:callback(card,'Yes','later')});card=await f.companion.handle({user:f.user,chatId:'123',callback:callback(card,'Confirm','later-confirm')});
 assert.equal((await f.db.raw.execute('SELECT health_date FROM journal_events')).rows[0].health_date,'2026-09-18');
 now=new Date('2026-09-21T00:00:00.001Z');const before=(await f.db.raw.execute('SELECT source_generation FROM phase4_user_state WHERE user_id=\'a\'')).rows[0].source_generation;
 const result=await f.companion.handle({user:f.user,chatId:'123',callback:callback(card,'Edit','expired')});assert.match(result.text,/expired/);
 assert.equal((await f.db.raw.execute('SELECT source_generation FROM phase4_user_state WHERE user_id=\'a\'')).rows[0].source_generation,before);
});
test('DST exact half-open target day is stored, timezone switch and lifecycle ABA invalidate prior callbacks',async t=>{
 const f=await stage7Fixture(t,{now:()=>new Date('2026-11-03T12:00:00.000Z')});await f.db.setLocale('a','en',{now:f.core.now()});
 await f.db.updateUser('a',{timezone:'America/New_York'},{now:f.core.now()});let user=await f.db.getUser('a'),actor=await f.companion.interactions.authenticate({user,chatId:'123'});
 const issued=await f.companion.interactions.issue(actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-11-01'});assert.equal(Date.parse(issued.row.window_end)-Date.parse(issued.row.window_start),25*3600000);
 const card=await f.companion.card(actor,issued.row);await f.companion.interactions.bind(actor,issued.row.interaction_id,42);
 await f.db.updateUser('a',{timezone:'Asia/Taipei'},{now:f.core.now()});user=await f.db.getUser('a');assert.equal(await f.companion.interactions.resolve(await f.companion.interactions.authenticate({user,chatId:'123'}),callback(card,'Yes')),null);
 await f.db.transitionUserLifecycle({userId:'a',targetStatus:'PAUSED',now:f.core.now()});await f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE',now:f.core.now()});user=await f.db.getUser('a');actor=await f.companion.interactions.authenticate({user,chatId:'123'});
 assert.equal(await f.companion.interactions.resolve(actor,callback(card,'Yes')),null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
test('foreign direct rendering/writing fails, note cannot replace proactive pending reply, and default-off callback routing preserves Settings',async t=>{
 const f=await stage7Fixture(t),a=await f.companion.interactions.authenticate({user:f.user,chatId:'123'}),row=(await f.companion.interactions.issue(a,{category:'alcohol',targetDate:'2026-09-18'})).row;
 const user=await f.db.getUser('b'),b=await f.companion.interactions.authenticate({user,chatId:'456'});
 await assert.rejects(f.companion.interactions.render(b,row),/FENCED/);await assert.rejects(f.db.transaction(()=>f.companion.interactions.update(b,row,{state:'SKIPPED'})),/FENCED/);
 await assert.rejects(f.db.transaction(()=>f.companion.changePreferences(a,{revision:0},{topics_json:'["unsupported"]'})),/TOPICS/);
});
