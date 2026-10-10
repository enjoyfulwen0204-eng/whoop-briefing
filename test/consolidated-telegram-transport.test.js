import test from 'node:test';import assert from 'node:assert/strict';
import {createTelegram} from '../src/telegram.js';import {createTelegramApi} from '../src/bot/api.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {deliverReport,DELIVERY_RESULT} from '../src/reportDelivery.js';
import {SEND_OUTCOME} from '../src/sendOutcome.js';
const message=(id)=>({message_id:id,date:1791586800,chat:{id:1001,type:'private'},text:'synthetic'});
const wire=value=>new Response(JSON.stringify(value));
const clients=fetchImpl=>[createTelegram({botToken:'synthetic',chatId:'1001',fetchImpl}).send,
 text=>createTelegramApi({botToken:'synthetic',fetchImpl}).sendMessage('1001',text)];
for(const id of [undefined,null,false,'','42',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])test('F08 malformed raw message_id '+String(id),async()=>{
 for(const send of clients(async()=>wire({ok:true,result:message(id)})))await assert.rejects(()=>send('synthetic'),e=>e.sendOutcome===SEND_OUTCOME.AMBIGUOUS);
});
for(const body of [null,[],{}, {ok:'true',result:message(42)},{ok:1,result:message(42)},{ok:true},{ok:true,result:[]},{ok:true,result:{message_id:42}},
 {ok:true,result:{...message(42),date:'1791586800'}},{ok:true,result:{...message(42),chat:{id:'1001',type:'private'}}}, {ok:true,result:{...message(42),chat:{id:1002,type:'private'}}}])test('F08 malformed raw Message/wrapper '+JSON.stringify(body),async()=>{
 for(const send of clients(async()=>wire(body)))await assert.rejects(()=>send('synthetic'),e=>e.sendOutcome===SEND_OUTCOME.AMBIGUOUS);
});
test('F08 valid immediate Message control',async()=>{for(const send of clients(async()=>wire({ok:true,result:message(42)})))await send('synthetic');});
test('F08 durable invalid ACK is ambiguous, one claim and zero replay sends',async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});await db.linkTelegram({userId:'alice',chatId:'1001'});
 const claimKey={userId:'alice',reportType:'daily',localDateKey:'2026-10-10'},claim=await db.claimReport({...claimKey,ttlMs:60000,expectedLifecycleGeneration:1});let sends=0;
 const telegram=createTelegram({botToken:'synthetic',chatId:'1001',fetchImpl:async()=>{sends++;return wire({ok:true,result:message(null)});}});
 assert.equal((await deliverReport({db,claimKey,claim,telegram,text:'synthetic'})).result,DELIVERY_RESULT.AMBIGUOUS);
 const row=(await db.raw.execute("SELECT * FROM report_claims WHERE user_id='alice'")).rows[0];assert.equal(row.delivery_state,'AMBIGUOUS');assert.equal(row.telegram_message_id,null);
 assert.equal((await db.claimReport({...claimKey,ttlMs:60000,expectedLifecycleGeneration:1})).granted,false);assert.equal(sends,1);
 assert.equal(await db.markClaimSent({...claimKey,owner:claim.owner,messageId:'42'}),false);
});
for(const stage of ['before','headers','body','late'])test('F10 parent cancellation '+stage,async()=>{
 const controller=new AbortController(),budget=createExecutionBudget({budgetMs:1000,signal:controller.signal});let calls=0,providerSignal;
 const telegram=createTelegram({botToken:'synthetic',chatId:'1001',fetchImpl:async(_url,init)=>{calls++;providerSignal=init.signal;
  if(stage==='headers'){controller.abort();return new Promise(()=>{});}
  if(stage==='late'){controller.abort();return wire({ok:true,result:message(42)});}
  if(stage==='body')return {ok:true,status:200,text:async()=>{controller.abort();return new Promise(()=>{});}};
  return wire({ok:true,result:message(42)});
 }});
 if(stage==='before')controller.abort();
 try {await assert.rejects(()=>withExecutionBudget(budget,()=>telegram.send('synthetic')),e=>e.sendOutcome===(stage==='before'?SEND_OUTCOME.DEFINITE_FAILURE:SEND_OUTCOME.AMBIGUOUS));
 assert.equal(calls,stage==='before'?0:1);if(providerSignal)assert.equal(providerSignal.aborted,true);
 }finally{budget.close();}
});
