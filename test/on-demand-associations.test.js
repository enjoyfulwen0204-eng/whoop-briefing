import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateAssociations,renderAssociations,createOnDemandAssociations,withAssociationTick,associationQuestion} from '../src/onDemandAssociations.js';
import {notifyAssociation,changedAssociation} from '../src/associationNotifications.js';
import {proactiveQuota} from '../src/proactiveQuota.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {addDays} from '../src/time.js';
import {createRouter} from '../src/bot/router.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {createStage7Composition} from '../src/stage7Composition.js';
import {createStage7Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import {renderJournalWeek,summarizeJournalWeek} from '../src/stage7WeeklyReview.js';
const instant=new Date('2026-11-01T06:00:00Z'),today='2026-11-01';
function input(n=6){
 const facts=[],days=[];
 for(let i=0;i<n*2;i++){const date=addDays(today,-i);days.push({health_date:date,hrv:i<n?40:60,recovery:i<n?50:80,rhr:i<n?70:55,sleep_performance:i<n?60:85});facts.push({category:'alcohol',health_date:addDays(date,-1),exposure_state:i<n?'EXPOSED':'CONFIRMED_UNEXPOSED',fact_status:'ACTIVE',content_state:'PRESENT',privacy_artifact_id:'fact-'+i,source_kind:i%2?'free_text':'bot_question'});}
 return {facts,days,today};
}
test('explicit exposed/control days only; free text counts, missing/uncertain/skipped do not; next-health-day alignment',()=>{
 const x=input();x.facts.push(...['NOT_SURE','UNKNOWN','SKIPPED'].map((exposure_state,i)=>({...x.facts[0],health_date:addDays(today,-20-i),exposure_state})));x.days.push({health_date:addDays(today,-30),hrv:200,recovery:100,rhr:10,sleep_performance:100});
 const r=calculateAssociations(x).topics.find(r=>r.topic==='alcohol');assert.equal(r.exposed,6);assert.equal(r.unexposed,6);assert.equal(r.metrics.length,4);assert.ok(Math.abs(r.metrics[0].difference+100/3)<1e-10);assert.equal(r.metrics[1].difference,-30);
 const conflict=input();conflict.facts.push({...conflict.facts[0],exposure_state:'CONFIRMED_UNEXPOSED'});assert.equal(calculateAssociations(conflict).topics[1].exposed,5);
});
test('each arm needs five valid days per metric, not duplicate facts; insufficient localized counts',()=>{
 const x=input(4);x.facts.push({...x.facts[0]});const result=calculateAssociations(x);assert.equal(result.topics[1].status,'INSUFFICIENT');assert.equal(result.topics[1].metrics.length,0);
 for(const locale of ['zh-TW','vi','en']){const text=renderAssociations(result,locale,'alcohol');assert.match(text,/4/);assert.match(text,/5/);assert.doesNotMatch(text,/33\.3/);}
});
test('half recent-30-day SD threshold, zero difference and metric-specific missingness',()=>{
 const x=input();for(const d of x.days){d.hrv=50;d.recovery=70;d.rhr=60;d.sleep_performance=80;}
 assert.equal(calculateAssociations(x).topics[1].status,'NO_DIFFERENCE');
 x.days[0].hrv=1000;for(let i=1;i<6;i++)x.days[i].hrv=null;assert.ok(!calculateAssociations(x).topics[1].metrics.some(m=>m.metric==='hrv'));
});
test('90 day bound and new WHOOP revision immediately changes fresh B3 result',()=>{
 const x=input();const a=calculateAssociations(x);for(const d of x.days)d.hrv=60;const b=calculateAssociations(x);assert.notDeepEqual(a,b);assert.ok(!b.topics[1].metrics.some(m=>m.metric==='hrv'));
 x.facts.push({...x.facts[0],health_date:addDays(today,-100)});x.days.push({...x.days[0],health_date:addDays(today,-99)});assert.equal(calculateAssociations(x).topics[1].exposed,6);
});
test('notification only first qualified topic or changed direction, not ordinary magnitude change',()=>{
 const topics=calculateAssociations(input()).topics;assert.equal(changedAssociation(topics,{}).topic,'alcohol');const old=Object.fromEntries(topics[1].metrics.map(m=>[m.metric,m.direction]));assert.equal(changedAssociation(topics,{alcohol:old}),null);assert.ok(changedAssociation(topics,{alcohol:{...old,hrv:'high'}}));
});
async function fixture(t){
 const f=await syntheticStage7V33Fixture(t,{now:()=>instant});const raw=bodyInput({asOf:instant.getTime()});for(const rows of Object.values(raw.sources))for(const row of rows)row.whoop_user_id='synthetic';await seedBodyInput(f.db,raw);await f.db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id='synthetic' WHERE user_id='a'");await f.db.ensureOnboarding('a',{state:'READY',now:instant});await f.db.linkTelegram({userId:'a',chatId:'123',now:instant});await f.db.setLocale('a','en');
 let reads=0;const source=input();const stores={...f.stores,journal:{...f.stores.journal,list:async()=>{reads++;return source.facts;}}};
 await f.db.raw.execute("UPDATE whoop_recoveries SET hrv_rmssd_milli=CASE WHEN sleep_id IN ('sleep-00','sleep-01','sleep-02','sleep-03','sleep-04','sleep-05') THEN 40 ELSE 60 END");
 const reader=createOnDemandAssociations({...f,stores,now:()=>instant});return {...f,reader,reads:()=>reads,user:await f.db.getUser('a')};
}
test('real local SQL obeys identity, resource access, tombstones and cache once per tick',async t=>{
 const f=await fixture(t);await withAssociationTick(async()=>{const a=await f.reader.inspect('a'),b=await f.reader.inspect('a');assert.equal(a,b);assert.equal(a.topics[1].metrics[0].metric,'hrv');assert.equal(f.reads(),1);});
 await f.db.raw.execute("UPDATE whoop_recoveries SET hrv_rmssd_milli=60");assert.ok(!(await f.reader.inspect('a')).topics[1].metrics.some(m=>m.metric==='hrv'));assert.equal(f.reads(),2);
 await f.db.raw.execute("UPDATE whoop_resource_access SET status='UNAUTHORIZED' WHERE user_id='a' AND resource='sleep'");const r=await f.reader.inspect('a');assert.equal(r.topics[1].exposed,0);
});
test('shared result invalidates on authorization and source change without recalculation; saved reply guard fences',async t=>{
 const f=await fixture(t),reply=await f.reader.reply('a','en','alcohol');assert.equal(await f.reader.verifyReply({userId:'a',reply}),true);
 await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");assert.equal(await f.reader.verifyReply({userId:'a',reply}),false);
 await assert.rejects(f.reader.inspect('b'),/PHASE4_AUTH_FENCED/);
});
test('Coach natural association response is deterministic, owner-only and bypasses LLM; emergency wins',async()=>{
 let reads=0;const reader={question:associationQuestion,reply:async()=>{reads++;return {text:'synthetic association',associationGuard:{}};}};
 const router=createRouter({db:{getLocale:async()=> 'zh-TW'},associations:reader,coachFor:()=>{throw Error('LLM_MUST_NOT_RUN');}});
 const user={id:'a',timezone:'Asia/Taipei'};
 const reply=await router.handle({text:'喝酒對我有什麼影響',chatId:'123',user});assert.equal(reply.text,'synthetic association');assert.equal(reads,1);
 assert.match(await router.handle({text:'胸痛，喝酒對我有什麼影響',chatId:'123',user}),/立刻/);assert.equal(reads,1);
 assert.equal((await router.handle({text:'咖啡對睡眠有影響嗎',chatId:'123',user})).text,'synthetic association');assert.equal(reads,2);
 for(const q of ['咖啡對睡眠有影響嗎','How does alcohol affect me?','ruou anh huong toi the nao'])assert.ok(associationQuestion(q));
});
test('weekly renderer uses same numeric non-causal calculation, not saved Stage5 insight',()=>{
 const summary=summarizeJournalWeek({facts:[],history:[],topics:[],startDate:'2026-10-19',endDate:'2026-10-25'});summary.onDemand=calculateAssociations(input());for(const locale of ['zh-TW','en','vi']){const text=renderJournalWeek(summary,locale).text;for(const row of summary.onDemand.topics.filter(r=>r.status==='ASSOCIATION'))assert.ok(text.includes(renderAssociations({topics:[row]},locale).split('\n').slice(1).join('\n')));}
});
test('notification once weekly, ordinary shared quota, retained unknown delivery, no numeric result storage',async t=>{
 const f=await fixture(t),sent=[];const args={db:f.db,keys:f.keys,reader:f.reader,user:f.user,locale:'en',now:instant,telegram:{send:async text=>{sent.push(text);return {messageId:9};}}};
 assert.equal((await notifyAssociation(args)).status,'DELIVERED');assert.equal((await notifyAssociation(args)).status,'ALREADY_CHECKED_TODAY');assert.equal(sent.length,1);assert.deepEqual(await proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:instant}),{total:1,health:0,ask:0});
 const row=(await f.db.raw.execute('SELECT message_text,reason_json FROM proactive_events')).rows[0];assert.equal(row.message_text,null);assert.doesNotMatch(row.reason_json,/difference|33\.3|60/);
});
test('quiet/paused and budget defer without computing or reserving',async t=>{
 const f=await fixture(t);let reads=0;const args={db:f.db,keys:f.keys,reader:{inspect:()=>{reads++;throw Error('NOT_ALLOWED');}},user:f.user,now:new Date('2026-11-01T15:00:00Z')};assert.equal((await notifyAssociation(args)).status,'QUIET_OR_PAUSED');
 const b=createExecutionBudget({budgetMs:1000});try{assert.equal((await withExecutionBudget(b,()=>notifyAssociation({...args,now:instant}))).status,'DEFERRED_BUDGET');}finally{b.close();}assert.equal(reads,0);
});
test('production composition uses one reader in daily/weekly/Coach and insight after weekly before Coach; no Advanced toggle',()=>{
 const runtime=readFileSync(new URL('../src/stage7Runtime.js',import.meta.url),'utf8');assert.match(runtime,/withAssociationTick/);assert.ok(runtime.indexOf("step('weekly'")<runtime.indexOf("step('insight'"));assert.ok(runtime.indexOf("step('insight'")<runtime.indexOf("step('coach'"));
 for(const name of ['onDemandAssociations','associationNotifications','accountSelfService'])assert.doesNotMatch(readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8'),/DELETE FROM|migrate\(|BODY_ENERGY_PUBLICATION\s*=|PHASE4_STAGE8_RUNTIME\s*=/);
});
test('uncertain association delivery retains weekly barrier and cannot consume health exception',async t=>{
 const f=await fixture(t);let sends=0;const args={db:f.db,keys:f.keys,reader:f.reader,user:f.user,locale:'en',now:instant,telegram:{send:async()=>{sends++;return {};}}};
 assert.equal((await notifyAssociation(args)).status,'UNKNOWN');assert.equal((await notifyAssociation(args)).status,'ALREADY_RESERVED');assert.equal(sends,1);
 const a=await f.db.transaction(()=>f.db.claimProactiveEvent('a',{healthDate:today,idempotencyKey:'optional-2',decision:'NOTIFY',policyVersion:'on-demand-association-v1'},{now:instant,expectedLifecycleGeneration:f.user.lifecycleGeneration}));assert.equal(a.claimed,true);
 const third=await f.db.transaction(()=>f.db.claimProactiveEvent('a',{healthDate:today,idempotencyKey:'optional-3',decision:'NOTIFY',policyVersion:'on-demand-association-v1'},{now:instant,expectedLifecycleGeneration:f.user.lifecycleGeneration}));assert.equal(third.claimed,false);
 const health=await f.db.transaction(()=>f.db.claimProactiveEvent('a',{healthDate:today,idempotencyKey:'health',decision:'NOTIFY',policyVersion:'synthetic-health'},{now:instant,expectedLifecycleGeneration:f.user.lifecycleGeneration}));assert.equal(health.claimed,true);
 assert.deepEqual(await proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:instant}),{total:3,health:1,ask:0});
});

