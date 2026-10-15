import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../..',import.meta.url).pathname.replace(/\/$/,'');
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
const {createStage7Runtime}=await import(root+'/src/stage7Runtime.js');
const {createSettings,settingsKey,normalizeSettingsName,SETTINGS_NAME_LIMIT,SETTINGS_COPY}=await import(root+'/src/bot/settings.js');
const {createRouter}=await import(root+'/src/bot/router.js');
const {createUpdateProcessor}=await import(root+'/src/bot/updateProcessor.js');
const {interpretUrgentSymptoms,urgentReply}=await import(root+'/src/bot/triage.js');
const {JOURNAL_COPY}=await import(root+'/src/stage7Registry.js');
const original=JSON.parse(fs.readFileSync(new URL('./original-cases.json',import.meta.url))).cases;
const references=JSON.parse(fs.readFileSync(new URL('./reference-cases.json',import.meta.url))).cases;
const output='/private/tmp/stage8-scoped-repair-independent-processor-results.json';
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
const jobs=[];
for(const id of ['present-perfect','different-friends','conditional-actual-tail','time-adjacent-no-now','reference-other-headache']){
 const c=[...original,...references].find(c=>c.id===id);assert.ok(c);
 for(const lane of ['name','note','health'])jobs.push({...c,locale:'en',lane});
}
for(const [id,locale] of [['reference-zh','zh-TW'],['reference-vi','vi'],['zh-other-distinct','zh-TW'],['vi-distinct-other','vi']]){
 const c=[...original,...references].find(c=>c.id===id);for(const lane of ['note','health'])jobs.push({...c,locale,lane});
}
for(const locale of ['en','vi','zh-TW'])for(const lane of ['name','note','coach','health'])jobs.push({id:'positive-'+locale,locale,lane,expected:'SAFETY',text:{en:'I have "chest pain" and cannot breathe now.',vi:'Tôi đã hết đau ngực nhưng tôi đang khó thở.','zh-TW':'我昨天胸痛然而我現在呼吸困難。'}[locale]});
for(const id of ['neg-possession','neg-other-object'])for(const lane of ['name','note'])jobs.push({...original.find(c=>c.id===id),locale:'en',lane});
fs.writeFileSync('/private/tmp/stage8-scoped-repair-independent-processor-cases.json',JSON.stringify({frozenBeforeExecution:true,count:jobs.length,jobs},null,2));
for(const [i,c] of jobs.entries())test('independent ingress '+c.id+' '+c.lane,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,c.locale,c.lane);
 const before=await snapshot();const invalidName=c.id==='neg-other-object'&&c.lane==='name';const profileBefore=invalidName?await f.db.getUser('a'):null,revisionBefore=invalidName?await f.db.getProfileRevision('a'):null;const text=c.text+(c.lane==='health'?' What is my HRV today?':'');
 const u=update(900001+i,text),outcome=await processor.processUpdate(u),replay=await processor.processUpdate(u);
 const after=await snapshot(),scopeReads=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n);
 const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;
 const failures=[];if(outcome.outcome!=='processed')failures.push('not-processed');if(replay.outcome!=='replayed'||observed.sends!==1)failures.push('replay');
 if(c.expected==='SAFETY'){
  if(reply!==urgentReply(c.locale))failures.push('missing-safety');
  if(JSON.stringify(before)!==JSON.stringify(after))failures.push('persistence-changed');
  if(scopeReads)failures.push('ordinary-scope-opened');
  if(observed.consumers||observed.captures)failures.push('ordinary-consumer');
 }else{
  if(reply===urgentReply(c.locale))failures.push('false-emergency');
  if(c.lane==='name'){
   if(invalidName){
    assert.equal([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].length,67);assert.equal(SETTINGS_NAME_LIMIT,64);assert.throws(()=>normalizeSettingsName(text),/SETTINGS_NAME_INVALID/);
    if(reply!==SETTINGS_COPY[c.locale].invalid||after.name!==before.name)failures.push('invalid-name-contract');
    assert.deepEqual(await f.db.getUser('a'),profileBefore);assert.equal(await f.db.getProfileRevision('a'),revisionBefore);
    const valid='Valid Reader';assert.equal((await processor.processUpdate(update(990001,valid))).outcome,'processed');assert.equal(JSON.parse((await snapshot()).name).pendingName,valid);assert.equal(observed.sends,2);assert.equal(await f.db.getProfileRevision('a'),revisionBefore);
   }else if(JSON.parse(after.name??'{}').pendingName!==text)failures.push('normal-name-blocked');
  }
  if(c.lane==='note'&&!after.interactions.some(r=>r.note===text&&r.state==='CONFIRM'))failures.push('normal-note-blocked');
 }
 const row={id:c.id,lane:c.lane,locale:c.locale,text,expected:c.expected,classification:interpretUrgentSymptoms(text).decision,pass:failures.length===0,failures,scopeReads,reply,observed:{sends:observed.sends,consumers:observed.consumers,captures:observed.captures},name:after.name,notes:after.interactions.filter(r=>r.note).map(r=>({note:r.note,state:r.state}))};record(row);
 assert.deepEqual(failures,[],JSON.stringify(row));
});
for(const locale of ['en','vi','zh-TW'])for(const lane of ['name','note','coach'])test('normal flow '+locale+' '+lane,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,locale,lane);
 const text=lane==='name'?'Synthetic Reader':lane==='note'?{en:'My chest pain and difficulty breathing have resolved.',vi:'Tôi đã hết đau ngực và khó thở.','zh-TW':'我胸痛和呼吸困難都已經好了。'}[locale]:'/coach';
 const outcome=await processor.processUpdate(update(920001,text));const after=await snapshot();const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;
 const failures=[];if(outcome.outcome!=='processed'||reply===urgentReply(locale))failures.push('normal-flow');
 if(lane==='name'&&JSON.parse(after.name??'{}').pendingName!==text)failures.push('normal-name');
 if(lane==='note'&&!after.interactions.some(r=>r.note===text&&r.state==='CONFIRM'))failures.push('normal-note');
 if(lane==='coach'&&!observed.reply?.replyMarkup?.inline_keyboard.flat().length)failures.push('normal-coach');
 record({id:'normal-'+locale,lane,locale,text,pass:!failures.length,failures,reply});assert.deepEqual(failures,[]);
});
for(const kind of ['forged','bot','group','inactive'])test('ingress authority '+kind,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,'en','name');const before=await snapshot();const u=update(930001,'I have chest pain right now.');
 if(kind==='forged')u.message.from.id=456;if(kind==='bot')u.message.from.is_bot=true;if(kind==='group')u.message.chat.type='group';if(kind==='inactive')await f.db.transitionUserLifecycle({userId:'a',targetStatus:'PAUSED'});
 const outcome=await processor.processUpdate(u);const after=await snapshot();const failures=[];
 if(observed.sends||observed.consumers||JSON.stringify(before)!==JSON.stringify(after))failures.push('authority-side-effect');
 if(Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n))failures.push('unauthorized-scope');
 record({id:'authority-'+kind,outcome,pass:!failures.length,failures,observed});assert.deepEqual(failures,[]);
});
