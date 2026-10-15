import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../..',import.meta.url).pathname.replace(/\/$/,'');
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
const {createStage7Runtime}=await import(root+'/src/stage7Runtime.js');
const {createSettings,settingsKey}=await import(root+'/src/bot/settings.js');
const {createRouter}=await import(root+'/src/bot/router.js');
const {createUpdateProcessor}=await import(root+'/src/bot/updateProcessor.js');
const {interpretUrgentSymptoms,urgentReply}=await import(root+'/src/bot/triage.js');
const {JOURNAL_COPY}=await import(root+'/src/stage7Registry.js');
const original=JSON.parse(fs.readFileSync(new URL('./original-cases.json',import.meta.url))).cases;
const references=JSON.parse(fs.readFileSync(new URL('./reference-cases.json',import.meta.url))).cases;
const output='/private/tmp/stage8-scoped-repair-limit-results.json';
const results=[];
function record(r){results.push(r);fs.writeFileSync(output,JSON.stringify({count:results.length,pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length,results},null,2));}
async function tap(app,f,card,label){const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b);return app.companion.handle({...f.input,callback:{id:'independent',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});}
async function setup(t,locale,lane){
 t.mock.method(globalThis,'fetch',()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);
 await f.app.identity.recordTelegram({...f.input,message:{chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}});
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){return null;}});
 if(lane==='name')await settings({...f.input,text:'/name'});
 if(lane==='note'){const j=JOURNAL_COPY[locale];let card=await app.companion.handle({...f.input,text:'/journal'});card=await tap(app,f,card,j.topics[0]);card=await tap(app,f,card,j.yes);card=await tap(app,f,card,j.details[0]);await tap(app,f,card,j.note);}
 if(lane==='coach')await app.coach.handle({...f.input,text:'/coach'});
 const observed={sends:0,consumers:0,captures:0};
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:input=>{observed.captures++;return f.app.captureIdentity(input);},stage7Inbound:input=>{observed.consumers++;return app.stage7Inbound(input);},stage7Reply:app.stage7Reply,handleMessage:async input=>{observed.consumers++;return (await settings(input))??router.handle(input);},sendReply:input=>f.app.sendReply(value=>app.sendReply(async delivered=>{observed.reply=delivered.reply;observed.sends++;return{sent:true,messageId:84};},value),input)});
 const snapshot=async()=>({name:await f.db.getState(settingsKey('a')),interactions:(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a'")).rows,identity:(await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows});
 return{f,app,processor,observed,snapshot};
}
function update(id,text){return{update_id:id,message:{text,message_id:id,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}};}


test('clear negative statement retains name limit and legitimate continuation',async t=>{
 const {f,processor,observed,snapshot}=await setup(t,'en','name');const before=await snapshot();
 const text='She is not experiencing her chest pain or her difficulty breathing.';
 assert.equal(text.length,67);assert.equal(interpretUrgentSymptoms(text).decision,'CLEARLY_NONURGENT');
 const u=update(970001,text);assert.equal((await processor.processUpdate(u)).outcome,'processed');assert.equal((await processor.processUpdate(u)).outcome,'replayed');
 const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;assert.equal(reply,'Invalid name. Enter 1–64 characters without control characters.');assert.notEqual(reply,urgentReply('en'));assert.equal((await snapshot()).name,before.name);assert.equal(observed.sends,1);assert.ok(observed.consumers>0);
 const valid='She has no chest pain or difficulty breathing.';assert.ok(valid.length<=64);assert.equal(interpretUrgentSymptoms(valid).decision,'CLEARLY_NONURGENT');
 assert.equal((await processor.processUpdate(update(970002,valid))).outcome,'processed');assert.equal(JSON.parse((await snapshot()).name).pendingName,valid);assert.equal(observed.sends,2);
 record({id:'independent-name-limit-adjudication',classification:'CLEARLY_NONURGENT',inputLength:67,limit:64,originalFrozenAssertion:'expects persistence of over-limit input; still FAIL',normalValidationReply:reply,validContinuation:true,pass:true,failures:[]});
});
