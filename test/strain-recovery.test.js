import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateStrainRecovery,renderStrainRecovery,createOnDemandAssociations} from '../src/onDemandAssociations.js';
import {addDays} from '../src/time.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7Composition} from '../src/stage7Composition.js';
import {createCompanionCoach} from '../src/companionCoach.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage7ReplyAuthority} from '../src/stage7ReplyAuthority.js';
const now=new Date('2026-11-03T03:00:00.000Z'),today='2026-11-03';
function input(n=6){
 const cycles=[],days=[];
 for(let i=0;i<n*2;i++){
  const day=addDays(today,-i),start=addDays(day,-1)+'T04:00:00.000Z',end=day+'T03:00:00.000Z';
  cycles.push({id:'c'+i,health_date:addDays(day,-1),start_at:start,end_at:end,score_state:'SCORED',strain:i<n?15:5});
  days.push({health_date:day,end_at:end,sleep_score_state:'SCORED',recovery_score_state:'SCORED',recovery:i<n?50:80,hrv:i<n?40:60});
 }
 return {cycles,days,today};
}
test('90-day median, exact next-day pairing, Recovery points and HRV percentage',()=>{
 const r=calculateStrainRecovery(input());assert.equal(r.median,10);assert.deepEqual([r.high,r.low],[6,6]);assert.equal(r.status,'ASSOCIATION');
 assert.equal(r.metrics[0].difference,-30);assert.ok(Math.abs(r.metrics[1].difference+100/3)<1e-8);
});
test('median uses completed strain days even without outcomes; no missing outcome becomes zero',()=>{
 const x=input();x.days=x.days.slice(1);const r=calculateStrainRecovery(x);assert.equal(r.median,10);assert.equal(r.high,5);
 x.days=x.days.slice(1);assert.equal(calculateStrainRecovery(x).status,'INSUFFICIENT');
 for(const c of x.cycles)c.strain=5;assert.equal(calculateStrainRecovery(x).high,0);
});
test('scored sources only, one latest cycle per day, calendar window and duplicate outcomes',()=>{
 const x=input();x.cycles.push({...x.cycles[0],id:'old',end_at:'2026-11-03T02:00:00Z',strain:0});x.days.push({...x.days[0]});
 assert.equal(calculateStrainRecovery(x).high,6);
 x.cycles.push({...x.cycles[0],health_date:addDays(today,-90),strain:21});assert.equal(calculateStrainRecovery(x).median,10);
 x.cycles[0].score_state='PENDING_SCORE';x.days[1].recovery_score_state='PENDING_SCORE';
 assert.equal(calculateStrainRecovery(x).status,'INSUFFICIENT');
});
test('activity finishing after the next wake cannot leak into the preceding-day comparison',()=>{
 const x=input();x.cycles[0].end_at='2026-11-03T04:00:00.000Z';assert.equal(calculateStrainRecovery(x).high,5);
});
test('at least five per metric; half 30-day SD threshold; constant difference zero hidden',()=>{
 assert.equal(calculateStrainRecovery(input(4)).status,'INSUFFICIENT');
 const x=input();for(const d of x.days){d.recovery=70;d.hrv=50;}
 assert.equal(calculateStrainRecovery(x).status,'NO_DIFFERENCE');
 x.days[0].recovery=71;x.days.push({health_date:addDays(today,-20),sleep_score_state:'SCORED',recovery_score_state:'SCORED',recovery:0});
 assert.ok(!calculateStrainRecovery(x).metrics.some(m=>m.metric==='recovery'));
 const y=input();y.days[0].hrv=null;y.days[1].hrv=null;assert.deepEqual(calculateStrainRecovery(y).metrics.map(m=>m.metric),['recovery']);
});
for(const locale of ['zh-TW','en','vi'])test(`localized deterministic output ${locale}`,()=>{
 const r=calculateStrainRecovery(input()),text=renderStrainRecovery(r,locale);
 assert.match(text,/Recovery/);assert.match(text,/30/);assert.match(text,/33\.3%/);assert.match(text,/90/);assert.doesNotMatch(text,/undefined|NaN/);
 assert.match(renderStrainRecovery(calculateStrainRecovery(input(4)),locale),/還在累積資料|Still collecting data|Đang tích lũy dữ liệu/);
});
async function fixture(t){
 const f=await syntheticStage7V33Fixture(t,{now:()=>now}),raw=bodyInput({asOf:+now,days:11});
 for(const rows of Object.values(raw.sources))for(const r of rows)r.whoop_user_id='synthetic';
 const data=input();raw.sources.cycle=data.cycles.map(c=>({user_id:'a',id:c.id,start_at:c.start_at,end_at:c.end_at,strain:c.strain,score_state:'SCORED',whoop_user_id:'synthetic',updated_at:c.end_at,synced_at:now.toISOString()}));
 raw.sources.recovery.forEach((r,i)=>Object.assign(r,{recovery_score:data.days[i].recovery,hrv_rmssd_milli:data.days[i].hrv}));
 await seedBodyInput(f.db,raw);await f.db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id='synthetic' WHERE user_id='a'");
 await f.db.ensureOnboarding('a',{state:'READY',now});await f.db.linkTelegram({userId:'a',chatId:'123',now});
 return {...f,reader:createOnDemandAssociations({...f,now:()=>now}),user:await f.db.getUser('a')};
}
test('real SQL: resource generations, provider identity, tombstones and future versions',async t=>{
 const f=await fixture(t);assert.equal((await f.reader.inspectStrain('a')).status,'ASSOCIATION');
 await f.db.raw.execute("UPDATE whoop_resource_access SET auth_generation=2 WHERE user_id='a' AND resource='cycle'");assert.equal((await f.reader.inspectStrain('a')).high,0);
 await f.db.raw.execute("UPDATE whoop_resource_access SET auth_generation=1 WHERE user_id='a' AND resource='cycle'");
 await f.db.raw.execute("UPDATE whoop_cycles SET whoop_user_id='wrong' WHERE id='c0'");assert.equal((await f.reader.inspectStrain('a')).high,5);
 await f.db.raw.execute("UPDATE whoop_cycles SET updated_at='2027-01-01T00:00:00Z' WHERE id='c1'");assert.equal((await f.reader.inspectStrain('a')).high,4);
 await f.db.raw.execute({sql:"INSERT INTO whoop_resource_tombstones(user_id,resource_type,resource_id,deleted_at,created_at,updated_at) VALUES('a','cycle','c2',?,?,?)",args:[now.toISOString(),now.toISOString(),now.toISOString()]});assert.equal((await f.reader.inspectStrain('a')).high,3);
 await assert.rejects(f.reader.inspectStrain('b'),/PHASE4_AUTH_FENCED/);
});
for(const locale of ['zh-TW','en','vi'])test(`real Coach exercise callback and final send guard ${locale}`,async t=>{
 const f=await fixture(t);await f.db.setLocale('a',locale);
 const companion=await createStage7Composition({...f,associations:f.reader}),coach=createCompanionCoach({...f,companion,associations:f.reader}),request={user:f.user,chatId:'123'};
 const actor=await companion.interactions.authenticate(request);let reply=await coach.handle({...request,text:'/coach'});
 async function tap(action){
  await companion.interactions.bind(actor,reply.stage7InteractionId,44);
  const tokens=(await f.db.raw.execute({sql:'SELECT token_hash,action FROM journal_callback_tokens WHERE user_id=? AND interaction_id=? AND revision=?',args:['a',reply.stage7InteractionId,reply.stage7Revision]})).rows;
  const button=reply.replyMarkup.inline_keyboard.flat().find(b=>tokens.some(t=>t.action===action&&t.token_hash===f.keys.lookup(['stage7-callback',b.callback_data.slice(3)])));assert.ok(button,action);
  reply=await coach.handle({...request,callback:{id:'synthetic-tap',data:button.callback_data,message:{message_id:44,chat:{id:123,type:'private'}},from:{id:123,is_bot:false}}});
 }
 await tap('coach:topic:exercise');await tap('coach:range:today');await tap('coach:focus:patterns');
 assert.match(reply.text,/Recovery/);assert.match(reply.text,/33\.3%/);assert.ok(reply.associationGuard);
 for(const b of reply.replyMarkup.inline_keyboard.flat())assert.match(b.text,/^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u);
 assert.equal(await f.reader.verifyReply({userId:'a',reply}),true);assert.equal(await f.reader.verifyReply({userId:'b',reply}),false);
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},env:{telegramBotToken:'SYNTHETIC'},now:()=>now});
 const sealed=await createStage7ReplyAuthority({...f,companion}).seal(actor,reply);let sends=0;const send=async x=>{assert.equal(await x.beforeSend(),true);sends++;return {sent:true,messageId:44};};
 assert.equal((await app.sendReply(send,{userId:'a',chatId:'123',reply:sealed})).sent,true);assert.equal(sends,1);
 await f.db.raw.execute("UPDATE whoop_resource_access SET status='UNAUTHORIZED' WHERE user_id='a' AND resource='cycle'");
 assert.equal((await app.sendReply(send,{userId:'a',chatId:'123',reply:sealed})).sent,false);assert.equal(sends,1);
});

