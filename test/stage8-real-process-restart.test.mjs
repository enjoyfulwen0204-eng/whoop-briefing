import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function child(mode,path){return new Promise((resolve,reject)=>{
 const processChild=spawn(process.execPath,[new URL('./stage8RestartChild.mjs',import.meta.url).pathname,mode,path],{env:{PATH:process.env.PATH,...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})},stdio:['ignore','pipe','pipe']});let output='';
 const timer=setTimeout(()=>processChild.kill('SIGKILL'),45000);
 const collect=part=>{output=(output+part).slice(-100000);};processChild.stdout.on('data',collect);processChild.stderr.on('data',collect);processChild.on('error',reject);
 processChild.on('close',(code,signal)=>{clearTimeout(timer);const line=output.split('\n').filter(line=>line.startsWith('RESTART_CHILD_RESULT ')).at(-1);const value=line?JSON.parse(line.slice('RESTART_CHILD_RESULT '.length)):null;
  console.log('REAL_RESTART_CHILD '+JSON.stringify({mode,pid:processChild.pid,code,signal,value}));resolve({code,signal,value,output});});
});}
const workCounts=value=>[value.phase4_executions,value.stage8_live_executions,value.stage8_live_execution_work_receipts,value.completedJobs];
test('kernel SIGKILL after finalized LIVE work replays the original signed child across real process restarts and natural lease expiry',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stage8-real-restart-')),path=join(directory,'fixture.sqlite'),pids=new Set();
 try{
  const crashed=await child('CRASH',path);pids.add(crashed.value?.pid);assert.equal(crashed.signal,'SIGKILL',crashed.output);assert.equal(crashed.value?.kind,'BEFORE_PROGRESS_SIGKILL');
  const original=crashed.value.counts;assert.equal(original.phase4_executions,1);assert.ok(original.stage8_live_execution_work_receipts>0);
  const busy=await child('RESUME',path);pids.add(busy.value?.pid);assert.equal(busy.code,0,busy.output);assert.equal(busy.value.result.status,'BUSY');assert.deepEqual(workCounts(busy.value.counts),workCounts(original));
  const expiry=Date.parse(original.subjectLockExpiry);assert.ok(Number.isFinite(expiry)&&expiry>Date.now());assert.ok(expiry-Date.now()<=60000);
  while(Date.now()<=expiry)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,expiry-Date.now()+1)));
  const replay=await child('RESUME',path);pids.add(replay.value?.pid);assert.equal(replay.code,0,replay.output);assert.equal(replay.value.result.replayed,true);assert.deepEqual(workCounts(replay.value.counts),workCounts(original));
  let last=replay.value;
  for(let leg=0;leg<32&&last.result.status!=='CURRENT';leg++){
   const next=await child('RESUME',path);assert.equal(next.code,0,next.output);pids.add(next.value.pid);last=next.value;assert.equal(last.counts.phase4_executions,1);
  }
  assert.equal(last.result.status,'CURRENT');assert.equal(last.counts.completedJobs,2);
  const idle=await child('RESUME',path);assert.equal(idle.code,0,idle.output);pids.add(idle.value.pid);assert.deepEqual(idle.value.result,{status:'IDLE',invoked:0});assert.deepEqual(workCounts(idle.value.counts),workCounts(last.counts));
  assert.ok(pids.size>=5);console.log('REAL_PROCESS_RESTART_PASS '+JSON.stringify({processes:pids.size,syncExecutions:last.counts.phase4_executions,receipts:last.counts.stage8_live_execution_work_receipts,originalLeaseWait:true,noClockOrLeaseReset:true,production:false}));
 }finally{await rm(directory,{recursive:true,force:true});}
});
