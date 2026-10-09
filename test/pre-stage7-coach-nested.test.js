import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoach} from '../src/coach.js';
import {createExecutionBudget, withExecutionBudget} from '../src/executionBudget.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ok=()=>new Response(JSON.stringify({choices:[{message:{content:'safe'}}]}));
for(const mode of ['before','headers','body','backoff','parameter','fallback','late','explicit-parent','two-users','repeated']) {
 test(`Coach cancellation reaches ${mode}; no stale result or new requests`,async()=>{
  const controller=new AbortController(),budget=createExecutionBudget({budgetMs:mode==='explicit-parent'?20:1500});
  const calls=[];
  if(mode==='before')controller.abort();
  const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:mode==='fallback'?{MODEL_QA:'synthetic-missing'}:{},signal:controller.signal,
   executionBudget:mode==='explicit-parent'?budget:undefined,maxRetries:3,backoffFor:()=>10000,
   fetchImpl:async(url,init)=>{
    calls.push({aborted:init.signal.aborted,at:Date.now()});assert.equal(init.signal.aborted,false);
    if(mode==='body')return new Response(new ReadableStream({start(c){setTimeout(()=>{controller.abort();c.close();},20);}}));
    if(['headers','late','explicit-parent','two-users','repeated'].includes(mode)){await pause(70);return ok();}
    if(['parameter','fallback'].includes(mode))await pause(70);
    return new Response(JSON.stringify({error:{message:mode==='fallback'?'model not found':'bad parameter'}}),{status:mode==='parameter'?400:mode==='fallback'?404:503});
   }});
  const timer=setTimeout(()=>{controller.abort();if(mode==='repeated')controller.abort();},30);
  const ambient=mode==='explicit-parent'?createExecutionBudget({budgetMs:1500}):budget;
  const start=Date.now();
  try{
   const work=withExecutionBudget(ambient,()=>coach.ask({system:'synthetic',user:'synthetic'}));
   if(mode==='two-users'){
    const healthy=createCoach({apiKey:'synthetic',model:'synthetic',env:{},fetchImpl:async()=>ok()});
    assert.equal(await healthy.ask({system:'x',user:'y'}),'safe');
   }
   assert.equal(await work,null);assert.ok(Date.now()-start<1000,'abortable backoff does not retain a 10-second timer');
   await pause(100);assert.equal(calls.length,mode==='before'?0:1);assert.ok(calls.every(c=>!c.aborted));
  }finally{clearTimeout(timer);budget.close();ambient.close();}
 });
}
test('Coach rejects successful fallback result cancelled during usage recording',async()=>{
 const controller=new AbortController();let calls=0,writes=0;
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',userId:'alice',env:{MODEL_QA:'missing'},signal:controller.signal,
  db:{recordAiUsage:async()=>{writes++;controller.abort();await pause(20);}},maxRetries:1,
  fetchImpl:async()=>{calls++;return calls===1?new Response(JSON.stringify({error:{message:'model not found'}}),{status:404}):ok();}});
 assert.equal(await coach.ask({system:'synthetic',user:'synthetic'}),null);assert.equal(calls,2);assert.equal(writes,1);
});
