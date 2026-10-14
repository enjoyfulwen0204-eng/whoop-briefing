import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {stage8Fixture} from '../stage8Fixture.js';
import {createStage7Runtime} from '../../src/stage7Runtime.js';
import {createSettings,settingsKey} from '../../src/bot/settings.js';
import {createRouter} from '../../src/bot/router.js';
import {createUpdateProcessor} from '../../src/bot/updateProcessor.js';
import {interpretUrgentSymptoms,urgentReply} from '../../src/bot/triage.js';
import {JOURNAL_COPY} from '../../src/stage7Registry.js';
const contract=JSON.parse(fs.readFileSync(new URL('./contract.json',import.meta.url)));
async function tap(app,f,card,label){const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b);return app.companion.handle({...f.input,callback:{id:'ownership',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});}
const cases=[...contract.cases.map((c,i)=>({text:c.text,locale:i===2?'zh-TW':'en',decision:c.decision})),...Object.entries({en:'chest pain',vi:'khó thở','zh-TW':'胸痛'}).map(([locale,text])=>({text,locale,decision:'POSSIBLE_CURRENT_URGENT'}))];
for(const [i,c] of cases.entries())for(const lane of ['name','note','health'])test('ownership shared processor '+i+' '+lane,async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
 assert.equal(interpretUrgentSymptoms(c.text).decision,c.decision);
 const f=await stage8Fixture(t);await f.db.setLocale('a',c.locale);
 const message={text:c.text,message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}};
 await f.app.identity.recordTelegram({...f.input,message});
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){throw Error('MODEL_FORBIDDEN');}});
 if(lane==='name')await settings({...f.input,text:'/name'});
 if(lane==='note'){const j=JOURNAL_COPY[c.locale];let card=await app.companion.handle({...f.input,text:'/journal'});card=await tap(app,f,card,j.topics[0]);card=await tap(app,f,card,j.yes);card=await tap(app,f,card,j.details[0]);await tap(app,f,card,j.note);}
 const snapshot=async()=>({name:await f.db.getState(settingsKey('a')),interactions:(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a'")).rows,identity:(await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows});
 const before=await snapshot();let sent,sends=0,consumers=0,captures=0;
 const p=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:input=>{captures++;return f.app.captureIdentity(input);},stage7Inbound:input=>{consumers++;return app.stage7Inbound(input);},stage7Reply:app.stage7Reply,handleMessage:async input=>{consumers++;return (await settings(input))??router.handle(input);},sendReply:input=>f.app.sendReply(value=>app.sendReply(async delivered=>{sent=delivered.reply;sends++;return {sent:true,messageId:84};},value),input)});
 const update={update_id:99800+i,message};assert.equal((await p.processUpdate(update)).outcome,'processed');assert.equal((await p.processUpdate(update)).outcome,'replayed');
 assert.equal(typeof sent==='string'?sent:sent.text,urgentReply(c.locale));assert.equal(sends,1);assert.equal(consumers,0);assert.equal(captures,0);assert.deepEqual(await snapshot(),before);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
});
