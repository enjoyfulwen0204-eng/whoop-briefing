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
const {SETTINGS_COPY}=await import(root+'/src/bot/settings.js');
const {normalizeSettingsName}=await import(root+'/src/bot/settings.js');
const {normalizeJournalNote}=await import(root+'/src/stage7Registry.js');
const {JOURNAL_COPY}=await import(root+'/src/stage7Registry.js');
const original=JSON.parse(fs.readFileSync(new URL('../stage8-scoped-repair/original-cases.json',import.meta.url))).cases;
const references=JSON.parse(fs.readFileSync(new URL('../stage8-scoped-repair/reference-cases.json',import.meta.url))).cases;
const shard=process.env.STAGE8_GATE_TEST_SHARD===undefined?null:Number(process.env.STAGE8_GATE_TEST_SHARD);
if(shard!==null&&![0,1,2].includes(shard))throw Error('INVALID_TEST_SHARD');
const output='/private/tmp/stage8-final-quotation-repair/final/quotation-processor-'+(shard??'all')+'-results.json';
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

const corpus=JSON.parse(fs.readFileSync(new URL('./cases.json',import.meta.url)));
const selected=['current-en','current-zh','current-vi','current-mixed','uncertain-en','uncertain-zh','uncertain-vi','negated-en','negated-zh','negated-vi','reading-en','reading-zh','reading-vi','unrelated-object-en','unrelated-object-zh','unrelated-object-vi','hypothetical-en','hypothetical-zh','hypothetical-vi'];
const jobs=corpus.cases.filter(c=>selected.includes(c.id)).flatMap(c=>['name','note','coach','health'].map(lane=>({...c,lane,text:c.text+(lane==='health'?' What is my HRV today?':'')})));
fs.writeFileSync('/private/tmp/stage8-final-quotation-repair/final/quotation-processor-'+(shard??'all')+'-cases.json',JSON.stringify({jobs},null,2));
for(const [i,c]of jobs.entries())if(shard===null||i%3===shard)test('quotation fallback ingress '+c.id+' '+c.lane,async t=>{
 const locale=c.locale==='mixed'?'en':c.locale;const {f,processor,observed,snapshot}=await setup(t,locale,c.lane);const before=await snapshot(),peer=await f.db.getUser('b'),profile=await f.db.getUser('a');
 const u=update(989001+i,c.text),outcome=await processor.processUpdate(u),replay=await processor.processUpdate(u),after=await snapshot();
 let invalidName=false,continuation=null;
 const scopeReads=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n),reply=typeof observed.reply==='string'?observed.reply:observed.reply?.text,failures=[];
 if(outcome.outcome!=='processed'||replay.outcome!=='replayed'||observed.sends!==1)failures.push('TRANSPORT_REPLAY');
 if(c.expected!=='CLEARLY_NONURGENT'){
  if(reply!==urgentReply(locale))failures.push('MISSING_SAFETY');if(JSON.stringify(before)!==JSON.stringify(after))failures.push('PERSISTENCE_CHANGED');if(scopeReads)failures.push('ORDINARY_SCOPE_READ');if(observed.consumers||observed.captures)failures.push('ORDINARY_CONSUMER');if(JSON.stringify(profile)!==JSON.stringify(await f.db.getUser('a')))failures.push('PROFILE_CHANGED');
 }else{
  if(reply===urgentReply(locale))failures.push('FALSE_EMERGENCY');if(!observed.consumers)failures.push('NORMAL_CONSUMER_BLOCKED');
  if(c.lane==='name'){const b=JSON.parse(before.name),a=JSON.parse(after.name);let expectedName;try{expectedName=normalizeSettingsName(c.text);}catch{invalidName=true;}
   if(invalidName){if(reply!==SETTINGS_COPY[locale].invalid||JSON.stringify(before)!==JSON.stringify(after))failures.push('INVALID_NAME_REJECTION_CHANGED');}
   else if(a.mode!=='name_confirm'||a.pendingName!==expectedName||a.nonce!==b.nonce)failures.push('NAME_FLOW_BLOCKED');
   if(JSON.stringify(profile)!==JSON.stringify(await f.db.getUser('a')))failures.push('PROFILE_CHANGED');}
  if(c.lane==='note'&&!after.interactions.some(r=>r.note===normalizeJournalNote(c.text)&&r.state==='CONFIRM'))failures.push('NOTE_FLOW_BLOCKED');
 }
 if(JSON.stringify(peer)!==JSON.stringify(await f.db.getUser('b')))failures.push('PEER_CHANGED');
 const classification=interpretUrgentSymptoms(c.text).decision;
 const broad=c.reviewed&&c.id.startsWith('quoted-post-assertion');if(broad?classification==='CLEARLY_NONURGENT':classification!==c.expected)failures.push('CLASSIFICATION_CHANGED');
 const firstObserved={sends:observed.sends,consumers:observed.consumers,captures:observed.captures};
 if(invalidName){const next=update(990501+i,'Review Reader');const accepted=await processor.processUpdate(next),duplicate=await processor.processUpdate(next),state=JSON.parse((await snapshot()).name),initial=JSON.parse(before.name);
  continuation={accepted:accepted.outcome,replay:duplicate.outcome,mode:state.mode,pendingName:state.pendingName,noncePreserved:state.nonce===initial.nonce,sends:observed.sends};
  if(continuation.accepted!=='processed'||continuation.replay!=='replayed'||continuation.mode!=='name_confirm'||continuation.pendingName!=='Review Reader'||!continuation.noncePreserved||continuation.sends!==2)failures.push('VALID_NAME_CONTINUATION_BLOCKED');
 }
 record({invalidName,continuation,id:c.id,locale,lane:c.lane,reviewed:Boolean(c.reviewed),text:c.text,expected:c.expected,classification,pass:!failures.length,failures,scopeReads,reply,statePreserved:JSON.stringify(before)===JSON.stringify(after),peerPreserved:JSON.stringify(peer)===JSON.stringify(await f.db.getUser('b')),observed:firstObserved});assert.deepEqual(failures,[],JSON.stringify(results.at(-1)));
});
