import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureKeys as keys} from './localDb.js';
import {assertPreparedNativeReaderAck as check} from './stage8-prepared-native-reader-ack.mjs';
const expected={pid:123,manifestDigest:'a'.repeat(64),bodyQualification:{mode:'FRESH_LIMITED',fixtureAsOfEpochMs:1000,scopeAsOfEpochMs:2000,lastFreshAt:3000,expectedItems:1,positiveLimitedQualified:true,staleExclusionQualified:false}};
function fixture(){return {contract:'r22-native-reader-only-ack-v1',pid:expected.pid,manifestDigest:expected.manifestDigest,transportJoined:true,report:{status:'NATIVE_READER_ONLY_COMPONENT_PASS',bodyQualification:structuredClone(expected.bodyQualification),nativeWorkInvocations:0,stage6HranaQualified:false,productionEvidence:false,originalFourKindReplyGuardVerified:true,retainedHealthAndOriginalAuthorityUnchanged:true,requestErrors:0,responseErrors:0,openStreams:0,pendingRequests:0,ownedMemoryPerTransaction:'UNKNOWN',kinds:[['BODY_ENERGY',1],['EPISODES',0],['EVIDENCE',8],['INSIGHTS',0]].map(([kind,items])=>({kind,items,status:'CURRENT'}))}};}
const signed=body=>({...body,seal:keys.lookup([body.contract,body])});
test('complete final joined synthetic ACK is accepted only for the exact process and source',()=>{const body=fixture();assert.deepEqual(check(signed(body),expected),body);});
test('missing or changed complete ACK seal is rejected before accepting fields',()=>{const body=fixture(),ack=signed(body);assert.throws(()=>check(body,expected),/ACK_SEAL/);ack.report.originalFourKindReplyGuardVerified=false;assert.throws(()=>check(ack,expected),/ACK_SEAL/);});
for(const field of ['pid','manifestDigest'])test('even a signed foreign '+field+' is rejected',()=>{const body=fixture();body[field]=field==='pid'?124:'b'.repeat(64);assert.throws(()=>check(signed(body),expected));});
for(const field of ['requestErrors','responseErrors','openStreams','pendingRequests'])test('a signed recovered transport failure cannot authorize ACK: '+field,()=>{const body=fixture();body.report[field]=1;assert.throws(()=>check(signed(body),expected));});
test('even a signed pass cannot widen the exact one Body result or memory observation scope',()=>{for(const mutate of [r=>r.kinds[0].items=2,r=>r.ownedMemoryPerTransaction='QUALIFIED',r=>r.nativeWorkInvocations=1,r=>r.originalFourKindReplyGuardVerified=false]){const body=fixture();mutate(body.report);assert.throws(()=>check(signed(body),expected));}});
test('expired-body ACK is a separate scope and cannot pass the positive LIMITED contract',()=>{
 const body=fixture();body.contract='r22-native-reader-expired-body-ack-v1';body.report.kinds[0].items=0;
 body.report.bodyQualification={...body.report.bodyQualification,mode:'EXPIRED_LIMITED',scopeAsOfEpochMs:3001,expectedItems:0,positiveLimitedQualified:false,staleExclusionQualified:true};
 const expired={...expected,bodyQualification:structuredClone(body.report.bodyQualification)};
 assert.deepEqual(check(signed(body),expired),body);assert.throws(()=>check(signed(body),expected));
 for(const mutation of [r=>r.kinds[0].items=1,r=>r.bodyQualification.positiveLimitedQualified=true,r=>r.bodyQualification.scopeAsOfEpochMs++]){
  const changed=structuredClone(body);mutation(changed.report);assert.throws(()=>check(signed(changed),expired));
 }
 assert.throws(()=>check(signed(body),{pid:expected.pid,manifestDigest:expected.manifestDigest}),/EXPLICIT_BODY_SCOPE_REQUIRED/);
});
