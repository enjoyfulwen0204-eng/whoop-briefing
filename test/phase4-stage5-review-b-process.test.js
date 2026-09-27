import test from 'node:test';
import assert from 'node:assert/strict';
import { fork,spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb,fixtureKeys } from './localDb.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { bodyInput,seedBodyInput } from './bodyEnergyFixture.js';
import { T } from './stage5ReviewBFixture.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const temporary=(t,prefix)=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
function worker(t,url,role) {
  const child=fork(new URL('./stage5ReviewBProcess.js',import.meta.url),[url,role],{execArgv:['--expose-gc'],silent:true});
  const messages=[],waiters=[],chunks=[];
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
  child.on('message',value=>{messages.push(value);for(const notify of waiters)notify();});
  let outcome;
  const closed=new Promise(resolve=>child.on('close',(code,signal)=>{outcome={code,signal,output:Buffer.concat(chunks).toString()};for(const notify of waiters)notify();resolve(outcome);}));
  t.after(()=>{if(!outcome)child.kill('SIGKILL');});
  const wait=kind=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`WORKER_TIMEOUT:${kind}`)),30000);
    const check=()=>{const value=messages.find(value=>value.kind===kind),error=messages.find(value=>value.kind==='error');
      if(value||error||outcome){clearTimeout(timer);if(value)resolve(value);else reject(Error(JSON.stringify(error??outcome)));}};
    waiters.push(check);check();
  });
  return {child,messages,wait,closed};
}

test('M003/N: equivalent normal-driver processes contend, replay one receipt and release every completed lease',async t=>{
  const dir=temporary(t,'stage5-review-b-race-'),url=`file:${path.join(dir,'fixture.db')}`,db=createDb({url});
  t.after(()=>db.close());await db.migrate();await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:new Date(T)});
  const stores=await createPhase4Foundation({db,keys:fixtureKeys,now:()=>new Date(T)});await stores.initializeTenant('a','SHADOW');
  const input=bodyInput({asOf:Date.parse(T),days:30});
  input.sources.recovery.forEach((row,index)=>{row.recovery_score=index===0?15:[40,45,50,55,60][(index-1)%5];});
  await db.transaction(()=>seedBodyInput(db,input));
  const holder=worker(t,url,'holder'),contender=worker(t,url,'contender');
  await Promise.all([holder.wait('initialized'),contender.wait('initialized')]);
  holder.child.send('capture');contender.child.send('capture');
  await Promise.all([holder.wait('ready'),contender.wait('ready')]);
  holder.child.send('go');await holder.wait('locked');contender.child.send('go');
  await contender.wait('busy');holder.child.send('continue');
  const results=await Promise.all([holder.wait('result'),contender.wait('result')]);assert.deepEqual(results[0],results[1]);
  for(const outcome of await Promise.all([holder.closed,contender.closed]))assert.deepEqual({code:outcome.code,signal:outcome.signal},{code:0,signal:null},outcome.output);
  const expected={evidence_runs:1,evidence_items:1,observation_episodes:1,phase4_episode_revisions:1,episode_events:1,insight_revisions:0,resource_locks:0};
  for(const [table,count] of Object.entries(expected))assert.equal((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,count,table);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n,1);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'")).rows[0].n,1);
  assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  assert.ok(contender.messages.some(value=>value.kind==='busy'));
});

test('T001: timeout runner kills its test worker and grandchild, reports TIMEOUT',async t=>{
  const dir=temporary(t,'stage5-review-b-timeout-');fs.mkdirSync(path.join(dir,'test'));
  fs.writeFileSync(path.join(dir,'test/hang.test.js'),`const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const output=path.join(dir,'results'),runner=spawn(process.execPath,[path.join(root,'scripts/test-stage5-closure.mjs'),'test/hang.test.js'],
    {cwd:dir,env:{...process.env,STAGE5_TEST_OUTPUT:output,STAGE5_TEST_TIMEOUT_MS:'1500'},stdio:['ignore','pipe','pipe']});
  const chunks=[];runner.stdout.on('data',chunk=>chunks.push(chunk));runner.stderr.on('data',chunk=>chunks.push(chunk));
  t.after(()=>runner.kill('SIGKILL'));
  const outcome=await new Promise(resolve=>runner.on('close',(code,signal)=>resolve({code,signal})));
  assert.deepEqual(outcome,{code:1,signal:null},Buffer.concat(chunks).toString());
  const results=JSON.parse(fs.readFileSync(path.join(output,'results.json')));assert.equal(results[0].classification,'TIMEOUT');
  const pids=JSON.parse(fs.readFileSync(path.join(dir,'pids.json')));assert.equal(pids.length,2);
  // Give the OS reaper a bounded chance to remove the killed descendants.
  for(const pid of pids) {
    let exists=true;
    for(let attempt=0;attempt<40;attempt++) {
      try {process.kill(pid,0);}catch(error){assert.equal(error.code,'ESRCH');exists=false;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(exists,false,`orphan ${pid}`);
  }
});
