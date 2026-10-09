import test from 'node:test';import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url).href;const {createCoach}=await import(root+'src/coach.js');const {createExecutionBudget}=await import(root+'src/executionBudget.js');
for(const mode of ['deadline_headers','caller_cancel','parameter_fallback'])test('coach submits zero new provider requests after authority ends: '+mode,async()=>{
 const controller=new AbortController(),budget=createExecutionBudget({budgetMs:mode==='caller_cancel'?1000:30,signal:controller.signal}),calls=[];let pending;
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',userId:'alice',env:{},maxRetries:mode==='parameter_fallback'?1:2,backoffFor:()=>0,
  fetchImpl:async(_url,init)=>{
   calls.push({at:performance.now(),phaseAborted:budget.signal.aborted,providerSignalAborted:init.signal.aborted});
   if(calls.length===1){await new Promise(r=>setTimeout(r,70));return new Response(JSON.stringify({error:{message:mode==='parameter_fallback'?'unsupported reasoning parameter':'temporary unavailable'}}),{status:mode==='parameter_fallback'?400:503});}
   return new Response(JSON.stringify({model:'synthetic',choices:[{message:{content:'{"order":["fact"]}'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  }});
 const timer=mode==='caller_cancel'?setTimeout(()=>controller.abort(),20):null;
 try{await assert.rejects(()=>budget.run(()=>pending=coach.narrativePlan([{id:'fact',text:'Synthetic recovery: 65%.',required:true}])));
  await pending;assert.equal(calls.length,1);assert.equal(calls[0].phaseAborted,false);assert.equal(calls[0].providerSignalAborted,false);
  console.log('REVIEW_FINDING '+JSON.stringify({kind:'COACH_WORK_AFTER_AUTHORITY',mode,calls,lateNewProviderRequests:0}));
 }finally{if(timer)clearTimeout(timer);budget.close();}
});