for(const available of [false,true])test(`daily uses ${available?'association priority':'neutral rotation'}; weekly still defers without association budget`,async t=>{
 const f=await fixture(t);let view=null,reads=0;
 const c=await createStage7Composition({...f,associations:{inspect:async()=>{reads++;return view;}}});
 const actor=await c.interactions.authenticate({user:f.user,chatId:'123'});
 await f.db.transaction(async()=>c.changePreferences(actor,await c.preferences(actor),{daily_enabled:1,weekly_enabled:1}));
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily',?,'synthetic',?,?,?,'DELIVERED',11)",args:[today,f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});
 await confirmedLegacyBrief({...f,companion:c},{day:today});
 assert.equal((await c.weekly.prepare(actor)).status,'DEFERRED_BUDGET');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
 if(available)view={today,topics:[{topic:'alcohol',status:'ASSOCIATION',metrics:[{metric:'hrv',direction:'low'}]}],signals:[{metric:'hrv',direction:'low',level:'STRONG'}]};
 const daily=await c.prepareAfterBrief({user:f.user,chatId:'123',healthDay:today});
 assert.equal(daily.status,'PROPOSED');
 if(available){assert.equal(daily.selection.category,'alcohol');assert.equal(daily.selection.relevant,true);}
 else assert.ok(!daily.selection.relevant);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);assert.equal(reads,2);
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,companion:c,provider});
 const request={user:f.user,chatId:'123',deliveryId:daily.deliveryId};
 assert.equal((await dispatcher.dispatch(request)).status,'DELIVERED');
 await dispatcher.dispatch(request);assert.equal(provider.calls.length,1);
});
