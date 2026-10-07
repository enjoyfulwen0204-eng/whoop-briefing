import test from 'node:test';import assert from 'node:assert/strict';
import {createWhoopClient,WhoopAuthError} from '../src/whoop.js';import {createSync} from '../src/sync.js';
import {createExecutionBudget} from '../src/executionBudget.js';import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
const db={getTokens:async()=>({accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000)}),getSyncState:async()=>({backfillComplete:true}),saveSyncState:async()=>{},transaction:async fn=>fn()};
const whoop=(budget,extra)=>createWhoopClient({db,userId:'synthetic',clientId:'synthetic',clientSecret:'synthetic',expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
 requestSignal:budget.signal,requestDeadlineAt:budget.deadlineAt,...extra});
for(const boundary of ['headers','body','retry_sleep'])test(`server WHOOP deadline bounds ${boundary} and prevents another request`,async()=>{
 const budget=createExecutionBudget({budgetMs:40});let calls=0,cancelled=false;
 const client=whoop(budget,{backoffFor:()=>1,sleepImpl:()=>new Promise(()=>{}),fetchImpl:async()=>{
   calls++;if(boundary==='headers')return new Promise(()=>{});
   if(boundary==='retry_sleep')return new Response('{}',{status:503});
   return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));
 }});
 const started=performance.now();try{await assert.rejects(()=>client.sleeps(new Date(),new Date()),e=>['WHOOP_MAINTENANCE_DEADLINE','SYNC_TIMEOUT'].includes(e.code));
  assert.ok(performance.now()-started<1000);assert.equal(calls,1);if(boundary==='body')assert.equal(cancelled,true);
 }finally{budget.close();}
});
test('incomplete pagination rejects the whole resource window without canonical writes',async()=>{
 const budget=createExecutionBudget({budgetMs:1000});let calls=0,writes=0;
 const client=whoop(budget,{fetchImpl:async()=>{calls++;return new Response(JSON.stringify({records:[{id:calls}],next_token:`next-${calls}`}));}});
 const sync=createSync({db:{...db,upsertSleeps:async()=>{writes++;}},whoop:client,userId:'synthetic',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED,budget});
 try{const result=await sync.syncAll({force:true,resources:['sleep']});assert.equal(result.outcome,'REQUIRED_RESOURCE_FAILED');assert.equal(calls,12);assert.equal(writes,0);}finally{budget.close();}
});
test('token refresh deadline also bounds response body and prevents token settlement',async()=>{
 const budget=createExecutionBudget({budgetMs:35});let writes=0;
 const client=whoop(budget,{db:{...db,getTokens:async()=>({accessToken:'old',refreshToken:'synthetic',expiresAt:new Date(0)}),saveTokens:async()=>{writes++;}},
 fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}))});
 try{await assert.rejects(()=>client.getAccessToken());assert.equal(writes,0);}finally{budget.close();}
});
test('canonical typed sync distinguishes auth failure, timeout, cancellation, no-data success and bounded incomplete backfill',async()=>{
 const base={db:{...db,upsertSleeps:async()=>0,upsertRecoveries:async()=>0},userId:'synthetic',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED};
 const auth=await createSync({...base,whoop:{sleeps:async()=>{throw new WhoopAuthError('synthetic auth failed');}}}).syncAll({force:true,resources:['sleep']});
 assert.equal(auth.outcome,'AUTH_FAILED');
 const timeout=createExecutionBudget({budgetMs:1});await new Promise(r=>setTimeout(r,3));
 try{assert.equal((await createSync({...base,budget:timeout,whoop:{sleeps:async()=>[]}}).syncAll({force:true,resources:['sleep']})).outcome,'TIMEOUT');}finally{timeout.close();}
 const controller=new AbortController(),cancel=createExecutionBudget({budgetMs:1000,signal:controller.signal});controller.abort();
 try{assert.equal((await createSync({...base,budget:cancel,whoop:{sleeps:async()=>[]}}).syncAll({force:true,resources:['sleep']})).outcome,'CANCELLED');}finally{cancel.close();}
 const noData=await createSync({...base,whoop:{sleeps:async()=>[],recoveries:async()=>[]}}).syncAll({force:true,resources:['sleep','recovery']});assert.equal(noData.outcome,'NO_NEW_DATA_SUCCESS');assert.equal(noData.complete,true);
 const partial=await createSync({...base,db:{...base.db,getSyncState:async()=>({backfillComplete:false})},whoop:{sleeps:async()=>[]}}).syncAll({force:true,resources:['sleep']});
 assert.equal(partial.outcome,'PARTIAL');assert.equal(partial.complete,false);assert.equal(JSON.parse(JSON.stringify(partial)).outcome,'PARTIAL');
});
