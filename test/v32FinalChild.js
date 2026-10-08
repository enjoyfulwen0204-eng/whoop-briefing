import {createDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {claimPhaseRequest} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
const [url,body,step,mode]=process.argv.slice(2),request=JSON.parse(body),transport=hranaTransport(url);
const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});let callbacks=0;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await db.admitRuntime({fresh:true});let claim;
 for(let attempt=0;attempt<30;attempt++){
  try{claim=await claimPhaseRequest(db,request,body,{keys:fixtureKeys,leaseMs:1200,deadlineAt:Date.now()+1200});break;}
  catch(error){if(error.code!=='REQUEST_PENDING')throw error;await pause(100);}
 }
 if(!claim)throw Error('BOUNDED_PENDING_TIMEOUT');
 if(mode==='kill')transport.arm({matchSql:/UPDATE user_notification_preferences SET preference_version/,after:async()=>{process.send?.({event:'committed',callbacks});await new Promise(()=>{});}});
 const result=await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority:{assert(){}}},()=>db.transaction(async()=>{
  callbacks++;await db.raw.execute("UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='counter'");return 17;
 },{workStep:step}));
 process.send?.({event:'result',result,callbacks});
}catch(error){process.send?.({event:'result',code:error.code??error.message,callbacks});process.exitCode=1;}
finally{db.close();transport.close();process.disconnect?.();}
