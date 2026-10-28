import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client/sqlite3';
import {fixture as httpFixture} from './v32ReviewFixture.js';

async function fixture(t){
 const f=await httpFixture(t,32,{traceTransactions:true});
 await f.db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'UTC'});
 await f.db.linkTelegram({userId:'a',chatId:'1001'});
 const now=new Date(),owner='synthetic-cleanup-owner';
 await f.db.claimTelegramUpdate(901,{owner,leaseMs:120000,now,conversationKey:'tg:1001'});
 await f.db.markTelegramUpdateProcessing(901,{owner,now});
 const separate=createClient({url:f.url});t.after(()=>separate.close());
 return {...f,separate,options:{owner,ownerUserId:'a'},result:{userId:'a',chatId:'1001',reply:'Synthetic reply'}};
}
const countReceipts=async f=>Number((await f.separate.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n);
const receiptSql=/INSERT INTO telegram_operations/;
const releaseSql=/DELETE FROM resource_locks/;
function rejectedCleanup(f){
 let attempts=0;
 const arm=()=>f.transport.arm({matchSql:releaseSql,before:()=>{
  attempts++;arm();throw Object.assign(Error('SYNTHETIC_RELEASE_REJECTED'),{code:'SQLITE_CONSTRAINT'});
 }});
 return {arm,attempts:()=>attempts};
}

for(const applied of [false,true])test('original Telegram lost receipt ACK survives failed privacy cleanup: applied='+applied,async t=>{
 const f=await fixture(t),cleanup=rejectedCleanup(f);let callbacks=0;
 f.transport.arm({matchSql:receiptSql,...(applied?{loseAcknowledgement:true,after:()=>cleanup.arm()}:{before:async native=>{
  // The isolated server aborts before COMMIT, while the application loses the
  // response. This ends the server writer without asserting client knowledge.
  await native.execute('ROLLBACK');cleanup.arm();throw Error('SYNTHETIC_COMMIT_ACK_LOST');
 }})});
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{callbacks++;return f.result;}),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.code,'COMMIT_INDETERMINATE');
  assert.equal(error.cause.code,'COMMIT_INDETERMINATE');assert.equal(error.errors[0],error.cause);
  assert.equal(error.errors[1].code,'SQLITE_CONSTRAINT');assert.equal(error.definiteCommitRejection,undefined);return true;
 });
 assert.equal(callbacks,1);assert.equal(cleanup.attempts(),1);assert.equal(await countReceipts(f),applied?1:0);
 assert.equal(f.db.getOriginalTelegramOperation(),null);
});

test('successful no-reply receipt does not retry a rejected cleanup transaction',async t=>{
 const f=await fixture(t),cleanup=rejectedCleanup(f);let callbacks=0;
 f.transport.arm({matchSql:receiptSql,after:()=>cleanup.arm()});
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{callbacks++;return {userId:'a',value:'synthetic'};}),error=>
  error.code==='SQLITE_CONSTRAINT'&&error.definiteCommitRejection===true);
 assert.equal(callbacks,1);assert.equal(await countReceipts(f),1);assert.equal(cleanup.attempts(),1);
});

test('successful no-reply receipt does not retry a lost cleanup COMMIT ACK',async t=>{
 const f=await fixture(t);let cleanupCommits=0,callbacks=0;
 const arm=()=>f.transport.arm({matchSql:releaseSql,loseAcknowledgement:true,after:()=>{cleanupCommits++;arm();}});
 f.transport.arm({matchSql:receiptSql,after:arm});
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{callbacks++;return {userId:'a'};}),error=>error.code==='COMMIT_INDETERMINATE');
 assert.equal(callbacks,1);assert.equal(await countReceipts(f),1);assert.equal(cleanupCommits,1);
});

test('unknown cleanup COMMIT retains original application failure as cause',async t=>{
 const f=await fixture(t),original=Object.assign(Error('SYNTHETIC_ORIGINAL_FAILURE'),{code:'SYNTHETIC_ORIGINAL_FAILURE'});let cleanupCommits=0;
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{
  f.transport.arm({matchSql:releaseSql,loseAcknowledgement:true,after:()=>{cleanupCommits++;}});throw original;
 }),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.code,'COMMIT_INDETERMINATE');
  assert.equal(error.cause,original);assert.equal(error.errors[0],original);assert.equal(error.errors[1].code,'COMMIT_INDETERMINATE');return true;
 });
 assert.equal(await countReceipts(f),0);assert.equal(cleanupCommits,1);
});

for(const original of [undefined,null,false])test('falsy original failure is retained with failed Telegram cleanup: '+String(original),async t=>{
 const f=await fixture(t),cleanup=rejectedCleanup(f);
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{cleanup.arm();throw original;}),error=>
  error instanceof AggregateError&&Object.hasOwn(error,'cause')&&error.cause===original&&error.errors[0]===original&&error.errors[1].code==='SQLITE_CONSTRAINT');
 assert.equal(await countReceipts(f),0);assert.equal(cleanup.attempts(),1);
});

test('successful cleanup preserves the exact original application failure',async t=>{
 const f=await fixture(t),original=Error('SYNTHETIC_ORIGINAL_FAILURE');
 await assert.rejects(f.db.processTelegramOperation(901,f.options,()=>{throw original;}),error=>error===original);
 assert.equal(await countReceipts(f),0);
});
