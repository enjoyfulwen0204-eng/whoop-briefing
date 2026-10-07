import test from 'node:test';import assert from 'node:assert/strict';
import {fork} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb} from './localDb.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-sync-owner-')),url=`file:${join(dir,'isolated.db')}`,db=createDb({url});
 await db.migrate();await db.createUser({id:'synthetic',displayName:'Initial',timezone:'Asia/Taipei',status:'ACTIVE'});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});return {db,url};}
function child(t,url,{budget=1500,delay=0,value='New',lease=1600}={}) {
 const c=fork(new URL('./syncOwnershipChild.js',import.meta.url),[url,String(budget),String(delay),value,String(lease)],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
 const events=[];let output='';c.stdout.on('data',d=>output+=d);c.stderr.on('data',d=>output+=d);c.on('message',m=>events.push(m));
 const exited=new Promise(resolve=>c.on('exit',(code,signal)=>resolve({code,signal,output})));
 t.after(()=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');});
 const wait=async event=>{const end=Date.now()+6000;while(Date.now()<end){const found=events.find(e=>e.event===event);if(found)return found;
  if(c.exitCode!==null||c.signalCode!==null)throw new Error(`child exited before ${event}: ${output}`);await sleep(10);}throw new Error(`child timeout ${event}: ${output}`);};
 return {c,events,wait,exited};
}
test('two OS processes: client stops waiting while server owns scope; overlap rejected, deadline fences late response, legitimate retry',async t=>{
 const {db,url}=await fixture(t),old=child(t,url,{budget:700,delay:1100,value:'Stale',lease:850});await old.wait('entered');
 // Simulated client timeout does not terminate or relinquish the server owner.
 await sleep(40);const overlap=child(t,url,{value:'Overlap'});assert.equal((await overlap.wait('settled')).code,'SYNC_SCOPE_BUSY');await overlap.exited;
 assert.equal((await old.wait('settled')).code,'SYNC_TIMEOUT');
 const retry=child(t,url,{budget:1400,delay:700,value:'Winner',lease:1500});await retry.wait('entered');
 assert.equal((await old.wait('late_rejected')).code,'SYNC_TIMEOUT');
 const lease=(await db.raw.execute("SELECT owner FROM resource_locks WHERE name='phase4:sync:synthetic'")).rows;
 assert.equal(lease.length,1,'old release must not erase successor');
 assert.equal((await retry.wait('settled')).ok,true);
 assert.equal((await old.exited).code,0);assert.equal((await retry.exited).code,0);
 assert.equal((await db.getUser('synthetic')).displayName,'Winner');
});
test('real process death leaves lease; bounded expiry permits safe takeover',async t=>{
 const {db,url}=await fixture(t),old=child(t,url,{budget:800,delay:3000,lease:1000});await old.wait('entered');old.c.kill('SIGKILL');
 assert.equal((await old.exited).signal,'SIGKILL');
 const blocked=child(t,url,{value:'TooEarly'});assert.equal((await blocked.wait('settled')).code,'SYNC_SCOPE_BUSY');await blocked.exited;
 await sleep(1050);const winner=child(t,url,{value:'TakenOver'});assert.equal((await winner.wait('settled')).ok,true);await winner.exited;
 assert.equal((await db.getUser('synthetic')).displayName,'TakenOver');
});

test('expired live owner cannot settle a delayed response or release the successor before its own deadline',async t=>{
 const {db,url}=await fixture(t),old=child(t,url,{budget:4000,delay:1500,lease:600,value:'Stale'});await old.wait('entered');
 await sleep(650);const winner=child(t,url,{budget:3000,delay:1200,lease:3100,value:'Winner'});await winner.wait('entered');
 assert.equal((await old.wait('late_rejected')).code,'SYNC_OWNER_FENCED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name='phase4:sync:synthetic'")).rows[0].n,1);
 assert.equal((await winner.wait('settled')).ok,true);await old.exited;await winner.exited;
 assert.equal((await db.getUser('synthetic')).displayName,'Winner');
});

test('two real HTTP server processes: actual client abort leaves old server fenced; retry overlap cannot write stale state',async t=>{
 const {db,url}=await fixture(t);
 const start=async options=>{
  const c=fork(new URL('./phase4SyncHttpChild.js',import.meta.url),[url,JSON.stringify(options)],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');});const events=[];let output='';
  c.stdout.on('data',d=>output+=d);c.stderr.on('data',d=>output+=d);c.on('message',m=>events.push(m));
  const wait=async event=>{const end=Date.now()+6000;while(Date.now()<end){const e=events.find(x=>x.event===event);if(e)return e;await sleep(10);}throw new Error(`HTTP child ${event}: ${output}`);};
  const listening=await wait('listening');return {c,wait,endpoint:`http://127.0.0.1:${listening.port}/sync`};
 };
 const old=await start({budget:700,delay:1500,lease:850,value:'Stale'}),next=await start({budget:2000,delay:1000,lease:2100,value:'Winner'});
 const controller=new AbortController();const first=fetch(old.endpoint,{method:'POST',signal:controller.signal});
 await old.wait('entered');controller.abort();await assert.rejects(()=>first,e=>e.name==='AbortError');
 const overlap=await fetch(next.endpoint,{method:'POST'});assert.equal(overlap.status,409);await overlap.body.cancel();
 assert.equal((await old.wait('settled')).code,'SYNC_TIMEOUT');
 const retry=fetch(next.endpoint,{method:'POST'});await sleep(1100);
 const response=await retry;assert.equal(response.status,200);await response.body.cancel();
 assert.equal((await old.wait('late_rejected')).code,'SYNC_TIMEOUT');assert.equal((await db.getUser('synthetic')).displayName,'Winner');
 old.c.send('stop');next.c.send('stop');
});
