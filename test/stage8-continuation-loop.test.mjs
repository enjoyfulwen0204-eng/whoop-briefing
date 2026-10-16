import test from 'node:test';
import assert from 'node:assert/strict';
import {createStage8ContinuationLoop,STAGE8_CONTINUATION_TICK_MS} from '../src/stage8ContinuationLoop.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function scheduler(){let next=1;const tasks=new Map();return {tasks,timers:{set(fn,ms){assert.equal(ms,2000);const id=next++;tasks.set(id,fn);return id;},clear(id){tasks.delete(id);}},fire(){assert.equal(tasks.size,1);const [id,fn]=tasks.entries().next().value;tasks.delete(id);fn();}};}
test('server loop never overlaps work and shutdown joins the actual in-flight promise before DB close',async()=>{
 const s=scheduler(),entered=deferred(),finish=deferred();let calls=0,closed=false;
 const loop=createStage8ContinuationLoop({timers:s.timers,resume:async()=>{calls++;entered.resolve();await finish.promise;assert.equal(closed,false);}});
 loop.start();loop.start();assert.equal(s.tasks.size,1);s.fire();await entered.promise;assert.equal(s.tasks.size,0);
 let stopped=false;const stopping=loop.stop().then(()=>{stopped=true;closed=true;});await Promise.resolve();assert.equal(stopped,false);
 finish.resolve();await stopping;assert.equal(calls,1);assert.equal(s.tasks.size,0);assert.equal(closed,true);
 loop.start();assert.equal(s.tasks.size,0,'one server lifetime cannot accidentally restart a stopped loop');
});
test('a queued tick stopped before entry performs no continuation and leaves no scheduled callback',async()=>{
 const s=scheduler();let calls=0;const loop=createStage8ContinuationLoop({timers:s.timers,resume:async()=>{calls++;}});
 loop.start();s.fire();await loop.stop();assert.equal(calls,0);assert.equal(s.tasks.size,0);assert.equal(STAGE8_CONTINUATION_TICK_MS,2000);
});
test('a rejected tick is observed once and schedules only one later bounded attempt',async()=>{
 const s=scheduler(),seen=[],done=deferred();let calls=0;
 const loop=createStage8ContinuationLoop({timers:s.timers,resume:async()=>{calls++;if(calls===1)throw Error('FENCED');done.resolve();},onError:e=>seen.push(e.message)});
 loop.start();s.fire();for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(seen,['FENCED']);assert.equal(s.tasks.size,1);
 s.fire();await done.promise;await loop.stop();assert.equal(calls,2);assert.equal(s.tasks.size,0);
});
