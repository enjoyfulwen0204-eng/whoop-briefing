// Synthetic native qualification ACK validation only; no runtime authority.
import assert from 'node:assert/strict';
import {fixtureKeys as keys} from './localDb.js';
export function assertPreparedNativeReaderAck(ack,{pid,manifestDigest,bodyQualification}){
 assert.ok(['FRESH_LIMITED','EXPIRED_LIMITED'].includes(bodyQualification?.mode),'EXPLICIT_BODY_SCOPE_REQUIRED');
 const contract=bodyQualification.mode==='EXPIRED_LIMITED'?'r22-native-reader-expired-body-ack-v1':'r22-native-reader-only-ack-v1';
 const {seal,...body}=ack??{};
 assert.equal(seal,keys.lookup([contract,body]),'COMPLETE_NATIVE_READER_ACK_SEAL');
 assert.equal(body.contract,contract);assert.equal(body.pid,pid);assert.equal(body.manifestDigest,manifestDigest);assert.equal(body.transportJoined,true);
 const r=body.report;assert.equal(r.status,'NATIVE_READER_ONLY_COMPONENT_PASS');assert.equal(r.nativeWorkInvocations,0);assert.equal(r.stage6HranaQualified,false);assert.equal(r.productionEvidence,false);
 assert.deepEqual(r.bodyQualification,bodyQualification,'ORIGINAL_BODY_FRESHNESS_SCOPE');
 assert.equal(r.originalFourKindReplyGuardVerified,true);assert.equal(r.retainedHealthAndOriginalAuthorityUnchanged,true);
 assert.equal(r.requestErrors,0);assert.equal(r.responseErrors,0);assert.equal(r.openStreams,0);assert.equal(r.pendingRequests,0);assert.equal(r.ownedMemoryPerTransaction,'UNKNOWN');
 assert.equal(r.kinds.length,4);
 for(const [i,[kind,count]] of [['BODY_ENERGY',bodyQualification.mode==='EXPIRED_LIMITED'?0:1],['EPISODES',0],['EVIDENCE',8],['INSIGHTS',0]].entries()){
  assert.equal(r.kinds[i].kind,kind);assert.equal(r.kinds[i].status,'CURRENT');assert.equal(r.kinds[i].items,count);
 }
 return body;
}
