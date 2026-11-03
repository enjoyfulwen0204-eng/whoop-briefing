import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN_SYNTHETIC_ONLY');};
process.loadEnvFile=()=>{throw Error('ENV_FILE_READ_FORBIDDEN');};
const root='../src/';
const {createExecutionBudget,ExecutionBudgetError}=await import(root+'executionBudget.js');
const {processingTransactions}=await import(root+'processingTransaction.js');
const {createTelegram}=await import(root+'telegram.js');
const {withDeliveryAuthorization}=await import(root+'accountLifecycle.js');
const {log}=await import(root+'logger.js');
const {createIdentityStore}=await import(root+'identityStore.js');
for(const level of ['info','warn','error'])log[level]=()=>{};

test('no new Telegram submission after a predeadline authorization read returns postdeadline',async()=>{
 const epoch=Date.now();let now=epoch,releaseRead,startedRead,submissions=0,submissionsAfterDeadline=0;
 const started=new Promise(resolve=>{startedRead=resolve;});
 const read=new Promise(resolve=>{releaseRead=resolve;});
 const controller=new AbortController();
 const budget=createExecutionBudget({budgetMs:1000,startedAtMs:epoch,nowMs:()=>now,signal:controller.signal});
 const p=processingTransactions({execute:async()=>{startedRead();await read;return {rows:[{telegram_chat_id:'101'}]};},batch:async()=>({rows:[]})});
 const identity=createIdentityStore(p.client,{transaction:p.transaction});
 const telegram=withDeliveryAuthorization(createTelegram({botToken:'synthetic-only',chatId:'synthetic-chat',fetchImpl:async()=>{
   submissions++;if(now>=budget.deadlineAt)submissionsAfterDeadline++;
   return new Response(JSON.stringify({ok:true,result:{message_id:101}}),{status:200,headers:{'content-type':'application/json'}});
 }}),async()=>Boolean(await identity.getActiveChatIdForUser('synthetic-user',{expectedLifecycleGeneration:1})),{userId:'synthetic-user',expectedLifecycleGeneration:1});
 let underlying;
 try{
   const phase=budget.run(()=>underlying=p.withFence(()=>budget.assert(),()=>telegram.send('synthetic-only')));
   await started;now=epoch+1000;controller.abort(new ExecutionBudgetError());
   await assert.rejects(phase,{code:'SYNC_TIMEOUT'});
   assert.equal(submissions,0);
   releaseRead();await assert.rejects(underlying); 
   assert.equal(submissionsAfterDeadline,0,'A new synthetic sendMessage was submitted after phase TIMEOUT');
 }finally{releaseRead();budget.close();}
});
