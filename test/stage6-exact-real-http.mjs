import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client';import {exactRealStatement} from '../src/exactRealStatement.js';
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
test('HTTP exact reconstruction and native inputs agree across finite corpus and every scaling exponent',async()=>{
 const n=createClient({url:'file::memory:'}),h=createClient({url:'http://sqld-control:8080'});
 try{
  const values=[0,-0,null,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,0.9048374180359595,0.1,2**-1022,2**53];let state=0x6a09e667f3bcc909n;
  for(let i=0;i<2048;i++){state^=state<<13n;state^=state>>7n;state^=state<<17n;state=BigInt.asUintN(64,state);const b=Buffer.alloc(8);b.writeBigUInt64BE(state);const v=b.readDoubleBE();if(Number.isFinite(v))values.push(v);}
  const originals=await n.batch(values.map(v=>({sql:'SELECT ? v',args:[v]})),'deferred'),observed=await h.batch(values.map(v=>exactRealStatement({sql:'SELECT ? v,typeof(?) storage',args:[v,v]})),'deferred');
  // Existing JSON transport canonicalizes -0 to +0; SQLite IS and the
  // existing signed JSON receipt contract intentionally identify both zeros.
  for(let i=0;i<values.length;i++){assert.equal(observed[i].rows[0].storage,values[i]===null?'null':'real','original Hrana float storage type');if(values[i]===null)assert.equal(observed[i].rows[0].v,null);else if(values[i]===0)assert.equal(observed[i].rows[0].v===0,true);else assert.equal(bits(observed[i].rows[0].v),bits(originals[i].rows[0].v),'finite corpus index'+i);}
  const powers=await h.batch(Array.from({length:2098},(_,i)=>exactRealStatement({sql:'SELECT ? v',args:[2**(i-1074)]})),'deferred');for(let i=0;i<powers.length;i++)assert.equal(bits(powers[i].rows[0].v),bits(2**(i-1074)));
  const raw=(await h.execute({sql:'SELECT 0.9048374180359595 IS ? same',args:[.9048374180359595]})).rows[0].same;assert.equal(raw,0,'retain the uncorrected transport negative control');
  const exact=await h.execute(exactRealStatement({sql:'SELECT 0.9048374180359595 IS ? same,0.9048374180359595 IS ? changed,? IS NULL null_same,? IS ? zeros',args:[.9048374180359595,.9048374180359596,null,0,-0]}));assert.deepEqual(['same','changed','null_same','zeros'].map(k=>exact.rows[0][k]),[1,0,1,1]);
  console.log('EXACT_REAL_HTTP '+JSON.stringify({finiteSamples:values.length,allScalingExponents:2098,rawEquality:raw,correctedEquality:1,oneUlpMutationRejected:true,nullAndSignedZeroOriginalIS:true,applicationWrites:0}));
 }finally{n.close();h.close();}
});
