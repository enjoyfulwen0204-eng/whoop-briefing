import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadSnapshotMemo,READ_SNAPSHOT_LIMITS} from '../src/processingReadSnapshot.js';
const result=(n=1)=>({rows:[{n}],columns:['n'],columnTypes:['INTEGER'],rowsAffected:0,lastInsertRowid:undefined});
test('ROW same context/key/epoch keeps original and skips discarded JSON and clone',()=>{
 const m=createReadSnapshotMemo(),c={};m.put(c,'k',result(1),m.epoch());let json=0,descriptors=0;const second={...result(2),toJSON(){json++;return {};}};second.rows[0]=new Proxy({n:2},{ownKeys(t){descriptors++;return Reflect.ownKeys(t);}});m.put(c,'k',second,m.epoch());assert.equal(json,0);assert.equal(descriptors,0);assert.equal(m.get(c,'k').rows[0].n,1);
});
test('PREFIX_DATA same context/key/epoch skips discarded serialization and structured clone',()=>{
 const m=createReadSnapshotMemo(),c={};m.putData(c,'k',{rows:[{n:1}]},m.epoch());let json=0;m.putData(c,'k',{rows:[{n:2}],toJSON(){json++;return {rows:[]};}},m.epoch());assert.equal(json,0);assert.deepEqual(m.getData(c,'k'),{rows:[{n:1}]});
});
test('context identity and ROW/DATA key spaces remain distinct',()=>{
 const m=createReadSnapshotMemo(),a={},b={};m.put(a,'k',result(1),0);m.put(b,'k',result(2),0);m.putData(a,'k',{rows:[{n:3}]},0);assert.equal(m.get(a,'k').rows[0].n,1);assert.equal(m.get(b,'k').rows[0].n,2);assert.equal(m.getData(a,'k').rows[0].n,3);
});
test('clear, closed and stale-epoch rejection cannot reuse a previous duplicate',()=>{
 const m=createReadSnapshotMemo(),c={};m.put(c,'k',result(1),0);m.clear();m.put(c,'k',result(2),0);assert.equal(m.get(c,'k'),undefined);m.put(c,'k',result(3),m.epoch());assert.equal(m.get(c,'k').rows[0].n,3);m.close();m.put(c,'k',result(4),m.epoch());assert.equal(m.get(c,'k'),undefined);
});
test('original shape guards still run before duplicate short circuit',()=>{
 const m=createReadSnapshotMemo(),c={};m.put(c,'k',result(),0);let gets=0;const r={get rows(){gets++;throw Error('original shape');}};assert.throws(()=>m.put(c,'k',r,0),/original shape/);assert.equal(gets,1);assert.equal(m.get(c,'k').rows[0].n,1);
});
test('failed first serialization or clone does not create an entry or poison retry',()=>{
 const m=createReadSnapshotMemo(),c={};m.put(c,'k',{...result(),toJSON(){throw Error('json');}},0);assert.equal(m.get(c,'k'),undefined);const bad=result();Object.defineProperty(bad.rows[0],'n',{get(){return 1},enumerable:true});m.put(c,'k',bad,0);assert.equal(m.get(c,'k'),undefined);m.put(c,'k',result(9),0);assert.equal(m.get(c,'k').rows[0].n,9);
});
test('original final duplicate check preserves reentrant first-writer semantics',()=>{
 const m=createReadSnapshotMemo(),c={};const r={...result(2),toJSON(){m.put(c,'k',result(1),0);return {rows:[{n:2}]};}};m.put(c,'k',r,0);assert.equal(m.get(c,'k').rows[0].n,1);
 const d={rows:[{n:2}],toJSON(){m.putData(c,'data',{rows:[{n:1}]},0);return {rows:[{n:2}]};}};m.putData(c,'data',d,0);assert.equal(m.getData(c,'data').rows[0].n,1);
});
test('all existing row, per-result, entry and total byte bounds stay unchanged',()=>{
 assert.deepEqual(READ_SNAPSHOT_LIMITS,{entries:256,bytes:4194304,resultBytes:262144,rows:128,keyBytes:8192});const m=createReadSnapshotMemo(),c={};m.put(c,'rows',{...result(),rows:Array(129).fill({n:1})},0);assert.equal(m.get(c,'rows'),undefined);m.put(c,'size',{...result(),rows:[{n:'x'.repeat(270000)}]},0);assert.equal(m.get(c,'size'),undefined);for(let i=0;i<256;i++)m.put(c,'entry'+i,result(i),0);m.put(c,'overflow',result(),0);assert.equal(m.get(c,'overflow'),undefined);assert.equal(m.get(c,'entry255').rows[0].n,255);
 const data=createReadSnapshotMemo();for(let i=0;i<22;i++)data.putData(c,'p'+i,{rows:[{v:'x'.repeat(220000)}]},0);assert.ok(data.getData(c,'p18'));assert.equal(data.getData(c,'p19'),undefined);
});
test('returned rows and prefix data remain fresh clones',()=>{
 const m=createReadSnapshotMemo(),c={};m.put(c,'k',result(),0);const r=m.get(c,'k');r.rows[0].n=8;assert.equal(m.get(c,'k').rows[0].n,1);m.putData(c,'k',{rows:[{n:2}]},0);const d=m.getData(c,'k');d.rows[0].n=9;assert.equal(m.getData(c,'k').rows[0].n,2);
});

test('nonstring prefix keys retain original single coercion after serialization',()=>{
 const m=createReadSnapshotMemo(),c={},key=Buffer.from('k'),events=[];key.toString=()=>{events.push('key');return 'k';};const d={rows:[]};Object.defineProperty(d,'toJSON',{value(){events.push('json');return {rows:[]};}});m.putData(c,key,d,0);assert.deepEqual(events,['json','key']);
});
