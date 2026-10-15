import test from 'node:test';import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';import {exactRealStatement} from '../src/exactRealStatement.js';
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
export function finiteCorpus(){
 const values=[0,-0,1,-1,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,Number.EPSILON,0.9048374180359595,0.1,2**-1022,2**53,Number.MAX_SAFE_INTEGER];
 let state=0x6a09e667f3bcc909n;for(let i=0;i<1024;i++){state^=state<<13n;state^=state>>7n;state^=state<<17n;state=BigInt.asUintN(64,state);const b=Buffer.alloc(8);b.writeBigUInt64BE(state);const n=b.readDoubleBE();if(Number.isFinite(n))values.push(n);}
 return values;
}
test('native reconstructed values preserve finite binary64 and original SQLite IS semantics',async()=>{
 const c=createClient({url:'file::memory:'});try{
  const corpus=finiteCorpus();const originals=await c.batch(corpus.map(v=>({sql:'SELECT ? value',args:[v]})));
  const rebuilt=await c.batch(corpus.map(v=>exactRealStatement({sql:'SELECT ? value',args:[v]})));
  for(let i=0;i<corpus.length;i++)assert.equal(bits(rebuilt[i].rows[0].value),bits(originals[i].rows[0].value),'finite corpus index'+i);
  const truth=await c.execute(exactRealStatement({sql:'SELECT ? IS ? same,? IS NULL null_same,? IS ? zeros',args:[0.9048374180359595,0.9048374180359595,null,0,-0]}));assert.deepEqual(['same','null_same','zeros'].map(k=>truth.rows[0][k]),[1,1,1]);
 }finally{c.close();}
});
test('all finite binary exponents survive integer-only scaling exactly',async()=>{
 const c=createClient({url:'file::memory:'});try{const rows=await c.batch(Array.from({length:2098},(_,i)=>exactRealStatement({sql:'SELECT ? v',args:[2**(i-1074)]})));for(let i=0;i<rows.length;i++)assert.equal(bits(rows[i].rows[0].v),bits(2**(i-1074)));}finally{c.close();}
});
test('scanner preserves SQL literals, identifiers, comments and bind order',()=>{
 const q={sql:'SELECT ? a,\'?literal\' s,"?column" c,`?tick` t,[?bracket] b,? z /* ? comment */ -- ? comment\n,? last',args:['tenant',.9048374180359595,null]};
 const r=exactRealStatement(q);assert.equal(r.sql,q.sql.replace('? z','(CAST(? AS REAL)/CAST(? AS REAL)) z'));assert.deepEqual(r.args,['tenant',8150050917395258n,9007199254740992n,null]);assert.equal(q.args.length,3);
});
test('nonfinite, indexed, named, missing and ambiguous parameters fail closed',()=>{
 for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>exactRealStatement({sql:'SELECT ?',args:[value]}),/EXACT_REAL_STATEMENT_UNSUPPORTED/);
 for(const sql of ['SELECT ?1','SELECT :n','SELECT @n','SELECT $n','SELECT ? + ?','SELECT 1',"SELECT 'unterminated ?"] )assert.throws(()=>exactRealStatement({sql,args:[.1]}),/EXACT_REAL_STATEMENT_UNSUPPORTED/);
 assert.throws(()=>exactRealStatement({sql:'SELECT :n',args:{n:.1}}),/EXACT_REAL_STATEMENT_UNSUPPORTED/);
});
test('NULL, strings, bigint, safe integers and negative zero retain original bindings',()=>{
 const s={sql:'SELECT ?,?,?,?,?',args:[null,'a',1n,1,-0]};assert.equal(exactRealStatement(s),s);assert.equal(exactRealStatement('SELECT 1'),'SELECT 1');
});
