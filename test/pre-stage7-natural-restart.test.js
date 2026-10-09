import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {runningReleaseSha} from '../src/phase4Release.js';import {configurationProof,readExecution} from '../src/phase4ExecutionStore.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
test('SIGKILL: natural durable deadline permits same-request CAS takeover despite retained 225s lease',async t=>{
 const dir=await mkdtemp('/private/tmp/pre-stage7-restart-'),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});await seed.migrate({targetVersion:32});await seed.createUser({id:'alice',displayName:'Initial',status:'ACTIVE'});await seed.close();
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const child=fork(new URL('./preStage7KilledOwner.js',import.meta.url),[url,JSON.stringify(request)],{stdio:['ignore','ignore','pipe','ipc']});let logs='';child.stderr.on('data',x=>logs+=x);
 t.after(()=>{try{child.kill('SIGKILL');}catch{}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHILD_BARRIER_TIMEOUT '+logs)),20000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
 const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
 const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 const old=await readExecution(db,request.requestId);assert.ok(old.lease_until>Date.now()+100000);assert.equal((await db.getUser('alice')).displayName,'Committed');
 await new Promise(r=>setTimeout(r,Math.max(0,old.deadline_at-Date.now()+30)));
 const options={request,db,keys:fixtureKeys,environment,env:{dryRun:true},budgetMs:3000,deps:{runBriefing:async()=>{await db.updateUser('alice',{displayName:'Committed'});return {syncComplete:true,syncOutcome:'COMPLETE_SUCCESS',users:1,failed:0};}}};
 const result=await runExecutionPhase(options);assert.equal(result.status,200,JSON.stringify(result));assert.equal((await readExecution(db,request.requestId)).generation,old.generation+1);assert.deepEqual(await runExecutionPhase(options),result);
});
