import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '../src/phase4EntityStore.js';
import {bodySha256} from '../src/briefingTriggerAuth.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {fixtureKeys as keys} from './localDb.js';
import {nativePreparedResultDigest} from './stage8-prepared-native-result.mjs';
test('original result and verified persisted canonical replay retain the same semantic identity',()=>{
 const request={contract:'stage8-live-producer-v1',tenantScope:'synthetic-scope'},canonicalRequest=canonicalJson(request),identity=bodySha256(canonicalRequest);
 const payload={version:2,identity,releaseSha:'a'.repeat(40),phase:'STAGE6_DRAIN',source:'manual',executionMode:'LIVE',configProof:'b'.repeat(64),outcome:'PARTIAL',itemsProcessed:2,unitsCommitted:10,jobsCompleted:0};
 const result={...payload,signature:keys.lookup(['stage8-live-execution-result-v1',request.tenantScope,canonicalJson(payload)])},json=canonicalJson(result);
 const replay=verifyLiveExecutionResult(keys,{result_json:json,result_digest:bodySha256(json),canonical_request_json:canonicalRequest,identity_digest:identity,release_sha:payload.releaseSha,config_proof:payload.configProof,phase:payload.phase,trigger_source:payload.source,execution_mode:'LIVE'});
 assert.deepEqual(replay,result);assert.notEqual(JSON.stringify(result),JSON.stringify(replay));assert.equal(nativePreparedResultDigest(replay),nativePreparedResultDigest(result));
 assert.notEqual(nativePreparedResultDigest({...replay,unitsCommitted:11}),nativePreparedResultDigest(result),'actual payload modification must not match');
});
