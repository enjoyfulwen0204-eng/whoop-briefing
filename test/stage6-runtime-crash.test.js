import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {reconcileExecution} from '../src/phase4ExecutionStore.js';import {verifyShortProof} from './stage6ShortProof.mjs';
test('actual monitored runtime SIGKILL after atomic COMMIT settles exact receipts after process restart',async t=>{
 const dir=await mkdtemp('/private/tmp/whoop-stage6-runtime-crash-'),marker=join(dir,'marker.json');t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.execPath,['--max-old-space-size=128','--max-semi-space-size=4','--experimental-test-isolation=none','--test','test/stage6-runtime-target.test.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,NODE_TEST_CONTEXT:'',STAGE6_RUNTIME_FAULT:'SIGKILL_AFTER',STAGE6_RUNTIME_MARKER:marker},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output=(output+b).slice(-6000));child.stderr.on('data',b=>output=(output+b).slice(-6000));
 const exit=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));assert.equal(exit.signal,'SIGKILL',output);
 const saved=JSON.parse(await readFile(marker,'utf8'));assert.equal(saved.synthetic,true);assert.match(await realpath(saved.path),/^\/private\/var\/folders\/.*\/whoop-stage6-runtime-[^/]+\/fixture.sqlite$|^\/private\/tmp\/whoop-stage6-runtime-[^/]+\/fixture.sqlite$/);t.after(()=>rm(dirname(saved.path),{recursive:true,force:true}));
 const transport=hranaTransport(saved.url,{transactionMaxMs:5000});t.after(()=>transport.close());const fetch=async r=>transport.fetch(r);let db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});t.after(()=>db.close());
 assert.deepEqual((await db.raw.execute('SELECT id,display_name FROM users')).rows.map(r=>[r.id,r.display_name]),[['a','Synthetic']]);
 const before=await reconcileExecution(db,saved.req);assert.equal(before.state,'WORK_COMMITTED_UNFINALIZED');assert.equal(before.receipts.length,5);
 const deadline=(await db.raw.execute({sql:'SELECT deadline_at FROM phase4_executions WHERE execution_id=?',args:[saved.req.requestId]})).rows[0].deadline_at;while(Date.now()<=deadline)await new Promise(r=>setTimeout(r,Math.min(30000,deadline-Date.now()+50)));
 const result=await runExecutionPhase({db,keys:fixtureKeys,request:saved.req,environment:saved.env,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'}});
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.stopReason,'RECONCILIATION_ONLY');
 const f={get db(){return db;},fresh:async()=>{await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});}};const proof=await verifyShortProof(f,{domainOnly:true});
 const permit=JSON.parse((await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail);assert.equal(permit.attempts,1);
 console.log('RUNTIME_SIGKILL_PROOF '+JSON.stringify({signal:exit.signal,reconciled:before.state,settlement:result.body.result.settlementState,permitAttempts:permit.attempts,proof,production:false}));
});
