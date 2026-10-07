import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {claimPhaseRequest,commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {createExecutionBudget} from '../src/executionBudget.js';
const [url,body,variant]=process.argv.slice(2),request=JSON.parse(body),transport=hranaTransport(url);
const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys}),commands=new Map();
process.on('message',name=>{const callback=commands.get(name);if(typeof callback==='function')callback();else commands.set(name,true);});
const command=name=>commands.get(name)===true?Promise.resolve():new Promise(resolve=>commands.set(name,resolve));
const authority=createExecutionBudget({budgetMs:10000});
try{
 await db.admitRuntime();const claim=await claimPhaseRequest(db,request,body,{keys:fixtureKeys,leaseMs:10000});
 transport.arm(variant==='after-commit'?{after:async()=>{process.send({event:'committed_ack_pending'});await new Promise(()=>{});}}:
  {before:async()=>{process.send({event:'commit_pending'});await command('resume');}});
 await commitPhaseWork(db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 process.send({event:'work_committed'});await command('finalize');
 try{await finalizePhaseWork(db,request,claim,fixtureKeys,authority);process.send({event:'unexpected_success'});}
 catch(error){process.send({event:'fenced',code:error.code});}
}catch(error){process.send?.({event:'error',code:error.code});process.exitCode=1;}
finally{authority.close();db.close();transport.close();process.disconnect?.();}
