import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {processingTransactions,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {hranaTransport} from './hranaTransport.js';
const ownerSql='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';
const context=()=>({claim:{request:{phase:'SYNC'}},receipts:false,pending:new Set(),authority:{assert(){}},syncContinuation:true,syncYieldReserveMs:30000});
for(const [label,stmt,value] of [
 ['unknown readonly tuple',['SELECT 31 value',[]],31],
 ['known metadata tuple',[ownerSql,['synthetic','owner','2099','2000']],1],
])test(`${label} retains the original separate BEGIN ACK without widening the prefix allowlist`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sync-tuple-fallback-')),url=`file:${join(dir,'db.sqlite')}`,seed=createClient({url});
 await seed.executeMultiple("CREATE TABLE resource_locks(name TEXT,owner TEXT,expires_at TEXT); INSERT INTO resource_locks VALUES('synthetic','owner','2099');");seed.close();
 const transport=hranaTransport(url),packets=[],sqlCache=new Map();
 const raw=createClient({url:'https://isolated.invalid',fetch:async req=>{
  const body=await req.clone().json(),packet=[];
  for(const item of body.requests){
   if(item.type==='store_sql')sqlCache.set(item.sql_id,item.sql);
   if(item.type==='batch')for(const step of item.batch.steps)packet.push(step.stmt.sql??sqlCache.get(step.stmt.sql_id));
   if(item.type==='execute')packet.push(item.stmt.sql??sqlCache.get(item.stmt.sql_id));
  }packets.push(packet.filter(Boolean));return transport.fetch(req);
 }}),p=processingTransactions(raw,{privateRuntime:true});
 t.after(async()=>{raw.close();transport.close();global.gc?.();await new Promise(r=>setImmediate(r));await rm(dir,{recursive:true,force:true});});
 let observed,callbacks=0;
 const result=await withDurableExecution(context(),()=>p.withFence(readOnlyProcessingCheck(async client=>{if(client)observed=await client.execute(stmt);}),()=>p.transaction(()=>{callbacks++;return 19;},{readOnly:true})));
 assert.equal(result,19);assert.equal(callbacks,1);assert.equal(observed.rows[0][0],value);
 assert.deepEqual(packets.find(packet=>packet.some(sql=>/^BEGIN/.test(sql))),['BEGIN IMMEDIATE','SELECT 1']);
 assert.ok(packets.some(packet=>packet.includes(stmt[0])));
});
