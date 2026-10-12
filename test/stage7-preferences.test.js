import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {JOURNAL_COPY} from '../src/stage7Registry.js';

let sequence=0;
async function tap(f,card,label,messageId=501){
 const button=typeof label==='string'?card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label)):label;assert.ok(button);
 const id=card.editMessageId??messageId,actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 await f.companion.interactions.bind(actor,card.stage7InteractionId,id);
 assert.ok(Buffer.byteLength(button.callback_data)<=64);
 return f.companion.handle({user:f.user,chatId:'123',callback:{id:`pref-${++sequence}`,data:button.callback_data,from:{id:123},message:{message_id:Number(id),chat:{id:123,type:'private'}}}});
}
const prefs=f=>f.db.raw.execute("SELECT * FROM journal_tracking_preferences WHERE user_id='a'").then(r=>r.rows[0]);
const open=async(f,c,id)=>tap(f,await f.command(),c.preferences,id);

test('independent daily cards retain desired values and reject global preference ABA',async t=>{
 const f=await stage7Fixture(t);await f.db.setLocale('a','en',{now:f.core.now()});const c=JOURNAL_COPY.en;
 const old=await open(f,c,501);let current=await open(f,c,502);current=await tap(f,current,c.enable);
 assert.equal((await prefs(f)).daily_enabled,1);assert.equal((await tap(f,old,c.enable)).text,c.expired);assert.equal((await prefs(f)).daily_enabled,1);
 current=await tap(f,current,c.disable);const before=await prefs(f);assert.equal(before.daily_enabled,0);
 assert.equal((await tap(f,old,c.enable)).text,c.expired);assert.equal((await prefs(f)).revision,before.revision);assert.equal((await prefs(f)).daily_enabled,0);
});

for(const locale of ['zh-TW','vi','en'])test(`tracking, exclusions and weekly choices preserve localized displayed intent: ${locale}`,async t=>{
 const f=await stage7Fixture(t);await f.db.setLocale('a',locale,{now:f.core.now()});const c=JOURNAL_COPY[locale],old=await open(f,c,501);let current=await open(f,c,502);
 current=await tap(f,current,c.topics[0]);assert.deepEqual(JSON.parse((await prefs(f)).topics_json),['caffeine']);
 assert.equal((await tap(f,old,c.topics[0])).text,c.expired);assert.deepEqual(JSON.parse((await prefs(f)).topics_json),['caffeine']);
 current=await tap(f,current,current.replyMarkup.inline_keyboard[0][1]);assert.deepEqual(JSON.parse((await prefs(f)).excluded_topics_json),['caffeine']);
 current=await tap(f,current,c.weeklyEnable);assert.equal((await prefs(f)).weekly_enabled,1);
 current=await tap(f,current,c.weeklyDisable);assert.equal((await prefs(f)).weekly_enabled,0);
 assert.equal((await tap(f,old,c.weeklyEnable)).text,c.expired);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0,'preferences never assert daily health facts');
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM journal_tracking_preferences WHERE user_id='b'")).rows[0].n,0);
});

test('concurrent preference cards commit one displayed intent at their shared revision',async t=>{
 const f=await stage7Fixture(t);await f.db.setLocale('a','en',{now:f.core.now()});const c=JOURNAL_COPY.en,first=await open(f,c,501),second=await open(f,c,502);
 const results=await Promise.all([tap(f,first,c.enable),tap(f,second,c.weeklyEnable)]),p=await prefs(f);
 assert.equal(p.daily_enabled+p.weekly_enabled,1);assert.equal(p.revision,1);assert.equal(results.filter(r=>r.text===c.expired).length,1);
});
