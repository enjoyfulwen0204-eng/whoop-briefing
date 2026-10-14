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
const output='/private/tmp/stage8-scoped-repair-added-processor-results.json';
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

const families=[
 {id:'PO-H01',expected:'CURRENT_URGENT',texts:{en:'I have chest pain. I had a headache yesterday. It has resolved.','zh-TW':'我現在胸痛。我昨天頭痛。它已經好了。',vi:'Tôi đang đau ngực. Tôi đau đầu hôm qua. Nó đã hết.'}},
 {id:'PO-H02',expected:'CURRENT_URGENT',texts:{en:'My friend Ana has chest pain. My friend Bo has no chest pain.','zh-TW':'我朋友小明胸痛。我朋友小華沒有胸痛。',vi:'Bạn tôi An đau ngực. Bạn tôi Bình đã hết đau ngực.'}},
 {id:'PO-H03',expected:'CURRENT_URGENT',texts:{en:'I have had chest pain since this morning.','zh-TW':'我從今天早上一直胸痛。',vi:'Tôi đau ngực từ sáng nay đến giờ.'}},
 {id:'PO-H04',expected:'CURRENT_URGENT',texts:{en:'If chest pain is dangerous, please help: I have chest pain now.','zh-TW':'如果胸痛很危險，我現在胸痛。',vi:'Nếu đau ngực nguy hiểm, tôi đang đau ngực.'}},
 {id:'PO-H05',expected:'CURRENT_URGENT',texts:{en:'I had chest pain yesterday I have difficulty breathing.','zh-TW':'我昨天胸痛我呼吸困難。',vi:'Tôi đau ngực hôm qua tôi khó thở.'}},
 {id:'PO-H06',expected:'POSSIBLE_CURRENT_URGENT',texts:{en:'I cannot say that I do not have chest pain.','zh-TW':'我無法確定我沒有胸痛。',vi:'Tôi không thể nói rằng tôi không đau ngực.'}},
 {id:'PO-M01',expected:'CLEARLY_NONURGENT',texts:{en:'I am not experiencing my chest pain or my difficulty breathing.','zh-TW':'我沒有胸痛和我的呼吸困難。',vi:'Tôi không có đau ngực và tôi không khó thở.'}},
];
const jobs=[];
for(const f of families)for(const [locale,text] of Object.entries(f.texts)){
 const lanes=f.id==='PO-M01'||f.id==='PO-H06'?['name','note',f.id==='PO-M01'?'coach':'health']:[{en:'name','zh-TW':'note',vi:'health'}[locale]];
 for(const lane of lanes)jobs.push({id:f.id,expected:f.expected,locale,text,lane});
}
assert.equal(jobs.length,33);
for(const [i,c] of jobs.entries())test('seven family shared processor '+c.id+' '+c.locale+' '+c.lane,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,c.locale,c.lane);const before=await snapshot();
 const text=c.text+(c.lane==='health'?' What is my HRV today?':'');assert.equal(interpretUrgentSymptoms(text).decision,c.expected);
 const u=update(960001+i,text);const outcome=await processor.processUpdate(u),replay=await processor.processUpdate(u);const after=await snapshot();
 const scopeReads=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n),reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;
 const failures=[];if(outcome.outcome!=='processed'||replay.outcome!=='replayed'||observed.sends!==1)failures.push('receipt/replay');
 if(c.expected!=='CLEARLY_NONURGENT'){
  if(reply!==urgentReply(c.locale))failures.push('missing-safety');if(JSON.stringify(before)!==JSON.stringify(after))failures.push('persistence');if(scopeReads||observed.consumers||observed.captures)failures.push('ordinary-consumer');
 }else{
  if(reply===urgentReply(c.locale))failures.push('false-emergency');if(!observed.consumers)failures.push('normal-route-blocked');
  if(c.lane==='name'&&JSON.parse(after.name??'{}').pendingName!==text)failures.push('name-blocked');
  if(c.lane==='note'&&!after.interactions.some(r=>r.state==='CONFIRM'&&r.note===text))failures.push('note-blocked');
 }
 record({id:c.id,locale:c.locale,lane:c.lane,text,expected:c.expected,decision:interpretUrgentSymptoms(text).decision,scopeReads,observed:{sends:observed.sends,captures:observed.captures,consumers:observed.consumers},pass:!failures.length,failures});assert.deepEqual(failures,[]);
});
