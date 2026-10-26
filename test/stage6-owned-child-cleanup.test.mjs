import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createOwnedChildCleanup} from './stage6-owned-child-cleanup.mjs';
function model(group=false){
 const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:null,signalCode:null}),signals=[],timers=new Map();let id=0,time=0;
 const lifecycle=createOwnedChildCleanup(child,{send:(...args)=>signals.push(args),after:(fn,ms)=>{const n=++id;timers.set(n,{fn,ms});return n;},cancel:n=>timers.delete(n),now:()=>time,pause:async ms=>{time+=ms;},groupAlive:()=>group});
 return {child,signals,timers,lifecycle,fire(ms){for(const [n,timer]of [...timers])if(timer.ms===ms){timers.delete(n);timer.fn();}}};
}
test('overflow, repeated signals and timeout create one TERM and at most one KILL',async()=>{
 const m=model();try{m.lifecycle.stop();m.lifecycle.stop();m.lifecycle.stop();assert.equal(m.timers.size,2);m.fire(5000);m.lifecycle.stop();assert.deepEqual(m.signals,[[-12345,'SIGTERM'],[-12345,'SIGKILL']]);m.child.emit('exit',null,'SIGKILL');m.child.emit('close',null,'SIGKILL');assert.equal(await m.lifecycle.waitClosed(),true);assert.equal(await m.lifecycle.waitGroupAbsent(),true);assert.equal(m.timers.size,0);}finally{m.lifecycle.dispose();}
});
test('even a queued stale KILL callback cannot signal after leader exit or physical close',()=>{
 const m=model();try{m.lifecycle.stop();const late=[...m.timers.values()].find(t=>t.ms===5000).fn;m.child.emit('exit',0,null);late();m.child.emit('close',0,null);late();m.lifecycle.stop();assert.deepEqual(m.signals,[[-12345,'SIGTERM']]);assert.equal(m.timers.size,0);}finally{m.lifecycle.dispose();}
});
test('an unknown surviving group fails bounded join and requires preserving its directory',async()=>{
 const m=model(null);try{m.child.emit('exit',0,null);m.child.emit('close',0,null);assert.equal(await m.lifecycle.waitClosed(),true);assert.equal(await m.lifecycle.waitGroupAbsent(),false);assert.deepEqual(m.signals,[]);const preserveDirectory=!(m.lifecycle.status().closed&&await m.lifecycle.waitGroupAbsent());assert.equal(preserveDirectory,true);}finally{m.lifecycle.dispose();}
});
test('missing physical close remains UNKNOWN after cleanup expiry, never a successful terminal',async()=>{
 const m=model();try{m.lifecycle.stop();m.fire(5000);m.fire(15000);assert.equal(await m.lifecycle.waitClosed(),false);assert.equal(m.lifecycle.status().closed,false);assert.equal(m.signals.length,2);}finally{m.lifecycle.dispose();}assert.equal(m.timers.size,0);
});
