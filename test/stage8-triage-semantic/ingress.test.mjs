import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from '../stage8Fixture.js';
import {createStage7Runtime} from '../../src/stage7Runtime.js';
import {createSettings,settingsKey} from '../../src/bot/settings.js';
import {createRouter} from '../../src/bot/router.js';
import {createUpdateProcessor} from '../../src/bot/updateProcessor.js';
import {urgentReply} from '../../src/bot/triage.js';
import {JOURNAL_COPY} from '../../src/stage7Registry.js';
const current={en:'What causes my current chest pain and difficulty breathing?',vi:'Tôi muốn tìm hiểu HRV vì tôi không thở được.','zh-TW':'我想知道我目前胸痛且呼吸困難的原因'};
const resolved={en:'No longer having chest pain',vi:'Tôi đã hết đau ngực','zh-TW':'我昨天胸痛，現在已經好了'};
async function tap(app,f,card,label){const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b,label);return app.companion.handle({...f.input,callback:{id:'synthetic',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});}
for(const locale of ['zh-TW','en','vi'])for(const lane of ['name','note'])test(`semantic scope preserves real ${lane} state, replay and normal continuation in ${locale}`,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);await f.app.identity.recordTelegram({...f.input,message:{chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}});const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){throw Error('MODEL_FORBIDDEN');}});
 if(lane==='name')await settings({...f.input,text:'/name'});
 else{const c=JOURNAL_COPY[locale];let card=await app.companion.handle({...f.input,text:'/journal'});card=await tap(app,f,card,c.topics[0]);card=await tap(app,f,card,c.yes);card=await tap(app,f,card,c.details[0]);await tap(app,f,card,c.note);}
 const oldName=await f.db.getState(settingsKey('a')),oldNotes=JSON.stringify((await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a' AND state='NOTE'")).rows),oldIdentity=JSON.stringify((await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows);let sent,sends=0;
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:f.app.captureIdentity,stage7Inbound:app.stage7Inbound,stage7Reply:app.stage7Reply,handleMessage:async input=>(await settings(input))??router.handle(input),sendReply:input=>app.sendReply(async inp=>{sends++;sent=inp.reply;return {sent:true,messageId:84};},input)});
 const update=(id,text)=>({update_id:id,message:{text,message_id:id,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}});
 const urgent=update(96501,current[locale]);assert.equal((await processor.processUpdate(urgent)).outcome,'processed');assert.equal(sent.text,urgentReply(locale));assert.equal(await f.db.getState(settingsKey('a')),oldName);assert.equal(JSON.stringify((await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a' AND state='NOTE'")).rows),oldNotes);assert.equal(JSON.stringify((await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows),oldIdentity);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 assert.equal((await processor.processUpdate(urgent)).outcome,'replayed');assert.equal(sends,1);
 assert.equal((await processor.processUpdate(update(96502,lane==='name'?'Nonurgent Name':resolved[locale]))).outcome,'processed');assert.notEqual(sent.text,urgentReply(locale));
 if(lane==='name')assert.equal(JSON.parse(await f.db.getState(settingsKey('a'))).pendingName,'Nonurgent Name');else{const row=(await f.db.raw.execute("SELECT state,note FROM quick_action_interactions WHERE user_id='a' AND category='caffeine'")).rows[0];assert.equal(row.state,'CONFIRM');assert.equal(row.note,resolved[locale]);}
 console.log('SEMANTIC_INGRESS_PASS',JSON.stringify({locale,lane,sends,ordinaryScopeReads:0}));
});
