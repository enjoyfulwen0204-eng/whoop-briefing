import {installDrainChildLifecycle} from '../src/drainChildLifecycle.js';
import {issueDrainProcessAuthority} from '../src/drainProcessAuthority.js';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
import {stage6CapacityStatus} from '../src/stage6CapacityRuntime.js';
import {linuxMetrics} from './stage6LinuxMetrics.mjs';
installDrainChildLifecycle({execute:async({request,body,slot,control,notify,environment,env})=>{
 if(request.executionMode!=='SHADOW'||environment.PHASE4_BETA_PILOT_USER_ID!=='a')throw Error('ISOLATED_SYNTHETIC_CHILD_ONLY');
 const metrics=linuxMetrics(),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{if(new URL(r.url).hostname!=='isolated.invalid')throw Error('ISOLATED_SYNTHETIC_ONLY');return fetch('http://fixture:8080/v2/pipeline',{method:'POST',headers:{'x-synthetic-role':'drain-child'},body:await r.text(),signal:r.signal});}});
 try{const processAuthority=issueDrainProcessAuthority({db,keys:fixtureKeys,userId:'a',request,slot,control,notify});
  const result=await runExecutionPhase({request,body,db,keys:fixtureKeys,environment,env,signal:control.signal,processAuthority});await db.close();return {result,scopes:receiverScopeStatistics(),metrics:metrics.snapshot(),capacity:stage6CapacityStatus()};
 }finally{await db.close();metrics.close();}
}});
