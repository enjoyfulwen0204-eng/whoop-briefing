import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import {createOwnedDb}from'./stage5OwnedDb.js';import{readOnlyTelegramOperation}from'../src/telegramReadOnlyPreparation.js';
import{createRouter}from'../src/bot/router.js';
import{isAccountInactiveError}from'../src/accountLifecycle.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'stage6-telegram-prep-')),url='file:'+join(dir,'db.sqlite'),db=createOwnedDb({url});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:32});await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE'});await db.linkTelegram({userId:'a',chatId:'1001'});const now=new Date(),owner='synthetic-owner';await db.claimTelegramUpdate(900,{owner,now,conversationKey:'tg:1001'});await db.markTelegramUpdateProcessing(900,{owner,now});return{db,url,now,owner,options:{owner,ownerUserId:'a',now:()=>now}};}
test('read-only preparation runs once outside receipt transaction, then publishes and replays original receipt',async t=>{const f=await fixture(t);let calls=0;const fn=readOnlyTelegramOperation(async()=>{calls++;assert.equal(f.db.processingTransactionActive(),false);return{userId:'a',chatId:'1001',reply:'synthetic help'};});const first=await f.db.processTelegramOperation(900,f.options,fn);assert.equal(first.reply,'synthetic help');assert.deepEqual(await f.db.processTelegramOperation(900,f.options,fn),first);assert.equal(calls,1);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,1);await f.db.releaseTelegramReply(first);});
test('caught preparation write is rejected without a reply receipt or unauthorized row',async t=>{const f=await fixture(t);const fn=readOnlyTelegramOperation(async()=>{try{await f.db.raw.execute("UPDATE users SET display_name='forbidden' WHERE id='a'");}catch{}return{userId:'a',chatId:'1001',reply:'must reject'};});await assert.rejects(f.db.processTelegramOperation(900,f.options,fn),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);assert.equal((await f.db.raw.execute("SELECT display_name FROM users WHERE id='a'")).rows[0].display_name,'Synthetic');});
test('concurrent source generation change cannot publish prepared reply',async t=>{const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());const fn=readOnlyTelegramOperation(async()=>{await peer.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");return{userId:'a',chatId:'1001',reply:'stale'};});await assert.rejects(f.db.processTelegramOperation(900,f.options,fn),/PHASE4_RECEIPT_GENERATION_STALE/);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);});
test('cross-tenant prepared reply is rejected by original owner boundary',async t=>{const f=await fixture(t);await assert.rejects(f.db.processTelegramOperation(900,f.options,readOnlyTelegramOperation(async()=>({userId:'peer',chatId:'1001',reply:'wrong'}))),/PHASE4_RESULT_OWNER_MISMATCH/);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);});
test('clone getter side effects remain inside mutation denial before receipt publication',async t=>{const f=await fixture(t);let attempted;const fn=readOnlyTelegramOperation(async()=>({userId:'a',chatId:'1001',get reply(){attempted=f.db.raw.execute("UPDATE users SET display_name='forbidden' WHERE id='a'").catch(()=>{});return 'unsafe getter';}}));await assert.rejects(f.db.processTelegramOperation(900,f.options,fn),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);await attempted;assert.equal((await f.db.raw.execute("SELECT display_name FROM users WHERE id='a'")).rows[0].display_name,'Synthetic');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);});
for(const kind of ['expired','malformed'])test(`actual help router preserves ${kind} question expiry and atomic reply replay`,async t=>{
  const f=await fixture(t),at=f.now.toISOString();
  await f.db.raw.execute({sql:'INSERT INTO user_locales(user_id,locale,created_at,updated_at) VALUES (?,?,?,?)',args:['a','en',at,at]});
  await f.db.openPendingQuestion('a',{chatId:'1001',question:'Synthetic question',context:{synthetic:true},ttlMs:kind==='expired'?10:60_000},{now:new Date(f.now.getTime()-1000)});
  if(kind==='malformed')await f.db.raw.execute("UPDATE pending_questions SET context_json='{' WHERE user_id='a'");
  const router=createRouter({db:f.db,coachFor:()=>({}),now:()=>f.now});let calls=0;
  const fn=readOnlyTelegramOperation(async()=>{calls++;assert.equal(f.db.processingTransactionActive(),true);return{userId:'a',chatId:'1001',reply:await router.handle({text:'/help',chatId:'1001',user:{id:'a',timezone:'Asia/Taipei',locale:'en'}})};});
  const first=await f.db.processTelegramOperation(900,f.options,fn);assert.ok(first.reply);
  assert.equal((await f.db.raw.execute("SELECT status FROM pending_questions WHERE user_id='a'")).rows[0].status,'EXPIRED');
  assert.deepEqual(await f.db.processTelegramOperation(900,f.options,fn),first);assert.equal(calls,1);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,1);await f.db.releaseTelegramReply(first);
});
test('question arriving during preparation is re-evaluated under the fresh owned transaction',async t=>{
  const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());let calls=0;
  const fn=readOnlyTelegramOperation(async()=>{calls++;
    if(calls===1){assert.equal(f.db.processingTransactionActive(),false);await peer.openPendingQuestion('a',{chatId:'1001',question:'Synthetic question',ttlMs:10},{now:new Date(f.now.getTime()-1000)});}
    else{assert.equal(f.db.processingTransactionActive(),true);await f.db.getOpenPendingQuestion('a',{now:f.now});}
    return{userId:'a',chatId:'1001',reply:calls===1?'discard prepared value':'fresh owned result'};
  });
  const result=await f.db.processTelegramOperation(900,f.options,fn);assert.equal(result.reply,'fresh owned result');assert.equal(calls,2);
  assert.equal((await f.db.raw.execute("SELECT status FROM pending_questions WHERE user_id='a'")).rows[0].status,'EXPIRED');
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,1);await f.db.releaseTelegramReply(result);
});
test('revoked lifecycle during preparation cannot publish a receipt',async t=>{
  const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());
  const fn=readOnlyTelegramOperation(async()=>{await peer.raw.execute("UPDATE users SET status='INACTIVE',lifecycle_generation=lifecycle_generation+1 WHERE id='a'");return{userId:'a',chatId:'1001',reply:'revoked'};});
  await assert.rejects(f.db.processTelegramOperation(900,f.options,fn),isAccountInactiveError);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);
});
test('expired update owner lease during preparation cannot publish a receipt',async t=>{
  const f=await fixture(t);let time=f.now;const fn=readOnlyTelegramOperation(async()=>{time=new Date(f.now.getTime()+600_000);return{userId:'a',chatId:'1001',reply:'expired'};});
  await assert.rejects(f.db.processTelegramOperation(900,{...f.options,now:()=>time},fn),/telegram_processing_ownership_lost/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);
});
