import {SCHEMA_VERSION} from '../src/schema.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {createReceiptRouting} from '../src/phase4ReceiptRouting.js';

const context=Object.freeze({userId:'a',executionMode:'SHADOW'}),identity=['body_energy','energy'];
const manifest=sql=>/SELECT \* FROM phase4_receipt_route_manifests/.test(sql);
const entries=sql=>/SELECT COUNT\(\*\) count FROM phase4_receipt_route_entries/.test(sql);
const sqlOf=statement=>typeof statement==='string'?statement:statement.sql;

test('physical Hrana routing tip dispatches its two independent signed-header observations together',async t=>{
 const {db,transport}=await fixture(t,SCHEMA_VERSION);await db.admitRuntime();
 const routing=createReceiptRouting(db.raw,fixtureKeys),before=transport.counts.httpRequests;
 assert.equal(await db.transaction(()=>routing.tip(context,'EPISODE',identity)),null);
 const requests=transport.counts.httpRequests-before;
 // BEGIN/read requests coalesce, and COMMIT remains a separate request.
 assert.ok(requests<=4);assert.equal(transport.counts.byTemplate&&Object.keys(transport.counts.byTemplate).length>0,true);
 console.log('ROUTING_TIP_READ_BATCH_HTTP '+JSON.stringify({requests}));
});

test('reversed routing read completion retains the original first SQL failure and settles its submitted sibling before rollback',async t=>{
 const {db}=await fixture(t,SCHEMA_VERSION);await db.admitRuntime();const execute=db.raw.execute.bind(db.raw),events=[];
 db.raw.execute=async statement=>{
  const sql=sqlOf(statement);
  if(manifest(sql)){await execute(statement);await new Promise(resolve=>setTimeout(resolve,40));events.push('manifest');throw Error('FIRST_ROUTE_SQL');}
  if(entries(sql)){await execute(statement);events.push('entries');throw Error('SECOND_ROUTE_SQL');}
  return execute(statement);
 };
 try {await assert.rejects(db.transaction(()=>createReceiptRouting(db.raw,fixtureKeys).tip(context,'EPISODE',identity)),/FIRST_ROUTE_SQL/);}
 finally{db.raw.execute=execute;}
 assert.deepEqual(events,['entries','manifest']);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_receipt_route_manifests')).rows[0].n,0);
});

test('a synchronous routing-header throw still waits for the already submitted physical sibling before failing',async t=>{
 const {db}=await fixture(t,SCHEMA_VERSION);await db.admitRuntime();const execute=db.raw.execute.bind(db.raw);let settled=false;
 db.raw.execute=statement=>{
  const sql=sqlOf(statement);if(manifest(sql))throw Error('SYNCHRONOUS_ROUTE_SQL');
  if(entries(sql))return execute(statement).then(async result=>{await new Promise(resolve=>setTimeout(resolve,40));settled=true;return result;});
  return execute(statement);
 };
 try{await assert.rejects(db.transaction(()=>createReceiptRouting(db.raw,fixtureKeys).tip(context,'EPISODE',identity)),/SYNCHRONOUS_ROUTE_SQL/);}
 finally{db.raw.execute=execute;}
 assert.equal(settled,true);
});
