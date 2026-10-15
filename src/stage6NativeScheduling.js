import {setImmediate} from 'node:timers/promises';

/** Fairness for the privately owned synchronous native RAM receiver. A SQL
 * operation finishes before yielding; the processing root still owns its
 * transaction and performs all original post-ACK fences. No timeout, result,
 * owner, admission, receipt or transaction boundary is changed here. */
export function createNativeReceiverScheduling(){
 let last=performance.now();
 return async()=>{
  if(performance.now()-last<8)return;
  await setImmediate();last=performance.now();
 };
}
export function scheduleNativeReceiverExecutor(executor,pause){
 for(const name of ['execute','batch']){
  const run=executor[name].bind(executor);
  executor[name]=async(...args)=>{const result=await run(...args);await pause();return result;};
 }
 return executor;
}
