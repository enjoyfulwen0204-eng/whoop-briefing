import test from 'node:test';
import assert from 'node:assert/strict';
import {finishRunObservationBranches} from '../src/phase4RunObservationBarriers.js';
const branches=(...found)=>found.map(value=>({found:value,error:null}));
async function original(bs,observe){
 const branch=i=>{if(bs[i].error)throw bs[i].error;return bs[i].found;};
 const whole=branch(0);await observe();if(whole)return true;
 const started=branch(1);await observe();if(!started)return false;
 const completed=branch(2);await observe();return completed;
}
for(const found of [[true,false,false],[true,true,true],[false,false,false],[false,false,true],[false,true,false],[false,true,true]])test('original short-circuit and exact fresh guard count '+found,async()=>{
 const bs=branches(...found);let expectedCalls=0,calls=0;
 const expected=await original(bs,async()=>{expectedCalls++;});
 const value=await finishRunObservationBranches(bs,async()=>{calls++;});
 assert.equal(value,expected);assert.equal(calls,expectedCalls);
});
test('original branch-error precedence includes unused bad START/COMPLETE branches',async()=>{
 for(let errorAt=0;errorAt<3;errorAt++)for(const found of [[true,true,true],[false,false,true],[false,true,true]]){
  const bs=branches(...found),error=Error('branch-'+errorAt);bs[errorAt].error=error;
  let expectedCalls=0,calls=0;const outcome=async work=>{try{return {value:await work()};}catch(reason){return {reason};}};
  const expected=await outcome(()=>original(bs,async()=>{expectedCalls++;}));
  const actual=await outcome(()=>finishRunObservationBranches(bs,async()=>{calls++;}));
  assert.deepEqual(actual,expected);assert.equal(calls,expectedCalls);
 }
});
test('overlap settles every original eligible guard before returning the first logical guard failure',async()=>{
 const bs=branches(false,true,true),early=Error('first-original-guard'),late=Error('later-guard');
 let calls=0,settled=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const work=finishRunObservationBranches(bs,async()=>{const index=calls++;await gate;settled++;if(index===0)throw early;if(index===2)throw late;});
 await Promise.resolve();assert.equal(calls,3,'all three original nonhealth barriers may overlap');release();
 await assert.rejects(work,e=>e===early);assert.equal(settled,3,'no abandoned guard after failure');
});
test('an earlier fresh guard failure retains priority over a later branch receipt error',async()=>{
 const bs=branches(false,true,true),early=Error('fresh-owner-fenced'),later=Error('bad-start-receipt');bs[1].error=later;
 let calls=0;await assert.rejects(finishRunObservationBranches(bs,async()=>{calls++;throw early;}),e=>e===early);assert.equal(calls,1);
});
test('even an immediately failed early guard waits for a held later original guard',async()=>{
 const bs=branches(false,true,true),early=Error('first-fresh-guard');let release,returned=false,finished=0;
 const held=new Promise(resolve=>{release=resolve;});let calls=0;
 const work=finishRunObservationBranches(bs,async()=>{const index=calls++;if(index===1)await held;finished++;if(index===0)throw early;});
 const observed=work.then(()=>{returned=true;},error=>{returned=true;throw error;});
 await Promise.resolve();await Promise.resolve();assert.equal(calls,3);assert.equal(returned,false);assert.equal(finished,2);
 release();await assert.rejects(observed,e=>e===early);assert.equal(finished,3);
});
test('a later original authority revocation rejects all-true receipt facts before any following effect',async()=>{
 const bs=branches(false,true,true),revoked=Error('later-runtime-revoked');let calls=0,effects=0;
 await assert.rejects((async()=>{await finishRunObservationBranches(bs,async()=>{if(++calls===3)throw revoked;});effects++;})(),e=>e===revoked);
 assert.equal(calls,3);assert.equal(effects,0);
});
