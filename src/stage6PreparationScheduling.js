import {setImmediate} from 'node:timers/promises';

// Per-preparation fairness only. Callers must be outside their owned atomic
// transaction. This supplies no authority, deadline extension or work receipt.
export function createPreparationScheduling(assertAuthority){
 let lastYield=performance.now(),yields=0;
 return Object.freeze({
  checkpoint(){
   if(performance.now()-lastYield<8)return;
   assertAuthority();
   return setImmediate().then(()=>{assertAuthority();lastYield=performance.now();yields++;});
  },
  statistics:()=>({yields,quantumMs:8}),
 });
}
