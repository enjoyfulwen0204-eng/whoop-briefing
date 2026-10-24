import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadSnapshotMemo,READ_SNAPSHOT_LIMITS} from '../src/processingReadSnapshot.js';
const result=value=>({columns:['value'],columnTypes:['TEXT'],rows:[{value}],rowsAffected:0,lastInsertRowid:123n});
test('raw DATA shares the original epoch-cleared pool budget and never returns driver metadata',()=>{
 const m=createReadSnapshotMemo(),c={},other={},r=result('first');
 m.put(c,'ordinary',r,m.epoch());m.putRawRows(c,'raw',r,m.rawEpoch());
 r.rows[0].value='changed';
 m.clear({retainRawData:true});
 assert.equal(m.get(c,'ordinary'),undefined);
 const hit=m.getRawRows(c,'raw');assert.deepEqual(hit,{rows:[{value:'first'}]});
 assert.equal(m.getRawRows(other,'raw'),undefined);
 hit.rows[0].value='caller';assert.equal(m.getRawRows(c,'raw').rows[0].value,'first');
 const epoch=m.rawEpoch();m.clear();assert.equal(m.getRawRows(c,'raw'),undefined);
 m.putRawRows(c,'late',r,epoch);assert.equal(m.getRawRows(c,'late'),undefined);
 m.close();m.putRawRows(c,'closed',r,m.rawEpoch());assert.equal(m.getRawRows(c,'closed'),undefined);
});
test('combined original and raw entries never exceed the original 256-entry budget',()=>{
 const m=createReadSnapshotMemo(),c={};
 for(let i=0;i<READ_SNAPSHOT_LIMITS.entries-1;i++)m.put(c,'normal'+i,result(i),m.epoch());
 m.putRawRows(c,'last',result('raw'),m.rawEpoch());
 m.put(c,'overflow-normal',result('no'),m.epoch());
 m.putRawRows(c,'overflow-raw',result('no'),m.rawEpoch());
 assert.ok(m.getRawRows(c,'last'));assert.equal(m.get(c,'overflow-normal'),undefined);
 assert.equal(m.getRawRows(c,'overflow-raw'),undefined);
 m.clear({retainRawData:true});
 for(let i=0;i<READ_SNAPSHOT_LIMITS.entries;i++)m.putRawRows(c,'raw'+i,result(i),m.rawEpoch());
 assert.ok(m.getRawRows(c,'raw254'));assert.equal(m.getRawRows(c,'raw255'),undefined);
});
test('oversize, binary, nonfinite, accessor and proxy rows are not retained',()=>{
 const m=createReadSnapshotMemo(),c={};let called=0;
 const getter={};Object.defineProperty(getter,'value',{enumerable:true,get(){called++;return 'x';}});
 for(const [key,r] of [
  ['bytes',result('x'.repeat(READ_SNAPSHOT_LIMITS.resultBytes))],
  ['rows',{rows:Array.from({length:READ_SNAPSHOT_LIMITS.rows+1},()=>({value:1}))}],
  ['binary',result(Buffer.from('x'))],['nan',result(NaN)],['getter',{rows:[getter]}],
  ['proxy',{rows:[new Proxy({value:1},{ownKeys(){called++;return ['value'];}})]}],
 ]){m.putRawRows(c,key,r,m.rawEpoch());assert.equal(m.getRawRows(c,key),undefined);}
 assert.equal(called,0);
});

test('optional outer rows and array accessors/proxies never execute or throw',()=>{
 const m=createReadSnapshotMemo(),c={};let invoked=0;
 const outer={};Object.defineProperty(outer,'rows',{get(){invoked++;throw Error('GETTER');}});
 const array=[{value:1}];Object.defineProperty(array,0,{get(){invoked++;throw Error('INDEX_GETTER');}});
 const revoked=Proxy.revocable({rows:[]},{});revoked.revoke();
 const inherited=Object.create({get value(){invoked++;throw Error('INHERITED');}});
 const overridden=[{value:1}];Object.defineProperty(overridden,'map',{value(){invoked++;throw Error('MAP');}});
 for(const [i,value]of[outer,{rows:array},revoked.proxy,{rows:overridden},{rows:[inherited]}].entries()){
  assert.doesNotThrow(()=>m.putRawRows(c,'bad'+i,value,m.rawEpoch()));
  assert.equal(m.getRawRows(c,'bad'+i),undefined);
 }assert.equal(invoked,0);
});
