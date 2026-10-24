import test from 'node:test';import assert from 'node:assert/strict';
import {rawEffectSubmissionArguments as snapshot} from '../src/processingRawSourceEffects.js';
test('accepted submission is bounded private immutable scalar SQL, independent of caller mutation',()=>{
 const original={sql:'SELECT * FROM whoop_sleeps WHERE id=?',args:['original']},batch=[original];
 const a=snapshot('execute',[original]),b=snapshot('batch',[batch]);
 original.sql='UPDATE whoop_sleeps SET raw_json=NULL';original.args[0]='changed';batch.push(original);
 assert.deepEqual(a,[{sql:'SELECT * FROM whoop_sleeps WHERE id=?',args:['original']}]);
 assert.deepEqual(b,[[{sql:'SELECT * FROM whoop_sleeps WHERE id=?',args:['original']}]]);
 assert.ok(Object.isFrozen(a)&&Object.isFrozen(a[0])&&Object.isFrozen(a[0].args)&&Object.isFrozen(b[0]));
 assert.equal(snapshot('batch',[[]])?.[0].length,0);
});
test('unknown/accessor/proxy/alias argument shapes decline without optional hooks',()=>{
 let invoked=0;const getter={};Object.defineProperty(getter,'sql',{get(){invoked++;throw Error('SQL');}});
 const args=[];Object.defineProperty(args,0,{get(){invoked++;throw Error('ARG');}});
 const revoked=Proxy.revocable({},{});revoked.revoke();
 const array=[{sql:'SELECT 1'}];Object.defineProperty(array,'0',{get(){invoked++;throw Error('STMT');}});
 for(const a of [[getter],[{sql:'SELECT ?',args}],[revoked.proxy],[{sql:'SELECT ?',args:[{}]}],
  [{sql:'SELECT 1',extra:1}],[{sql:'SELECT ?',args:new Proxy([1],{})}]])assert.equal(snapshot('execute',a),null);
 assert.equal(snapshot('batch',[array]),null);assert.equal(snapshot('execute',['SELECT 1','extra']),null);
 assert.equal(invoked,0);
});
