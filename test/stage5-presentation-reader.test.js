import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage5PresentationReader,createStage5PresentationSender,stage5PresentationCohort,isStage5PresentationCommand} from '../src/stage5PresentationReader.js';
import {createRouter} from '../src/bot/router.js';
import {urgentReply} from '../src/bot/triage.js';

async function bind(f){
 await f.db.linkTelegram({userId:'a',chatId:'123'});await f.db.linkTelegram({userId:'b',chatId:'456'});
 await f.db.saveTokens('a',{accessToken:'fixture',refreshToken:'fixture',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'fixture'},{now:new Date()});
 await f.db.raw.execute("INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY','2026-10-16','2026-10-16','2026-10-16') ON CONFLICT(user_id) DO UPDATE SET state='READY'");
 return f.db.getUser('a');
}
const reader=async f=>createStage5PresentationReader({...f,stores:await createPhase4Foundation({db:f.db,keys:f.keys,admission:await f.db.admitRuntime(),now:()=>new Date()}),eligible:id=>id==='a',now:()=>new Date()});

test('explicit Phase4 commands cannot select a peer or replace legacy command forms',async()=>{
 assert.equal(isStage5PresentationCommand('/insights phase4'),true);
 assert.equal(isStage5PresentationCommand('/evidence@Fixture_bot PHASE4'),true);
 for(const text of ['/insights','/insights history','/evidence'])assert.equal(isStage5PresentationCommand(text),false);
 for(const text of ['/insights phase4 b','/evidence phase4 other','/insights phase4 history'])assert.equal(isStage5PresentationCommand(text),true,'unknown Phase4 arguments cannot fall through to legacy data');
 assert.deepEqual(stage5PresentationCohort({STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a,b,c'}),[]);
 assert.deepEqual(stage5PresentationCohort({STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'}),[]);
});

test('same-schema feature-off restart suppresses persisted typed replies and preserves ordinary replies',async()=>{
 let sent=0;const base=async()=>{sent++;return {sent:true};},off=createStage5PresentationSender(null,base);
 const saved={userId:'a',chatId:'123',reply:{text:'private analysis',stage5PresentationGuard:{signature:'saved'}}};
 assert.equal((await off(saved)).sent,false);assert.equal(sent,0);
 assert.equal((await off({userId:'a',chatId:'123',reply:'ordinary'})).sent,true);assert.equal(sent,1);
 const enabled=createStage5PresentationSender({sendReply:async(_send,input)=>({sent:false,reason:input===saved?'typed_fence':'wrong_input'})},base);
 assert.equal((await enabled(saved)).reason,'typed_fence');assert.equal(sent,1);
});

test('v33 empty reader is self-only, localized, read-only and fenced before send',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date()});
 const user=await bind(f),r=await reader(f),counts=await f.db.raw.execute('SELECT count(*) n FROM evidence_items');
 for(const [locale,word] of [['zh-TW','沒有可驗證'],['en','No verified'],['vi','Chưa có']]){
  await f.db.setLocale('a',locale);
  const reply=await r.handle({text:'/insights phase4',chatId:'123',user});
  assert.match(reply.text,new RegExp(word));assert.match(reply.text,/SHADOW/);
  assert.equal(await r.verify({userId:'a',chatId:'123',reply}),true);
  assert.equal(await r.verify({userId:'b',chatId:'456',reply}),false);
  assert.equal(await r.verify({userId:'a',chatId:'456',reply}),false);
  assert.equal(await r.verify({userId:'a',chatId:'123',reply:{...reply,text:'changed'}}),false);
 }
 const denied=await r.handle({text:'/evidence phase4',chatId:'456',user});assert.equal(denied.stage5PresentationGuard,undefined);
 assert.equal((await r.handle({text:'/insights phase4 b',chatId:'123',user})).stage5PresentationGuard,undefined);
 const reply=await r.handle({text:'/evidence phase4',chatId:'123',user});
 await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");
 assert.equal(await r.verify({userId:'a',chatId:'123',reply}),false,'onboarding regression fences the persisted response');
 assert.equal((await r.handle({text:'/insights phase4',chatId:'123',user})).stage5PresentationGuard,undefined);
 await f.db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='a'");
 const expiredReader=createStage5PresentationReader({...f,eligible:id=>id==='a',now:()=>new Date(Date.now()+180000)});
 assert.equal(await expiredReader.verify({userId:'a',chatId:'123',reply}),false);
 let priorCalled=0;
 assert.equal((await r.sendReply(async()=>assert.fail('prior sender fence must win'),{userId:'a',chatId:'123',reply,beforeSend:async()=>{priorCalled++;return false;}})).sent,false);
 assert.equal(priorCalled,1);
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 let sent=0;const result=await r.sendReply(async()=>{sent++;return {sent:true};},{userId:'a',chatId:'123',reply});
 assert.equal(result.sent,false);assert.equal(sent,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n,counts.rows[0].n);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
});

test('missing authenticated producer cannot become a completed empty business claim',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date()}),user=await bind(f),r=await reader(f);
 await f.db.setLocale('a','en');
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='SHADOW'");
 const reply=await r.handle({text:'/insights phase4',chatId:'123',user});
 assert.match(reply.text,/No verified qualifying analysis/);assert.doesNotMatch(reply.text,/analysis complete|completed successfully/i);
});

test('router dispatches only explicit Phase4 forms and preserves legacy insights history',async()=>{
 let selected=0,legacy=0;
 const db={getLocale:async()=> 'en',getActiveInsights:async()=>{legacy++;return [];}},user={id:'a',timezone:'Asia/Taipei'};
 const router=createRouter({db,coachFor:()=>({}),phase4Reader:{handle:async()=>{selected++;return {text:'phase4'};}}});
 assert.deepEqual(await router.handle({text:'/insights phase4',chatId:'123',user}),{text:'phase4'});
 assert.equal(selected,1);
 const old=await router.handle({text:'/insights history',chatId:'123',user});assert.equal(typeof old,'string');assert.equal(legacy,1);assert.equal(selected,1);
 assert.equal(await router.handle({text:'/insights phase4 我現在胸痛而且呼吸困難',chatId:'123',user}),urgentReply('en'));
 assert.equal(selected,1,'urgent symptoms keep priority over malformed new command arguments');
});
