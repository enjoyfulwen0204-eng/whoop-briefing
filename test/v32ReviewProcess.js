import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {claimPhaseRequest} from '../src/phase4ExecutionStore.js';import {withDurableExecution} from '../src/phase4ExecutionContext.js';
const [url,body,mode]=process.argv.slice(2),request=JSON.parse(body),transport=hranaTransport(url);
const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
const wait=()=>new Promise(()=>{}),barrier=async()=>{process.send?.({event:'barrier'});await wait();};
try{
 await db.admitRuntime({fresh:true,source:request.triggerSource});
 if(mode==='allocation-death')transport.arm({before:barrier});
 const claim=await claimPhaseRequest(db,request,body,{keys:fixtureKeys,leaseMs:2000,deadlineAt:Date.now()+2000});
 if(mode==='claim'){process.send?.({event:'result',sequence:claim.executionSeq});}
 else{
  if(mode==='work-death')transport.arm({after:barrier});
  const result=await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority:{assert(){}}},()=>db.transaction(async()=>{
   await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('generic_process_counter','1','2026-10-08') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");return 1;
  },{workStep:'generic-process-counter'}));
  process.send?.({event:'result',sequence:claim.executionSeq,result});
 }
}catch(error){process.send?.({event:'result',code:error.code??error.message});process.exitCode=1;}
finally{db.close();transport.close();process.disconnect?.();}
