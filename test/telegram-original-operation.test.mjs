import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixture as httpFixture,fixtureKeys} from './v32ReviewFixture.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {createStage8SelfQa} from '../src/stage8SelfQa.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';

async function fixture(t,{qa=false,http=false,leaseMs=120000}={}){
 let db,url;
 if(http)({db,url}=await httpFixture(t,qa?34:32));
 else{
  const directory=await mkdtemp(join(tmpdir(),'r22-original-operation-'));url='file:'+join(directory,'fixture.sqlite');db=createOwnedDb({url});
  t.after(async()=>{await db.close();await rm(directory,{recursive:true,force:true});});await db.migrate({targetVersion:qa?34:32});
 }
 let at=new Date();const original=at.getTime(),now=()=>new Date(at),owner='synthetic-original-owner';
 await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'UTC'});
 await db.linkTelegram({userId:'a',chatId:'1001'});await db.setLocale('a','en');
 await db.saveTokens('a',{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date(original+86400000),scope:'offline',whoopUserId:'synthetic'});
 await db.claimTelegramUpdate(900,{owner,leaseMs,now:now(),conversationKey:'tg:1001'});await db.markTelegramUpdateProcessing(900,{owner,now:now()});
 const user=await db.getUser('a'),input={user,chatId:'1001',text:'/evidence live'},options={owner,ownerUserId:'a',now};
 const f={db,url,user,input,options,now,original,setTime:value=>{at=new Date(value);},result:()=>({userId:'a',chatId:'1001',reply:'Synthetic result'})};
 if(qa){
  const scopes=await createScopedHealthContext({db,keys:fixtureKeys,now});
  f.qa=createStage8SelfQa({scopes,db,now});f.scopes=scopes;
 }
 return f;
}
const receipts=async db=>Number((await db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n);

for(const http of [false,true])test('original identity and asOf survive outside replay with one actual audit and receipt: http='+http,async t=>{
 const f=await fixture(t,{qa:true,http}),seen=[];let preparations=0,callbacks=0;
 assert.equal(f.db.getOriginalTelegramOperation(),null);
 const run=()=>f.db.processTelegramOperation(900,f.options,async()=>{
  callbacks++;const identity=f.db.getOriginalTelegramOperation();seen.push(identity);assert.ok(Object.isFrozen(identity));
  await f.db.assertOriginalTelegramOperation(identity);
  const reply=await f.qa.handle(f.input);
  await f.db.outsideProcessingTransaction('one-original-input',async()=>{
   preparations++;assert.equal(f.db.processingTransactionActive(),false);assert.equal(f.db.getOriginalTelegramOperation(),identity);
   await f.db.assertOriginalTelegramOperation(identity);f.setTime(f.original+1000);return 17;
  });
  return {...f.result(),reply};
 });
 const first=await run();assert.equal(callbacks,2);assert.equal(preparations,1);assert.equal(seen[0],seen[1]);
 assert.deepEqual(seen[0],{updateId:900,owner:f.options.owner,ownerUserId:'a',asOfEpochMs:f.original});
 const audits=(await f.db.raw.execute('SELECT as_of_utc FROM stage8_scoped_read_audit')).rows;
 assert.equal(audits.length,1);assert.equal(audits[0].as_of_utc,new Date(f.original).toISOString());
 assert.equal(first.reply.stage8ReplyGuard.asOfEpochMs,f.original);assert.equal(await receipts(f.db),1);
 const replay=await run();assert.deepEqual(replay,first);assert.equal(callbacks,2);assert.equal(await receipts(f.db),1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,1);
 assert.equal(f.db.getOriginalTelegramOperation(),null);await f.db.releaseTelegramReply(first);await f.db.releaseTelegramReply(replay);
});
test('clone, another database and nested outside operations cannot claim the original binding',async t=>{
 const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());
 const result=await f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();
  await assert.rejects(f.db.assertOriginalTelegramOperation({...identity}),/TELEGRAM_ORIGINAL_OPERATION_REQUIRED/);
  assert.equal(peer.getOriginalTelegramOperation(),null);await assert.rejects(peer.assertOriginalTelegramOperation(identity),/TELEGRAM_ORIGINAL_OPERATION_REQUIRED/);
  await f.db.outsideProcessingTransaction('nested-operation-rejected',async()=>{
   await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>f.result()),/PHASE4_TELEGRAM_OPERATION_MUST_BE_ROOT/);return null;
  });return f.result();
 });
 assert.equal(await receipts(f.db),1);await f.db.releaseTelegramReply(result);
});
for(const mutation of ['owner','auth','lifecycle','purge','lease-shortened'])test('fresh original metadata assertion rejects changed '+mutation,async t=>{
 const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());let asserted=false;
 await assert.rejects(f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();
  return f.db.outsideProcessingTransaction('changed-original-metadata',async()=>{
   const sql={owner:"UPDATE telegram_processed_updates SET owner='other' WHERE update_id=900",auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
    lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'"}[mutation];
   if(sql)await peer.raw.execute(sql);else await peer.raw.execute({sql:'UPDATE telegram_processed_updates SET lease_expires_at=? WHERE update_id=900',args:[new Date(f.original-1).toISOString()]});
   asserted=true;await f.db.assertOriginalTelegramOperation(identity);return f.result();
  });
 }));assert.equal(asserted,true);assert.equal(await receipts(f.db),0);
});
test('same-owner renewal cannot extend the originally observed lease',async t=>{
 const f=await fixture(t,{leaseMs:20000}),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());
 const originalUntil=Date.parse((await peer.raw.execute('SELECT lease_expires_at FROM telegram_processed_updates WHERE update_id=900')).rows[0].lease_expires_at);
 assert.equal(originalUntil,f.original+20000);
 await assert.rejects(f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();return f.db.outsideProcessingTransaction('renewed-lease',async()=>{
   await peer.raw.execute({sql:'UPDATE telegram_processed_updates SET lease_expires_at=? WHERE update_id=900',args:[new Date(originalUntil+600000).toISOString()]});
   f.setTime(originalUntil+1);await f.db.assertOriginalTelegramOperation(identity);
  });
 }),/TELEGRAM_ORIGINAL_OPERATION_EXPIRED/);assert.equal(await receipts(f.db),0);
});
test('a newly shortened lease bounds local metadata after its fresh assertion',async t=>{
 const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());
 await assert.rejects(f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();return f.db.outsideProcessingTransaction('shorten-live-lease',async()=>{
   await peer.raw.execute({sql:'UPDATE telegram_processed_updates SET lease_expires_at=? WHERE update_id=900',args:[new Date(f.original+10000).toISOString()]});
   await f.db.assertOriginalTelegramOperation(identity);f.setTime(f.original+10001);f.db.getOriginalTelegramOperation();
  });
 }),/TELEGRAM_ORIGINAL_OPERATION_EXPIRED/);assert.equal(await receipts(f.db),0);
});
test('original parent cancellation is not replaced by a fresh child budget',async t=>{
 const f=await fixture(t),parent=createExecutionBudget({budgetMs:5000}),child=createExecutionBudget({budgetMs:10000});
 try{await assert.rejects(withExecutionBudget(parent,()=>f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();return f.db.outsideProcessingTransaction('cancel-parent',async()=>{
   parent.cancel();return withExecutionBudget(child,()=>f.db.assertOriginalTelegramOperation(identity));
  });
 })),error=>error.code==='SYNC_CANCELLED');}finally{parent.close();child.close();}
 assert.equal(await receipts(f.db),0);
});
test('closed inherited operation cannot downgrade a late actual QA call to a new standalone clock',async t=>{
 const f=await fixture(t,{qa:true});let release,late;
 const gate=new Promise(resolve=>{release=resolve;});
 const result=await f.db.processTelegramOperation(900,f.options,async()=>{
  await f.db.outsideProcessingTransaction('create-late-qa',async()=>{
   assert.equal(f.db.processingTransactionActive(),false);late=gate.then(()=>f.qa.handle(f.input));return null;
  });return f.result();
 });
 f.setTime(f.original+1000);release();await assert.rejects(late,/TELEGRAM_ORIGINAL_OPERATION_CLOSED/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 await f.db.releaseTelegramReply(result);
});
test('an assertion waiting on its fresh ownership read rejects after the operation closes',async t=>{
 const f=await fixture(t);let release,entered,late,armed=false;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),execute=f.db.raw.execute;
 f.db.raw.execute=async statement=>{
  const pause=armed&&/SELECT update_id,lease_expires_at FROM telegram_processed_updates/.test(statement?.sql??'');if(pause)armed=false;
  const result=await execute(statement);if(pause){entered();await gate;}return result;
 };
 const result=await f.db.processTelegramOperation(900,f.options,async()=>{
  const identity=f.db.getOriginalTelegramOperation();
  await f.db.outsideProcessingTransaction('create-late-assertion',async()=>{
   assert.equal(f.db.processingTransactionActive(),false);armed=true;late=f.db.assertOriginalTelegramOperation(identity);await started;return null;
  });return f.result();
 });
 release();await assert.rejects(late,/TELEGRAM_ORIGINAL_OPERATION_CLOSED/);f.db.raw.execute=execute;await f.db.releaseTelegramReply(result);
});
test('QA binds the original subject and retains original 30-second admission and standalone clocks',async t=>{
 const f=await fixture(t,{qa:true});
 const result=await f.db.processTelegramOperation(900,f.options,async()=>{
  await assert.rejects(f.qa.handle({...f.input,user:{...f.user,id:'b'}}),/SCOPED_ACTOR_FENCED/);
  f.setTime(f.original+30001);await assert.rejects(f.qa.handle(f.input),/SCOPED_REQUEST_INVALID/);return f.result();
 });
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 await f.db.releaseTelegramReply(result);
 f.setTime(f.original+40000);const standalone=await f.qa.handle(f.input);
 assert.equal(standalone.stage8ReplyGuard.asOfEpochMs,f.original+40000);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,1);
});
