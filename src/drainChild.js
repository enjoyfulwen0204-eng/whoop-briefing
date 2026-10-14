import {installDrainChildLifecycle} from './drainChildLifecycle.js';
import {issueDrainProcessAuthority} from './drainProcessAuthority.js';
import {createDb} from './db.js';
import {loadEnv} from './config.js';
import {publicBetaKeys} from './publicBetaConfig.js';
import {betaPilotConfiguration} from './betaPilotPermit.js';
import {runExecutionPhase} from './phase4Execution.js';
import {receiverScopeStatistics} from './receiverScopeLifetime.js';
installDrainChildLifecycle({execute:async({request,body,slot,control,notify})=>{
 const environment=process.env,env=loadEnv(),keys=publicBetaKeys(environment),config=betaPilotConfiguration(environment);
 const db=createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 try{const processAuthority=issueDrainProcessAuthority({db,keys,userId:config.userId,request,slot,control,notify});
  const result=await runExecutionPhase({request,body,db,keys,environment,env,signal:control.signal,processAuthority});await db.close();return {result,scopes:receiverScopeStatistics()};
 }finally{await db.close();}
}});
