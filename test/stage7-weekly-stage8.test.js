import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7Development} from '../src/stage7Development.js';
import {createStage8MorningStore} from '../src/stage8MorningStore.js';
import {confirmedMorningReceipt} from '../src/confirmedMorningReceipt.js';
import {createSyntheticJournalTelegram,createStage7Dispatcher} from '../src/stage7Dispatcher.js';
import {mkdtemp,chmod,mkdir,symlink,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createStage7Composition} from '../src/stage7Composition.js';

async function fixture(t,targetVersion){
 let at=new Date('2026-09-20T00:00:00Z');const now=()=>new Date(at),f=await syntheticPhase4Fixture(t,{targetVersion,now});
 await seedBodyInput(f.db,bodyInput({asOf:Date.parse('2026-09-21T00:00:00Z'),days:2}));
 await f.db.linkTelegram({userId:'a',chatId:'123',now:now()});await f.db.setLocale('a','en',{now:now()});
 await f.db.ensureOnboarding('a',{state:'READY',now:now()});await f.core.initializeTenant('a','LIVE');
 const store=createStage8MorningStore({...f,preferences:f.stores.preferences,enabled:id=>id==='a'}),control=await f.core.captureControl('a');
 await store.requestCutover(control,{expectedRevision:0});at=new Date('2026-09-21T04:10:00Z');
 const user=await f.db.getUser('a'),companion=await createStage7Development(f),actor=await companion.interactions.authenticate({user,chatId:'123'});
 let sequence=0,card=await companion.handle({user,chatId:'123',text:'/journal'});
 async function tap(label){
  await companion.interactions.bind(actor,card.stage7InteractionId,42);
  const button=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button,label);
  card=await companion.handle({user,chatId:'123',callback:{id:String(++sequence),data:button.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
 }
 await tap('Alcohol');await tap('Yes');await tap('Confirm');
 await f.core.transaction(async()=>{const prefs=await companion.preferences(actor);await companion.changePreferences(actor,prefs,{weekly_enabled:1,topics_json:'["alcohol"]'});});
 const prepare=()=>companion.weekly.prepare(actor,{automatic:true}),read=async id=>(await f.db.raw.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND delivery_id=?',args:['a',id]})).rows[0];
 assert.equal((await prepare()).status,'BRIEF_NOT_CONFIRMED');
 const morning=await store.prepare(control);assert.equal(morning.status,'READY');const context=await store.context(control);
 await store.transport.makeEligible(context,{messageId:morning.messageId,expectedRevision:morning.revision});
 const lease=await store.transport.claim(context,{messageId:morning.messageId,owner:'synthetic-weekly-morning'}),attempt=await store.transport.start(context,lease);
 assert.equal((await prepare()).status,'BRIEF_NOT_CONFIRMED','a started PHASE4 send is not a Morning acknowledgement');
 await store.transport.settle(control,'LIVE',{attemptId:attempt.attemptId,outcome:'DELIVERED',providerMessageId:'101'});
 const receipt=await confirmedMorningReceipt({...f,actor,day:'2026-09-21'});assert.equal(receipt.reportType,'outbound_messages');
 return {...f,companion,actor,prepare,read,receipt,request:{user,chatId:'123'}};
}

for(const targetVersion of [34,35])test(`v${targetVersion} weekly requires a genuine typed Morning acknowledgement and preserves LIVE→SHADOW provenance`,async t=>{
 const f=await fixture(t,targetVersion),p=await f.prepare(),row=await f.read(p.deliveryId),schedule=JSON.parse(row.schedule_json);
 assert.equal(p.status,'PROPOSED');assert.equal(row.kind,'WEEKLY');assert.equal(row.interaction_id,null);assert.equal(p.summary.daysRecorded,1);
 assert.equal(schedule.briefType,'outbound_messages');assert.equal(schedule.briefSource,f.receipt.reportSource);assert.equal(schedule.enrollment.enrollment_revision,0);
 assert.equal((await f.db.raw.execute({sql:"SELECT count(*) n FROM phase4_source_links WHERE user_id='a' AND artifact_type='journal_prompt_deliveries' AND artifact_id=? AND artifact_execution_mode='SHARED' AND source_type='outbound_messages' AND source_id=? AND source_execution_mode='LIVE' AND unlinked_at IS NULL",args:[row.privacy_artifact_id,f.receipt.reportSource]})).rows[0].n,1);
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'DELIVERED');assert.equal(provider.calls.length,1);
 assert.equal((await f.prepare()).status,'DELIVERED');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
});

for(const targetVersion of [34,35])test(`v${targetVersion} weekly retains migrated enrollment compatibility but fences same-clock READY ABA`,async t=>{
 const f=await fixture(t,targetVersion),p=await f.prepare(),row=await f.read(p.deliveryId),schedule=JSON.parse(row.schedule_json);
 const {enrollment_revision,...legacy}=schedule.enrollment;schedule.enrollment={...legacy,version:'stage7-ready-enrollment-v1'};
 await f.db.raw.execute({sql:'UPDATE journal_prompt_deliveries SET schedule_json=? WHERE delivery_id=?',args:[JSON.stringify(schedule),p.deliveryId]});
 assert.equal((await f.companion.weekly.due(f.actor,await f.read(p.deliveryId))).status,'READY','untouched enrollment revision0 retains the v33 schedule contract');
 await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");await f.db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='a'");
 assert.equal((await f.db.raw.execute("SELECT enrollment_revision FROM user_onboarding WHERE user_id='a'")).rows[0].enrollment_revision,2);
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 await assert.rejects(dispatcher.dispatch({...f.request,deliveryId:p.deliveryId}),/STAGE7_ENROLLMENT_FENCED/);
 assert.equal(provider.calls.length,0);assert.equal((await f.read(p.deliveryId)).attempt_count,0);
});

test('exact reviewed v33 pending weekly identity survives actual ordered34→35 migration with its original Morning source',async t=>{
 const sourceSha='ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',directory=await mkdtemp(join(tmpdir(),'stage7-weekly-legacy33-'));
 let db;await chmod(directory,0o700);t.after(async()=>{await db?.close();await rm(directory,{recursive:true,force:true});});
 const legacy=join(directory,'legacy'),path=join(directory,'fixture.sqlite');await mkdir(legacy,{mode:0o700});
 const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 // Materialize the exact accepted source. The candidate intentionally refuses
 // runtime admission on33; no candidate schema/Core gate is widened here.
 const archive=execFileSync('git',['archive','--format=tar',sourceSha,'src','package.json','package-lock.json'],{cwd:new URL('../',import.meta.url),env:gitEnv,maxBuffer:16*1024*1024});
 execFileSync('tar',['-xf','-','-C',legacy],{input:archive});
 const dependencyPath=fileURLToPath(import.meta.resolve('libsql')),dependencies=dependencyPath.slice(0,dependencyPath.lastIndexOf('/node_modules/')+13);
 await symlink(dependencies,join(legacy,'node_modules'));
 const old=relative=>import(pathToFileURL(join(legacy,relative)).href),now=()=>new Date('2026-09-21T04:10:00Z');
 const {createOwnedFileDb}=await old('src/db.js'),{createPhase4Keys}=await old('src/phase4Keys.js'),{createPhase4Foundation}=await old('src/phase4Foundation.js'),{createStage7Runtime}=await old('src/stage7Runtime.js');
 const oldKeys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)}),seed=createOwnedFileDb({url:'file:'+path,phase4Keys:oldKeys});let original;
 try{
  await seed.migrate({targetVersion:33});await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});
  await seed.linkTelegram({userId:'a',chatId:'123',now:now()});await seed.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'synthetic'},{now:now()});
  await seed.setLocale('a','en',{now:now()});await seed.ensureOnboarding('a',{state:'READY',now:now()});const admission=await seed.admitRuntime();
  const foundation=await createPhase4Foundation({db:seed,keys:oldKeys,admission,now});await foundation.initializeTenant('a','SHADOW');
  const runtime=await createStage7Runtime({db:seed,keys:oldKeys,admission,now,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'}});
  const companion=runtime.companion,user=await seed.getUser('a'),actor=await companion.interactions.authenticate({user,chatId:'123'});let sequence=0,card=await companion.handle({user,chatId:'123',text:'/journal'});
  for(const label of ['Alcohol','Yes','Confirm']){
   await companion.interactions.bind(actor,card.stage7InteractionId,42);const button=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button,label);
   card=await companion.handle({user,chatId:'123',callback:{id:String(++sequence),data:button.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
  }
  await seed.transaction(async()=>{const prefs=await companion.preferences(actor);await companion.changePreferences(actor,prefs,{weekly_enabled:1});});
  await seed.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-21','synthetic',?,?,?,'DELIVERED',11)",args:[now().toISOString(),now().toISOString(),user.lifecycleGeneration]});
  const report={user_id:'a',report_type:'daily',local_date:'2026-09-21',health_date:'2026-09-21',telegram_message_id:11,status:'SENT',sent_at:now().toISOString(),...companion.interactions.privacyFields(actor.state)};
  await companion.interactions.insert('report_runs',report);await companion.interactions.link('report_runs',report);
  assert.equal((await companion.weekly.prepare(actor,{automatic:true})).status,'PROPOSED');original=(await seed.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];
  const schedule=JSON.parse(original.schedule_json);assert.equal(schedule.enrollment.version,'stage7-ready-enrollment-v1');assert.equal(schedule.briefType,undefined);
 }finally{seed.close();}
 let latest;
 for(const version of [34,35]){
  // A release/migration boundary closes the prior runtime. Reopen the actual
  // owned receiver so no cached34 admission is reused after migration35.
  if(db)await db.close();db=createOwnedDb({url:'file:'+path});
  await db.migrate({targetVersion:version});const admission=await db.admitRuntime({fresh:true});
  const core=await buildPhase4Core({keys:fixtureKeys,admission,now,processing:{client:db.raw,transaction:db.transaction,withReadSnapshot:db.withProcessingReadSnapshot,assertFences:db.assertRuntimeFences,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode){if(mode!=='SHADOW')throw Error('SYNTHETIC_SHADOW_ONLY');}});
  const stores=composePhase4Stores(core),companion=await createStage7Composition({core,stores,db}),user=await db.getUser('a'),actor=await companion.interactions.authenticate({user,chatId:'123'}),row=(await db.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];
  assert.equal(core.schemaVersion,version);assert.equal(row.delivery_id,original.delivery_id);assert.equal(row.semantic_key,original.semantic_key);assert.equal(row.attempt_count,0);
  assert.equal(row.schedule_json,original.schedule_json,'migration preserves the actual old schedule bytes');assert.equal((await companion.weekly.due(actor,row)).status,'READY');
  latest={core,stores,db,companion,user,actor};
 }
 const same=await latest.companion.weekly.prepare(latest.actor,{automatic:true});assert.equal(same.deliveryId,original.delivery_id);
 const refreshed=(await db.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];assert.equal(JSON.parse(refreshed.schedule_json).briefType,'report_runs');
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...latest,provider});
 assert.equal((await dispatcher.dispatch({user:latest.user,chatId:'123',deliveryId:original.delivery_id})).status,'DELIVERED');assert.equal(provider.calls.length,1);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
});
