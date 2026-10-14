// Local execution-isolation experiment only. Original grant issuance, budget,
// named ACK, fencing and settlement occur in this receiver's real runtime.
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
process.once('message',async({request,environment,env})=>{
 let db;try{
  if(process.platform!=='linux'||request?.phase!=='STAGE6_DRAIN'||request.executionMode!=='SHADOW'||environment?.PHASE4_BETA_PILOT_USER_ID!=='a')throw Error('SYNTHETIC_ISOLATION_ONLY');
  db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{if(new URL(r.url).hostname!=='isolated.invalid')throw Error('SYNTHETIC_ONLY');return fetch('http://fixture:8080/v2/pipeline',{method:'POST',body:await r.text(),signal:r.signal});}});
  const result=await runExecutionPhase({request,environment,env,db,keys:fixtureKeys});await db.close();db=null;process.send({result,scopes:receiverScopeStatistics()},()=>process.disconnect());
 }catch(e){await db?.close();process.send({error:e.code??e.name},()=>process.disconnect());}
});
