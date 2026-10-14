import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';
import {liveDrainGroupMembers} from '../src/drainChildSupervisor.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const kind of ['disconnect-before-start','SIGTERM-graceful','SIGKILL-group'])test(kind,{skip:process.platform!=='linux'},async()=>{
 const at=performance.now(),child=fork(new URL('./stage6DrainControlChild.mjs',import.meta.url),[],{detached:true,execArgv:[],stdio:['ignore','ignore','ignore','ipc','pipe']});
 let fallback,deadline,progress,exitCode,exitSignal,descendant;
 const ended=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>{exitCode=code;exitSignal=signal;child.stdio[4].destroy();resolve();});child.once('error',reject);deadline=setTimeout(()=>reject(Error('BOUNDED_PROCESS_EXIT_REQUIRED')),7000);});
 child.on('message',p=>{assert.equal(p.pid,child.pid);assert.equal(p.parentPid,process.pid);
  if(p.type==='ready'){
   if(kind==='disconnect-before-start'){child.stdio[4].destroy();child.disconnect();return;}
   child.send({type:'start',nonce:'a'.repeat(64),parentPid:process.pid,mode:kind==='SIGKILL-group'?'blocked':'graceful'});
  }
  if(p.type==='progress'){progress=p.stage;child.stdio[4].destroy();child.kill('SIGTERM');if(kind==='SIGKILL-group'){descendant=Number(p.stage.split('_')[1]);fallback=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}},500);}}
 });
 try{await ended;for(let n=0;liveDrainGroupMembers(child.pid).length&&n<50;n++)await pause(20);assert.deepEqual(liveDrainGroupMembers(child.pid),[]);
  assert.ok(performance.now()-at<6500);if(kind==='SIGKILL-group'){assert.ok(descendant);assert.equal(exitSignal,'SIGKILL');}else assert.equal(exitCode,0);
  console.log('PROCESS_CONTROL '+JSON.stringify({kind,progress,exitCode,exitSignal,elapsedMs:performance.now()-at,noLiveProcessGroup:true}));
 }finally{clearTimeout(deadline);clearTimeout(fallback);if(liveDrainGroupMembers(child.pid).length)try{process.kill(-child.pid,'SIGKILL');}catch{}}
});