test('bounded source read, source-generation changes and insufficient budget fail closed',async t=>{
 const f=await fixture(t),reply=await f.reader.coachReply('a','en','exercise',{text:'Synthetic'});
 const {createExecutionBudget,withExecutionBudget}=await import('../src/executionBudget.js');const budget=createExecutionBudget({budgetMs:1000});
 try{assert.equal(await withExecutionBudget(budget,()=>f.reader.inspectStrain('a')),null);}finally{budget.close();}
 // Only synthetic DB rows. The LIMIT 1001 sentinel refuses truncation, even
 // when many provider cycles would subsequently collapse onto the same date.
 await f.db.raw.batch(Array.from({length:1001},(_,i)=>({sql:"INSERT INTO whoop_cycles(user_id,id,whoop_user_id,start_at,end_at,strain,score_state,updated_at,synced_at) VALUES('a',?,'synthetic','2026-11-02T04:00:00.000Z','2026-11-03T03:00:00.000Z',10,'SCORED','2026-11-03T03:00:00.000Z','2026-11-03T03:00:00.000Z')",args:['extra-'+i]})));
 await assert.rejects(f.reader.inspectStrain('a'),/ASSOCIATION_SOURCE_BOUNDS/);
 await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
 assert.equal(await f.reader.verifyReply({userId:'a',reply}),false);

});
