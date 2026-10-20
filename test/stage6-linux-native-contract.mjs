// Pure qualification contract; importing never inspects the host or starts work.
import assert from 'node:assert/strict';
export const NATIVE_NODE='v22.23.2';
export const NATIVE_LIMITS=Object.freeze({memoryBytes:536870912,cpuQuota:50000,cpuPeriod:100000,maximumCalls:24,wallMs:900000,transactionUpperBoundMs:5000,addedHttpLatencyMs:115});
export function assertNativeResources(value){
 assert.equal(value.node,NATIVE_NODE,'EXACT_PRODUCTION_NODE_REQUIRED');
 assert.equal(value.platform,'linux','ACTUAL_LINUX_REQUIRED');
 assert.ok(['x64','arm64'].includes(value.architecture),'EXPLICIT_SUPPORTED_NATIVE_ARCH_REQUIRED');
 const host=value.nativeHost,normalize=v=>({x64:'x64',amd64:'x64',x86_64:'x64',X64:'x64',arm64:'arm64',aarch64:'arm64',ARM64:'arm64'})[v];
 assert.equal(host?.contract,'stage6-native-host-observation-v1');assert.equal(host.platform,'linux');
 for(const field of ['machine','dockerArchitecture','imageArchitecture','runnerArchitecture'])assert.equal(normalize(host[field]),value.architecture,'MEASURED_HOST_IMAGE_ARCHITECTURES_MUST_MATCH');
 assert.equal(host.requestedPlatform,'linux/'+(value.architecture==='x64'?'amd64':'arm64'));
 assert.match(host.candidateSha??'',/^[a-f0-9]{40}$/);
 assert.equal(value.memoryMax,String(NATIVE_LIMITS.memoryBytes));assert.equal(value.swapMax,'0');
 assert.equal(value.cpuMax,'50000 100000');assert.deepEqual(value.interfaces,['lo']);
 assert.match(value.memoryPeak??'',/^[0-9]+$/);assert.ok(Number(value.memoryPeak)>0&&Number(value.memoryPeak)<=NATIVE_LIMITS.memoryBytes);
 const events=Object.fromEntries(String(value.memoryEvents??'').split('\n').filter(Boolean).map(x=>x.trim().split(/\s+/)));for(const key of ['oom','oom_kill'])assert.equal(events[key],'0','NO_CGROUP_OOM_REQUIRED');
 return true;
}
export function assertJoinedNativeTransactions(http){
 assert.ok(http.requests>0&&http.transactions.length>0,'ACTUAL_HTTP_AND_TRANSACTIONS_REQUIRED');
 assert.equal(http.requestErrors,0,'NO_HTTP_REQUEST_ERRORS');assert.equal(http.responseErrors,0,'NO_NATIVE_RESPONSE_ERRORS');
 assert.equal(http.openTransactions,0,'ALL_NATIVE_TRANSACTIONS_JOINED');assert.equal(http.droppedTransactions,0,'COMPLETE_TRANSACTION_TRACE_REQUIRED');
 for(const tx of http.transactions){assert.ok(['COMMIT','ROLLBACK'].includes(tx.outcome),'TERMINAL_NATIVE_TRANSACTION_REQUIRED');assert.ok(Number.isFinite(tx.durationUpperBoundMs)&&tx.durationUpperBoundMs>=0&&tx.durationUpperBoundMs<NATIVE_LIMITS.transactionUpperBoundMs,'OBSERVED_NATIVE_TRANSACTION_BELOW_5S_REQUIRED');}
 return true;
}
export function assertNativeEmptyCompletion(report){
 assert.equal(report.productionEvidence,false);assertNativeResources(report.resources);
 assert.ok(Number.isSafeInteger(report.callsStarted)&&report.callsStarted>=2&&report.callsStarted<=NATIVE_LIMITS.maximumCalls);
 assert.ok(report.elapsedMs>0&&report.elapsedMs<NATIVE_LIMITS.wallMs,'ORIGINAL_WALL_BOUND_REQUIRED');
 assert.equal(report.originalJobsCompleted,2);assert.equal(report.currentPublications,1);assert.equal(report.currentComputation,true);
 assert.equal(report.coldProcessRestart,true);assert.equal(report.exactOriginalIdentityReplay,true);assert.equal(report.replayPreservedCanonicalMetadata,true);
 assert.equal(report.sourceRows,0);assert.equal(report.outboundMessages,0);assert.equal(report.pilotLedgers,0);
 assert.deepEqual(report.typedCurrentKinds,['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']);
 assertJoinedNativeTransactions(report.producerHttp);assertJoinedNativeTransactions(report.restartHttp);
 assert.equal(report.serverEnforcedAbsoluteTransactionLimit,'UNKNOWN');assert.equal(report.productionAmd64Qualified,false);
 return true;
}

// A missing next baton is not a terminal witness. Retain the orphan observation
// and fail the gate rather than silently removing an active native transaction.
export function retainNativeBatonObservation(streams,{priorBaton,nextBaton,stream,http,finishedMono}){
 if(priorBaton)streams.delete(priorBaton);
 if(nextBaton)streams.set(nextBaton,stream);
 else if(stream.transaction){
  http.droppedTransactions++;
  if(http.transactions.length<16384)http.transactions.push({phase:stream.transaction.phase??'UNKNOWN',outcome:'BATON_LOST_UNRESOLVED',durationUpperBoundMs:finishedMono-stream.transaction.startedMono});
  streams.set(Symbol('UNRESOLVED_NATIVE_TRANSACTION'),stream);
 }
 http.openTransactions=[...new Set(streams.values())].filter(s=>s.transaction).length;
}
