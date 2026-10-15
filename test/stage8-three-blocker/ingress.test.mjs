import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');const {createStage7Runtime}=await import(root+'/src/stage7Runtime.js');
const {createSettings}=await import(root+'/src/bot/settings.js');const {createRouter}=await import(root+'/src/bot/router.js');
const {createUpdateProcessor}=await import(root+'/src/bot/updateProcessor.js');const {urgentReply}=await import(root+'/src/bot/triage.js');
const symptom='我現在胸痛而且呼吸困難，今天我的 HRV 多少？';
async function tap(app,f,card,label){const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);
 const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b,label);return app.companion.handle({...f.input,callback:{id:'probe',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});}
for(const lane of ['Settings name edit','Journal optional note'])test('Recognized urgent input precedes active '+lane+' through real processor',async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a','zh-TW');const stage7=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){throw Error('MODEL_FORBIDDEN');}});
 if(lane==='Settings name edit')await settings({...f.input,text:'/name'});
 else{let card=await stage7.companion.handle({...f.input,text:'/journal'});card=await tap(stage7,f,card,'咖啡因');card=await tap(stage7,f,card,'有');card=await tap(stage7,f,card,'早上');card=await tap(stage7,f,card,'加上備註');}
 let sent;
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:f.app.captureIdentity,stage7Inbound:stage7.stage7Inbound,stage7Reply:stage7.stage7Reply,
 handleMessage:async input=>{const s=await settings(input);return s??router.handle(input);},sendReply:async input=>{sent=input.reply;return {sent:true,messageId:12};}});
 const result=await processor.processUpdate({update_id:99001,message:{text:symptom,message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}});
 const rows=(await f.db.raw.execute("SELECT state,note FROM quick_action_interactions WHERE user_id='a' AND category='caffeine'")).rows;
 console.log('INGRESS_PROBE',JSON.stringify({lane,result,reply:sent,rows}));assert.equal(typeof sent==='string'?sent:sent?.text,urgentReply('zh-TW'));assert.ok(rows.every(r=>r.note!==symptom));assert.ok(rows.every(r=>r.state==='NOTE'&&r.note===null));assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
});
