import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedHttpLifetime} from '../src/ownedHttpLifetime.js';
import {createDb,stage6OwnedBinding} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const request=()=>new Request('https://isolated.invalid/v2/pipeline',{method:'POST',body:'{"requests":[]}'});

test('initial no-baton fetch stays owned before headers, independent of cancellation',async()=>{
 const headers=deferred(),controller=new AbortController(),owner=createOwnedHttpLifetime(()=>headers.promise);
 const work=owner.fetch(request(),{signal:controller.signal});
 assert.equal(owner.snapshot().pendingFetches,1);controller.abort();
 const early=await owner.join({timeoutMs:5});assert.equal(early.joinCompleted,false);assert.equal(early.pendingFetches,1);
 headers.resolve(new Response('actual body'));const response=await work;
 assert.equal(owner.snapshot().pendingBodies,1);assert.equal(await response.text(),'actual body');
 const final=await owner.join();assert.equal(final.joinCompleted,true);assert.equal(final.providerCompletion,'UNKNOWN');assert.equal(final.healthDisposalAuthorized,false);
});

test('response headers do not close an unread or partially received body',async()=>{
 let source;const owner=createOwnedHttpLifetime(async()=>new Response(new ReadableStream({start(controller){source=controller;}})));
 const response=await owner.fetch(request()),reading=response.text();
 source.enqueue(new TextEncoder().encode('partial'));
 assert.equal((await owner.join({timeoutMs:5})).joinCompleted,false);
 assert.equal(owner.snapshot().pendingBodies,1);source.close();assert.equal(await reading,'partial');
 assert.equal((await owner.join()).joinCompleted,true);
});

test('body cancellation remains live until original cancellation physically settles',async()=>{
 const cancelled=deferred();let entered=false;
 const owner=createOwnedHttpLifetime(async()=>new Response(new ReadableStream({cancel(){entered=true;return cancelled.promise;}})));
 const response=await owner.fetch(request()),closing=response.body.cancel();await tick();assert.equal(entered,true);
 assert.equal((await owner.join({timeoutMs:5})).joinCompleted,false);assert.equal(owner.snapshot().pendingBodies,1);
 cancelled.resolve();await closing;
 const result=await owner.join();assert.equal(result.joinCompleted,true);assert.equal(result.cancellations,1);assert.equal(result.failures,1);assert.equal(result.providerCompletion,'UNKNOWN');
});

test('fetch rejection is latched after a later successful close response',async()=>{
 const failure=Error('ORIGINAL_FETCH_ERROR');let first=true;
 const owner=createOwnedHttpLifetime(()=>{if(first){first=false;throw failure;}return Promise.resolve(new Response('{}'));});
 await assert.rejects(owner.fetch(request()),error=>error===failure);
 await (await owner.fetch(request())).json();const result=await owner.join();
 assert.equal(result.requests,2);assert.equal(result.failures,1);assert.equal(result.joinCompleted,true);assert.equal(result.healthDisposalAuthorized,false);
});

test('body error and HTTP rejection stay latched and retain original error identity',async()=>{
 const failure=Error('ORIGINAL_BODY_ERROR');let source;
 const owner=createOwnedHttpLifetime(async()=>new Response(new ReadableStream({start(controller){source=controller;}}),{status:503}));
 const response=await owner.fetch(request());source.error(failure);
 await assert.rejects(response.text(),error=>error===failure);
 const result=await owner.join();assert.equal(result.failures,1);assert.equal(result.joinCompleted,true);assert.equal(result.providerCompletion,'UNKNOWN');
});

test('a body cancellation rejection is observed and never converted to a successful close',async()=>{
 const failure=Error('ORIGINAL_CANCEL_ERROR');
 const owner=createOwnedHttpLifetime(async()=>new Response(new ReadableStream({cancel(){throw failure;}})));
 const response=await owner.fetch(request());await assert.rejects(response.body.cancel(),error=>error===failure);
 const result=await owner.join();assert.equal(result.failures,1);assert.equal(result.cancellations,1);assert.equal(result.providerCompletion,'UNKNOWN');
});

