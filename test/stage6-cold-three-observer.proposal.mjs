// UNACTIVATED clone; only dependency changed to the fixed three-call observer.
// Test-only native transport observer. No application/DB/provider imports.
import {createAttribution,classifySql} from './stage6-cold-three-attribution.proposal.mjs';
const bound=128,own=(o,k)=>o&&Object.hasOwn(o,k),id=v=>Number.isSafeInteger(v)&&v>=0;
const failure=code=>Object.assign(Error(code),{code});
const delay=(ms,signal)=>new Promise((resolve,reject)=>{
 const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??failure('SYNC_CANCELLED'));};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
});
export function createDiagnosticFetch({fetch,decodePipelineReply,observer,now=()=>performance.now(),latencyEnabled=()=>false,wait=delay,onFetchEntry=()=>null,onFetchSettled=()=>{},onFailureSettlementRevoked=null}={}){
 if(typeof fetch!=='function'||typeof decodePipelineReply!=='function')throw failure('DIAGNOSTIC_ADAPTER_REQUIRED');
 const ownedObserver=observer===undefined;if(ownedObserver)observer=createAttribution();
 const streams=new Map(),unresolved=new Set(),idleWaiters=[];let active=0,dropped=0,unknownProtocolReplies=0,transportInvocations=0,responsesObserved=0;
 const deliveries=new Map(),proofs=new WeakMap();let epoch=0,consumed=false,deliveryLost=false,startedRequests=0;
 const deliveryCounts={NOT_SENT:0,SENT_REPLY:0,UNKNOWN:0};
 const signalOf=Object.getOwnPropertyDescriptor(Request.prototype,'signal').get,aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason').get;
 function cancelledBeforeCall(request,error){try{const signal=signalOf.call(request);return aborted.call(signal)&&reason.call(signal)===error;}catch{return false;}}
 function deliverySnapshot(){return {contract:'owned-native-request-delivery-v1',startedRequests,notSent:deliveryCounts.NOT_SENT,sentReply:deliveryCounts.SENT_REPLY,unknown:deliveryCounts.UNKNOWN,pending:deliveries.size,coverageComplete:!deliveryLost};}
 function canSettleFailure(){
  if(!ownedObserver||typeof onFailureSettlementRevoked!=='function'||wait!==delay)return false;
  const a=observer.snapshot(),unknownReplies=Object.values(a.bins).reduce((n,bin)=>n+bin.unknownReplies,0),requestErrors=Object.values(a.bins).reduce((n,bin)=>n+bin.requestErrors,0);
  return ownedObserver&&typeof onFailureSettlementRevoked==='function'&&wait===delay&&!deliveryLost&&deliveries.size===0&&active===0&&startedRequests>0
   &&deliveryCounts.UNKNOWN===0&&startedRequests===deliveryCounts.NOT_SENT+deliveryCounts.SENT_REPLY
   &&dropped===0&&unknownProtocolReplies===0&&streams.size===0&&unresolved.size===0
   &&a.observationCoverageComplete&&a.allRequestsSettled&&a.allAcknowledgedBeginsLinked&&a.allTransactionsSettled&&a.allTransactionTerminalsKnown&&a.transactionSampleCoverageComplete
   &&unknownReplies===deliveryCounts.NOT_SENT&&requestErrors===deliveryCounts.NOT_SENT;
 }
 function terminal(stream,outcome,finished){
  if(!stream?.transaction)return;
  observer.finishTransaction(stream.transaction.token,{outcome,durationUpperBoundMs:Math.max(0,finished-stream.transaction.started)});stream.transaction=null;
 }
 function retain(key,stream){
  if(streams.has(key)){if(streams.get(key)!==stream){dropped++;return false;}return true;}
  if(streams.size+unresolved.size>=bound){dropped++;return false;}streams.set(key,stream);return true;
 }
 function orphan(stream){if(!stream?.transaction)return;if(unresolved.size+streams.size<bound)unresolved.add(stream);else dropped++;}
 async function observedFetch(input,init){
  epoch++;if(consumed){consumed=false;try{onFailureSettlementRevoked();}catch{/* owner must conservatively revoke its reserved failure-only exit */}}
  startedRequests=Math.min(999999999,startedRequests+1);if(startedRequests===999999999)deliveryLost=true;const deliveryOwner=deliveries.size<bound?Object.freeze({}):null;if(deliveryOwner)deliveries.set(deliveryOwner,'BEFORE_CALL');else deliveryLost=true;
  // The request owner is captured before Request creation, body decoding, latency or transport awaits.
  let budgetToken=null,diagnosticFailed=false,diagnosticError=null;try{budgetToken=onFetchEntry();}catch{}
  const requestOwner=observer.startRequest(),started=now();active++;
  let request,body,stream,entries=[],requestFinished=false,injectedDelayMs=0,protocolKnown=true,callStage='BEFORE_CALL',waitRejected=false,deliveryClass='UNKNOWN';
  try{
   request=new Request(input,init);
   try{
    const raw=await request.clone().text();if(raw.length>4*1024*1024)throw failure('DIAGNOSTIC_PROTOCOL_BOUND');body=JSON.parse(raw);
    if(!body||!Array.isArray(body.requests)||body.requests.length>4096||(body.baton!=null&&typeof body.baton!=='string'))throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');
    stream=body.baton?streams.get(body.baton):null;
    if(body.baton&&!stream){dropped++;protocolKnown=false;}
    stream??={sql:new Map(),transaction:null};const sqls=[],working=new Map(stream.sql);
    for(const item of body.requests){
     const entry={item,statements:[]};entries.push(entry);
     if(item?.type==='store_sql'){
      if(!id(item.sql_id)||typeof item.sql!=='string'||working.size>=4096)throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');working.set(item.sql_id,item.sql);
     }else if(item?.type==='close_sql'){
      if(!id(item.sql_id))throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');working.delete(item.sql_id);
     }else if(item?.type==='execute'||item?.type==='batch'){
      const stmts=item.type==='execute'?[item.stmt]:item.batch?.steps?.map(step=>step.stmt);
      if(!Array.isArray(stmts)||stmts.length>4096)throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');
      for(const stmt of stmts){
       const sql=typeof stmt?.sql==='string'?stmt.sql:id(stmt?.sql_id)?working.get(stmt.sql_id):undefined;
       if(typeof sql!=='string'||sqls.length>=4096)throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');
       sqls.push(sql);entry.statements.push({ordinal:sqls.length,category:classifySql(sql)});
      }
     }else if(item?.type!=='close')throw failure('DIAGNOSTIC_PROTOCOL_UNKNOWN');
    }
    observer.bindRequestStatements(requestOwner,sqls);
   }catch{protocolKnown=false;dropped++;}
   if(latencyEnabled()){
    const began=now();try{await wait(115,request.signal);}catch(error){waitRejected=true;throw error;}finally{injectedDelayMs=Math.max(0,now()-began);}
   }
   // Owned monotonic transition immediately BEFORE invoking the passed fetch.
   // Any synchronous throw/thenable rejection after here remains UNKNOWN.
   callStage='CALLED';if(deliveryOwner)deliveries.set(deliveryOwner,'CALLED');
   transportInvocations++;const response=await fetch(request);responsesObserved++;let decoded,mask=[],responseError=!response.ok;
   if(protocolKnown&&response.ok){
    try{
     // The locked SDK's decoder validates every native reply, result and batch step before any ACK is credited.
     const rawReply=await response.clone().json();decoded=decodePipelineReply(rawReply);
     if(decoded.results.length!==entries.length)throw failure('DIAGNOSTIC_REPLY_UNKNOWN');
     for(let i=0;i<entries.length;i++){
      const {item,statements}=entries[i],reply=decoded.results[i];
      if(reply.type==='error'){responseError=true;for(const _ of statements)mask.push(false);continue;}
      if(reply.type!=='ok'||reply.response.type!==item.type)throw failure('DIAGNOSTIC_REPLY_UNKNOWN');
      if(item.type==='execute')mask.push(true);
      if(item.type==='batch'){
       const rawBatch=rawReply.results[i].response.result;if(rawBatch.step_results.length!==statements.length||rawBatch.step_errors.length!==statements.length)throw failure('DIAGNOSTIC_REPLY_UNKNOWN');
       const {stepResults,stepErrors}=reply.response.result;
       for(const index of [...stepResults.keys(),...stepErrors.keys()])if(!id(index)||index>=statements.length)throw failure('DIAGNOSTIC_REPLY_UNKNOWN');
       for(let j=0;j<statements.length;j++){
        if(stepResults.has(j)&&stepErrors.has(j))throw failure('DIAGNOSTIC_REPLY_UNKNOWN');
        mask.push(stepResults.has(j));if(stepErrors.has(j))responseError=true;
       }
      }
     }
    }catch{decoded=null;mask=[];unknownProtocolReplies++;}
   }else{unknownProtocolReplies++;}
   const finished=now(),begins=observer.finishRequest(requestOwner,{durationMs:Math.max(0,finished-started),injectedDelayMs,successMask:mask,responseError});requestFinished=true;
   if(decoded&&protocolKnown){
    const beginByOrdinal=new Map(begins.map(v=>[v.statementOrdinal,v.owner]));
    for(let i=0;i<entries.length;i++){
     const {item,statements}=entries[i],reply=decoded.results[i];if(reply.type!=='ok')continue;
     for(const entry of statements){
      if(!mask[entry.ordinal-1])continue;
      if(entry.category==='TX_BEGIN'){
       if(stream.transaction){dropped++;throw failure('NO_HIDDEN_PRIOR_TRANSACTION');}
       const token=observer.startTransaction(beginByOrdinal.get(entry.ordinal),requestOwner,entry.ordinal);
       if(token)stream.transaction={token,started};else dropped++;
      }else if(entry.category==='TX_COMMIT'||entry.category==='TX_ROLLBACK')terminal(stream,entry.category==='TX_COMMIT'?'COMMITTED':'ROLLED_BACK',finished);
      else if(stream.transaction)observer.transactionStorage(stream.transaction.token,entry.category);
     }
     if(item.type==='store_sql')stream.sql.set(item.sql_id,item.sql);
     if(item.type==='close_sql')stream.sql.delete(item.sql_id);
     if(item.type==='close'){terminal(stream,'CLOSE_UNRESOLVED',finished);stream.sql.clear();}
    }
    if(body.baton)streams.delete(body.baton);
    if(decoded.baton)retain(decoded.baton,stream);
    else if(stream.transaction){terminal(stream,'BATON_LOST_UNRESOLVED',finished);dropped++;}
   }else if(stream?.transaction){
    // No terminal result is promoted after malformed/lost reply. The stream remains visibly unresolved.
    if(body?.baton)streams.delete(body.baton);orphan(stream);
   }
   if(decoded&&protocolKnown)deliveryClass='SENT_REPLY';
   return response;
  }catch(error){
   diagnosticFailed=true;diagnosticError=error;
   if(deliveryOwner&&deliveries.get(deliveryOwner)==='BEFORE_CALL'&&callStage==='BEFORE_CALL'&&wait===delay&&waitRejected&&protocolKnown&&cancelledBeforeCall(request,error))deliveryClass='NOT_SENT';
   if(!requestFinished)observer.finishRequest(requestOwner,{durationMs:Math.max(0,now()-started),injectedDelayMs,requestError:true,successMask:[]});
   if(stream?.transaction){if(body?.baton)streams.delete(body.baton);orphan(stream);}
   throw error;
  }finally{
   if(deliveryOwner&&deliveries.has(deliveryOwner)){deliveries.delete(deliveryOwner);deliveryCounts[deliveryClass]=Math.min(999999999,deliveryCounts[deliveryClass]+1);if(deliveryCounts[deliveryClass]===999999999)deliveryLost=true;}else deliveryLost=true;
   try{onFetchSettled(budgetToken,diagnosticFailed,diagnosticError,deliveryClass);}catch{}active--;if(active===0)for(const resolve of idleWaiters.splice(0))resolve();
  }
 }
 return Object.freeze({fetch:observedFetch,observer,
  proveFailedTransportSettlement(){if(!canSettleFailure())return null;const token=Object.freeze({});proofs.set(token,epoch);return token;},
  consumeFailedTransportSettlement(token){const original=proofs.get(token);proofs.delete(token);if(original===undefined||original!==epoch||!canSettleFailure())return false;consumed=true;return true;},
  awaitIdle:()=>active===0?Promise.resolve():new Promise(resolve=>idleWaiters.push(resolve)),snapshot(){
  const attribution=observer.snapshot();
  const terminalComplete=dropped===0&&unknownProtocolReplies===0&&active===0&&unresolved.size===0&&attribution.physicalTerminalObservationComplete;
  return {...attribution,adapter:{activeFetches:active,transportInvocations,responsesObserved,retainedStreams:streams.size,unresolvedStreams:unresolved.size,droppedObservations:dropped,unknownProtocolReplies,coverageComplete:dropped===0,terminalComplete,attributionComplete:terminalComplete&&attribution.attributionComplete,delivery:deliverySnapshot()}};
 }});
}
