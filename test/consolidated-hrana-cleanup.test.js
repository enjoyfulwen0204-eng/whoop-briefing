import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {createDb} from '../src/db.js';import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {hranaTransport} from './hranaTransport.js';import {closeOnlyPayload} from '../src/hranaCleanup.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const mode of ['lost-BEGIN-ack','known-baton-statement'])test('Hrana cancellation releases '+mode+' without SQL cleanup authority',async t=>{
 const {url}=await deliveryFixture(t),transport=hranaTransport(url),events=[];let armed=false,delayed=false;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  const payload=await request.clone().json();events.push({at:Date.now(),payload});
  const response=await transport.fetch(request);
  const sql=JSON.stringify(payload);
  if(armed&&!delayed&&(mode==='lost-BEGIN-ack'?sql.includes('BEGIN'):sql.includes('SELECT 222'))){delayed=true;await pause(150);}
  return response;
 }});t.after(()=>{db.close();transport.close();});await db.admitRuntime();
 const budget=createExecutionBudget({budgetMs:60});armed=true;let callback=false;
 await assert.rejects(()=>budget.run(()=>db.transaction(async()=>{callback=true;await db.raw.execute('SELECT 222');await db.raw.execute("INSERT INTO telegram_state VALUES('forbidden','health','2026-10-10')");})),/SYNC_TIMEOUT/);const ended=budget.deadlineAt;budget.close();
 await pause(250);assert.equal(delayed,true);assert.equal(callback,mode!=='lost-BEGIN-ack');
 await db.transaction(()=>db.raw.execute("INSERT INTO telegram_state VALUES('fresh','allowed','2026-10-10')"));
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='forbidden'")).rows[0].n,0);
 const closed=events.filter(e=>closeOnlyPayload(e.payload));assert.ok(closed.length>0,'known or late-issued baton is closed');
 assert.ok(closed.every(e=>e.payload.requests.every(r=>r.type==='close'&&Object.keys(r).length===1)));
 assert.ok(!events.some(e=>e.at>=ended&&/INSERT INTO telegram_state.*forbidden/.test(JSON.stringify(e.payload))));
});
test('Hrana cleanup payload cannot smuggle SQL, COMMIT, another command or a new stream',()=>{
 assert.ok(closeOnlyPayload({baton:'owned',requests:[{type:'close'}]}));
 for(const p of [{requests:[{type:'close'}]},{baton:'owned',requests:[{type:'execute',stmt:{sql:'COMMIT'}}]},
 {baton:'owned',requests:[{type:'close',sql:'COMMIT'}]},{baton:'owned',requests:[{type:'close'},{type:'execute'}]},
 {baton:'owned',requests:[{type:'close'}],sql:'COMMIT'}])assert.ok(!closeOnlyPayload(p));
});
