import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {runningReleaseSha,cliTriggerSource} from '../src/phase4Release.js';import {configurationProof} from '../src/phase4ExecutionStore.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
test('R2 release: missing/malformed/tampered SHA rejects before admission; actual checkout pin is independently enforced',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-release-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:32});let admissions=0;
 const admit=db.admitRuntime;db.admitRuntime=async(...a)=>{admissions++;return admit(...a);};
 const sha=runningReleaseSha(),value={requestId:randomUUID(),releaseSha:sha,phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)};
 for(const releaseSha of [undefined,'',sha.toUpperCase(),'malformed','a'.repeat(40)])await assert.rejects(()=>runExecutionPhase({db,request:{...value,releaseSha},environment,env:{},keys:fixtureKeys}),/RELEASE_IDENTITY_INVALID|RELEASE_CHECKOUT_MISMATCH/);
 await assert.rejects(()=>runExecutionPhase({db,request:value,environment:{...environment,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'push'},env:{},keys:fixtureKeys}),/GITHUB_SOURCE_UNSUPPORTED/);
 await assert.rejects(()=>runExecutionPhase({db,request:value,environment:{...environment,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'schedule'},env:{},keys:fixtureKeys}),/GITHUB_SOURCE_UNSUPPORTED/);
 assert.equal(admissions,0);assert.equal(runningReleaseSha({PHASE4_RELEASE_SHA:sha}),sha);
 assert.throws(()=>runningReleaseSha({PHASE4_RELEASE_SHA:'a'.repeat(40)}),/RELEASE_CHECKOUT_MISMATCH/);
 assert.throws(()=>runningReleaseSha({PHASE4_RELEASE_SHA:'REVIEWED_RELEASE_SHA'}),/RELEASE_IDENTITY_INVALID/);
 assert.throws(()=>runningReleaseSha({GITHUB_ACTIONS:'true'}),/RELEASE_PIN_REQUIRED/);
 assert.notEqual(configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment,sha),configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment,'a'.repeat(40)));
});
test('R2 dispatch: only schedule/workflow_dispatch accepted in GitHub context; malformed source cannot claim manual policy',()=>{
 assert.equal(cliTriggerSource({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'schedule'}),'github');assert.equal(cliTriggerSource({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch'}),'manual');
 for(const event of [undefined,'','Schedule','WORKFLOW_DISPATCH','push','pull_request','repository_dispatch','arbitrary'])assert.throws(()=>cliTriggerSource({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:event}),e=>e.code==='GITHUB_SOURCE_UNSUPPORTED');
 for(const key of ['GITHUB_RUN_ID','GITHUB_SHA','GITHUB_JOB'])assert.throws(()=>cliTriggerSource({[key]:'synthetic'}),/GITHUB_SOURCE_UNSUPPORTED/);
 assert.equal(cliTriggerSource({}),'manual');assert.throws(()=>cliTriggerSource({GITHUB_EVENT_NAME:'schedule'}),/GITHUB_SOURCE_UNSUPPORTED/);
});
