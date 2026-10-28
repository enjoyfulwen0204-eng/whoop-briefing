import assert from 'node:assert/strict';
// Run after physical transport joins too: a late verification or close reply
// must veto the gate even after an earlier work-phase check succeeded.
export function assertPreparedNativeFinalObservation(observer,pending){
 assert.equal(observer.streams.size,0,'NATIVE_STREAMS_NOT_JOINED');assert.equal(pending,0,'NATIVE_PENDING_REQUESTS');
 const phases=Object.keys(observer.counts.begins).filter(name=>name!=='SETUP');assert.ok(phases.length>0,'RUNTIME_OBSERVATION_REQUIRED');
 for(const phase of phases){const actual=observer.assertComplete(phase);assert.ok(actual.every(t=>t.outcome==='COMMIT'&&t.upperBoundMs<5000),'EVERY_RUNTIME_PHASE_BELOW_5S');}
 return phases;
}
