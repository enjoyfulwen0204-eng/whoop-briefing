// Synthetic observation only. Never dispatch, retry, close or alter any SQL.
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function nativeTraceSummary(snapshot){
 const bins=Object.values(snapshot.bins),transactions=bins.map(b=>b.transactions);
 return {
  requests:bins.reduce((n,b)=>n+b.requests,0),
  requestErrors:bins.reduce((n,b)=>n+b.requestErrors,0),
  responseErrors:bins.reduce((n,b)=>n+b.responseErrors,0),
  begun:transactions.reduce((n,t)=>n+t.begun,0),
  committed:transactions.reduce((n,t)=>n+t.committed,0),
  rolledBack:transactions.reduce((n,t)=>n+t.rolledBack,0),
  unknownTerminal:transactions.reduce((n,t)=>n+t.unknownTerminal,0),
  atOrAbove5s:transactions.reduce((n,t)=>n+t.atOrAbove5s,0),
  maxDurationUpperBoundMs:Math.max(0,...transactions.map(t=>t.maxDurationUpperBoundMs)),
  inflightRequests:snapshot.inflightRequests,
  pendingAcknowledgedBegins:snapshot.pendingAcknowledgedBegins,
  unsettledTransactions:snapshot.unsettledTransactions,
  attributionDroppedObservations:snapshot.droppedObservations,
  physicalTerminalObservationComplete:snapshot.physicalTerminalObservationComplete,
  allTransactionTerminalsKnown:snapshot.allTransactionTerminalsKnown,
  transactionSamples:snapshot.transactionSamples,
  droppedTransactionSamples:snapshot.droppedTransactionSamples,
  transactionSampleCoverageComplete:snapshot.transactionSampleCoverageComplete,
  ...snapshot.adapter,
  adapterDroppedObservations:snapshot.adapter.droppedObservations,
  serverEnforcedAbsoluteTransactionLimit:'UNKNOWN',productionEvidence:false,wholeRuntimeQualified:false,
 };
}

export function nativeTraceJoined(snapshot){
 const s=nativeTraceSummary(snapshot);
 return s.physicalTerminalObservationComplete===true&&s.allTransactionTerminalsKnown===true
  &&s.terminalComplete===true&&s.activeFetches===0&&s.retainedStreams===0&&s.unresolvedStreams===0
  &&s.attributionDroppedObservations===0&&s.adapterDroppedObservations===0&&s.unknownProtocolReplies===0&&s.inflightRequests===0
  &&s.pendingAcknowledgedBegins===0&&s.unsettledTransactions===0;
}

// The client must be closed by its owner first. Waiting never grants a cleanup
// SQL authority and never treats server process exit as a stream witness.
export async function awaitNativeTraceJoined(trace,{now=()=>performance.now(),wait=sleep}={}){
 const deadline=now()+3000;let quietTurns=0,previousCounters;
 for(;;){
  const remaining=deadline-now();
  if(remaining<=0){const error=Error('SYNTHETIC_NATIVE_STREAMS_NOT_JOINED');error.trace=nativeTraceSummary(trace.snapshot());throw error;}
  // close() and the locked driver's decode/flush chain schedule later work.
  // Never return a synchronous empty snapshot before those turns can dispatch.
  await wait(Math.min(10,remaining));
  const snapshot=trace.snapshot(),s=nativeTraceSummary(snapshot);
  const counters=[s.requests,s.transportInvocations,s.responsesObserved,s.begun,s.committed,s.rolledBack].join(':');
  quietTurns=nativeTraceJoined(snapshot)?(counters===previousCounters?quietTurns+1:1):0;
  previousCounters=counters;
  if(quietTurns>=3&&now()<=deadline)return snapshot;
 }
}

export function assertNativeObservedTransactions(snapshot){
 const s=nativeTraceSummary(snapshot);
 assert.equal(nativeTraceJoined(snapshot),true,'all observed Hrana streams must physically join');
 assert.ok(s.requests>0&&s.begun>0,'native request and transaction observations required');
 assert.equal(s.requestErrors,0);assert.equal(s.responseErrors,0);assert.equal(s.unknownTerminal,0);
 assert.equal(s.begun,s.committed+s.rolledBack);
 assert.equal(s.atOrAbove5s,0,'each observed native transaction upper bound must be below 5s');
 assert.ok(Number.isFinite(s.maxDurationUpperBoundMs)&&s.maxDurationUpperBoundMs>=0&&s.maxDurationUpperBoundMs<5000);
 return s;
}

export function throwNativeCloseFailures(joinError,shutdownError){
 if(joinError&&shutdownError)throw new AggregateError([joinError,shutdownError],'SYNTHETIC_NATIVE_TRACE_AND_SHUTDOWN_FAILED',{cause:joinError});
 if(joinError)throw joinError;if(shutdownError)throw shutdownError;
}

// Per-invocation gate before another original work cycle. An acknowledged idle
// baton may remain owned; active/unknown transactions or lost observations may
// never be carried into the next cycle. This is not a physical close witness.
export function assertNativeLegObservations(snapshot){
 const s=nativeTraceSummary(snapshot);
 assert.ok(s.requests>0&&s.begun>0,'original native work observations required');
 for(const key of ['requestErrors','responseErrors','unknownTerminal','atOrAbove5s','attributionDroppedObservations','adapterDroppedObservations','unknownProtocolReplies','inflightRequests','activeFetches','pendingAcknowledgedBegins','unsettledTransactions','unresolvedStreams'])assert.equal(s[key],0,'NATIVE_LEG_'+key);
 assert.equal(s.begun,s.committed+s.rolledBack,'NATIVE_LEG_EVERY_BEGIN_TERMINAL');
 assert.equal(s.physicalTerminalObservationComplete,true);assert.equal(s.allTransactionTerminalsKnown,true);assert.equal(s.terminalComplete,true);
 assert.ok(Number.isFinite(s.maxDurationUpperBoundMs)&&s.maxDurationUpperBoundMs>=0&&s.maxDurationUpperBoundMs<5000,'observed original native leg transactions below 5s');
 return s;
}
