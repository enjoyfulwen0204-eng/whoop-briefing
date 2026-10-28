import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
import {assertPreparedNativeFinalObservation} from './stage8-prepared-native-final-observation.mjs';
function transaction(observer,phase,start,end){
 const begin={requests:[{type:'execute',stmt:{sql:'BEGIN'}}]},commit={baton:'owned',requests:[{type:'execute',stmt:{sql:'COMMIT'}}]};
 observer.acknowledged(observer.submitted(begin,phase,start),{baton:'owned',results:[{type:'ok',response:{type:'execute'}}]},start+1);
 observer.acknowledged(observer.submitted(commit,phase,end-1),{baton:null,results:[{type:'ok',response:{type:'execute'}}]},end);
}
test('late VERIFY transaction cannot escape the final bound after early work check passed',()=>{
 const observer=createPreparedNativeObserver();transaction(observer,'WORK_1',0,100);observer.assertComplete('WORK_1');
 transaction(observer,'VERIFY',200,5200);assert.throws(()=>assertPreparedNativeFinalObservation(observer,0),/EVERY_RUNTIME_PHASE_BELOW_5S/);
});
test('unknown close reply after earlier complete phases still vetoes final acceptance',()=>{
 const observer=createPreparedNativeObserver();transaction(observer,'WORK_1',0,100);assertPreparedNativeFinalObservation(observer,0);
 const close={requests:[{type:'close'}]};observer.acknowledged(observer.submitted(close,'VERIFY',101),{results:[{type:'ok',response:{type:'unexpected'}}]},102);
 assert.throws(()=>assertPreparedNativeFinalObservation(observer,0),/NATIVE_OBSERVATION_unknownReplies/);
});
test('every observed runtime phase is included while setup duration is separately classified',()=>{
 const observer=createPreparedNativeObserver();transaction(observer,'SETUP',0,9000);transaction(observer,'WORK_1',10000,10100);transaction(observer,'VERIFY',10200,10300);transaction(observer,'READER_a',10400,10500);
 assert.deepEqual(assertPreparedNativeFinalObservation(observer,0),['WORK_1','VERIFY','READER_a']);assert.throws(()=>assertPreparedNativeFinalObservation(observer,1),/NATIVE_PENDING_REQUESTS/);
});
