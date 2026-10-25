// Test-only pure closed projection. No I/O, SQL, health values, keys or callers.
import assert from 'node:assert/strict';
import {PHASES,UNITS,CATEGORIES} from './stage6-native-attribution.mjs';
const NUMBER_FIELDS='startedPreparations completedPreparations sourceAcknowledgments unitsCommitted lastPendingJobs lastBudgetPerTenant physicalChildrenJoined preparationBatches lastBatchOrdinal fileClientClosed originalApplicationTablesPreserved fullTypedRowsPreserved joinInitialIdleWithinBudget joinInitialActive joinInitialRetained joinInitialAdapterTerminal joinInitialPhysicalTerminal eofRequests eofRequestErrors eofResponseErrors eofUnknownReplies eofTransactions eofMaxUpperMs eofAtOrAbove5s eofOpen eofUnknownTerminal joinElapsedMs joinProbes joinWithinBudget preparationTransactionCount preparationMaxUpperMs preparationAtOrAbove5s preparationUnknown preparationOpen'.split(' ');
const ENUMS={check:'NOT_STARTED JOIN_INITIAL_IDLE JOIN_PHYSICAL_DEADLINE JOIN_ADAPTER_TERMINAL JOIN_RETAINED_STREAMS JOIN_PHYSICAL_TERMINAL EOF_REQUEST_ERRORS EOF_RESPONSE_ERRORS EOF_UNKNOWN_REPLIES EOF_TX_OPEN EOF_TX_UNKNOWN EOF_TX_5S_COUNT EOF_TX_BEGIN_AND_MAX'.split(' '),preparationSnapshotState:['NOT_STARTED','UNKNOWN','PROVISIONAL','TERMINAL'],eofSnapshotState:['UNKNOWN','PROVISIONAL','TERMINAL'],joinTransport:['EOF','PREPARATION']};
const STAGES=['SERVER_START','BOUNDED_PHYSICAL_FILE_PREPARATION','VERIFY_GENUINE_FILE_PREPARATION','ONE_SQLD_LEGACY_STARTUP','FULL_TYPED_APPLICATION_FILE_HANDOFF_READBACK','GENUINE_NATIVE_EOF','EXACT_ORIGINAL_IDENTITY_REPLAY','JOINED_CLIENT_CLEANUP'];
const CODES=['OTHER','ERR_ASSERTION','SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','SQLITE_BUSY','SQLITE_LOCKED','PHASE4_LIVE_NOT_AUTHORIZED','STAGE8_LIVE_PRINCIPAL_FENCED','NONE'];
const CLASSES=['BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_NONEMPTY_CURSOR_REQUIRED','REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED','ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_RECEIPT_CHANGED_OR_MISSING','OTHER_ASSERTION','OTHER_ERROR'];
function data(v){
 assert.ok(v&&Object.getPrototypeOf(v)===Object.prototype);const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
 assert.ok(keys.every(k=>typeof k==='string'&&Object.hasOwn(descriptors[k],'value')));return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
function exact(v,fields){const d=data(v);assert.deepEqual(Object.keys(d).sort(),[...fields].sort());return d;}
const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
function numericRecord(value,fields){const d=exact(value,fields);for(const k of fields)assert.ok(numeric(d[k]));return d;}
export function projectFailureProgress(value){
 try{const d=data(value),out={};assert.ok(Object.hasOwn(d,'check'));for(const [k,v]of Object.entries(d)){
  if(NUMBER_FIELDS.includes(k)){assert.ok(numeric(v)||v===null&&['lastPendingJobs','lastBudgetPerTenant'].includes(k));out[k]=v;}
  else{assert.ok(Object.hasOwn(ENUMS,k)&&ENUMS[k].includes(v));out[k]=v;}
 }return out;}catch{return null;}
}
const BIN_NUMBERS='requests submittedStatements observedExecutedStatements requestErrors responseErrors unknownReplies sumRequestDurationMs maxRequestDurationMs sumInjectedDelayMs phaseWallMs'.split(' ');
const TX_NUMBERS='begun committed rolledBack unknownTerminal open sumDurationUpperBoundMs maxDurationUpperBoundMs atOrAbove5s'.split(' ');
function safeBin(value){
 const d=exact(value,[...BIN_NUMBERS,'categories','transactions','lastKnownOuterWorkUnit','innerSemanticWorkUnit','lastStorageCategory','lastTypedCode']),out={};
 for(const k of BIN_NUMBERS){assert.ok(numeric(d[k]));out[k]=d[k];}
 const categories=exact(d.categories,CATEGORIES);out.categories={};for(const k of CATEGORIES)out.categories[k]=numericRecord(categories[k],['submitted','executed']);
 out.transactions=numericRecord(d.transactions,TX_NUMBERS);assert.ok(UNITS.includes(d.lastKnownOuterWorkUnit)&&d.innerSemanticWorkUnit==='UNKNOWN_NOT_INSTRUMENTED'&&CATEGORIES.includes(d.lastStorageCategory)&&CODES.includes(d.lastTypedCode));
 for(const k of ['lastKnownOuterWorkUnit','innerSemanticWorkUnit','lastStorageCategory','lastTypedCode'])out[k]=d[k];return out;
}
function safeSample(value){
 const d=exact(value,['startedPhase','endedPhase','outerWorkUnit','callOrdinal','requestOrdinal','beginStatementOrdinal','innerSemanticWorkUnit','lastStorageCategory','outcome','durationUpperBoundMs']);
 assert.ok(PHASES.includes(d.startedPhase)&&PHASES.includes(d.endedPhase)&&UNITS.includes(d.outerWorkUnit)&&d.innerSemanticWorkUnit==='UNKNOWN_NOT_INSTRUMENTED'&&CATEGORIES.includes(d.lastStorageCategory)&&['committed','rolledBack','unknownTerminal'].includes(d.outcome));
 for(const k of ['callOrdinal','requestOrdinal','beginStatementOrdinal','durationUpperBoundMs'])assert.ok(numeric(d[k]));assert.ok(Number.isSafeInteger(d.callOrdinal)&&d.callOrdinal<=1);return d;
}
function validateDiagnostic(value){
 const d=exact(value,['contract','eof','replay','physicalTerminalObservationComplete','transactionSampleCoverageComplete','allRequestsSettled','allTransactionsSettled','allRepliesKnown','allTransactionTerminalsKnown','adapterTerminalComplete','retainedStreams','sampleCountRetained','sampleCountDropped','selectedSamples','productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified']);
 assert.equal(d.contract,'closed-native-eof-failure-attribution-v1');d.eof=safeBin(d.eof);d.replay=safeBin(d.replay);
 for(const k of ['physicalTerminalObservationComplete','transactionSampleCoverageComplete','allRequestsSettled','allTransactionsSettled','allRepliesKnown','allTransactionTerminalsKnown','adapterTerminalComplete'])assert.equal(typeof d[k],'boolean');
 for(const k of ['retainedStreams','sampleCountRetained','sampleCountDropped'])assert.ok(Number.isSafeInteger(d[k])&&d[k]>=0);assert.ok(d.sampleCountRetained<=64);
 assert.ok(Array.isArray(d.selectedSamples)&&d.selectedSamples.length<=8&&d.selectedSamples.length<=d.sampleCountRetained);d.selectedSamples=d.selectedSamples.map(safeSample);
 assert.ok(d.selectedSamples.every(s=>['GENUINE_ORIGINAL_PRODUCER_CALL','EXACT_ORIGINAL_REPLAY'].includes(s.startedPhase)));
 for(let i=1;i<d.selectedSamples.length;i++)assert.ok(d.selectedSamples[i-1].durationUpperBoundMs>=d.selectedSamples[i].durationUpperBoundMs);
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'])assert.equal(d[k],false);return d;
}
export function collectEOFFailureDiagnostic(snapshot){
 try{const s=data(snapshot),bins=data(s.bins),adapter=data(s.adapter);assert.ok(Array.isArray(s.transactionSamples)&&s.transactionSamples.length<=64);
 const samples=s.transactionSamples.map(safeSample),selectedSamples=samples.filter(x=>['GENUINE_ORIGINAL_PRODUCER_CALL','EXACT_ORIGINAL_REPLAY'].includes(x.startedPhase)).sort((a,b)=>b.durationUpperBoundMs-a.durationUpperBoundMs).slice(0,8);
 return validateDiagnostic({contract:'closed-native-eof-failure-attribution-v1',eof:safeBin(bins.GENUINE_ORIGINAL_PRODUCER_CALL),replay:safeBin(bins.EXACT_ORIGINAL_REPLAY),physicalTerminalObservationComplete:s.physicalTerminalObservationComplete,
  transactionSampleCoverageComplete:s.transactionSampleCoverageComplete,allRequestsSettled:s.allRequestsSettled,allTransactionsSettled:s.allTransactionsSettled,allRepliesKnown:s.allRepliesKnown,allTransactionTerminalsKnown:s.allTransactionTerminalsKnown,
  adapterTerminalComplete:adapter.terminalComplete,retainedStreams:adapter.retainedStreams,sampleCountRetained:samples.length,sampleCountDropped:s.droppedTransactionSamples,selectedSamples,productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false});
 }catch{return null;}
}
export function projectEOFFailure(raw){
 const output={status:'NO_VALID_FAILURE_PACKET',failure:null,productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};
 try{assert.equal(typeof raw,'string');assert.ok(Buffer.byteLength(raw)<16*1024*1024);const prefix='STAGE6_FILE_PREPARED_NATIVE_EOF_FAILURE ',rows=raw.split('\n').filter(x=>x.startsWith(prefix));assert.equal(rows.length,1);assert.ok(Buffer.byteLength(rows[0])<32768);
  const d=exact(JSON.parse(rows[0].slice(prefix.length)),['stage','type','code','classification','progress','eofDiagnostic','elapsedMs']);assert.ok(STAGES.includes(d.stage)&&['Error','AssertionError'].includes(d.type)&&CLASSES.includes(d.classification)&&numeric(d.elapsedMs));
  const progress=projectFailureProgress(d.progress);let diagnostic=null;try{if(d.eofDiagnostic!==null)diagnostic=validateDiagnostic(d.eofDiagnostic);}catch{}
  output.status='CLOSED_FAILURE_COUNTERS_ONLY_NO_QUALIFICATION';output.failure={stage:d.stage,type:d.type,code:CODES.includes(d.code)?d.code:'OTHER',classification:d.classification,progress,progressProjectionStatus:progress?'VALID_CLOSED_COUNTERS':'INVALID_OR_MISSING_COUNTERS',eofDiagnostic:diagnostic,eofDiagnosticStatus:diagnostic?'VALID_BOUNDED_OBSERVATION_ONLY':'INVALID_OR_MISSING_OBSERVATION',elapsedMs:d.elapsedMs};
 }catch{}return output;
}
