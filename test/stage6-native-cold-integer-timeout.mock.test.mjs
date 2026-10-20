/** Pure source-derived wrapper checks. No native module import, fetch, DB or CI.
 * Request/URL/AbortSignal are the real Node APIs; only networkFetch is mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const source=readFileSync(new URL('./stage6-native-cold-progress.mjs',import.meta.url),'utf8');
const fixed='AbortSignal.timeout(Math.max(1,Math.floor(workDeadlineMs-now())))';
const prior='AbortSignal.timeout(Math.max(1,workDeadlineMs-now()))';
assert.equal(source.split(fixed).length,2);
const oldSource=source.replace(fixed,prior);
// This reconstructs the exact original R2 module, not a mirrored implementation.
assert.equal(createHash('sha256').update(oldSource).digest('hex'),'80762524e4e384cbc3a26d791c37681ee8f46f17c927f56c0076669a0ad3d759');
function extracted(text){
 const lines=text.split('\n'),guards=lines.filter(line=>line.startsWith('function guard(){'));
 const prefix='const transport=createDiagnosticFetch({fetch:',wrappers=lines.filter(line=>line.startsWith(prefix));
 assert.equal(guards.length,1);assert.equal(wrappers.length,1);
 const end=wrappers[0].indexOf(',decodePipelineReply:');assert.ok(end>prefix.length);
 return {guard:guards[0],wrapper:wrappers[0].slice(prefix.length,end)};
}
const old=extracted(oldSource),current=extracted(source);assert.equal(old.guard,current.guard);
function probe(text,remainingMs){
 const {guard,wrapper}=extracted(text),network=[];
 const state={remaining:remainingMs};
 const invoke=vm.runInNewContext('(()=>{'+guard+';return '+wrapper+';})()',{
  assert,Request,URL,AbortSignal,Math,started:0,workDeadlineMs:285000,
  now:()=>285000-state.remaining,abort:new AbortController(),
  networkFetch:(request,options)=>{network.push({origin:new URL(request.url).origin,signal:options.signal});return 'MOCK_NETWORK_RETURN';},
 });
 return {network,state,invoke:()=>invoke('http://127.0.0.1:18080/v3/pipeline',{method:'POST',body:'SYNTHETIC_ONLY'})};
}
test('exact prior R2 wrapper rejects a fractional remaining clock before mock network',()=>{
 const p=probe(oldSource,285000-1691.273978);
 assert.throws(p.invoke,error=>error.name==='RangeError'&&error.code==='ERR_OUT_OF_RANGE');
 assert.equal(p.network.length,0);
});
test('exact repaired wrapper uses real AbortSignal timeout and one mocked call for fractional clocks',()=>{
 for(const remaining of [285000-1691.273978,284999.875,125.999,1.25,0.25]){
  const p=probe(source,remaining);assert.equal(p.invoke(),'MOCK_NETWORK_RETURN');assert.equal(p.network.length,1);
  assert.equal(p.network[0].origin,'http://127.0.0.1:18080');assert.ok(p.network[0].signal instanceof AbortSignal);
 }
});
test('integer remaining bounds retain original one-call behavior',()=>{
 for(const remaining of [285000,1000,1]){
  for(const text of [oldSource,source]){const p=probe(text,remaining);assert.equal(p.invoke(),'MOCK_NETWORK_RETURN');assert.equal(p.network.length,1);}
 }
});
test('exact source guard refuses original work deadline, later clock and pre-start clock before network',()=>{
 for(const remaining of [0,-0.25,-1,285001]){
  const p=probe(source,remaining);assert.throws(p.invoke,/ORIGINAL_285S_WORK_BOUND_WITHIN_300S/);assert.equal(p.network.length,0);
 }
 const p=probe(source,100);p.state.remaining=0;assert.throws(p.invoke,/ORIGINAL_285S_WORK_BOUND_WITHIN_300S/);assert.equal(p.network.length,0);
});
test('source fix preserves original outer budget, reserve and every other R2 native module byte',()=>{
 assert.ok(source.includes('deadlineMs=started+PROFILE.proposedOuterMs'));
 assert.ok(source.includes('const workDeadlineMs=deadlineMs-SETTLEMENT_RESERVE_MS;'));
 assert.equal(source.replace(fixed,prior),oldSource);
 assert.equal(current.wrapper.replace(fixed,prior),old.wrapper);
});
