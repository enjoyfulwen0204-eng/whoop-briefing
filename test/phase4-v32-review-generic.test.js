import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';
import {fixture,request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {readExecution,reconcileExecution} from '../src/phase4ExecutionStore.js';
const context=c=>({claim:c,keys:fixtureKeys,pending:new Set(),authority});
const expire=(db,r)=>db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,r.requestId]});
test('generic work without a deterministic step identity fails before a mutation, never silently replays',async t=>{
 const {db}=await fixture(t),r=request(),c=await claim(db,r);
 await assert.rejects(()=>withDurableExecution(context(c),()=>db.transaction(()=>db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('unkeyed','1','2026-10-08')"))),/WORK_STEP_REQUIRED/);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='unkeyed'")).rows[0].n,0);
});
function child(url,r,mode){const c=fork(new URL('./v32ReviewProcess.js',import.meta.url),[url,JSON.stringify(r),mode],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});
 let log='';c.stdout.on('data',v=>log+=v);c.stderr.on('data',v=>log+=v);const result=new Promise(resolve=>c.on('message',v=>resolve(v))),exit=new Promise(resolve=>c.on('exit',(code,signal)=>resolve({code,signal,log})));return {c,result,exit};}
test('generic named step: safe scalar receipt, no callback replay under repeated ACK loss/takeover, distinct steps remain distinct',async t=>{
 const {db,transport}=await fixture(t),r=request();let c=await claim(db,r),callbacks=0;
 const operation=step=>withDurableExecution(context(c),()=>db.transaction(async()=>{callbacks++;await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('counter','1','2026-10-08') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");return 7;},{workStep:step}));
 transport.arm({loseAcknowledgement:true});await assert.rejects(()=>operation('counter-A'),/COMMIT_INDETERMINATE/);
 assert.equal((await reconcileExecution(db,r)).state,'WORK_COMMITTED_UNFINALIZED');
 for(let i=0;i<3;i++){await expire(db,r);c=await claim(db,r);assert.equal(await operation('counter-A'),7);}
 assert.equal(callbacks,1);assert.equal(Number((await db.raw.execute("SELECT value FROM telegram_state WHERE key='counter'")).rows[0].value),1);
 assert.equal(await operation('counter-B'),7);assert.equal(callbacks,2);
 const rows=(await db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows;
 assert.equal(rows.length,2);assert.notEqual(rows[0].receipt_key,rows[1].receipt_key);
 for(const row of rows){await assert.rejects(()=>db.raw.execute({sql:'DELETE FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[row.receipt_key]}));await assert.rejects(()=>db.raw.execute({sql:'UPDATE phase4_execution_work_receipts SET generation=generation+1 WHERE receipt_key=?',args:[row.receipt_key]}));}
});
test('definitely failed generic business work has no receipt, retries once; unsafe result cannot persist payload',async t=>{
 const {db}=await fixture(t),r=request(),c=await claim(db,r);
 await assert.rejects(()=>withDurableExecution(context(c),()=>db.transaction(async()=>{await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('failed_work','1','2026-10-08')");throw Error('DEFINITE_FAILURE');},{workStep:'failed-counter'})));
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='failed_work'")).rows[0].n,0);
 assert.equal((await reconcileExecution(db,r)).state,'NOT_COMMITTED');
 await assert.rejects(()=>withDurableExecution(context(c),()=>db.transaction(async()=>{await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('unsafe_result','1','2026-10-08')");return {health:'private'};},{workStep:'unsafe'})),/RESULT_UNSAFE/);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='unsafe_result'")).rows[0].n,0);
});
test('real process SIGKILL after committed work preserves deterministic receipt; expired retry returns result without duplicate effect',async t=>{
 const {db,url}=await fixture(t),r=request(),p=child(url,r,'work-death');t.after(()=>p.c.kill('SIGKILL'));
 assert.equal((await p.result).event,'barrier');p.c.kill('SIGKILL');assert.equal((await p.exit).signal,'SIGKILL');
 assert.equal((await reconcileExecution(db,r)).state,'WORK_COMMITTED_UNFINALIZED');
 await new Promise(resolve=>setTimeout(resolve,2100));
 const retry=child(url,r,'work'),out=await retry.result,exit=await retry.exit;assert.equal(exit.code,0,exit.log);assert.equal(out.result,1);
 assert.equal(Number((await db.raw.execute("SELECT value FROM telegram_state WHERE key='generic_process_counter'")).rows[0].value),1);
});
test('two real processes racing one expired logical step produce exactly one effect and one receipt',async t=>{
 const {db,url}=await fixture(t),r=request();await claim(db,r);await expire(db,r);
 const a=child(url,r,'work'),b=child(url,r,'work'),results=await Promise.all([a.result,b.result]),exits=await Promise.all([a.exit,b.exit]);
 assert.equal(results.filter(x=>x.result===1).length,1,JSON.stringify({results,exits}));
 assert.equal(results.filter(x=>x.code==='REQUEST_PENDING').length,1,JSON.stringify({results,exits}));
 assert.equal(Number((await db.raw.execute("SELECT value FROM telegram_state WHERE key='generic_process_counter'")).rows[0].value),1);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
});
test('two-process monotonic allocation, killed uncommitted allocation, retry, and immutable order',async t=>{
 const {db,url}=await fixture(t),ra=request(),rb=request(),a=child(url,ra,'claim'),b=child(url,rb,'claim');
 const [ar,br]=await Promise.all([a.result,b.result]);for(const e of await Promise.all([a.exit,b.exit]))assert.equal(e.code,0,e.log);
 assert.notEqual(ar.sequence,br.sequence);const high=Math.max(ar.sequence,br.sequence);
 const killed=request(),p=child(url,killed,'allocation-death');t.after(()=>p.c.kill('SIGKILL'));assert.equal((await p.result).event,'barrier');p.c.kill('SIGKILL');assert.equal((await p.exit).signal,'SIGKILL');
 assert.equal(await readExecution(db,killed.requestId),null);
 const retry=child(url,killed,'claim'),result=await retry.result;assert.equal((await retry.exit).code,0);assert.ok(result.sequence>high);
 assert.equal((await readExecution(db,ra.requestId)).execution_seq,ar.sequence);
});
