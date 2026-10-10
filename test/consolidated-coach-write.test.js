import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {createCoach} from '../src/coach.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('F03: shorter explicit Coach parent is absent from real HTTP usage COMMIT authority',async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();await db.createUser({id:'alice',status:'ACTIVE',displayName:'Alice'});await db.getCapabilities('alice');
 const ambient=createExecutionBudget({budgetMs:5000}),parent=createExecutionBudget({budgetMs:1000});let commitAfterExpiry=false,calls=0,delayed=false;
 const execute=db.raw.execute;
 db.raw.execute=async statement=>{const sql=typeof statement==='string'?statement:statement.sql;
  if(!delayed&&/INSERT\s+INTO\s+ai_usage/.test(sql)){delayed=true;await pause(1200);try{parent.assert();}catch{commitAfterExpiry=true;}}
  return execute(statement);
 };
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:{},db,userId:'alice',executionBudget:parent,maxRetries:1,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'synthetic'}}],usage:{prompt_tokens:1,completion_tokens:1}}));}});
 try{
  const result=await withExecutionBudget(ambient,()=>coach.ask({system:'synthetic',user:'synthetic'}));
  const observedUntil=Date.now()+2000;while(!commitAfterExpiry&&Date.now()<observedUntil)await pause(10);
  const rows=(await db.raw.execute("SELECT count(*) n FROM ai_usage WHERE user_id='alice'")).rows[0].n;
  assert.equal(result,null);assert.equal(commitAfterExpiry,true);assert.equal(calls,1);assert.equal(rows,0);
  console.log('COUNTEREXAMPLE '+JSON.stringify({issue:'COACH_EXPLICIT_PARENT_USAGE_WRITE',result,providerCalls:calls,writeSubmittedAfterParentExpiry:commitAfterExpiry,durableUsageRows:rows,ambientStillValid:ambient.remainingMs()>0}));
 }finally{ambient.cancel();ambient.close();parent.cancel();parent.close();}
});
for(const mode of ['cancel-before','cancel-insert','commit-lost-ack','cancel-commit'])test('F03 composite usage authority '+mode,async t=>{
 const {db,transport}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});
 const controller=new AbortController(),ambient=createExecutionBudget({budgetMs:5000});let calls=0,submitted=false;
 const execute=db.raw.execute;
 if(mode==='cancel-insert')db.raw.execute=async s=>{if(/INSERT INTO ai_usage/.test(s.sql??s)){controller.abort();}return execute(s);};
 if(mode.includes('commit'))transport.arm({matchSql:/INSERT INTO ai_usage/,before:async()=>{submitted=true;if(mode==='cancel-commit')controller.abort();},loseAcknowledgement:mode==='commit-lost-ack'});
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:{},db,userId:'alice',signal:controller.signal,maxRetries:1,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'synthetic'}}],usage:{prompt_tokens:1,completion_tokens:1}}));}});
 if(mode==='cancel-before')controller.abort();
 try {const answer=await withExecutionBudget(ambient,()=>coach.ask({system:'synthetic',user:'synthetic'}));
  const rows=(await db.raw.execute("SELECT count(*) n FROM ai_usage WHERE user_id='alice'")).rows[0].n;
  if(mode.startsWith('cancel'))assert.equal(answer,null);
  if(!mode.includes('commit'))assert.equal(rows,0);
  else {assert.equal(submitted,true);assert.ok(rows===0||rows===1,'unknown COMMIT may be durable; no automatic write replay');}
  assert.equal(calls,mode==='cancel-before'?0:1);
 }finally{ambient.close();}
});
test('F03 explicit parent deadline without a signal aborts a child and rejects a late usage result',async()=>{
 const started=Date.now(),deadlineAt=started+150;
 const parent={deadlineAt,remainingMs:()=>Math.max(0,deadlineAt-Date.now()),assert(){if(Date.now()>=deadlineAt)throw Error('PARENT_EXPIRED');}};
 let usageCalls=0,finish;const held=new Promise(r=>finish=r);
 const coach=createCoach({apiKey:'synthetic',userId:'alice',executionBudget:parent,db:{recordAiUsage:async()=>{usageCalls++;await held;return 1;}},env:{},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'synthetic'}}]}))});
 const answer=await coach.ask({system:'synthetic',user:'synthetic'});assert.equal(answer,null);assert.equal(usageCalls,1);assert.ok(Date.now()-started<500);
 finish();await pause(10);
});
