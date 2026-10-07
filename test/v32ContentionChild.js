// Stock supported driver and a real OS process; synthetic file only.
import {createClient} from '@libsql/client';
import {composeDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
const [url,role]=process.argv.slice(2);
if(!url?.startsWith('file:')||!['holder','contender'].includes(role))throw Error('ISOLATED_CONTENTION_ONLY');
const base=createClient({url}),native=base.transaction.bind(base);
let busy=0,reconnects=0,callbacks=0;
const reconnect=base.reconnect.bind(base);
base.reconnect=async()=>{reconnects++;return reconnect();};
base.transaction=async(...args)=>{try{return await native(...args);}catch(e){if(e.code==='SQLITE_BUSY'){busy++;process.send({event:'busy'});}throw e;}};
const db=composeDb(base,{phase4Keys:fixtureKeys}),capability=await db.admitRuntime();
const budget=createExecutionBudget({budgetMs:8000});
process.send({event:'ready'});
await new Promise(resolve=>process.once('message',resolve));
try{
 await withExecutionBudget(budget,()=>db.transaction(async()=>{
  callbacks++;await db.raw.execute("UPDATE telegram_state SET value=CAST(value AS INTEGER)+1 WHERE key='isolated_counter'");
  if(role==='holder'){process.send({event:'work_pending'});await new Promise(()=>{});}
 }));
 let oldRejected=false;try{db.requireRuntimeAdmission(capability);}catch{oldRejected=true;}
 const fresh=await db.admitRuntime();db.requireRuntimeAdmission(fresh);
 process.send({event:'complete',callbacks,busy,reconnects,oldRejected});
}catch(error){process.send({event:'error',code:error.code});process.exitCode=1;}
finally{budget.close();db.close();process.disconnect();}
