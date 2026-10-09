import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('SIGKILL during a Coach body read ends provider work without a retry or accepted result',async t=>{
 const coachUrl=new URL('../src/coach.js',import.meta.url).href;
 const program=`
  import {createCoach} from ${JSON.stringify(coachUrl)};
  const keepAlive=setInterval(()=>{},1000);
  const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:{},maxRetries:3,backoffFor:()=>0,
   fetchImpl:async()=>{process.send({event:'request'});return {ok:true,status:200,headers:new Headers(),
    body:new ReadableStream({start(){process.send({event:'body'});}})};}});
  await coach.ask({system:'synthetic',user:'synthetic'});process.send({event:'accepted'});clearInterval(keepAlive);
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe','ipc']});
 const events=[];let stderr='';child.stderr.on('data',v=>stderr+=v);
 const exit=once(child,'exit');t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('CHILD_BODY_NOT_ENTERED:'+stderr)),5000);
  child.on('message',v=>{events.push(v.event);if(v.event==='body'){clearTimeout(timer);resolve();}});
  child.once('error',e=>{clearTimeout(timer);reject(e);});
 });
 child.kill('SIGKILL');const [code,signal]=await exit;
 assert.equal(code,null);assert.equal(signal,'SIGKILL');
 assert.deepEqual(events,['request','body']);assert.equal(stderr,'');
});
