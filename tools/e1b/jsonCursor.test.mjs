import test from 'node:test';
import assert from 'node:assert/strict';
import {openJsonCursorClient} from './jsonCursor.mjs';
import {exportSelectSnapshot} from './selectSnapshot.mjs';

const origin = new URL('https://synthetic.invalid');
test('locked client negotiates v3 JSON and yields typed rows before the final cursor frame exists', async()=>{
  const paths=[];
  const line = x=>new TextEncoder().encode(JSON.stringify(x)+'\n');
  let controller;
  const fetchImpl=async request=>{
    const path=new URL(request.url).pathname; paths.push(path);
    if(path==='/v3') {
      assert.equal(request.method,'GET');assert.equal(request.headers.has('authorization'),false);
      return new Response('Hrana 3');
    }
    assert.equal(path,'/v3/cursor');assert.equal(request.headers.get('content-type'),'application/json');
    assert.equal(request.headers.get('authorization'),'Bearer fixture');
    const {batch}=await request.json();assert.equal(batch.steps.length,1);assert.equal(batch.steps[0].stmt.sql,'SELECT 1');
    return new Response(new ReadableStream({start(c){
      controller=c;c.enqueue(line({baton:null,base_url:null}));
      c.enqueue(line({type:'step_begin',step:0,cols:[{name:'one'}]}));
      c.enqueue(line({type:'row',row:[{type:'integer',value:'1'}]}));
    }}));
  };
  const client=await openJsonCursorClient(origin,'fixture',fetchImpl),stream=client.openStream();
  try{
    assert.equal(await client.getVersion(),3);
    const cursor=await stream._openCursor({steps:[{stmt:{sql:'SELECT 1',args:[],namedArgs:[],wantRows:true}}]});
    try {
      assert.equal((await cursor.next()).type,'step_begin');assert.deepEqual((await cursor.next()).row,[1n]);
      controller.enqueue(line({type:'step_end',affected_row_count:0})); controller.close();
      assert.equal((await cursor.next()).affectedRowCount,0);assert.equal(await cursor.next(),undefined);
    } finally {cursor.close();}
    assert.deepEqual(paths,['/v3','/v3/cursor']);
  }finally{stream.close();client.close();}
});

test('failed JSON discovery blocks every SQL request and does not create a snapshot',async()=>{
  const calls=[];
  await assert.rejects(exportSelectSnapshot({url:origin.href,token:'fixture',path:'/unused',
    fetchImpl:async(req,init)=>{calls.push([req.method,new URL(req.url).pathname]);assert.equal(init.redirect,'error');return new Response(null,{status:404});},
    onReadStart(){assert.fail('SQL boundary reached');}}),{code:'SNAPSHOT_CURSOR_UNAVAILABLE'});
  assert.deepEqual(calls,[['GET','/v3']]);
});

test('a cross-origin stream base from a valid peer cannot receive a follow-up request or credential',async()=>{
  const origins=[];
  const fake=async(req,init)=>{
    const u=new URL(req.url);origins.push(u.origin);assert.equal(init.redirect,'error');
    if(req.method==='GET')return new Response('Hrana 3');
    const info=await req.json();
    if(info.requests[0].type==='close')return Response.json({baton:null,results:[]});
    // Force a second metadata request with a known table list from the v33 catalog.
    const {ERASURE_TABLES}=await import('../../src/erasureCatalog.js');
    return Response.json({baton:'fixture',base_url:'https://foreign.invalid',results:[{type:'ok',response:{
      type:'execute',result:{cols:[{name:'name'},{name:'sql'}],rows:Object.keys(ERASURE_TABLES).map(name=>[
        {type:'text',value:name},{type:'text',value:''}]),affected_row_count:0}}}]});
  };
  await assert.rejects(exportSelectSnapshot({url:origin.href,token:'fixture',path:'/unused',fetchImpl:fake}),{code:'SNAPSHOT_NETWORK_DENIED'});
  assert.deepEqual(origins,[origin.origin,origin.origin]);
});
