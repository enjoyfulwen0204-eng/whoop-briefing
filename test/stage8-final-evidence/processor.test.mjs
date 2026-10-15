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
const original=JSON.parse(fs.readFileSync(new URL('../stage8-scoped-repair/original-cases.json',import.meta.url))).cases;
const references=JSON.parse(fs.readFileSync(new URL('../stage8-scoped-repair/reference-cases.json',import.meta.url))).cases;
const output='/private/tmp/stage8-final-quotation-repair/final/copied-processor-results.json';
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

const novel=JSON.parse(fs.readFileSync(new URL('./independent40.json',import.meta.url)));
const jobs=[];
for(const [id,locale]of[['explicit-other-outcome','en'],['explicit-other-outcome-zh','zh-TW'],['explicit-other-outcome-vi','vi']])for(const lane of ['name','note','coach','health'])jobs.push({...novel.find(c=>c.id===id),locale,lane});
for(const [id,locale]of[['comma-negation','en'],['ideographic-object-list','zh-TW'],['closed-duration','en'],['causal-since','en'],['explicit-same-outcome','en']])for(const lane of ['name','note'])jobs.push({...novel.find(c=>c.id===id),locale,lane});
fs.writeFileSync('/private/tmp/stage8-final-quotation-repair/final/copied-processor-cases.json',JSON.stringify({frozenBeforeExecution:true,jobs},null,2));
for(const [i,c]of jobs.entries())test('novel real ingress '+c.id+' '+c.locale+' '+c.lane,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,c.locale,c.lane);const before=await snapshot();const text=c.text+(c.lane==='health'?' What is my HRV today?':'');
 const u=update(991001+i,text);const outcome=await processor.processUpdate(u),replay=await processor.processUpdate(u);const after=await snapshot();
 const scopeReads=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n);const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;const failures=[];
 if(outcome.outcome!=='processed'||replay.outcome!=='replayed'||observed.sends!==1)failures.push('transport-or-replay');
 if(c.expected==='SAFETY'){
  if(reply!==urgentReply(c.locale))failures.push('missing-safety');if(JSON.stringify(before)!==JSON.stringify(after))failures.push('persistence-changed');if(scopeReads)failures.push('ordinary-scope-opened');if(observed.consumers||observed.captures)failures.push('ordinary-consumer');
 }else{
  if(reply===urgentReply(c.locale))failures.push('false-emergency');if(c.lane==='name'&&JSON.parse(after.name??'{}').pendingName!==text)failures.push('normal-name-blocked');if(c.lane==='note'&&!after.interactions.some(r=>r.note===text&&r.state==='CONFIRM'))failures.push('normal-note-blocked');
 }
 const row={id:c.id,locale:c.locale,lane:c.lane,text,expected:c.expected,classification:interpretUrgentSymptoms(text).decision,pass:!failures.length,failures,reply,scopeReads,name:after.name,notes:after.interactions.filter(r=>r.note).map(r=>({note:r.note,state:r.state})),observed:{sends:observed.sends,consumers:observed.consumers,captures:observed.captures}};record(row);assert.deepEqual(failures,[],JSON.stringify(row));
});
const {normalizeSettingsName,SETTINGS_NAME_LIMIT,SETTINGS_COPY}=await import(root+'/src/bot/settings.js');
for(const locale of ['en','zh-TW','vi'])test('independent Settings assertion adjudication '+locale,async t=>{
 const {f,processor,observed,snapshot}=await setup(t,locale,'name');
 const current=await f.db.getUser('a');const peer=await f.db.getUser('b');const revision=await f.db.getProfileRevision('a');const before=await snapshot();
 const text='She is not experiencing her chest pain or her difficulty breathing.';
 const graphemes=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text.normalize('NFC').trim().replace(/\s+/gu,' '))].length;
 assert.equal(graphemes,67);assert.equal(SETTINGS_NAME_LIMIT,64);assert.throws(()=>normalizeSettingsName(text),/SETTINGS_NAME_INVALID/);assert.equal(interpretUrgentSymptoms(text).decision,'CLEARLY_NONURGENT');
 const u=update(995001,text);assert.equal((await processor.processUpdate(u)).outcome,'processed');assert.equal((await processor.processUpdate(u)).outcome,'replayed');
 const reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text;assert.equal(reply,SETTINGS_COPY[locale].invalid);assert.notEqual(reply,urgentReply(locale));assert.deepEqual(await snapshot(),before);assert.deepEqual(await f.db.getUser('a'),current);assert.deepEqual(await f.db.getUser('b'),peer);assert.equal(await f.db.getProfileRevision('a'),revision);assert.equal(observed.sends,1);assert.ok(observed.consumers>0);assert.equal(Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n),0);
 const valid='Independent Reader';assert.equal(normalizeSettingsName(valid),valid);assert.equal((await processor.processUpdate(update(995002,valid))).outcome,'processed');const pending=JSON.parse((await snapshot()).name);assert.equal(pending.mode,'name_confirm');assert.equal(pending.pendingName,valid);assert.equal(pending.revision,JSON.parse(before.name).revision+1);assert.equal((await f.db.getUser('a')).displayName,current.displayName);
 const save=observed.reply.replyMarkup.inline_keyboard.flat().find(b=>b.text===SETTINGS_COPY[locale].save);assert.ok(save);
 const cb={update_id:995003,callback_query:{id:'settings-independent',data:save.callback_data,from:{id:123,is_bot:false},message:{message_id:84,chat:{id:123,type:'private'}}}};
 assert.equal((await processor.processUpdate(cb)).outcome,'processed');assert.equal((await processor.processUpdate(cb)).outcome,'replayed');assert.equal((await f.db.getUser('a')).displayName,valid);assert.equal(await f.db.getState(settingsKey('a')),null);assert.deepEqual(await f.db.getUser('b'),peer);assert.equal(observed.sends,3);
 record({id:'settings-adjudication',locale,pass:true,failures:[],graphemes,limit:64,classification:'CLEARLY_NONURGENT',validationReply:reply,rejectionPreservesStateAndProfiles:true,validNamePreviewAndSave:true,replaySends:3,scopedHealthReads:0});
});
