import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=process.env.STAGE8_TWO_WARNING_REVIEW_ROOT??"/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing";
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
const original=JSON.parse(fs.readFileSync("/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing/test/stage8-scoped-repair/original-cases.json")).cases;
const references=JSON.parse(fs.readFileSync("/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing/test/stage8-scoped-repair/reference-cases.json")).cases;
const shard=process.env.STAGE8_GATE_TEST_SHARD===undefined?null:Number(process.env.STAGE8_GATE_TEST_SHARD);
if(shard!==null&&![0,1,2].includes(shard))throw Error('INVALID_TEST_SHARD');
const outputDir=process.env.STAGE8_TWO_WARNING_OUTPUT_DIR??fs.mkdtempSync(path.join(os.tmpdir(),'stage8-two-warning-'));
fs.mkdirSync(outputDir,{recursive:true});
const output=path.join(outputDir,'processor-'+(shard??'all')+'-results.json');
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


const {COACH_COPY}=await import(root+'/src/companionCoach.js');

for(const locale of ['zh-TW','en','vi'])for(const [id,text]of [['negative','「呼吸困難」是我現在還沒有感到的症狀。'],['educational','我想了解胸痛的一般原因。']])test('Coach signed continuation after repaired '+id+' '+locale,async t=>{
 const {f,app,processor,observed}=await setup(t,locale,'health');const peer=await f.db.getUser('b');let sequence=993001;
 const first=await processor.processUpdate(update(sequence++,'/coach')),card=observed.reply;assert.equal(first.outcome,'processed');assert.ok(card.stage7InteractionId);assert.equal(card.stage7View,'COACH');
 const oldRow=await app.companion.interactions.read('a',card.stage7InteractionId);
 const clear=await processor.processUpdate(update(sequence++,text));assert.equal(clear.outcome,'processed');assert.notEqual(typeof observed.reply==='string'?observed.reply:observed.reply?.text,urgentReply(locale));assert.equal(interpretUrgentSymptoms(text).decision,'CLEARLY_NONURGENT');
 const retained=await app.companion.interactions.read('a',card.stage7InteractionId);assert.equal(retained.revision,oldRow.revision);assert.equal(retained.state,oldRow.state);
 async function choose(from,label){const b=from.replyMarkup.inline_keyboard.flat().find(b=>b.text===label);assert.ok(b,label);const n=sequence++,u={update_id:n,callback_query:{id:'continue-'+n,data:b.callback_data,from:{id:123,is_bot:false},message:{message_id:84,chat:{id:123,type:'private'}}}};const done=await processor.processUpdate(u),replay=await processor.processUpdate(u);assert.equal(done.outcome,'processed');assert.equal(replay.outcome,'replayed');return observed.reply;}
 const selected=await choose(card,COACH_COPY[locale].topics[0]);assert.equal(selected.stage7InteractionId,card.stage7InteractionId);const delivered=await choose(selected,COACH_COPY[locale].today);assert.equal(delivered.stage7InteractionId,card.stage7InteractionId);
 const row=await app.companion.interactions.read('a',card.stage7InteractionId),d=JSON.parse(row.diagnostics_json);assert.equal(d.coachTopic,'sleep');assert.equal(d.coachRange,'today');assert.equal(observed.sends,4);assert.deepEqual(await f.db.getUser('b'),peer);assert.equal(Number((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n),0);
 record({id,locale,pass:true,sends:observed.sends,coachTopic:d.coachTopic,coachRange:d.coachRange,interactionPreserved:true,replayPrevented:true,peerPreserved:true});
});
