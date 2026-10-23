/** Pure bounded diagnostics; no app/DB/provider/I/O import or execution authority. */
import {PHASES,UNITS,CATEGORIES,safeFailureFrames} from './stage6-cold-three-attribution.proposal.mjs';
import {getCallSites} from 'node:util';
export const BUDGET_ATTRIBUTION_CONTRACT='stage6-native-cold-budget-attribution-v3';
export const BUDGET_ATTRIBUTION_MAX_BYTES=32768;
export const BUDGET_WIDTHS=Object.freeze(['MS_5000','MS_10000','MS_15000','MS_45000','MS_50000','MS_70000','OTHER','NONE','UNKNOWN']);
export const FRAME_BASENAMES=Object.freeze(['stage8LiveProducer.js','stage8LiveExecution.js','phase4Cache.js','executionBudget.js','processingTransaction.js','db.js','phase4Reanalysis.js','phase4Core.js','phase4QueueStore.js','phase4ExecutionContext.js','phase4Coordination.js']);
export const DELIVERY_CLASSES=Object.freeze(['NOT_SENT','SENT_REPLY','UNKNOWN']);
export const FETCH_CALLSITE_TAGS=Object.freeze(['LIVE_PRODUCER','LIVE_EXECUTION','PROCESSING_TRANSACTION','CORE_CONTEXT','DB_HTTP','KNOWN_APP_SOURCE','UNKNOWN']);
const sourceUrls=new Map(FRAME_BASENAMES.map(name=>[new URL('../src/'+name,import.meta.url).href,name]));
export const TYPED_CODES=Object.freeze(['NONE','OTHER','UNKNOWN','SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','SQLITE_BUSY','SQLITE_LOCKED','PHASE4_LIVE_NOT_AUTHORIZED','STAGE8_LIVE_PRINCIPAL_FENCED']);
const own=(value,key)=>value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
const number=(value,max=1e12)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<max?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<1e9?value:null;
const bool=value=>typeof value==='boolean'?value:null;
const member=(values,value,fallback='UNKNOWN')=>values.includes(value)?value:fallback;
const rows=(value,max)=>Array.isArray(value)&&value.length<=max?Array.from({length:value.length},(_,i)=>own(value,String(i))):[];
const inc=(object,key)=>object[key]=Math.min(999999999,object[key]+1);
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
export const typedDiagnosticCode=error=>member(TYPED_CODES,own(error,'code'),'OTHER');
function frames(value){
 return rows(value,8).map(frame=>({sourceBasename:member(FRAME_BASENAMES,own(frame,'sourceBasename')),line:own(frame,'line')}))
  .filter(frame=>FRAME_BASENAMES.includes(frame.sourceBasename)&&Number.isSafeInteger(frame.line)&&frame.line>=1&&frame.line<=1000000);
}
// Native synchronous callsites bypass Error.stack/prepareStackTrace, including
// Node22's lazy own stack accessor. Never inspect a supplied error's getter.
// Exact manifest-root URLs only; no source-map lookup, I/O, message or raw path
// survives this function. A tag names an observed frame, never semantic authority.
function fetchEntryCallsites(){
 const out=[],seen=new Set();try{
  for(const frame of getCallSites(40,{sourceMap:false})){
   const name=sourceUrls.get(own(frame,'scriptName')),line=own(frame,'lineNumber'),key=name+':'+line;
   if(!name||!Number.isSafeInteger(line)||line<1||line>1000000||seen.has(key))continue;
   seen.add(key);out.push({sourceBasename:name,line});if(out.length===8)break;
  }
 }catch{/* missing native frame evidence stays UNKNOWN */}
 const tags={'stage8LiveProducer.js':'LIVE_PRODUCER','stage8LiveExecution.js':'LIVE_EXECUTION','processingTransaction.js':'PROCESSING_TRANSACTION','phase4Core.js':'CORE_CONTEXT','db.js':'DB_HTTP'};
 const selected=out.find(frame=>['stage8LiveProducer.js','stage8LiveExecution.js'].includes(frame.sourceBasename))??out[0];
 return {callsiteTag:selected?(tags[selected.sourceBasename]??'KNOWN_APP_SOURCE'):'UNKNOWN',fetchEntryFrames:out};
}
function budgetObservation(api){
 if(api===undefined)return {widthBucket:'NONE',widthMs:null,remainingMs:null,signalAborted:null};
 const started=own(api,'startedAt'),deadline=own(api,'deadlineAt');
 const width=typeof started==='number'&&Number.isFinite(started)&&typeof deadline==='number'&&Number.isFinite(deadline)?number(deadline-started,225001):null;
 let remaining=null,signalAborted=null;
 const read=own(api,'remainingMs');try{if(typeof read==='function')remaining=number(read.call(api),225001);}catch{}
 try{signalAborted=bool(aborted.call(own(api,'signal')));}catch{}
 const exact=width!==null&&width>=1?'MS_'+width:'UNKNOWN';
 return {widthBucket:exact==='UNKNOWN'?'UNKNOWN':member(BUDGET_WIDTHS,exact,'OTHER'),widthMs:width!==null&&width>=1?width:null,remainingMs:remaining,signalAborted};
}
function budgetEntry(value){
 const out={phase:member(PHASES,own(value,'phase')),callOrdinal:count(own(value,'callOrdinal')),widthBucket:member(BUDGET_WIDTHS,own(value,'widthBucket')),widthMs:number(own(value,'widthMs'),225001),remainingMs:number(own(value,'remainingMs'),225001),signalAborted:bool(own(value,'signalAborted')),workRemainingMs:number(own(value,'workRemainingMs'),300001),outerRemainingMs:number(own(value,'outerRemainingMs'),300001),elapsedMs:number(own(value,'elapsedMs')),settled:bool(own(value,'settled')),requestError:bool(own(value,'requestError')),typedErrorCode:member(TYPED_CODES,own(value,'typedErrorCode')),remainingMsAtSettlement:number(own(value,'remainingMsAtSettlement'),225001),signalAbortedAtSettlement:bool(own(value,'signalAbortedAtSettlement')),workRemainingMsAtSettlement:number(own(value,'workRemainingMsAtSettlement'),300001),outerRemainingMsAtSettlement:number(own(value,'outerRemainingMsAtSettlement'),300001),callsiteTag:member(FETCH_CALLSITE_TAGS,own(value,'callsiteTag')),fetchEntryFrames:frames(own(value,'fetchEntryFrames')),deliveryClass:member(DELIVERY_CLASSES,own(value,'deliveryClass'))};
 if(out.callOrdinal===null||out.callOrdinal>3)out.callOrdinal=null;
 return out;
}
export function projectBudgetSnapshot(value){
  const first=own(value,'firstFailedEntry');
  return {captures:count(own(value,'captures')),droppedCaptures:count(own(value,'droppedCaptures')),inflight:count(own(value,'inflight')),recentEvictions:count(own(value,'recentEvictions')),widthBins:rows(own(value,'widthBins'),BUDGET_WIDTHS.length).map(row=>({widthBucket:member(BUDGET_WIDTHS,own(row,'widthBucket')),captures:count(own(row,'captures')),settled:count(own(row,'settled')),requestErrors:count(own(row,'requestErrors')),abortedAtEntry:count(own(row,'abortedAtEntry')),abortedAtSettlement:count(own(row,'abortedAtSettlement')),lastTypedErrorCode:member(TYPED_CODES,own(row,'lastTypedErrorCode'))})),recentEntries:rows(own(value,'recentEntries'),8).map(budgetEntry),firstFailedEntry:first&&own(first,'settled')===true&&own(first,'requestError')===true?budgetEntry(first):null};
}
export function createFetchBudgetProbe({getBudget,elapsedMs,clocks}={}){
 if(typeof getBudget!=='function'||typeof elapsedMs!=='function'||typeof clocks!=='function')throw Error('DIAGNOSTIC_BUDGET_CALLBACK_REQUIRED');
 const pending=new Map(),recent=[],bins=Object.fromEntries(BUDGET_WIDTHS.map(widthBucket=>[widthBucket,{widthBucket,captures:0,settled:0,requestErrors:0,abortedAtEntry:0,abortedAtSettlement:0,lastTypedErrorCode:'NONE'}]));
  let phase='UNKNOWN',callOrdinal=0,captures=0,droppedCaptures=0,recentEvictions=0,firstFailedEntry=null;
 function clock(){try{const x=clocks();return {workRemainingMs:number(own(x,'workRemainingMs'),300001),outerRemainingMs:number(own(x,'outerRemainingMs'),300001)};}catch{return {workRemainingMs:null,outerRemainingMs:null};}}
 return Object.freeze({
  notePhase(next,ordinal){phase=member(PHASES,next);callOrdinal=Number.isSafeInteger(ordinal)&&ordinal>=0&&ordinal<=3?ordinal:null;},
  captureEntry(){
   captures=Math.min(999999999,captures+1);
   if(pending.size>=128){droppedCaptures=Math.min(999999999,droppedCaptures+1);return null;}
   let api,observation;try{api=getBudget();observation=budgetObservation(api);}catch{observation={widthBucket:'UNKNOWN',widthMs:null,remainingMs:null,signalAborted:null};}
   let elapsed=null;try{elapsed=number(elapsedMs());}catch{}
    const record={phase,callOrdinal,...observation,...clock(),...fetchEntryCallsites(),elapsedMs:elapsed,settled:false,requestError:null,typedErrorCode:'UNKNOWN',remainingMsAtSettlement:null,signalAbortedAtSettlement:null,workRemainingMsAtSettlement:null,outerRemainingMsAtSettlement:null};
   const token=Object.freeze({});pending.set(token,{api,record});recent.push(record);if(recent.length>8){recent.shift();recentEvictions=Math.min(999999999,recentEvictions+1);}
   const bin=bins[record.widthBucket];inc(bin,'captures');if(record.signalAborted===true)inc(bin,'abortedAtEntry');return token;
  },
  settle(token,requestError,error,deliveryClass='UNKNOWN'){
   const held=pending.get(token);if(!held){if(token!==null)droppedCaptures=Math.min(999999999,droppedCaptures+1);return;}
   pending.delete(token);const {record}=held,observation=budgetObservation(held.api),at=clock();
   Object.assign(record,{deliveryClass:member(DELIVERY_CLASSES,deliveryClass),settled:true,requestError:requestError===true,typedErrorCode:requestError===true?typedDiagnosticCode(error):'NONE',remainingMsAtSettlement:observation.remainingMs,signalAbortedAtSettlement:observation.signalAborted,workRemainingMsAtSettlement:at.workRemainingMs,outerRemainingMsAtSettlement:at.outerRemainingMs});
    // First observed failed settlement is write-once and independent of the
    // recent ring. Snapshot callers receive copies, never this retained owner.
    if(requestError===true&&firstFailedEntry===null)firstFailedEntry=Object.freeze({...record,fetchEntryFrames:Object.freeze(record.fetchEntryFrames.map(frame=>Object.freeze({...frame})))});
   const bin=bins[record.widthBucket];inc(bin,'settled');if(requestError===true){inc(bin,'requestErrors');bin.lastTypedErrorCode=record.typedErrorCode;}if(record.signalAbortedAtSettlement===true)inc(bin,'abortedAtSettlement');
  },
   snapshot(){return projectBudgetSnapshot({captures,droppedCaptures,inflight:pending.size,recentEvictions,widthBins:Object.values(bins),recentEntries:recent,firstFailedEntry});},
 });
}
const COUNT_FIELDS=['requests','submittedStatements','observedExecutedStatements','requestErrors','responseErrors','unknownReplies'];
const TIME_FIELDS=['sumRequestDurationMs','maxRequestDurationMs','sumInjectedDelayMs','phaseWallMs'];
const TX_COUNTS=['begun','committed','rolledBack','unknownTerminal','open','atOrAbove5s'];
const TX_TIMES=['sumDurationUpperBoundMs','maxDurationUpperBoundMs'];
export function budgetAttributionRecord({candidateSha,phase,stage,callIntents,elapsedMs,failureCode,errorMessageSha256,error=null,attribution,budgetObservations}={}){
 const phaseBins=[];
 for(const name of PHASES){
  const bin=own(own(attribution,'bins'),name),row={phase:name};
  for(const key of COUNT_FIELDS)row[key]=count(own(bin,key));
  for(const key of TIME_FIELDS)row[key]=number(own(bin,key));
  row.lastKnownOuterWorkUnit=member(UNITS,own(bin,'lastKnownOuterWorkUnit'));row.lastStorageCategory=member(CATEGORIES,own(bin,'lastStorageCategory'));row.lastTypedCode=member(TYPED_CODES,own(bin,'lastTypedCode'));
  row.categories=CATEGORIES.map(category=>({category,submitted:count(own(own(own(bin,'categories'),category),'submitted')),executed:count(own(own(own(bin,'categories'),category),'executed'))})).filter(x=>x.submitted!==0||x.executed!==0);
  row.transactions={};for(const key of TX_COUNTS)row.transactions[key]=count(own(own(bin,'transactions'),key));for(const key of TX_TIMES)row.transactions[key]=number(own(own(bin,'transactions'),key));
  if(COUNT_FIELDS.some(key=>row[key]!==0)||TIME_FIELDS.some(key=>row[key]!==0)||row.categories.length||Object.values(row.transactions).some(x=>x!==0))phaseBins.push(row);
 }
 const adapter={};for(const key of ['activeFetches','transportInvocations','responsesObserved','unresolvedStreams','droppedObservations','unknownProtocolReplies'])adapter[key]=count(own(own(attribution,'adapter'),key));
 for(const key of ['terminalComplete','coverageComplete'])adapter[key]=bool(own(own(attribution,'adapter'),key));
 const delivery=own(own(attribution,'adapter'),'delivery');adapter.delivery={contract:'owned-native-request-delivery-v1'};for(const key of ['startedRequests','notSent','sentReply','unknown','pending'])adapter.delivery[key]=count(own(delivery,key));adapter.delivery.coverageComplete=bool(own(delivery,'coverageComplete'));
 const coverage={};for(const key of ['inflightRequests','pendingAcknowledgedBegins','unsettledTransactions','droppedObservations','droppedTransactionSamples'])coverage[key]=count(own(attribution,key));
 for(const key of ['physicalTerminalObservationComplete','observationCoverageComplete','allRequestsSettled','allAcknowledgedBeginsLinked','allTransactionsSettled','allRepliesKnown','allTransactionTerminalsKnown','transactionSampleCoverageComplete'])coverage[key]=bool(own(attribution,key));
 // Read data stack only; caller-defined getters are never invoked. Existing
 // reviewed helper strips paths/messages and permits at most8 known source frames.
 const frames=safeFailureFrames({stack:own(error,'stack')}).filter(frame=>FRAME_BASENAMES.includes(frame.sourceBasename)&&Number.isSafeInteger(frame.line)&&frame.line>=1&&frame.line<=1000000);
 return {contract:BUDGET_ATTRIBUTION_CONTRACT,productionEvidence:false,actualNativeQualified:false,wholeJobCompletionQualified:false,capacityQualified:false,candidateSha:typeof candidateSha==='string'&&/^[a-f0-9]{40}$/.test(candidateSha)?candidateSha:null,phase:member(['A','B'],phase),stage:member(['LEG_METADATA_READY','APP_FAILURE'],stage),callIntents:Number.isSafeInteger(callIntents)&&callIntents>=0&&callIntents<=3?callIntents:null,elapsedMs:number(elapsedMs),failureCode:failureCode===null?null:member(['ERR_ASSERTION','NATIVE_COLD_PROOF_REFUSED'],failureCode),errorMessageSha256:typeof errorMessageSha256==='string'&&/^[a-f0-9]{64}$/.test(errorMessageSha256)?errorMessageSha256:null,typedFailureCode:error===null?'NONE':typedDiagnosticCode(error),safeFrames:frames,coverage,adapter,phaseBins,fetchBudgets:projectBudgetSnapshot(budgetObservations)};
}
