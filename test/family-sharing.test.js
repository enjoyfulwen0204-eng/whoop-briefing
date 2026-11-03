import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {createFamilySharing,familyDue,familyLight} from '../src/familySharing.js';
import {createFamilyStore,familyConfiguration} from '../src/familySharingStore.js';
import {isFamilyCallback} from '../src/familySharingUi.js';
import {createSettings,isSettingsCallback} from '../src/bot/settings.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {runCompanionStep} from '../src/companionStep.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createOnDemandBodyEnergy} from '../src/onDemandBodyEnergy.js';

const monday='2026-11-02T01:30:00Z';
async function fixture(t,{at=monday,third=false}={}){
 let instant=new Date(at);const now=()=>new Date(instant),f=await syntheticStage7V33Fixture(t,{now});
 const ids=third?['a','b','c']:['a','b'];
 if(third){await f.db.createUser({id:'c',displayName:'Synthetic C',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});await f.core.initializeTenant('c','SHADOW');}
 for(const [i,id] of ids.entries()){
  await f.db.saveTokens(id,{accessToken:'SYNTHETIC',refreshToken:'SYNTHETIC',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'synthetic-'+id},{now:now()});
  await f.db.linkTelegram({userId:id,chatId:String(101+i),now:now()});
  await f.db.setLocale(id,'zh-TW');await f.db.ensureOnboarding(id,{state:'READY',now:now()});
  await f.db.raw.execute({sql:'INSERT INTO user_notification_preferences(user_id,created_at,updated_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',args:[id,now().toISOString(),now().toISOString()]});
 }
 const environment={FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:ids.join(','),BODY_ENERGY_ON_DEMAND:'on'};
 const sent=[],calculations=[];let nextMessage=1;
 const send=async x=>{sent.push(structuredClone(x));return {message_id:nextMessage++};};
 const app=createFamilySharing({db:f.db,keys:f.keys,environment,now,send,bodyEnergyFactory:async()=>({inspect:async({userId})=>{calculations.push(userId);return {calculation:{quality_state:'LIMITED',value:82}};}})});
 const rows=()=>app.store.members();
 async function change(source,recipient,category='daily',value=true,kind='grant'){
  const r=await rows();return app.store.transaction('synthetic-control',[source,recipient,category,value,kind],()=>app.store.change({actor:r.find(x=>x.id===source),peer:r.find(x=>x.id===recipient),category,value,kind}));
 }
 const input=async id=>({user:await f.db.getUser(id),chatId:String(101+ids.indexOf(id))});
 async function open(id){const i=await input(id),reply=await app.ui.decorate({...i,text:'/settings',reply:{text:'⚙️ Settings'}});await app.ui.bind({...i,userId:id,reply},90);return reply;}
 async function click(id,reply,action,{messageId=90}={}){
  const cb=reply.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action));assert.ok(cb,action);
  const i=await input(id),out=await app.ui.handle({...i,callback:{data:cb.callback_data,message:{message_id:messageId}}});
  if(out.familyGuard)await app.ui.bind({...i,userId:id,reply:out},90);return out;
 }
 function health(){let reads=0;
  t.mock.method(f.db,'getSleeps',async id=>{reads++;return [{id:'s-'+id,health_date:'2026-11-02',score_state:'SCORED',nap:0,total_sleep_milli:7.2*3600000,private_note:'PRIVATE_NEVER_SHARE'},
   {id:'prev-'+id,health_date:'2026-10-31',score_state:'SCORED',nap:0,total_sleep_milli:8*3600000},
   {id:'older-'+id,health_date:'2026-10-24',score_state:'SCORED',nap:0,total_sleep_milli:7*3600000}];});
  t.mock.method(f.db,'getRecoveries',async id=>{reads++;return [{sleep_id:'s-'+id,score_state:'SCORED',recovery_score:78},{sleep_id:'prev-'+id,score_state:'SCORED',recovery_score:72},{sleep_id:'older-'+id,score_state:'SCORED',recovery_score:62}];});
  return ()=>reads;
 }
 return {...f,app,environment,sent,calculations,change,open,click,input,rows,health,now,setTime:x=>{instant=new Date(x);}};
}

