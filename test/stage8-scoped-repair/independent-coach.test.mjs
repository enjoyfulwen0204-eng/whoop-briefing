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
const output='/private/tmp/stage8-scoped-repair-independent-coach-results.json';
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

const jobs=[
 {id:'present-perfect-coach',locale:'en',text:'I have had chest pain since this morning. What is my HRV today?',lane:'coach'},
 {id:'new-reference-coach',locale:'en',text:'I have chest pain. I had a headache yesterday. It has resolved. What is my HRV today?',lane:'coach'},
];
fs.writeFileSync('/private/tmp/stage8-scoped-repair-independent-coach-cases.json',JSON.stringify({frozenBeforeExecution:true,count:jobs.length,jobs},null,2));
for(const [i,c]of jobs.entries())test('targeted ingress '+c.id+' '+c.locale+' '+c.lane,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,c.locale,c.lane);const before=await snapshot();
 const text=c.text+(c.lane==='health'?' What is my HRV today?':'');const u=update(940001+i,text);
 const outcome=await processor.processUpdate(u),replay=await processor.processUpdate(u);const after=await snapshot();
 const scopeReads=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n);
 const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;
 const failures=[];if(outcome.outcome!=='processed')failures.push('not-processed');if(replay.outcome!=='replayed'||observed.sends!==1)failures.push('replay');
 if(reply!==urgentReply(c.locale))failures.push('missing-safety');if(JSON.stringify(before)!==JSON.stringify(after))failures.push('persistence-changed');if(scopeReads)failures.push('ordinary-scope-opened');if(observed.consumers||observed.captures)failures.push('ordinary-consumer');
 const row={id:c.id,locale:c.locale,lane:c.lane,text,classification:interpretUrgentSymptoms(text).decision,pass:!failures.length,failures,reply,scopeReads,name:after.name,notes:after.interactions.filter(r=>r.note).map(r=>({note:r.note,state:r.state})),observed:{sends:observed.sends,consumers:observed.consumers,captures:observed.captures}};record(row);assert.deepEqual(failures,[],JSON.stringify(row));
});
