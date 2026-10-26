// Explicit synthetic Linux fixture. Clone the fresh fixture's exact schema and
// typed rows into the pinned owned SQLD, then use its real Hrana HTTP endpoint.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
import {createClient} from '@libsql/client';
import {exactRealStatement} from '../src/exactRealStatement.js';
import {createDiagnosticFetch} from './stage6-native-diagnostic-observer.mjs';
import {awaitNativeTraceJoined,assertNativeObservedTransactions,nativeTraceSummary,throwNativeCloseFailures} from './stage6ShadowNativeTrace.mjs';
const {PipelineRespBody}=await import(new URL('./http/json_decode.js',import.meta.resolve('@libsql/hrana-client')));
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function rethrowNativeSetupFailure(original,cleanup){
 try{await cleanup();}catch(error){throw new AggregateError([original,error],'SYNTHETIC_NATIVE_SETUP_AND_CLEANUP_FAILED',{cause:original});}
 throw original;
}

export async function nativeShadowFixture(f){
 assert.equal(process.platform,'linux');assert.equal(process.env.STAGE6_SHADOW_NATIVE_SQLD,'1');
 assert.equal(f.synthetic,true);assert.deepEqual((await f.db.raw.execute('SELECT id,display_name FROM users ORDER BY id')).rows.map(r=>[r.id,r.display_name]),[['a','Synthetic']]);
 const version=execFileSync('/usr/local/bin/isolated-sqld',['--version'],{encoding:'utf8',timeout:2000}).trim();
 assert.equal(version,'sqld sqld 0.24.33 (40a151bd 2025-12-19)');
 const directory=await mkdtemp(join(tmpdir(),'shadow-native-sqld-')),base='http://127.0.0.1:18080';
 const server=spawn('/usr/local/bin/isolated-sqld',['-d',join(directory,'physical'),'--http-listen-addr','127.0.0.1:18080','--no-welcome'],{stdio:['ignore','pipe','pipe']});
 let logBytes=0;for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{logBytes+=b.length;});
 let serverClosed=false,serverError=false;const terminal=new Promise(resolve=>{server.once('error',()=>{serverError=true;});server.once('close',(code,signal)=>{serverClosed=true;resolve({code,signal});});});
 let client,closed=false,runtimeUsed=false;
 const trace=createDiagnosticFetch({fetch:request=>{
  assert.equal(new URL(request.url).origin,base);
  return fetch(request,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)]),redirect:'error'});
 },decodePipelineReply:PipelineRespBody});
 const close=async()=>{
  if(closed)return;closed=true;client?.close();
  let joined,joinError;
  try{joined=await awaitNativeTraceJoined(trace);if(runtimeUsed)assertNativeObservedTransactions(joined);}catch(error){joinError=error;}
  let forced=false,observed=null,shutdownError;
  try{
   if(!serverClosed){server.kill('SIGTERM');await Promise.race([terminal,pause(3000)]);}
   if(!serverClosed){forced=true;server.kill('SIGKILL');await Promise.race([terminal,pause(3000)]);}
   assert.ok(serverClosed,'owned SQLD must physically close');observed=await terminal;
   await rm(directory,{recursive:true,force:true});
   assert.equal(forced,false,'normal SQLD shutdown must be observed');assert.equal(serverError,false);
   assert.ok(observed.code===0||observed.signal==='SIGTERM','owned SQLD must terminate normally');
  }catch(error){shutdownError=error;}
  console.log('SYNTHETIC_SHADOW_NATIVE_SERVER_TERMINAL '+JSON.stringify({version,terminal:observed,serverError,forced,logBytes,closed:serverClosed,httpTransportTerminal:joined?'OBSERVED_JOINED':'UNRESOLVED',allHranaStreamsJoined:Boolean(joined),trace:nativeTraceSummary(joined??trace.snapshot()),joinFailure:joinError?(joinError.message==='SYNTHETIC_NATIVE_STREAMS_NOT_JOINED'?'STREAMS_NOT_JOINED':'OBSERVED_TRANSACTION_CONTRACT_FAILED'):null,shutdownFailure:shutdownError?'OWNED_NATIVE_SHUTDOWN_FAILED':null,productionEvidence:false}));
  throwNativeCloseFailures(joinError,shutdownError);
 };
 try{
  // Startup probes open no Hrana stream or SQL transaction. Physically join
  // each TCP probe before observing every subsequent SQLD HTTP request.
  let ready=false;const deadline=performance.now()+6000;
  while(performance.now()<deadline&&!serverClosed){
   ready=await new Promise(resolve=>{
    let connected=false;const socket=createConnection({host:'127.0.0.1',port:18080});
    socket.once('connect',()=>{connected=true;socket.destroy();});
    socket.once('error',()=>socket.destroy());socket.setTimeout(500,()=>socket.destroy());
    socket.once('close',()=>resolve(connected));
   });
   if(ready)break;await pause(100);
  }
  assert.ok(ready&&!serverError,'fresh owned SQLD must accept the loopback socket');
  client=createClient({url:base,fetch:(request,init)=>{
   const url=new URL(request instanceof Request?request.url:request);assert.equal(url.origin,base);
   return trace.fetch(request,init);
  }});
  assert.equal((await client.execute('SELECT 1 n')).rows[0].n,1);
  const schema=(await f.db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger') ORDER BY type,name")).rows;
  assert.ok(schema.filter(r=>r.type==='table').length<=128);
  const descriptors=[];
  for(const table of schema.filter(r=>r.type==='table')){
   const info=(await f.db.raw.execute(`PRAGMA table_info(${quote(table.name)})`)).rows,columns=info.map(r=>r.name),primary=info.filter(r=>r.pk).sort((a,b)=>a.pk-b.pk).map(r=>r.name),order=(primary.length?primary:columns).map(quote).join(',');
   const query=`SELECT ${columns.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY ${order}`,rows=(await f.db.raw.execute(query)).rows.map(r=>columns.map(c=>r[c]));
   assert.ok(rows.length<=16000);
   assert.ok(rows.every(r=>r.every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v))));
   descriptors.push({table:table.name,columns,query,rows});
  }
  assert.ok(Buffer.byteLength(JSON.stringify(descriptors))<=16*1024*1024);
  await client.batch(schema.filter(r=>r.type==='table').map(r=>r.sql),'write');
  const inserts=descriptors.flatMap(d=>d.rows.map(row=>exactRealStatement({sql:`INSERT INTO ${quote(d.table)}(${d.columns.map(quote).join(',')}) VALUES(${row.map(()=>'?').join(',')})`,args:row})));
  // Defer only within this one seed transaction; HTTP connection reuse must
  // never be relied on to carry a foreign_keys=OFF setting between requests.
  if(inserts.length)await client.batch(['PRAGMA defer_foreign_keys=ON',...inserts],'write');
  await client.batch(schema.filter(r=>r.type!=='table').map(r=>r.sql),'write');
  assert.equal((await client.execute('PRAGMA quick_check')).rows[0][0],'ok');
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length,0);
  for(const d of descriptors){const rows=(await client.execute(d.query)).rows.map(r=>d.columns.map(c=>r[c]));assert.deepEqual(rows,d.rows,'exact typed synthetic clone: '+d.table);}
  const observed=(await client.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger') ORDER BY type,name")).rows;
  assert.deepEqual(observed.map(r=>[r.type,r.name,r.tbl_name,r.sql]),schema.map(r=>[r.type,r.name,r.tbl_name,r.sql]));
  client.close();client=null;
  const schemaVersion=(await f.db.raw.execute('SELECT max(version) version FROM schema_version')).rows[0].version;
  console.log('SYNTHETIC_SHADOW_NATIVE_CLONE '+JSON.stringify({version,schemaVersion,tables:descriptors.length,rows:descriptors.reduce((n,d)=>n+d.rows.length,0),exactSchema:true,exactTypedRows:true,source:'FRESH_SYNTHETIC_SCHEMA_FIXTURE_NOT_PRODUCTION',productionEvidence:false}));
  return {close,snapshot:()=>trace.snapshot(),setPhase:(...args)=>trace.observer.setPhase(...args),fetch:async request=>{
   assert.equal(new URL(request.url).origin,'https://isolated.invalid');
   runtimeUsed=true;
   return trace.fetch(base+'/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:await request.text(),signal:request.signal,redirect:'error'});
  }};
 }catch(error){return rethrowNativeSetupFailure(error,close);}
}
