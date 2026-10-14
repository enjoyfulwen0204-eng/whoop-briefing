import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
const {createStage7Runtime}=await import(root+'/src/stage7Runtime.js');
const {createSettings,settingsKey}=await import(root+'/src/bot/settings.js');
const {createRouter}=await import(root+'/src/bot/router.js');
const {createUpdateProcessor}=await import(root+'/src/bot/updateProcessor.js');
const {urgentReply,interpretUrgentSymptoms}=await import(root+'/src/bot/triage.js');
const {JOURNAL_COPY}=await import(root+'/src/stage7Registry.js');
const cases=[
 ['name','en',true,'I have chest pain after feeling fine yesterday.'],
 ['note','en',true,'I have chest pain again after it resolved yesterday. What is my HRV?'],
 ['health','en',true,'My chest pain started yesterday and has not resolved. What is my HRV today?'],
 ['name','en',true,'I want to learn about "chest pain", which I am having right now.'],
 ['note','en',true,'I am saying "I cannot breathe" because it is happening to me now.'],
 ['health','en',true,'I have chest pain after feeling fine yesterday. What is my HRV today?'],
 ['coach','en',true,'My chest pain started yesterday and has not resolved.'],
 ['name','en',false,'I am not having acute chest pain or difficulty breathing.'],
 ['note','vi',false,'Tôi đã hết hẳn đau ngực.'],
 ['note','zh-TW',false,'我沒有任何持續性的胸痛或呼吸困難。'],
 ['coach','en',false,'I have neither chest pain nor difficulty breathing.'],
 ['health','vi',false,'Tôi muốn biết nếu tôi khó thở thì phải làm gì.'],
 ['name','en',true,'I have chest pain.'],
 ['note','vi',false,'Tôi đã hết đau ngực.'],
 ['coach','zh-TW',true,'我現在胸痛，而且呼吸困難。'],
 ['health','en',false,'What causes chest pain in general?'],
 ['health','en',true,'I have chest pain although I felt fine. What is my HRV today?'],
 ['health','vi',true,'Tôi đau ngực dù trước đây khỏe. HRV hôm nay?'],
 ['health','zh-TW',true,'我胸痛雖然以前沒事。今天我的 HRV 多少？'],
];
async function tap(app,f,card,label){const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b,label);return app.companion.handle({...f.input,callback:{id:'independent',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});}
const results=[];
for(const [i,[lane,locale,expected,text]] of cases.entries())test('independent shared scope '+(i+1)+' '+lane+' '+locale,async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);
 await f.app.identity.recordTelegram({...f.input,message:{chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}});
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 // Urgent cases forbid every ordinary provider path. Clearly nonurgent
 // cases use the existing no-provider fallback so normal routing can finish.
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){if(expected)throw Error('MODEL_FORBIDDEN');return null;}});
 if(lane==='name')await settings({...f.input,text:'/name'});
 if(lane==='note'){const c=JOURNAL_COPY[locale];let card=await app.companion.handle({...f.input,text:'/journal'});card=await tap(app,f,card,c.topics[0]);card=await tap(app,f,card,c.yes);card=await tap(app,f,card,c.details[0]);await tap(app,f,card,c.note);}
 if(lane==='coach')await app.coach.handle({...f.input,text:'/coach'});
 const beforeName=await f.db.getState(settingsKey('a')),beforeJournal=JSON.stringify((await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a'")).rows),beforeIdentity=JSON.stringify((await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows);
 let sent,sends=0,ordinaryCalls=0;
 const p=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:f.app.captureIdentity,stage7Inbound:app.stage7Inbound,stage7Reply:app.stage7Reply,handleMessage:async input=>{ordinaryCalls++;return (await settings(input))??router.handle(input);},sendReply:input=>app.sendReply(async inp=>{sends++;sent=inp.reply;return {sent:true,messageId:84};},input)});
 const update={update_id:97500+i,message:{text,message_id:97500+i,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}};
 const outcome=await p.processUpdate(update),replay=await p.processUpdate(update);
 const actual=(typeof sent==='string'?sent:sent?.text)===urgentReply(locale);
 const row=(await f.db.raw.execute("SELECT state,note FROM quick_action_interactions WHERE user_id='a' AND category='caffeine'")).rows[0];
 const result={id:i+1,lane,locale,expectedUrgent:expected,text,classification:interpretUrgentSymptoms(text),outcome,replay,sends,actualSafety:actual,ordinaryCalls,scopedReads:(await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,beforeName,afterName:await f.db.getState(settingsKey('a')),note:row,conversationChanged:beforeJournal!==JSON.stringify((await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a'")).rows),identityChanged:beforeIdentity!==JSON.stringify((await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows),reply:sent};
 results.push(result);fs.writeFileSync('/private/tmp/stage8-triage-architecture-after-processor.json',JSON.stringify(results,null,2));console.log('ARCHITECTURE_INGRESS',JSON.stringify({id:i+1,lane,locale,actualSafety:actual,ordinaryCalls,scopedReads:result.scopedReads,conversationChanged:result.conversationChanged}));
 assert.equal(outcome.outcome,'processed');assert.equal(replay.outcome,'replayed');assert.equal(sends,1);assert.equal(actual,expected,'Safety decision mismatch: '+JSON.stringify(result));
 if(expected){assert.equal(ordinaryCalls,0);assert.equal(result.scopedReads,0);assert.equal(result.afterName,beforeName);assert.equal(result.conversationChanged,false);assert.equal(result.identityChanged,false);}
 else if(lane==='name')assert.equal(JSON.parse(result.afterName).pendingName,text);
 else if(lane==='note'){assert.equal(row.state,'CONFIRM');assert.equal(row.note,text);}
});
