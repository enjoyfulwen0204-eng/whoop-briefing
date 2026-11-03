import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7Composition} from '../src/stage7Composition.js';
import {createCompanionCoach} from '../src/companionCoach.js';
import {createCompanionMorningContext,renderMorningComparison} from '../src/companionMorningContext.js';
import {loadDailyMetrics} from '../src/dailyMetrics.js';
import {seriesByMetric,changeFor} from '../src/analytics/index.js';
import {updateAssociationMemory} from '../src/associationMemory.js';
import {calculateAssociations} from '../src/onDemandAssociations.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage7ReplyAuthority} from '../src/stage7ReplyAuthority.js';
import {addDays} from '../src/time.js';
const at=new Date('2026-11-03T03:00:00Z');
for(const locale of ['zh-TW','en','vi'])test(`current Coach ${locale}: actual baseline/history/evidence callbacks, numeric sources and final send fence`,async t=>{
 const f=await syntheticStage7V33Fixture(t,{now:()=>at}),raw=bodyInput({asOf:at.getTime(),days:36});
 for(const rows of Object.values(raw.sources))for(const r of rows)r.whoop_user_id='synthetic';
 await seedBodyInput(f.db,raw);await f.db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id='synthetic' WHERE user_id='a'");
 await f.db.ensureOnboarding('a',{state:'READY',now:at});await f.db.linkTelegram({userId:'a',chatId:'123',now:at});await f.db.setLocale('a',locale);
 const user=await f.db.getUser('a'),companion=await createStage7Composition(f),morningContext=createCompanionMorningContext(f),coach=createCompanionCoach({...f,companion,morningContext});
 const actor=await companion.interactions.authenticate({user,chatId:'123'}),input={user,chatId:'123'};
 let reply=await coach.handle({...input,text:'/coach'});
 async function tap(action){await companion.interactions.bind(actor,reply.stage7InteractionId,44);
  const tokens=(await f.db.raw.execute({sql:'SELECT token_hash,action FROM journal_callback_tokens WHERE user_id=? AND interaction_id=? AND revision=?',args:['a',reply.stage7InteractionId,reply.stage7Revision]})).rows;
  const button=reply.replyMarkup.inline_keyboard.flat().find(b=>tokens.some(t=>t.action===action&&t.token_hash===f.keys.lookup(['stage7-callback',b.callback_data.slice(3)])));assert.ok(button,action);
  reply=await coach.handle({...input,callback:{id:'synthetic-coach-tap',data:button.callback_data,message:{message_id:44,chat:{id:123,type:'private'}},from:{id:123,is_bot:false}}});
 }
 await tap('coach:topic:recovery');await tap('coach:range:today');
 const days=await loadDailyMetrics({db:f.db,userId:'a',timezone:user.timezone,from:'2026-09-28',to:'2026-11-03'}),expected=changeFor('hrv',seriesByMetric(days).hrv,'2026-11-03');
 assert.equal(expected.baseline_30d_n,30);assert.ok(reply.text.includes(String(Number(expected.baseline_30d_mean.toFixed(2)))));assert.ok(reply.stage7MorningGuard);
 await tap('coach:focus:history');assert.ok(reply.text.includes('z: '+Number(expected.z_score.toFixed(2))));
 await tap('coach:focus:evidence');assert.match(reply.text,/還在累積資料|Still collecting data|Đang tích lũy dữ liệu/);
 const facts=[],values=[];for(let n=0;n<12;n++){const date=addDays('2026-11-03',-n);values.push({health_date:date,hrv:n<6?40:60});facts.push({category:'alcohol',health_date:addDays(date,-1),exposure_state:n<6?'EXPOSED':'CONFIRMED_UNEXPOSED',fact_status:'ACTIVE',content_state:'PRESENT'});}
 await updateAssociationMemory({db:f.db,user,reader:{assertFresh:async()=>true},view:calculateAssociations({facts,days:values,today:'2026-11-03'}),now:at});
 await tap('coach:focus:evidence');assert.match(reply.text,/HRV/);assert.match(reply.text,/12/);assert.doesNotMatch(reply.text,/undefined|NaN/);
 assert.equal(await morningContext.verifyReply({userId:'b',reply}),false);
 assert.equal(await morningContext.verifyReply({userId:'a',reply:{...reply,text:reply.text+' changed'}}),false);
 const storedEvidenceReply=reply;
 await f.db.raw.execute("UPDATE health_insights SET sample_count=sample_count+1 WHERE user_id='a'");
 assert.equal(await morningContext.verifyReply({userId:'a',reply:storedEvidenceReply}),false,'evidence changes revoke the outgoing projection');
 for(const topic of ['sleep','exercise']){
  await tap('coach:topic:'+topic);await tap('coach:range:week');
  for(const focus of ['baseline','history','evidence']){await tap('coach:focus:'+focus);assert.ok(reply.stage7MorningGuard);assert.doesNotMatch(reply.text,/undefined|NaN/);}
  assert.match(reply.text,/還在累積資料|Still collecting data|Đang tích lũy dữ liệu/);
 }
 for(const b of reply.replyMarkup.inline_keyboard.flat())assert.match(b.text,/^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u);
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},env:{telegramBotToken:'SYNTHETIC'},now:()=>at});
 const sealed=await createStage7ReplyAuthority({...f,companion}).seal(actor,reply);let sends=0;const send=async x=>{assert.equal(await x.beforeSend(),true);sends++;return {sent:true,messageId:44};};
 assert.equal((await app.sendReply(send,{userId:'a',chatId:'123',reply:sealed})).sent,true);
 await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
 assert.equal((await app.sendReply(send,{userId:'a',chatId:'123',reply:sealed})).sent,false);assert.equal(sends,1);
});
test('empty comparison is localized; 30-day mean excludes today; exercise association stays hidden',async()=>{
 for(const locale of ['zh-TW','en','vi'])for(const topic of ['sleep','recovery','exercise'])for(const focus of ['baseline','history'])assert.match(renderMorningComparison({rows:[],topic,focus,range:'today',today:'2026-11-03',locale}),/還在累積資料|Still collecting data|Đang tích lũy dữ liệu/);
 const {coachFollowupsFor}=await import('../src/companionCoach.js');
 assert.deepEqual(coachFollowupsFor('exercise',{morningContext:{},associations:{}}),['baseline','history','evidence']);
 assert.deepEqual(coachFollowupsFor('sleep',{morningContext:{},associations:{}}),['baseline','patterns','history','evidence']);
 const rows=[{health_date:'2026-10-03',recovery:1},{health_date:'2026-10-04',recovery:50},{health_date:'2026-11-03',recovery:100}];
 assert.match(renderMorningComparison({rows,topic:'recovery',focus:'baseline',range:'today',today:'2026-11-03',locale:'en'}),/Average 50.*1 samples.*Current 100/);
});
