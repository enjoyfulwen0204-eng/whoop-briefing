import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {createStage7TelegramDevelopment} from '../src/stage7TelegramDevelopment.js';
import {conversationKeyOf} from '../src/bot/updateProcessor.js';

test('native synthetic Telegram pipeline ACKs early, edits the same card, persists receipts and rejects tenant switching',async t=>{
 const f=await stage7Fixture(t),app=await createStage7TelegramDevelopment(f);await f.db.setLocale('a','en',{now:f.core.now()});
 const message={update_id:5001,message:{message_id:1,text:'/journal',chat:{id:123,type:'private'},from:{id:123,is_bot:false}}};
 const initial=await app.processor.processUpdate(message);assert.equal(app.provider.calls.length,1,JSON.stringify(initial));
 let last=app.provider.calls.at(-1),sequence=5002;const messageId=(await f.db.getTelegramOperation(5001)).telegramMessageId??701;
 async function tap(label,chat=123){const button=last.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button);
  const update={update_id:sequence++,callback_query:{id:'q'+sequence,data:button.callback_data,from:{id:chat,is_bot:false},message:{message_id:Number(last.editMessageId??messageId),chat:{id:chat,type:'private'}}}};
  assert.equal(conversationKeyOf(update,{stage7Enabled:true}),`tg:${chat}`);const before=app.provider.calls.length;await app.processor.processUpdate(update);if(app.provider.calls.length>before)last=app.provider.calls.at(-1);return update;
 }
 await tap('Alcohol');await tap('Yes');const accepted=await tap('Confirm');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
 assert.equal(app.provider.calls.filter(c=>!c.editMessageId).length,1);
 const count=app.provider.calls.length;await app.processor.processUpdate(accepted);assert.equal(app.provider.calls.length,count);
 const button=last.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes('Edit'));
 await tap('Edit');await tap('No');await tap('Confirm');await tap('Retract');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 await app.processor.processUpdate({update_id:6000,callback_query:{id:'foreign',data:button.callback_data,from:{id:456},message:{message_id:messageId,chat:{id:456,type:'private'}}}});
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='b'")).rows[0].n,0);
 assert.ok(app.acks.includes('foreign'));assert.equal(app.acks.length,9);
});
