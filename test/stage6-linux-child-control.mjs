// Qualification only: original monitored grants, a retained synthetic DB,
// and a finite controller that always reaps every child it creates.
import test from 'node:test';import assert from 'node:assert/strict';
import {fork} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {linuxMetrics} from './stage6LinuxMetrics.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const control of ['SIGTERM','disconnect'])test(`admitted synthetic child retires after ${control}`,async t=>{
 const metrics=linuxMetrics(),identity=await(await fetch('http://fixture:8080/qualification/resume')).json();
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{assert.equal(new URL(r.url).hostname,'isolated.invalid');return fetch('http://fixture:8080/v2/pipeline',{method:'POST',body:await r.text(),signal:r.signal});}});
 let child,exited,spawnError;
 t.after(async()=>{
  try{if(child?.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   if(exited)assert.ok(await Promise.race([exited,pause(2000).then(()=>null)]),'finite child reap required');
  }finally{try{await db.close();}finally{console.log('LINUX_CHILD_CONTROL_CLEANUP '+JSON.stringify({control,metrics:metrics.snapshot()}));metrics.close();}}
 });
 const environment={PHASE4_RELEASE_SHA:runningReleaseSha(),PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:identity.pilotStartAt,PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow'};
 const parent=(await db.raw.execute({sql:'SELECT identity_digest FROM phase4_executions WHERE execution_id=?',args:[identity.handoffRequest.requestId]})).rows[0];
 assert.ok(parent);const original=identity.handoffRequest,originalBody=JSON.stringify(Object.fromEntries(['requestId','releaseSha','phase','triggerSource','executionMode','configProof'].map(k=>[k,original[k]])));
 assert.equal(createHash('sha256').update(originalBody).digest('hex'),parent.identity_digest);
 const parentReplay=await runExecutionPhase({request:original,body:originalBody,db,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true}});
 assert.equal(parentReplay.status,200);const handoff=parentReplay.body.handoff;assert.equal(typeof handoff,'string');
 const request={requestId:randomUUID(),releaseSha:runningReleaseSha(),phase:'STAGE6_DRAIN',triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment),syncRequestId:identity.handoffRequest.requestId,handoff};
 const attempts=async()=>JSON.parse((await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail).attempts;
 const before=await attempts();child=fork(new URL('./stage6LinuxDrainChild.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 exited=new Promise(resolve=>{child.once('close',(code,signal)=>resolve({code,signal}));child.on('error',error=>{spawnError=error;if(!child.pid)resolve({spawnError:error.code??error.name});});});
 child.send({request,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'synthetic',telegramChatId:'synthetic'}});
 const admissionAt=performance.now();let admitted=false;
 while(performance.now()-admissionAt<12000&&!spawnError&&child.exitCode===null&&child.signalCode===null){if(await attempts()>before){admitted=true;break;}await pause(50);}
 assert.equal(admitted,true,'control must interrupt genuine admission, not an invalid request');
 const at=performance.now();if(control==='disconnect')child.disconnect();else child.kill('SIGTERM');
 const termination=await Promise.race([exited,pause(1500).then(()=>null)]);
 console.log('LINUX_CHILD_CONTROL '+JSON.stringify({control,admitted,terminated:Boolean(termination),termination,elapsedMs:performance.now()-at,forcedCleanup:!termination}));
 assert.ok(termination,'admitted child must not silently outlive a retired control channel');
});
