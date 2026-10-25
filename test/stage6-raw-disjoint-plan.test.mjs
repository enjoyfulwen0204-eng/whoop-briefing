import test from 'node:test';import assert from 'node:assert/strict';
import {supportedRawDisjointSql as classify,RAW_DISJOINT_PLAN_LIMITS} from '../src/processingRawSourceEffects.js';
test('same cached syntax freshly checks current original catalog members',()=>{
 const s=Object.freeze(new Set(['evidence_items','phase4_jobs']));
 for(let i=0;i<3;i++){
  const q='SELECT * FROM evidence_items WHERE EXISTS(SELECT 1 FROM phase4_jobs)';
  assert.equal(classify(q,s),true);s.delete('phase4_jobs');assert.equal(classify(q,s),false);s.add('phase4_jobs');
  s.delete('evidence_items');assert.equal(classify(q,s),false);s.add('evidence_items');
 }
 for(const q of ['UPDATE whoop_sleeps SET id=?','DELETE FROM whoop_sleeps','INSERT INTO whoop_sleeps VALUES (?)'])assert.equal(classify(q,new Set(['whoop_sleeps'])),false);
});
test('fixed EXPECTED alias remains local while every joined catalog relation is fresh',()=>{
 const s=new Set();const alias='WITH expected(execution_id,receipt_key) AS (VALUES (?,?)) SELECT * FROM expected';
 assert.equal(classify(alias,s),true);assert.equal(classify('SELECT * FROM expected',s),false);s.add('expected');assert.equal(classify('SELECT * FROM expected',s),true);s.delete('expected');
 const join=alias+' JOIN evidence_items ON 1';assert.equal(classify(join,s),false);s.add('evidence_items');assert.equal(classify(join,s),true);s.clear();assert.equal(classify(join,s),false);
 assert.equal(classify('WITH expected(other,receipt_key) AS (VALUES (?,?)) SELECT * FROM expected',s),false);
});
test('custom and accessor membership retain original call behavior on warm and cold paths',()=>{
 const q='SELECT * FROM evidence_items WHERE EXISTS(SELECT 1 FROM evidence_items)';
 class Alternating extends Set{has(name){this.calls.push(name);return this.calls.length%2===1;}}
 for(let i=0;i<3;i++){const s=new Alternating();s.calls=[];assert.equal(classify(q,s),false);assert.deepEqual(s.calls,['evidence_items','evidence_items']);}
 for(let i=0;i<3;i++){const s=new Set(['evidence_items']);let gets=0,calls=0;Object.defineProperty(s,'has',{get(){gets++;return name=>{calls++;return name==='evidence_items';};}});assert.equal(classify(q,s),true);assert.equal(gets,2);assert.equal(calls,2);}
 assert.throws(()=>classify('SELECT * FROM evidence_items',new Proxy(new Set(['evidence_items']),{})),TypeError);
});
test('memo churn and byte-limit fallback preserve classification and fresh membership',()=>{
 assert.deepEqual(RAW_DISJOINT_PLAN_LIMITS,{entries:64,keyBytes:8192,bytes:128*1024});
 for(let i=0;i<600;i++){const q='SELECT c'+i+' FROM table'+i+' WHERE user_id=?',s=new Set(['table'+i]);assert.equal(classify(q,s),true);s.clear();assert.equal(classify(q,s),false);}
 assert.equal(classify('SELECT * FROM evidence_items',new Set()),false);assert.equal(classify('SELECT * FROM evidence_items',new Set(['evidence_items'])),true);
 assert.equal(classify('SELECT '+ 'a'.repeat(8193),new Set()),false);let calls=0;assert.equal(classify({toString(){calls++;return 'SELECT 1';}},new Set()),false);assert.equal(calls,0);
});
test('non-string original pragma membership edge preserves original fallback outcome',()=>{
 for(const q of ['PRAGMA table_info()','PRAGMA table_info(?)','PRAGMA table_info(42)']){
  assert.equal(classify(q,new Set()),false);
 }
 // Existing grammar accepts this odd case only for the noncanonical Set.
 // Keep its original result rather than introducing a new parser decision.
 assert.equal(classify('PRAGMA table_info()',new Set([undefined])),true);
 assert.equal(classify('PRAGMA table_info()',new Set()),false);
});
