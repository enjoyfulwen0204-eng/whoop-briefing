import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createSchemaTransitionRuntimeProfile,SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
async function syntheticPhase4Fixture(t,{targetVersion,now}){
 const directory=await mkdtemp(join(tmpdir(),'stage7-proactive-synthetic-'));
 const runtimeProfile=createSchemaTransitionRuntimeProfile({keys:fixtureKeys,environment:{PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE}});
 const db=createOwnedFileDb({url:'file:'+join(directory,'fixture.db'),phase4Keys:fixtureKeys,runtimeProfile});
 t.after(async()=>{global.gc?.();await new Promise(r=>setImmediate(r));db.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion});const admission=await db.admitRuntime();
 const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,admission,now,authorizeMode(mode){assert.equal(mode,'SHADOW');}});
 for(const id of ['a','b']){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});await core.initializeTenant(id,'SHADOW');}
 return {db,core,keys:fixtureKeys,stores:composePhase4Stores(core)};
}
import {createStage7Composition} from '../src/stage7Composition.js';
import {createStage7ProactiveJournal} from '../src/stage7ProactiveJournal.js';
import {createStage7Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {JOURNAL_COPY} from '../src/stage7Registry.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';

async function fixture(t,{outcomes=[],locale='en',hour='04',category='alcohol',targetDate='2026-09-17'}={}){
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(`2026-09-19T${hour}:00:00Z`)});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.linkTelegram({userId:'b',chatId:'456',now:f.core.now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});
 await f.db.setLocale('a',locale);await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const user=await f.db.getUser('a'),companion=await createStage7Composition(f),actor=await companion.interactions.authenticate({user,chatId:'123'});
 const proactiveJournal=createStage7ProactiveJournal({...f,companion}),provider=createSyntheticJournalTelegram({outcomes}),dispatcher=createStage7Dispatcher({...f,companion,provider,proactiveJournal});
 const claim=await f.db.claimProactiveEvent('a',{healthDate:'2026-09-18',idempotencyKey:'synthetic-original',decision:'ASK_CONTEXT',policyVersion:'synthetic',signals:[],reason:{question_category:category,question_target_date:targetDate}},{now:f.core.now(),expectedLifecycleGeneration:user.lifecycleGeneration});
 const prepare=()=>proactiveJournal.prepare({user,chatId:'123',eventId:claim.id});
 const dispatch=deliveryId=>dispatcher.dispatch({user,chatId:'123',deliveryId});
 let sequence=0;
 async function tap(reply,label,{chat='123',messageId=reply.editMessageId??701}={}){
  const button=reply.replyMarkup.inline_keyboard.flat().find(b=>b.text.slice(b.text.indexOf(' ')+1)===label);assert.ok(button,label);
  return companion.handle({user,chatId:chat,callback:{id:String(++sequence),data:button.callback_data,from:{id:Number(chat)},message:{message_id:Number(messageId),chat:{id:Number(chat),type:'private'}}}});
 }
 return {...f,user,actor,companion,proactiveJournal,provider,dispatcher,prepare,dispatch,tap,claim,c:JOURNAL_COPY[locale]};
}
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {withDurableExecution,workStepKey} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {request as syncRequest,claim as claimSync,authority as fixtureAuthority} from './v32ReviewFixture.js';
async function durableProactive(t,{outcome='DELIVERED'}={}){
 const f=await fixture(t),wire=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://api.telegram.org/botsynthetic-stage7/sendMessage');
  assert.equal(f.db.processingTransactionActive(),false,'TELEGRAM_IO_MUST_STAY_OUTSIDE_TRANSACTION');
  wire.push(JSON.parse(options.body));
  if(outcome==='AMBIGUOUS')throw Error('SYNTHETIC_ACCEPTANCE_UNKNOWN');
  return new Response(JSON.stringify({ok:true,result:{message_id:701,date:1789790400,chat:{id:123,type:'private'}}}),{status:200});
 });
 const runtime=await createStage7Runtime({db:f.db,keys:f.keys,admission:await f.db.admitRuntime(),now:f.core.now,
  env:{telegramBotToken:'synthetic-stage7',dryRun:false},environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'}});
 const claim=await claimSync(f.db,syncRequest()),context={claim,keys:f.keys,pending:new Set(),authority:fixtureAuthority};
 const run=fn=>withDurableExecution(context,fn),send=()=>runtime.sendProactiveJournal({userId:'a',chatId:'123',eventId:f.claim.id});
 return {...f,runtime,context,run,send,wire};
}
test('durable SYNC proactive path prepares, constructs keyboard wire outside TX and settles original receipt once',async t=>{
 const f=await durableProactive(t);
 const result=await f.run(f.send);assert.equal(result.status,'DELIVERED');
 assert.equal(f.wire.length,1);assert.equal(f.wire[0].chat_id,'123');
 assert.ok(f.wire[0].reply_markup.inline_keyboard.flat().every(b=>/^j7:[A-Za-z0-9_-]{32}$/.test(b.callback_data)));
 assert.match(f.wire[0].text,/2026-09-17/);
 assert.equal((await f.run(f.send)).status,'DELIVERED','RECEIPT_REPLAY_READS_CANONICAL_STATE_WITHOUT_RESENDING');
 assert.equal(f.wire.length,1);
 await f.run(()=>f.db.markProactiveEventSent('a',f.claim.id,{}, {now:f.core.now()}));
 const delivery=(await f.db.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];
 const interaction=(await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows[0];
 assert.equal(delivery.state,'DELIVERED');assert.equal(delivery.message_id,'701');assert.equal(interaction.message_id,'701');assert.equal(interaction.target_date,'2026-09-17');
 const receipts=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[f.context.claim.executionId]})).rows;
 assert.equal(receipts.length,5);assert.ok(receipts.every(r=>r.request_digest===f.context.claim.identity&&r.scope_key===f.context.claim.scopeKey&&r.generation===f.context.claim.generation));
 assert.equal(receipts.filter(r=>r.result_json===null).length,4,'NEW_STAGE7_ROOTS_DISCARD_CARDS_AND_ACTOR_AUTHORITY');
 assert.ok(receipts.every(r=>r.result_json===null||typeof JSON.parse(r.result_json)==='boolean'||typeof JSON.parse(r.result_json)==='number'),'RECEIPTS_CONTAIN_NO_CARDS_ACTOR_AUTHORITY_OR_HEALTH_TEXT');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM pending_questions')).rows[0].n,0);
 assert.ok((await f.db.raw.execute('SELECT sent_at FROM proactive_events')).rows[0].sent_at);
});
test('durable SYNC reuses committed preparation without replaying an actor or making a second ambiguous send',async t=>{
 const f=await durableProactive(t,{outcome:'AMBIGUOUS'});
 // A committed preparation can survive an interrupted caller and be read by
 // the separate production composition with newly captured actor authority.
 const prepared=await f.run(f.prepare);assert.equal(prepared.status,'PROPOSED');assert.equal(f.wire.length,0);
 const result=await f.run(f.send);assert.equal(result.status,'AMBIGUOUS');assert.equal(f.wire.length,1);
 assert.equal((await f.run(f.send)).status,'AMBIGUOUS');assert.equal(f.wire.length,1);
 const row=(await f.db.raw.execute('SELECT * FROM journal_prompt_deliveries')).rows[0];assert.equal(row.attempt_count,1);assert.equal(row.message_id,null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT sent_at FROM proactive_events')).rows[0].sent_at,null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
