#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { loadDotEnvIfPresent } from '../src/config.js';
import { publicBetaConfiguration, publicBetaKeys } from '../src/publicBetaConfig.js';
import { configurationProof, requirePhase } from '../src/phase4ExecutionStore.js';
import { cliTriggerSource, runningReleaseSha } from '../src/phase4Release.js';
import { runExecutionPhase } from '../src/phase4Execution.js';
loadDotEnvIfPresent();
try {
 if(Number(process.versions.node.split('.')[0])<22)throw new Error('NODE_22_REQUIRED');
 const triggerSource=cliTriggerSource(process.env),releaseSha=runningReleaseSha(process.env);
 const phase=requirePhase(process.env.PHASE4_EXECUTION_PHASE),config=publicBetaConfiguration(process.env),keys=publicBetaKeys(process.env);
 const base=process.env.GITHUB_RUN_ID?`gh_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT??1}`:randomUUID();
 const request={releaseSha,requestId:`${base}_${phase.toLowerCase()}`,phase,triggerSource,executionMode:config.runtime==='on'?'SHADOW':'OFF',
   configProof:configurationProof(keys,config,process.env,releaseSha),
   ...(phase==='STAGE6_DRAIN'?{syncRequestId:process.env.PHASE4_SYNC_REQUEST_ID,handoff:process.env.PHASE4_SYNC_HANDOFF}:{})};
 const result=await runExecutionPhase({request});
 if(phase==='SYNC'&&process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
   `sync_complete=${result.body.syncComplete===true}\ndrain_authorized=${result.body.drainAuthorized===true}\nsync_request_id=${request.requestId}\nsync_handoff=${result.body.handoff??''}\n`);
 const r=result.body.result;
 console.log(JSON.stringify({event:'phase4_cli_complete',ok:result.body.ok,phase,releaseSha,source:triggerSource,
   outcome:r.outcome,syncComplete:result.body.syncComplete,drainAuthorized:result.body.drainAuthorized,
   durationMs:r.durationMs,jobsCompleted:r.jobsCompleted,itemsProcessed:r.itemsProcessed,remainingJobs:r.remainingJobs}));
 process.exitCode=result.body.ok?0:1;
}catch(error){console.error(JSON.stringify({event:'phase4_cli_failed',code:error?.code??'PHASE4_EXECUTION_FAILED'}));process.exitCode=1;}
