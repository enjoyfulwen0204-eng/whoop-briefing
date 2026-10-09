import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {claimPhaseRequest,abortPhaseExecution,readExecution,configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {runningReleaseSha} from '../src/phase4Release.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
const request=()=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)});
test('no business receipt: temporary timeout preserves ESTABLISHED; live owner and conflicting body cannot be adopted',async t=>{
 const {db}=await deliveryFixture(t),r=request(),body=JSON.stringify(r);await db.admitRuntime();
 const claim=await claimPhaseRequest(db,r,body,{keys:fixtureKeys,deadlineAt:Date.now()+10000});
 await assert.rejects(()=>claimPhaseRequest(db,r,body,{keys:fixtureKeys}),/REQUEST_PENDING/);
 await assert.rejects(()=>claimPhaseRequest(db,{...r,executionMode:'SHADOW'},JSON.stringify({...r,executionMode:'SHADOW'}),{keys:fixtureKeys}),/REQUEST_ID_CONFLICT/);
 await abortPhaseExecution(db,claim,'TIMEOUT',{resumable:true});
 const row=await readExecution(db,r.requestId);assert.equal(row.state,'ESTABLISHED');
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n,0);
 const next=await claimPhaseRequest(db,r,body,{keys:fixtureKeys});assert.equal(next.generation,claim.generation+1);assert.notEqual(next.owner,claim.owner);
 await abortPhaseExecution(db,claim,'FAILED');assert.equal((await readExecution(db,r.requestId)).owner,next.owner,'stale cleanup cannot revoke successor');
});
