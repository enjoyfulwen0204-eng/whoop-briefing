import test from 'node:test';import assert from 'node:assert/strict';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
const observe=(h,sql,{baton=null,next='b',stmt={sql}}={})=>h.acknowledged(h.submitted({baton,requests:[{type:'execute',stmt}]},'WORK',10),{baton:next,results:[{type:'ok',response:{type:'execute',result:{}}}]},20);
test('native observer accepts only complete BEGIN and matching acknowledged terminal',()=>{const h=createPreparedNativeObserver();observe(h,'BEGIN');observe(h,'COMMIT',{baton:'b',next:null});assert.equal(h.assertComplete('WORK').length,1);});
test('native observer resolves stored SQL and leading comments without omitting a transaction',()=>{
 const h=createPreparedNativeObserver();
 h.acknowledged(h.submitted({requests:[{type:'store_sql',sql_id:1,sql:'-- comment\n/* comment */ BEGIN'},{type:'execute',stmt:{sql_id:1}}]},'WORK',10),{baton:'b',results:[{type:'ok',response:{type:'store_sql'}},{type:'ok',response:{type:'execute',result:{}}}]},20);
 observe(h,'COMMIT',{baton:'b',next:null});assert.equal(h.assertComplete('WORK').length,1);
});
for(const fault of ['UNMATCHED','UNKNOWN_SQL','OPEN','UNKNOWN_BATON','EMPTY'])test('native observer rejects '+fault+' instead of qualifying a measured subset',()=>{
 const h=createPreparedNativeObserver();
 if(fault==='UNMATCHED')observe(h,'COMMIT');
 if(fault==='UNKNOWN_SQL'){observe(h,'BEGIN');observe(h,null,{baton:'b',stmt:{sql_id:404}});observe(h,'COMMIT',{baton:'b',next:null});}
 if(fault==='OPEN')observe(h,'BEGIN');
 if(fault==='UNKNOWN_BATON'){observe(h,'BEGIN',{baton:'unobserved'});observe(h,'COMMIT',{baton:'b',next:null});}
 assert.throws(()=>h.assertComplete('WORK'));
});
