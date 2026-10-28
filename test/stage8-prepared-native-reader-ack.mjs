// Synthetic native qualification ACK validation only; no runtime authority.
import assert from 'node:assert/strict';
import {fixtureKeys as keys} from './localDb.js';
export function assertPreparedNativeReaderAck(ack,{pid,manifestDigest}){
 const {seal,...body}=ack??{};
 assert.equal(seal,keys.lookup(['r22-native-reader-only-ack-v1',body]),'COMPLETE_NATIVE_READER_ACK_SEAL');
 assert.equal(body.contract,'r22-native-reader-only-ack-v1');assert.equal(body.pid,pid);assert.equal(body.manifestDigest,manifestDigest);assert.equal(body.transportJoined,true);
 const r=body.report;assert.equal(r.status,'NATIVE_READER_ONLY_COMPONENT_PASS');assert.equal(r.nativeWorkInvocations,0);assert.equal(r.stage6HranaQualified,false);assert.equal(r.productionEvidence,false);
 assert.equal(r.originalFourKindReplyGuardVerified,true);assert.equal(r.retainedHealthAndOriginalAuthorityUnchanged,true);
 assert.equal(r.requestErrors,0);assert.equal(r.responseErrors,0);assert.equal(r.openStreams,0);assert.equal(r.pendingRequests,0);assert.equal(r.ownedMemoryPerTransaction,'UNKNOWN');
 assert.equal(r.kinds.length,4);
 for(const [i,[kind,count]] of [['BODY_ENERGY',1],['EPISODES',0],['EVIDENCE',8],['INSIGHTS',0]].entries()){
  assert.equal(r.kinds[i].kind,kind);assert.equal(r.kinds[i].status,'CURRENT');assert.equal(r.kinds[i].items,count);
 }
 return body;
}