test('bounded join cancellation leaves the original pending request owned',async()=>{
 const headers=deferred(),controller=new AbortController(),failure=Error('JOIN_CANCELLED'),owner=createOwnedHttpLifetime(()=>headers.promise);
 const work=owner.fetch(request()),joining=owner.join({signal:controller.signal});controller.abort(failure);
 await assert.rejects(joining,error=>error===failure);assert.equal(owner.snapshot().pendingFetches,1);
 headers.resolve(new Response(null,{status:204}));await work;assert.equal((await owner.join()).joinCompleted,true);
});

test('clone retention or malformed JSON cannot acquire provider or disposal authority',async()=>{
 const owner=createOwnedHttpLifetime(async()=>new Response('not json'));
 const response=await owner.fetch(request()),copy=response.clone();
 await assert.rejects(response.json());assert.equal(await copy.text(),'not json');
 const result=await owner.join();assert.equal(result.joinCompleted,true);assert.equal(result.providerCompletion,'UNKNOWN');assert.equal(result.healthDisposalAuthorized,false);
 assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(owner.snapshot()),true);
});

test('join observations are point-in-time and do not authorize later work',async()=>{
 const headers=deferred(),owner=createOwnedHttpLifetime(()=>headers.promise),initial=await owner.join();assert.equal(initial.joinCompleted,true);
 const work=owner.fetch(request());assert.equal(owner.snapshot().requestBodiesJoined,false);assert.equal(initial.healthDisposalAuthorized,false);
 headers.resolve(new Response(null,{status:204}));await work;
 for(const timeoutMs of [0,15001,Infinity,1.5])await assert.rejects(owner.join({timeoutMs}),/JOIN_BOUND/);
});

test('join includes a late initial-response close created while it is waiting',async()=>{
 const initial=deferred(),close=deferred();let calls=0,returned=false;
 const owner=createOwnedHttpLifetime(()=>++calls===1?initial.promise:close.promise);
 const work=owner.fetch(request()).then(async response=>{
  const payload=await response.json();assert.equal(payload.baton,'actual-late-baton');
  return (await owner.fetch(request())).json();
 });
 const joining=owner.join({timeoutMs:1000}).then(value=>{returned=true;return value;});
 initial.resolve(new Response('{"baton":"actual-late-baton"}'));await tick();await tick();
 assert.equal(calls,2);assert.equal(returned,false);assert.equal(owner.snapshot().pendingFetches,1);
 assert.equal((await owner.join({timeoutMs:5})).joinCompleted,false);
 close.resolve(new Response('{"baton":null}'));await work;
 const result=await joining;assert.equal(result.requests,2);assert.equal(result.joinCompleted,true);assert.equal(result.epoch,4);
 assert.equal(result.providerCompletion,'UNKNOWN');assert.equal(result.healthDisposalAuthorized,false);
});

test('a failed late close remains unknown after the request set becomes idle',async()=>{
 let calls=0;const failure=Error('LATE_CLOSE_REJECTED');
 const owner=createOwnedHttpLifetime(async()=>{if(++calls===1)return new Response('{"baton":"late"}');throw failure;});
 const first=await owner.fetch(request());assert.equal((await first.json()).baton,'late');
 await assert.rejects(owner.fetch(request()),error=>error===failure);
 const result=await owner.join();assert.equal(result.joinCompleted,true);assert.equal(result.failures,1);assert.equal(result.providerCompletion,'UNKNOWN');
});

test('owned database uses the same tracker for unbudgeted installed SDK and close-only requests',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'owned-http-')),transport=hranaTransport('file:'+join(dir,'fixture.sqlite'));
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch}),owner=stage6OwnedBinding(db).httpLifetime;
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 assert.deepEqual((await db.raw.execute('SELECT 1 AS value')).rows.map(r=>r.value),[1]);
 assert.equal(owner.snapshot().requests>0,true);
 const tx=await stage6OwnedBinding(db).base.transaction('read');await tx.execute('SELECT 2');const before=owner.snapshot().requests;
 tx.close();await tick();db.close();await tick();const result=await owner.join();
 assert.equal(result.requests>before,true);assert.equal(result.joinCompleted,true);assert.equal(result.failures,0);assert.equal(result.cancellations,0);
 assert.equal(result.providerCompletion,'UNKNOWN');assert.equal(result.healthDisposalAuthorized,false);
});
