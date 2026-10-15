import test from 'node:test';
import assert from 'node:assert/strict';
import {assessUrgency,urgentReply} from '../src/bot/triage.js';
import {stage8Fixture} from './stage8Fixture.js';
import {createSettings,settingsKey} from '../src/bot/settings.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';

test('native, mixed and repeated symptom mentions retain clause-specific currentness',()=>{
 const urgent=[
  '我沒有胸痛，但現在呼吸困難，今天我的 HRV 多少？',
  '我昨天胸痛已經好了，但現在胸痛又喘不過氣',
  'I have no chest pain but I cannot breathe. What is my HRV?',
  "I don't have chest pain. Now I have chest pain.",
  'I have chest pain and my headache has gone.',
  'What is this chest pain I am having right now?',
  'Tôi không đau ngực nhưng tôi đang khó thở.',
  'Tôi đang đau ngực và muốn biết HRV hôm nay.',
  'My HRV 今天多少？ Tôi đang khó thở.',
  '我只是有點累，但是 I cannot breathe.',
  'I am short of breath. What is my HRV?',
  'Tôi đau ngực và thường theo dõi HRV.',
  'I am having chest pain. HRV là gì?',
  'Tôi đang đau ngực và khó thở.',
 ];
 const ordinary=[
  '我想知道胸痛通常是什麼','我沒有胸痛也沒有呼吸困難','我昨天胸痛，現在已經好了',
  '昨天胸痛已經好了，今天我的 HRV 多少？','「喘不過氣」是什麼意思？',
  '這部電影讓我笑到喘不過氣','我的 recovery 低到快昏倒',
  'What causes chest pain?','I have a question about chest pain.',
  'I do not have chest pain or shortness of breath.',
  'I had chest pain yesterday, it has completely resolved.',
  'My chest pain and shortness of breath have resolved.',
  'If I have chest pain, what should I do?',
  'What does "I have chest pain" mean?',
  'Tôi có thể hỏi đau ngực là gì?','Tôi đang tìm hiểu khó thở là gì.',
  'Tôi không đau ngực và không khó thở.',
  'My heart is racing but I am not dizzy.',
  'Tôi tim đập nhanh nhưng không chóng mặt.',
  '我心跳很快但沒有頭暈。',
  'Tôi bị đau ngực hôm qua nhưng bây giờ đã hết.',
  'I had chest pain yesterday but I am fine now.',
  'Tôi bị đau ngực hôm qua nhưng hiện tại tôi ổn.',
  '我昨天胸痛，但是現在沒有胸痛。',
  'Nếu tôi bị đau ngực thì sao?','我只是有點累，今天我的 HRV 多少？',
 ];
 for(const text of urgent)assert.equal(assessUrgency(text).urgent,true,text);
 for(const text of ordinary)assert.equal(assessUrgency(text).urgent,false,text);
});

for(const locale of ['zh-TW','vi','en'])test(`shared urgent ingress preserves an active name edit and nonurgent continuation in ${locale}`,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);const settings=createSettings({db:f.db,stage8:f.app,now:f.now});await settings({...f.input,text:'/name'});
 const prior=await f.db.getState(settingsKey('a'));let sent,consumers=0;
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:f.app.captureIdentity,
  stage7Inbound:async()=>{consumers++;return null;},stage7Reply:async input=>input.reply,handleMessage:input=>settings(input),sendReply:async input=>{sent=input.reply;return {sent:true,messageId:12};}});
 const text={en:'I have chest pain and cannot breathe. What is my HRV?',vi:'Tôi đang đau ngực và khó thở. HRV của tôi hôm nay?', 'zh-TW':'我有點累但現在胸痛且呼吸困難，今天 HRV 多少？'}[locale];
 const update={update_id:88001,message:{text,message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false,first_name:'Synthetic'}}};
 assert.equal((await processor.processUpdate(update)).outcome,'processed');assert.equal(sent.text,urgentReply(locale));assert.equal(consumers,0);
 assert.equal(await f.db.getState(settingsKey('a')),prior);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM recipient_identity_sources')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 assert.equal((await processor.processUpdate(update)).outcome,'replayed');
 const next=await settings({...f.input,text:'Nonurgent Name'});assert.ok(next.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data.endsWith('.save')));
});

test('urgent ingress still denies forged private senders and revoked lifecycle authority',async t=>{
 const f=await stage8Fixture(t);let calls=0;
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:async id=>{const resolved=await f.db.resolveUserByChatId(id);if(resolved)await f.db.transitionUserLifecycle({userId:'a',targetStatus:'PAUSED'});return resolved;},
 handleMessage:async()=>{calls++;return {text:'FORBIDDEN'};},sendReply:async()=>{calls++;return {sent:true,messageId:13};}});
 const msg={text:'I have chest pain',message_id:1,chat:{id:123,type:'private'},from:{id:456,is_bot:false}};
 await processor.processUpdate({update_id:88101,message:msg});assert.equal(calls,0);
 await processor.processUpdate({update_id:88102,message:{...msg,from:{id:123,is_bot:false}}});assert.equal(calls,0);
});

