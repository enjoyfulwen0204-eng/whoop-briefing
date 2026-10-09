import test from 'node:test';import assert from 'node:assert/strict';
import {fork} from 'node:child_process';import {readFile,readdir} from 'node:fs/promises';
import {deliveryFixture,deliveryColumn,openHttpFixture} from './deliveryDefaultFixture.js';
import {createUpdateProcessor,UPDATE_OUTCOME} from '../src/bot/updateProcessor.js';
import {TelegramApiError} from '../src/bot/api.js';
import {SEND_OUTCOME} from '../src/sendOutcome.js';
const update=id=>({update_id:id,message:{message_id:id,text:'/synthetic',chat:{id:5001,type:'private'},from:{id:5001,is_bot:false}}});
function processor(db,{onHandle=()=>{},send=async()=>({sent:true,messageId:123}),now=()=>new Date()}={}){
 return createUpdateProcessor({db,resolveUser:async()=>null,handleMessage:async()=>{throw Error('UNEXPECTED_HEALTH_HANDLER');},
  handleUnlinked:async()=>{onHandle();return 'Synthetic reply';},sendReply:send,now,workerId:'isolated',sleepImpl:async()=>{}});
}
async function expireClaims(db,id){const past=new Date(Date.now()-60_000).toISOString();
 await db.raw.execute({sql:'UPDATE telegram_processed_updates SET lease_expires_at=? WHERE update_id=?',args:[past,id]});
 await db.raw.execute({sql:'UPDATE resource_locks SET expires_at=?',args:[past]});
}
test('all repository runtime/operator telegram_operations inserts explicitly set delivery_state',async()=>{
 const writers=[];
 for(const base of ['src','scripts'])for(const file of await readdir(new URL(`../${base}/`,import.meta.url),{recursive:true})){
  if(!file.endsWith('.js'))continue;const source=await readFile(new URL(`../${base}/${file}`,import.meta.url),'utf8');
  for(const match of source.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+telegram_operations\s*\(([^)]+)\)/gi)){
   assert.ok(match[1].split(',').map(s=>s.trim()).includes('delivery_state'),`${base}/${file}`);writers.push(`${base}/${file}`);
  }
 }
 assert.deepEqual(writers.sort(),['src/db.js','src/phase4JournalInbound.js','src/phase4JournalInbound.js']);
});
test('DELIVERED SQL default never substitutes for explicit new ACTION_READY/NOT_REQUIRED; explicit states preserve replay and send fencing',async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();assert.equal((await deliveryColumn(db)).dflt_value,"'DELIVERED'");
 let callbacks=0;const now=new Date(),owner='synthetic-owner';
 for(const [id,reply,expected] of [[701,'Synthetic reply','ACTION_READY'],[702,null,'NOT_REQUIRED']]){
  assert.equal((await db.claimTelegramUpdate(id,{owner,conversationKey:'tg:5001',now})).ok,true);
  assert.equal(await db.markTelegramUpdateProcessing(id,{owner,now}),true);
  const call=()=>db.processTelegramOperation(id,{owner,nonHealthOperation:true,now:()=>now},async()=>{callbacks++;return {reply,chatId:'5001'};});
  await call();await call();assert.equal((await db.getTelegramOperation(id)).deliveryState,expected);
  await db.completeTelegramUpdate(id,{owner,now});
 }
 assert.equal(callbacks,2);assert.equal((await db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,2);
 for(const [i,state] of ['ACTION_READY','AMBIGUOUS','DELIVERED'].entries()){
  const id=710+i;
  await db.raw.execute({sql:'INSERT INTO telegram_operations(update_id,result_json,committed_at,delivery_state) VALUES(?,?,?,?)',args:[id,'null',now.toISOString(),state]});
  assert.equal((await db.getTelegramOperation(id)).deliveryState,state);
  if(state!=='ACTION_READY')assert.equal(await db.markDeliveryStarted(id,{owner,conversationKey:'tg:5001',now}),false);
 }
});
test('successful fake send under historical default commits DELIVERED once; restart/replay runs no duplicate callback or send',async t=>{
 const {db,url}=await deliveryFixture(t);await db.admitRuntime();let callbacks=0,sends=0;
 const make=client=>processor(client,{onHandle:()=>{callbacks++;},send:async()=>{sends++;return {sent:true,messageId:123};}});
 assert.equal((await make(db).processUpdate(update(801))).outcome,UPDATE_OUTCOME.PROCESSED);
 assert.equal((await db.getTelegramOperation(801)).deliveryState,'DELIVERED');
 const reopened=openHttpFixture(url);t.after(()=>reopened.close());await reopened.db.admitRuntime();await make(reopened.db).processUpdate(update(801));
 assert.equal(callbacks,1);assert.equal(sends,1);assert.equal((await reopened.db.getTelegramOperation(801)).telegramMessageId,123);
});
test('definite fake rejection returns ACTION_READY; retry sends once without replaying committed action',async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();let callbacks=0,attempts=0;
 const make=()=>processor(db,{onHandle:()=>{callbacks++;},send:async()=>{attempts++;
  if(attempts===1)throw new TelegramApiError('synthetic rejection',{status:429,sendOutcome:SEND_OUTCOME.DEFINITE_FAILURE});
  return {sent:true,messageId:123};}});
 assert.equal((await make().processUpdate(update(901))).outcome,UPDATE_OUTCOME.RETRY);
 assert.equal((await db.getTelegramOperation(901)).deliveryState,'ACTION_READY');await expireClaims(db,901);
 assert.equal((await make().processUpdate(update(901))).outcome,UPDATE_OUTCOME.PROCESSED);
 assert.equal((await db.getTelegramOperation(901)).deliveryState,'DELIVERED');assert.equal(callbacks,1);assert.equal(attempts,2);
});
test('ambiguous fake send survives restart without false DELIVERED or duplicate delivery',async t=>{
 const {db,url}=await deliveryFixture(t);await db.admitRuntime();let callbacks=0,sends=0;
 const first=processor(db,{onHandle:()=>{callbacks++;},send:async()=>{sends++;throw new TelegramApiError('synthetic timeout',{sendOutcome:SEND_OUTCOME.AMBIGUOUS});}});
 assert.equal((await first.processUpdate(update(1001))).outcome,UPDATE_OUTCOME.AMBIGUOUS_DELIVERY);
 assert.equal((await db.getTelegramOperation(1001)).deliveryState,'AMBIGUOUS');
 const reopened=openHttpFixture(url);t.after(()=>reopened.close());await reopened.db.admitRuntime();
 await processor(reopened.db,{onHandle:()=>{callbacks++;},send:async()=>{sends++;}}).processUpdate(update(1001));
 assert.equal(callbacks,1);assert.equal(sends,1);assert.equal((await reopened.db.getTelegramOperation(1001)).deliveryState,'AMBIGUOUS');
});
function child(t,url,id,mode){
 const process=fork(new URL('./deliveryDefaultProcess.js',import.meta.url),[url,String(id),mode],{execArgv:['--expose-gc'],stdio:['ignore','pipe','pipe','ipc']});let output='';
 process.stdout.on('data',x=>output+=x);process.stderr.on('data',x=>output+=x);
 t.after(()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');});
 const exit=new Promise(resolve=>process.on('exit',(code,signal)=>resolve({code,signal})));
 const message=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ISOLATED_CHILD_TIMEOUT:'+output)),15000);
  process.once('message',value=>{clearTimeout(timer);resolve(value);});process.once('error',error=>{clearTimeout(timer);reject(error);});});
 return {process,exit,message};
}
for(const mode of ['before-send','after-send'])test(`real SIGKILL ${mode} under historical default preserves durable dedupe after fresh runtime restart`,async t=>{
 const {db,url}=await deliveryFixture(t);await db.admitRuntime();const id=mode==='before-send'?1101:1201;
 const first=child(t,url,id,mode),checkpoint=await first.message;
 assert.equal(checkpoint.callbacks,1);assert.equal(checkpoint.sends,mode==='before-send'?0:1);
 assert.equal((await db.getTelegramOperation(id)).deliveryState,mode==='before-send'?'ACTION_READY':'DELIVERY_STARTED');
 first.process.kill('SIGKILL');assert.equal((await first.exit).signal,'SIGKILL');await expireClaims(db,id);
 const retry=child(t,url,id,'retry'),result=await retry.message;assert.equal((await retry.exit).code,0);assert.equal(result.callbacks,0);
 assert.equal(result.sends,mode==='before-send'?1:0);assert.equal(result.state,mode==='before-send'?'DELIVERED':'DELIVERY_STARTED');
 const replay=child(t,url,id,'retry'),again=await replay.message;assert.equal((await replay.exit).code,0);assert.equal(again.callbacks,0);assert.equal(again.sends,0);
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM telegram_operations WHERE update_id=?',args:[id]})).rows[0].n,1);
});