test('default off, bounded group, immutable Recovery/Advanced modes and configuration binding',()=>{
 assert.equal(createFamilySharing({}),null);
 assert.throws(()=>familyConfiguration({FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,a'}),/FAMILY_CONFIG_INVALID/);
 const keys={lookup:x=>JSON.stringify(x)},env={PHASE4_RELEASE_SHA:'a'.repeat(40)};
 const p=configurationProof(keys,publicBetaConfiguration(env),env,'a'.repeat(40));
 assert.notEqual(configurationProof(keys,publicBetaConfiguration(env),{...env,FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b'},'a'.repeat(40)),p);
 const source=readFileSync(new URL('../src/familySharing.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/stage8|\.compute\(|\.persist\(|getJournal|deleteTokens|migrate\(/i);
});
test('no consent: no health read, summary, sender or new consent; out-of-group excluded',async t=>{
 const f=await fixture(t);let reads=0;
 for(const m of ['getSleeps','getRecoveries','getRecentProactiveEvents'])t.mock.method(f.db,m,async()=>{reads++;throw Error('MUST_NOT_READ');});
 await f.db.createUser({id:'outsider',displayName:'PRIVATE_OUTSIDER',status:'ACTIVE',timezone:'Asia/Taipei'});
 await f.app.tick();assert.equal(reads,0);assert.equal(f.sent.length,0);assert.equal(f.calculations.length,0);
 const reply=await f.open('a');assert.doesNotMatch(JSON.stringify(reply),/PRIVATE_OUTSIDER/);
 const view=await f.click('a',reply,'sharing');assert.equal(view.replyMarkup.inline_keyboard.flat().filter(x=>x.text.startsWith('👤')).length,1);
 assert.deepEqual((await f.app.store.state()).grants,{});
});
test('real UI consent/revoke, mutes, expired/foreign/replayed/message-substituted callbacks; all locales icons',async t=>{
 const f=await fixture(t);
 for(const locale of ['zh-TW','vi','en']){
  await f.db.setLocale('a',locale);let reply=await f.open('a');reply=await f.click('a',reply,'sharing');reply=await f.click('a',reply,'s1');
  for(const b of reply.replyMarkup.inline_keyboard.flat()){assert.match(b.text,/^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u);assert.ok(Buffer.byteLength(b.callback_data)<=64);assert.ok(isFamilyCallback(b.callback_data));assert.ok(isSettingsCallback(b.callback_data));}
  const original=reply;reply=await f.click('a',reply,'g10');
  assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'a','b','daily'),true);
  assert.equal((await f.click('a',original,'g10')).familyGuard,undefined);
  assert.equal((await f.click('a',reply,'g10',{messageId:999})).familyGuard,undefined);
  const foreign=await f.app.ui.handle({...await f.input('b'),callback:{data:reply.replyMarkup.inline_keyboard[0][0].callback_data,message:{message_id:90}}});assert.equal(foreign.familyGuard,undefined);
  reply=await f.click('a',reply,'g10');assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'a','b','daily'),false);
 }
 let reply=await f.open('b');reply=await f.click('b',reply,'tracking');reply=await f.click('b',reply,'f0');
 await f.change('a','b');reply=await f.click('b',reply,'m01');assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'a','b','daily'),false);
 f.setTime('2026-11-02T02:00:00Z');assert.equal((await f.click('b',reply,'m01')).familyGuard,undefined);
});
test('signed state tampering, group changes and lifecycle/auth/privacy changes fail closed',async t=>{
 const f=await fixture(t);await f.change('a','b');
 await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
 assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'a','b','daily'),false);
 const raw=JSON.parse(await f.db.getState(f.app.store.key('consent')));raw.body.revision++;
 await f.db.setState(f.app.store.key('consent'),JSON.stringify(raw));await assert.rejects(f.app.store.state(),/FAMILY_STATE_INVALID/);
 f.environment.FAMILY_GROUP_USER_IDS='a,b,c';await assert.rejects(f.app.store.members(),/FAMILY_CONFIG_FENCED/);
});
test('09:30 Taipei daily, shared calculation once per source for all recipients, minimal private projection, no resend',async t=>{
 const f=await fixture(t,{third:true}),reads=f.health();await f.change('a','b');await f.change('a','c');
 f.setTime('2026-11-02T01:29:59Z');await f.app.tick();assert.equal(f.sent.length,0);assert.equal(reads(),0);
 f.setTime(monday);await f.app.tick();assert.equal(f.sent.length,2);assert.equal(reads(),2);assert.deepEqual(f.calculations,['a']);
 for(const item of f.sent){assert.match(item.reply.text,/🟢.*Recovery 78.0%.*7.2h.*82.*參考值/);assert.doesNotMatch(JSON.stringify(item),/PRIVATE_NEVER_SHARE|Journal|question|private_note|raw_json/);}
 await f.app.tick();assert.equal(f.sent.length,2);assert.equal(reads(),2);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM proactive_events')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
});
test('daily no data shows white; consent revocation immediately suppresses future delivery',async t=>{
 const f=await fixture(t);await f.change('a','b');t.mock.method(f.db,'getSleeps',async()=>[]);t.mock.method(f.db,'getRecoveries',async()=>[]);
 await f.app.tick();assert.match(f.sent[0].reply.text,/⚪.*今天還沒有資料/);assert.equal(f.calculations.length,0);
 await f.change('a','b','daily',false);f.setTime('2026-11-03T01:30:00Z');await f.app.tick();assert.equal(f.sent.length,1);
 assert.deepEqual([undefined,67,66,34,33].map(familyLight),['⚪','🟢','🟡','🟡','🔴']);
});
test('weekly 08:59/09:00 Taipei independent of Vietnam recipient; previous two complete weeks',async t=>{
 const f=await fixture(t);f.health();await f.change('a','b','weekly');await f.db.updateUser('b',{timezone:'Asia/Ho_Chi_Minh'});
 f.setTime('2026-11-02T00:59:59Z');await f.app.tick();assert.equal(f.sent.length,0);
 f.setTime('2026-11-02T01:00:00Z');await f.app.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].reply.text,/72.0% ↗.*8.0h ↗/);assert.equal(f.calculations.length,0);
 assert.equal(familyDue(new Date('2026-11-03T01:00:00Z'),'weekly'),true);
 for(const at of ['2026-11-03T01:00:00Z','2026-11-04T01:00:00Z']){f.setTime(at);await f.app.tick();assert.equal(f.sent.length,1,'same Monday identity survives catch-up');}
});
test('daily expires at noon; weekly catch-up ends Thursday; invitations are not daily summaries',async t=>{
 for(const [at,due] of [['2026-11-02T01:29:59Z',false],[monday,true],['2026-11-02T03:59:59Z',true],['2026-11-02T04:00:00Z',false],['2026-11-02T13:00:00Z',false]])assert.equal(familyDue(new Date(at),'daily'),due);
 for(const [at,due] of [['2026-11-02T00:59:59Z',false],['2026-11-02T01:00:00Z',true],['2026-11-03T01:00:00Z',true],['2026-11-04T13:00:00Z',true],['2026-11-05T01:00:00Z',false]])assert.equal(familyDue(new Date(at),'weekly'),due);
 const f=await fixture(t,{at:'2026-11-02T04:00:00Z'}),reads=f.health(),logs=[];await f.change('a','b');
 t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
 assert.ok((await f.app.tick()).results.some(r=>r.status==='WINDOW_CLOSED'));assert.equal(f.sent.length,0);assert.equal(reads(),0);
 const missed=logs.filter(r=>r.event==='family_daily_window_missed');assert.equal(missed.length,1);assert.equal(missed[0].user,f.keys.lookup(['companion-diagnostic-user-v1','b']));
 let reply=await f.open('a');reply=await f.click('a',reply,'tracking');reply=await f.click('a',reply,'invites');await f.click('a',reply,'i1');
 await f.app.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].reply.text,/預設不分享/);
});
test('first weekly send on Tuesday is not resent Wednesday; noon reached during preparation suppresses daily',async t=>{
 const f=await fixture(t,{at:'2026-11-03T01:00:00Z'});f.health();await f.change('a','b','weekly');
 await f.app.tick();assert.equal(f.sent.length,1);f.setTime('2026-11-04T01:00:00Z');await f.app.tick();assert.equal(f.sent.length,1);
 await f.change('a','b','daily');f.setTime('2026-11-02T03:59:59Z');
 t.mock.method(f.db,'getSleeps',async()=>{f.setTime('2026-11-02T04:00:00Z');return [];});await f.app.tick();assert.equal(f.sent.length,1);
});
test('quiet floor, extended quiet and pause defer daily without consuming its delivery barrier',async t=>{
 const f=await fixture(t);f.health();await f.change('a','b');await f.db.updateUser('b',{timezone:'Europe/London'});
 await f.app.tick();assert.equal(f.sent.length,0);
 await f.db.updateUser('b',{timezone:'Asia/Taipei'});await f.db.raw.execute("UPDATE user_notification_preferences SET notifications_paused=1 WHERE user_id='b'");
 await f.app.tick();assert.equal(f.sent.length,0);
 await f.db.raw.execute("UPDATE user_notification_preferences SET notifications_paused=0 WHERE user_id='b'");await f.app.tick();assert.equal(f.sent.length,1);
});
test('invitation is consent-free, quiet deferred, recipient alone can allow, existing pending Settings untouched',async t=>{
 const f=await fixture(t,{at:'2026-11-01T15:10:00Z'});await f.db.setState('synthetic-pending-name','DO_NOT_CHANGE');
 let reply=await f.open('a');reply=await f.click('a',reply,'tracking');reply=await f.click('a',reply,'invites');await f.click('a',reply,'i1');
 await f.app.tick();assert.equal(f.sent.length,0);assert.deepEqual((await f.app.store.state()).grants,{});
 f.setTime('2026-11-02T00:10:00Z');await f.app.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].reply.text,/預設不分享/);
 const invitation=f.sent[0].reply;const out=await f.click('b',invitation,'g00',{messageId:1});assert.ok(out.familyGuard);
 assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'b','a','daily'),true);
 assert.equal(f.app.store.allowed(await f.app.store.state(),await f.rows(),'a','b','daily'),false);
 assert.equal(await f.db.getState('synthetic-pending-name'),'DO_NOT_CHANGE');
});
test('B4 only, once per pair/day, quiet deferred, original answers never shared, no recipient quota',async t=>{
 const f=await fixture(t,{at:'2026-11-01T23:10:00Z'});await f.change('a','b','alert');
 const events=[{id:1,policyVersion:'body-energy-v1',decision:'NOTIFY',lifecycleGeneration:1,healthDate:'2026-11-02',createdAt:'2026-11-01T23:00:00Z',signals:[]},
  {id:2,policyVersion:'proactive-policy-v1',decision:'ASK_CONTEXT',lifecycleGeneration:1,healthDate:'2026-11-02',createdAt:'2026-11-01T23:00:00Z',signals:[{metric:'hrv',direction:'low',value:40}],messageText:'PRIVATE_ANSWER',journalEventId:123}];
 let reads=0;t.mock.method(f.db,'getRecentProactiveEvents',async()=>{reads++;return events;});
 await f.app.tick();assert.equal(f.sent.length,0);assert.equal(reads,0);
 f.setTime('2026-11-02T00:10:00Z');await f.app.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].reply.text,/HRV/);assert.doesNotMatch(JSON.stringify(f.sent),/PRIVATE_ANSWER|40|journalEventId/);
 await f.app.tick();assert.equal(f.sent.length,1);
 await f.change('a','b','alert',false);f.setTime('2026-11-03T00:10:00Z');await f.app.tick();assert.equal(f.sent.length,1);
});
test('lost ACK, failed commit and simultaneous ticks never grant duplicate sends or clear existing receipts',async t=>{
 const f=await fixture(t);f.health();await f.change('a','b');
 const app=createFamilySharing({db:f.db,keys:f.keys,environment:f.environment,now:f.now,bodyEnergyFactory:async()=>({inspect:async()=>({calculation:{quality_state:'NO_DATA'}})}),send:async()=>{f.sent.push('ATTEMPT');throw Error('PRIVATE_NETWORK_ERROR');}});
 const values=await Promise.allSettled([app.tick(),app.tick()]);assert.equal(values.filter(v=>v.status==='rejected').length,1);assert.equal(f.sent.length,1);
 await app.tick();assert.equal(f.sent.length,1);
 const valuesInDb=(await f.db.raw.execute("SELECT value FROM telegram_state WHERE key LIKE 'family:%'")).rows.map(r=>r.value).join('');
 assert.match(valuesInDb,/DELIVERY_STARTED/);assert.doesNotMatch(valuesInDb,/PRIVATE_NETWORK_ERROR|Recovery 78/);
});
test('budget defers before queries; recoverable family errors isolate all three steps, other errors still fail',async t=>{
 const f=await fixture(t),budget=createExecutionBudget({budgetMs:1000});let calls=0;t.mock.method(f.db.raw,'execute',async()=>{calls++;throw Error('NO_QUERY_EXPECTED');});
 try{const result=await withExecutionBudget(budget,()=>f.app.tick());assert.equal(result.status,'DEFERRED_BUDGET');assert.equal(calls,0);}finally{budget.close();}
 for(const step of ['family_daily','family_alert','family_weekly']){
  const args={db:{processingTransactionActive:()=>false},keys:f.keys,userId:'a',step};
  assert.deepEqual(await runCompanionStep({...args,run:()=>{throw Object.assign(Error('PRIVATE'),{code:'PHASE4_SOURCE_NOT_FOUND'});}}),{status:'SKIPPED'});
  await assert.rejects(runCompanionStep({...args,run:()=>{throw Object.assign(Error('PRIVATE'),{code:'UNRELATED_FAILURE'});}}),e=>e.code==='UNRELATED_FAILURE');
 }
});
test('shared inbound transport admits family callback; emergency intercept remains before all family handlers',async t=>{
 const f=await fixture(t);let calls=0;const messages=[],settings=createSettings({db:f.db,now:f.now});
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),
  handleMessage:async input=>{calls++;return await f.app.ui.handle(input)??await settings(input);},
  sendReply:f.app.ui.wrapSender(async x=>{messages.push(x.reply);return {sent:true,messageId:90};}),answerCallback:async()=>{}});
 await processor.processUpdate({update_id:900,message:{message_id:1,from:{id:101},chat:{id:101,type:'private'},text:'我不是没有胸痛'}});
 assert.equal(calls,0);assert.match(messages[0].text,/急救/);
 const menu=await f.open('a'),data=menu.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.sharing')).callback_data;
 const result=await processor.processUpdate({update_id:901,callback_query:{id:'synthetic',from:{id:101},data,message:{message_id:90,chat:{id:101,type:'private'}}}});
 assert.equal(result.outcome,'processed');assert.equal(calls,1);assert.match(messages.at(-1).text,/分享授權/);
});