async function morning(t,{ambiguous=false}={}){
 const f=await stage8Fixture(t);let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;if(ambiguous)throw Error('Synthetic uncertainty');return new Response(JSON.stringify({ok:false,error_code:429,description:'Synthetic'}),{status:429});});
 // Actual scored source roots are available to the frozen plan on cutover day.
 await f.db.raw.execute("UPDATE whoop_sleeps SET end_at='2026-09-20T01:00:00.000Z',start_at='2026-09-19T17:00:00.000Z' WHERE user_id='a' AND id=(SELECT id FROM whoop_sleeps WHERE user_id='a' ORDER BY end_at DESC LIMIT 1)");
 const runtime=await createStage8MorningRuntime({...f,environment:{...f.environment,STAGE8_MORNING_BRIEF:'on'},env:f.env,now:f.now});await runtime.core.initializeTenant('a','LIVE');await runtime.store.requestCutover(await runtime.core.captureControl('a'),{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 const input={userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}};
 const first=await runtime.daily(input);assert.equal(first.status,ambiguous?'AMBIGUOUS':'FAILED_DEFINITE');if(!ambiguous)assert.equal((await runtime.daily(input)).status,'RETRY_WAIT');
 const row=(await f.db.raw.execute('SELECT * FROM outbound_messages')).rows[0],reservation=(await f.db.raw.execute('SELECT * FROM outbound_semantic_reservations')).rows[0];
 return {...f,runtime,input,row,reservation,sends:()=>sends};
}
for(const mutation of ['source-content','parent-link','resource','plan-expiry'])test(`frozen ELIGIBLE retry closes ${mutation} authority with its original reservation`,async t=>{
 const f=await morning(t);assert.equal(f.row.state,'ELIGIBLE');
 if(mutation==='source-content')await f.db.raw.execute("UPDATE whoop_sleeps SET total_sleep_milli=COALESCE(total_sleep_milli,0)+60000 WHERE user_id='a' AND end_at='2026-09-20T01:00:00.000Z'");
 if(mutation==='parent-link')await f.db.raw.execute("UPDATE phase4_source_links SET unlinked_at='2026-09-20T02:10:30.000Z' WHERE user_id='a' AND artifact_type='outbound_messages' AND source_type='morning_brief_plans'");
 if(mutation==='resource')await f.db.raw.execute("UPDATE whoop_resource_access SET status='UNAUTHORIZED' WHERE user_id='a' AND resource='sleep'");
 f.setTime(mutation==='plan-expiry'?'2026-09-20T04:10:00Z':'2026-09-20T02:11:00Z');assert.equal((await f.runtime.daily(f.input)).status,'FAILED_TERMINAL');
 const row=(await f.db.raw.execute('SELECT state,reservation_id FROM outbound_messages')).rows[0],res=(await f.db.raw.execute('SELECT reservation_id,state FROM outbound_semantic_reservations')).rows[0];
 assert.equal(row.state,'SUPPRESSED');assert.equal(res.state,'CLOSED');assert.equal(res.reservation_id,f.reservation.reservation_id);assert.equal(row.reservation_id,res.reservation_id);assert.equal(f.sends(),1);
 await f.runtime.daily(f.input);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_semantic_reservations')).rows[0].n,1);assert.equal(f.sends(),1);
});
test('conditional retry cleanup rejects wrong revision and closes row/reservation together',async t=>{
 const f=await morning(t),control=await f.runtime.core.captureControl('a');
 await assert.rejects(f.runtime.store.transport.closeMorningRetry(control,{messageId:f.row.message_id,expectedRevision:f.row.revision+1}),/CAS_LOST/);
 assert.equal((await f.db.raw.execute('SELECT state FROM outbound_messages')).rows[0].state,'ELIGIBLE');assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'RESERVED');
 await f.runtime.store.transport.closeMorningRetry(control,{messageId:f.row.message_id,expectedRevision:f.row.revision});assert.equal((await f.db.raw.execute('SELECT state FROM outbound_messages')).rows[0].state,'SUPPRESSED');assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
});
test('ambiguous attempt stays consumed after stale authority and cannot enter definite cleanup',async t=>{
 const f=await morning(t,{ambiguous:true});await f.db.setLocale('a','vi');await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");f.setTime('2026-09-20T02:11:00Z');
 await f.runtime.daily(f.input);await assert.rejects(f.runtime.store.transport.closeMorningRetry(await f.runtime.core.captureControl('a'),{messageId:f.row.message_id,expectedRevision:f.row.revision}),/CAS_LOST/);
 assert.equal((await f.db.raw.execute('SELECT state FROM outbound_messages')).rows[0].state,'AMBIGUOUS');assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CONSUMED');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_semantic_reservations')).rows[0].n,1);assert.equal(f.sends(),1);
});
