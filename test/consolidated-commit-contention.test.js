import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,fixtureKeys,environment} from './v32ReviewFixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {readExecution} from '../src/phase4ExecutionStore.js';
test('explicit closed HTTP COMMIT rejection remains resumable; fresh owner commits once without replaying uncertain work',async t=>{
 const {db,transport}=await fixture(t),r=request();let attempts=0;
 const deps={runBriefing:async()=>{
  await db.transaction(async()=>{
   attempts++;await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('busy_effect','1','2026-10-10')");
   if(attempts===1)transport.arm({before:()=>{throw Object.assign(Error('explicit commit busy'),{code:'SQLITE_BUSY'});}});
   return 1;
  },{workStep:'definitely-rejected-commit'});
  return {syncComplete:true,syncOutcome:'COMPLETE_SUCCESS',users:0,failed:0};
 }};
 const run=()=>runExecutionPhase({db,request:r,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},deps});
 const first=await run();assert.equal(first.status,202);assert.equal(first.body.result.resumable,true);assert.equal(first.body.drainAuthorized,false);
 assert.equal((await readExecution(db,r.requestId)).state,'ESTABLISHED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='busy_effect'")).rows[0].n,0);
 const second=await run();assert.equal(second.status,200);assert.equal(attempts,2);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='busy_effect'")).rows[0].n,1);
 const replay=await run();assert.deepEqual(replay,second);assert.equal(attempts,2);
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n,1);
});