test('Settings composition retains both Stage 7 and family callback authority at actual send boundary',async t=>{
 const f=await fixture(t),stage7=await createStage7Runtime({db:f.db,keys:f.keys,env:{telegramBotToken:'SYNTHETIC'},environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const input=await f.input('a'),settings=createSettings({db:f.db,now:f.now});
 let reply=await settings({...input,text:'/settings'});reply=await f.app.ui.decorate({...input,text:'/settings',reply});reply=await stage7.decorate({...input,text:'/settings',reply});
 assert.ok(reply.familySession);assert.ok(reply.stage7ReplyGuard);
 const sent=[];const sender=f.app.ui.wrapSender(x=>stage7.sendReply(async value=>{if(!await value.beforeSend())return {sent:false};sent.push(value.reply);return {sent:true,messageId:90};},x));
 assert.equal((await sender({...input,userId:'a',reply})).sent,true);assert.equal(sent.length,1);
 const control=await f.click('a',reply,'sharing');assert.ok(control.familyGuard);
});

test('consent revoked during summary preparation prevents any subsequent provider send',async t=>{
 const f=await fixture(t);f.health();await f.change('a','b');
 const original=f.db.getRecoveries;t.mock.method(f.db,'getRecoveries',async(...args)=>{const rows=await original(...args);await f.change('a','b','daily',false);return rows;});
 await f.app.tick();assert.equal(f.sent.length,0);
});

test('failed reservation transaction rolls back and never sends; fresh attempt succeeds',async t=>{
 const f=await fixture(t);f.health();await f.change('a','b');const original=f.db.setState;
 const mock=t.mock.method(f.db,'setState',async(...args)=>{if(String(args[1]).includes('DELIVERY_STARTED')){await original(...args);throw Object.assign(Error('SYNTHETIC_ROLLBACK'),{code:'SYNTHETIC_ROLLBACK'});}return original(...args);});
 await assert.rejects(f.app.tick(),/SYNTHETIC_ROLLBACK/);assert.equal(f.sent.length,0);
 mock.mock.restore();await f.app.tick();assert.equal(f.sent.length,1);
});

test('delivery barriers survive group edits; recoverable real family step does not stop later steps',async t=>{
 const f=await fixture(t);await f.change('a','b');
 const other=createFamilyStore({db:f.db,keys:f.keys,environment:{FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b,c'},now:f.now});
 assert.equal(f.app.store.key('delivery','stable'),other.key('delivery','stable'));assert.notEqual(f.app.store.key('consent'),other.key('consent'));
 t.mock.method(f.db,'getSleeps',async()=>{throw Object.assign(Error('PRIVATE'),{code:'PHASE4_SOURCE_NOT_FOUND'});});t.mock.method(f.db,'getRecoveries',async()=>[]);
 const result=await f.app.tick();const b=f.keys.lookup(['companion-diagnostic-user-v1','b']);
 assert.equal(result.results.find(r=>r.user===b&&r.step==='family_daily').status,'SKIPPED');
 assert.equal(result.results.find(r=>r.user===b&&r.step==='family_alert').status,'NO_CONSENT');
 assert.equal(result.results.find(r=>r.user===b&&r.step==='family_weekly').status,'NO_CONSENT');assert.equal(f.sent.length,0);
});

test('actual v33 source readers and unchanged on-demand Body calculator project synthetic health without storing results',async t=>{
 const f=await fixture(t),input=bodyInput({asOf:f.now().getTime()});
 for(const s of input.sources.sleep)s.total_sleep_milli=8*3600000;
 // Only this isolated synthetic database is seeded; never a production token.
 await f.db.raw.execute("DELETE FROM user_whoop_tokens WHERE user_id='a'");await seedBodyInput(f.db,input);
 const body=createOnDemandBodyEnergy({...f,environment:f.environment,now:f.now});
 const calculation=await body.inspect({userId:'a',requestedAt:f.now()});assert.ok(['AVAILABLE','LIMITED'].includes(calculation.calculation.quality_state));
 await f.change('a','b');let reads=0;const app=createFamilySharing({db:f.db,keys:f.keys,environment:f.environment,now:f.now,
  bodyEnergyFactory:async()=>({inspect:async request=>{reads++;return body.inspect(request);}}),send:async x=>{f.sent.push(x);return {message_id:1};}});
 const before=(await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n;
 await app.tick();assert.equal(f.sent.length,1);assert.equal(reads,1);assert.match(f.sent[0].reply.text,/Recovery 99.0%.*8.0h/);
 assert.ok(f.sent[0].reply.text.includes('🔋 '+calculation.calculation.value));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,before);
});
