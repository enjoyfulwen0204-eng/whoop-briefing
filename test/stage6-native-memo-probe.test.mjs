import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMemoProbe,validateMemoProbe} from './stage6-native-memo-probe.mjs';
import {transformMemo} from './stage6-native-memo-loader.mjs';
import {createWorkCorrelation} from './stage6-native-work-join.mjs';
const url=new URL('../src/processingReadSnapshot.js',import.meta.url),source=await readFile(url,'utf8');
const target=Object.freeze({preparationOrdinal:17,workInvocationOrdinal:2,workLabel:'stage6.family:recovery_score'});
const transformed=transformMemo(url.href,source);
let moduleOrdinal=0;
async function load(s){s=s.replace("'./sqlSyntaxMemo.js'",JSON.stringify(new URL('../src/sqlSyntaxMemo.js',import.meta.url).href));return import('data:text/javascript;base64,'+Buffer.from(s+'\n//'+(++moduleOrdinal)).toString('base64'));}
const original=await load(source),observed=await load(transformed);
function result(){return {rows:[{value:42}],columns:['value'],columnTypes:['INTEGER'],rowsAffected:0,lastInsertRowid:undefined};}
function setup(scope=()=>target){const p=createMemoProbe(scope);globalThis.__stage6MemoProbe=p;return p;}
test('closed numeric schema, target scope and shared row/data capacity counters',()=>{
 const p=setup();const id=p.register();p.note(id,'ROW_PUT',0,256,123,0);p.note(id,'DATA_PUT',0,256,124,0);p.note(id,'ROW_ROWS',0,4,500,129);p.note(id,'DATA_SIZE',0,4,4190000,300000);p.note(id,'CLEAR',0,4,500);p.note(id,'CLOSE',1,0,0);
 const v=p.snapshot();assert.equal(validateMemoProbe(v),true);const c=v.records[0].counts;assert.equal(c.entryRefusals,2);assert.equal(v.records[0].minEntryFullBytes,123);assert.equal(c.rowRefusals,1);assert.equal(c.resultByteRefusals,1);assert.equal(c.totalByteRefusals,1);assert.equal(c.clears,1);assert.equal(v.records[1].counts.closes,1);
 const leak=structuredClone(v);leak.records[0].privateValue='forbidden';assert.throws(()=>validateMemoProbe(leak));
});
test('other preparation, invocation and family never enter packet',()=>{
 let s=target;const p=setup(()=>s),id=p.register();for(const x of [{...target,preparationOrdinal:16},{...target,workInvocationOrdinal:3},{...target,workLabel:'stage6.family:hrv'}]){s=x;p.note(id,'ROW_PUT',0,2,40);}
 assert.equal(p.snapshot().observations,0);
});
test('bounded records and bad primitive observations fail safely and visibly',()=>{
 const p=setup(),id=p.register();for(let i=0;i<65;i++)p.note(id,'CLEAR',i,0,0);p.note(id,'SECRET',0,0,0);p.note(id,'ROW_SIZE',0,0,0,NaN);
 assert.equal(p.snapshot().records.length,64);assert.equal(p.snapshot().droppedObservations,3);const bad=createMemoProbe(()=>{throw Error('scope');});assert.doesNotThrow(()=>bad.note(bad.register(),'CLEAR',0,0,0));assert.equal(bad.snapshot().droppedObservations,1);
});
test('exact source hash and unrelated URL fail closed/no rewrite',()=>{assert.throws(()=>transformMemo(url.href,source+'\n'),/EXACT_MEMO_REQUIRED/);assert.equal(transformMemo('file:///other',source),source);});
test('real original entry cap and clear preserved with low-byte full events',()=>{
 const p=setup(),m=observed.createReadSnapshotMemo(),ctx={};for(let i=0;i<256;i++)m.put(ctx,'k'+i,result(),m.epoch());m.put(ctx,'rejected',result(),m.epoch());assert.equal(m.get(ctx,'rejected'),undefined);assert.equal(m.get(ctx,'k255').rows[0].value,42);
 let v=p.snapshot();assert.equal(v.records[0].counts.rowAdmissions,256);assert.equal(v.records[0].counts.entryRefusals,1);assert.ok(v.records[0].minEntryFullBytes<4194304);m.clear();m.putData(ctx,'data',{rows:[]},m.epoch());assert.deepEqual(m.getData(ctx,'data'),{rows:[]});m.close();assert.equal(m.getData(ctx,'data'),undefined);assert.equal(p.snapshot().droppedObservations,0);
});
test('stale epoch and closed paths do not inspect results',()=>{
 const p=setup(),m=observed.createReadSnapshotMemo(),ctx={};let gets=0;const r={get rows(){gets++;throw Error('read');}};m.clear();m.put(ctx,'stale',r,0);m.close();m.putData(ctx,'closed',r,m.epoch());assert.equal(gets,0);assert.equal(p.snapshot().records.reduce((n,r)=>n+r.counts.epochRefusals,0),1);assert.equal(p.snapshot().records.reduce((n,r)=>n+r.counts.closedRefusals,0),1);
});
test('getters, toJSON and result cloning execute original number of times',()=>{
 function run(factory){let gets=0,jsons=0;const m=factory(),ctx={};const r={get rows(){gets++;return [{n:1}];},columns:['n'],columnTypes:['INTEGER'],rowsAffected:0,toJSON(){jsons++;return {rows:[{n:1}]};}};m.put(ctx,'k',r,m.epoch());m.put(ctx,'k',r,m.epoch());return {gets,jsons,value:m.get(ctx,'k').rows};}
 setup();assert.deepEqual(run(observed.createReadSnapshotMemo),run(original.createReadSnapshotMemo));
});
test('original row/byte/duplicate decisions and callback failures are preserved',()=>{
 const p=setup(),m=observed.createReadSnapshotMemo(),ctx={};m.put(ctx,'rows',{...result(),rows:Array(129).fill({n:1})},0);m.put(ctx,'size',{...result(),rows:[{v:'x'.repeat(270000)}]},0);m.put(ctx,'k',result(),0);m.put(ctx,'k',result(),0);
 const c=p.snapshot().records[0].counts;assert.equal(c.rowRefusals,1);assert.equal(c.resultByteRefusals,1);assert.equal(c.duplicateRefusals,1);assert.equal(c.rowAdmissions,1);
 globalThis.__stage6MemoProbe={register(){throw Error('sink');},note(){throw Error('sink');}};const broken=observed.createReadSnapshotMemo();assert.doesNotThrow(()=>broken.put(ctx,'k',result(),0));assert.deepEqual(broken.get(ctx,'k').rows,[{value:42}]);
});
test('original prefix data storage, cloning and no shape serialization changes',()=>{
 const p=setup(),m=observed.createReadSnapshotMemo(),ctx={},data={rows:[{v:1}]};m.putData(ctx,'key',data,0);data.rows[0].v=2;assert.deepEqual(m.getData(ctx,'key'),{rows:[{v:1}]});m.putData(ctx,'key',data,0);assert.equal(p.snapshot().records[0].counts.dataAdmissions,1);assert.equal(p.snapshot().records[0].counts.duplicateRefusals,1);
});
test('work ALS exposes immutable original semantic scope only',async()=>{
 const c=createWorkCorrelation();assert.equal(c.workScope().workLabel,'OUTSIDE');await c.preparation(17,async()=>{await c.owned({workKind:'stage6.checkpoint'},async()=>{});await c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{assert.deepEqual(c.workScope(),target);assert.equal(Object.isFrozen(c.workScope()),true);});});assert.equal(c.workScope().workLabel,'OUTSIDE');
});
