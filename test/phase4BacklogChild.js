import {fixtureKeys} from './localDb.js';
import {createOwnedDb as createDb} from './stage5OwnedDb.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
const [url,raw]=process.argv.slice(2),request=JSON.parse(raw),db=createDb({url});
const admission=await db.admitRuntime();
const worker=await createPhase4Stage6({db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
const execute=db.raw.execute;let stopped=false;
db.raw.execute=async statement=>{
 const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
 if(!stopped&&/^UPDATE phase4_jobs SET full_scan_cursor=/i.test(sql)){
  stopped=true;db.afterProcessingCommit(async()=>{process.send?.({event:'committed_checkpoint'});await new Promise(()=>{});});
 }
 return result;
};
try{await runExecutionPhase({request,db,keys:fixtureKeys,environment:{PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'},
 env:{dryRun:true},now:new Date('2026-10-07T12:00:00Z'),deps:{runtime:{phase4Stage6:{drain:options=>worker.drain({...options,budget:{maxWallMs:3000,safetyMarginMs:1000,leaseMs:3000}})}}}});
 process.send?.({event:'unexpected_finish'});
}catch(e){process.send?.({event:'error',code:e.code,message:e.message});}
finally{await db.close();process.disconnect?.();}
