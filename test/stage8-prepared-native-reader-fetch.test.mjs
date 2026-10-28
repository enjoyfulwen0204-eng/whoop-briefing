// Exercise the worker's EXACT fetch wrapper without evaluating its Linux
// workload. The production transport function is not copied into a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
const source=readFileSync(new URL('./stage8-prepared-native-reader.mjs',import.meta.url),'utf8'),start=source.indexOf('const fetchOwned=async(input,init)=>{'),end=source.indexOf('globalThis.fetch=fetchOwned;',start);
assert.ok(start>=0&&end>start);
function fixture({submitted=()=>({}),acknowledged=()=>{},network=async()=>new Response(JSON.stringify({results:[]}))}={}){
 let networkCalls=0;
 return compileFunction("let requests=0,pending=0,errors=0,requestErrors=0,phase='SYNTHETIC';\n"+source.slice(start,end)+"\nreturn {fetch:fetchOwned,counts:()=>({requests,pending,errors,requestErrors})};",['assert','observer','nativeFetch','url','performance','Request','URL','AbortSignal'])(assert,{submitted,acknowledged},(...args)=>{networkCalls++;return network(...args);},'http://127.0.0.1:18083',performance,Request,URL,AbortSignal);
}
const request=()=>new Request('http://127.0.0.1:18083/v2/pipeline',{method:'POST',body:'{"requests":[]}'});
for(const kind of ['CONSTRUCT','ORIGIN','DECODE','SUBMITTED','NETWORK','ACK_DECODE','ACK_OBSERVER'])test('actual native fetch wrapper permanently latches '+kind+' failure and settles pending',async()=>{
 const f=fixture({...(kind==='SUBMITTED'?{submitted:()=>{throw Error('SUBMITTED_FAILURE');}}:{}),...(kind==='NETWORK'?{network:async()=>{throw Error('NETWORK_FAILURE');}}:{}),...(kind==='ACK_DECODE'?{network:async()=>new Response('{')}:{}),...(kind==='ACK_OBSERVER'?{acknowledged:()=>{throw Error('ACK_OBSERVER_FAILURE');}}:{})});
 const input=kind==='CONSTRUCT'?'bad-url':kind==='ORIGIN'?'http://127.0.0.1:19999/':kind==='DECODE'?new Request('http://127.0.0.1:18083/',{method:'POST',body:'{'}):request();
 await assert.rejects(f.fetch(input));assert.equal(f.counts().requestErrors,1);assert.equal(f.counts().pending,0);
 // A later successful request cannot reset the prior failure latch.
 if(['CONSTRUCT','ORIGIN','DECODE'].includes(kind)){await f.fetch(request());assert.equal(f.counts().requestErrors,1);}
});
test('pending starts BEFORE asynchronous request decoding and ends only after response ACK parsing',async()=>{
 const f=fixture();let controller;const body=new ReadableStream({start(value){controller=value;}}),req=new Request('http://127.0.0.1:18083/v2/pipeline',{method:'POST',body,duplex:'half'}),pending=f.fetch(req);
 assert.equal(f.counts().pending,1);assert.equal(f.counts().requests,0);
 controller.enqueue(new TextEncoder().encode('{"requests":[]}'));controller.close();await pending;
 assert.deepEqual(f.counts(),{requests:1,pending:0,errors:0,requestErrors:0});
});
