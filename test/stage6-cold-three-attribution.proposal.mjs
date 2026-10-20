// UNACTIVATED three-call qualification observer clone; no existing quota or diagnostic grant changed.
/** PRIVATE SOURCE PROPOSAL ONLY. Pure bounded test-observer; never executes, changes, retries or skips SQL. No application/provider/file imports. */
export const PHASES=Object.freeze(['SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','SETUP_EMPTY_FIXTURE','ADMISSION_AND_COMPOSITION','GENUINE_ORIGINAL_PRODUCER_CALL','READBACK','EXACT_ORIGINAL_REPLAY','CLEANUP','UNKNOWN']);
export const UNITS=Object.freeze(['CREATE_DB','MIGRATE','SEED_EMPTY_FIXTURE','RUNTIME_ADMISSION','BUILD_LIVE_PRODUCER','ORIGINAL_PRODUCER_RUN','READBACK','ORIGINAL_REQUEST_REPLAY','CLEANUP','UNKNOWN']);
export const CATEGORIES=Object.freeze(['TX_BEGIN','TX_COMMIT','TX_ROLLBACK','DDL','PRAGMA','SCHEMA_CATALOG','SCHEMA_VERSION','MIGRATION_METADATA','AUTHORITY_ASSERTION','PRINCIPAL_READINESS','CONTEXT_LEASE_RELEASE','EXECUTION_CONTROL','OPERATION_RECEIPT','CONTEXT_LEASE','QUEUE_CONTROL','FAMILY_DIRECTORY','SOURCE_DATA','DERIVED_DATA','OTHER']);
const ERRORS=new Set(['SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','SQLITE_BUSY','SQLITE_LOCKED','PHASE4_LIVE_NOT_AUTHORIZED','STAGE8_LIVE_PRINCIPAL_FENCED']);
const finite=n=>Number.isFinite(n)&&n>=0?Math.min(Number.MAX_SAFE_INTEGER,n):0;
const add=(o,k,n=1)=>o[k]=Math.min(Number.MAX_SAFE_INTEGER,o[k]+finite(n));
const member=(set,value,fallback='UNKNOWN')=>set.includes(value)?value:fallback;
const blank=()=>({requests:0,submittedStatements:0,observedExecutedStatements:0,requestErrors:0,responseErrors:0,unknownReplies:0,sumRequestDurationMs:0,maxRequestDurationMs:0,sumInjectedDelayMs:0,phaseWallMs:0,categories:Object.fromEntries(CATEGORIES.map(x=>[x,{submitted:0,executed:0}])),transactions:{begun:0,committed:0,rolledBack:0,unknownTerminal:0,open:0,sumDurationUpperBoundMs:0,maxDurationUpperBoundMs:0,atOrAbove5s:0},lastKnownOuterWorkUnit:'UNKNOWN',innerSemanticWorkUnit:'UNKNOWN_NOT_INSTRUMENTED',lastStorageCategory:'OTHER',lastTypedCode:'NONE'});
export function classifySql(value){
 if(typeof value!=='string'||value.length>262144)return 'OTHER';
 // Only a closed category is returned. Never emit the SQL, table/column text, parameters, template hashes or error messages.
 // Remove comments while preserving quoted literals transiently; a comment-only marker is not a guard.
 const uncommented=value.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,x=>x.startsWith("'")?x:' ');
 if(/\bSELECT\b[\s\S]*\bCASE\b[\s\S]*\bELSE\s+'SYNC_IMMUTABLE_AUTHORITY_CHANGED'\s+END\b/i.test(uncommented))return 'AUTHORITY_ASSERTION';
 const sql=uncommented.replace(/'(?:''|[^'])*'/g,"''").replace(/\s+/g,' ').trim().toUpperCase(),verb=/^[A-Z]+/.exec(sql)?.[0];
 if(verb==='BEGIN')return 'TX_BEGIN';if(verb==='COMMIT'||verb==='END')return 'TX_COMMIT';if(verb==='ROLLBACK')return 'TX_ROLLBACK';
 if(['CREATE','ALTER','DROP','VACUUM','REINDEX'].includes(verb))return 'DDL';if(verb==='PRAGMA')return 'PRAGMA';
 if(/^DELETE FROM RESOURCE_LOCKS WHERE NAME=\? AND OWNER=\?;?$/.test(sql))return 'CONTEXT_LEASE_RELEASE';
 if(/\bUSERS\b/.test(sql)&&/\bUSER_ONBOARDING\b/.test(sql)&&/\bPHASE4_USER_STATE\b/.test(sql)&&/\bUSER_WHOOP_TOKENS\b/.test(sql))return 'PRINCIPAL_READINESS';
 if(/\bSQLITE_(MASTER|SCHEMA)\b/.test(sql))return 'SCHEMA_CATALOG';
 const tests=[['SCHEMA_VERSION',/\bSCHEMA_VERSION\b/],['MIGRATION_METADATA',/\bPHASE4_MIGRATION_CHECKPOINTS\b/],['OPERATION_RECEIPT',/\b(?:PHASE4|STAGE8_LIVE)_OPERATION_RECEIPTS\b/],['CONTEXT_LEASE',/\bPHASE4_CONTEXT_LEASES\b/],['EXECUTION_CONTROL',/\b(?:PHASE4_EXECUTIONS|PHASE4_EXECUTION_WORK_RECEIPTS|STAGE8_LIVE_EXECUTIONS|STAGE8_LIVE_EXECUTION_PRODUCERS)\b/],['QUEUE_CONTROL',/\b(?:PHASE4_JOBS|PHASE4_COMPUTATION_STATE|RESOURCE_LOCKS)\b/],['FAMILY_DIRECTORY',/\b(?:PHASE4|STAGE8_LIVE)_FAMILY_(?:DIRECTORY_ENTRIES|DIRECTORY_MANIFESTS|WORK_TIPS)\b/],['SOURCE_DATA',/\b(?:WHOOP_SLEEPS|WHOOP_RECOVERIES|WHOOP_CYCLES|WHOOP_WORKOUTS|JOURNAL_EVENTS)\b/],['DERIVED_DATA',/\b(?:BODY_ENERGY_RESULTS|STAGE8_LIVE_PUBLICATIONS|HEALTH_INSIGHTS|EPISODES)\b/]];
 return tests.find(([,re])=>re.test(sql))?.[0]??'OTHER';
}
export function createAttribution({now=()=>performance.now(),maxInflight=128,maxTransactionSamples=64}={}){
 if(!Number.isSafeInteger(maxInflight)||maxInflight<1||maxInflight>128||!Number.isSafeInteger(maxTransactionSamples)||maxTransactionSamples<0||maxTransactionSamples>64)throw Error('DIAGNOSTIC_FIXED_BOUND_REQUIRED');
 const bins=Object.fromEntries(PHASES.map(p=>[p,blank()])),requests=new Map(),acknowledgedBegins=new Map(),transactions=new Map(),samples=[];
 let phase='UNKNOWN',unit='UNKNOWN',callOrdinal=0,phaseStarted=now(),requestOrdinal=0,dropped=0,droppedTransactionSamples=0;
 const retained=()=>requests.size+acknowledgedBegins.size+transactions.size;
 const emptyBegins=()=>Object.freeze([]);
 function setPhase(next,nextUnit='UNKNOWN',nextCallOrdinal=0){
  // Three fixed original calls in one operation: 0 means outside producer work, 1..3 are precommitted original ordinals.
  if(!Number.isSafeInteger(nextCallOrdinal)||nextCallOrdinal<0||nextCallOrdinal>3)throw Error('DIAGNOSTIC_CALL_ORDINAL_INVALID');
  const nextPhase=member(PHASES,next);
  if(nextPhase==='GENUINE_ORIGINAL_PRODUCER_CALL'&&nextCallOrdinal<1)throw Error('DIAGNOSTIC_CALL_ORDINAL_INVALID');
  add(bins[phase],'phaseWallMs',now()-phaseStarted);phase=nextPhase;unit=member(UNITS,nextUnit);callOrdinal=nextCallOrdinal;bins[phase].lastKnownOuterWorkUnit=unit;phaseStarted=now();
 }
 function startRequest(sqls){
  const b=bins[phase];add(b,'requests');if(retained()>=maxInflight){dropped++;return null;}
  // Capture synchronously at observedFetch entry, BEFORE awaiting body decoding or transport.
  const token=Object.freeze({});requests.set(token,Object.freeze({phase,unit,callOrdinal,requestOrdinal:++requestOrdinal,categories:null}));
  if(sqls!==undefined)bindRequestStatements(token,sqls);return token;
 }
 function bindRequestStatements(token,sqls){
  const r=requests.get(token);if(!r||r.categories!==null){dropped++;return false;}
  if(!Array.isArray(sqls)||sqls.length>4096){dropped++;return false;}
  const categories=[];
  for(let i=0;i<sqls.length;i++){
   const d=Object.getOwnPropertyDescriptor(sqls,String(i));
   if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'){dropped++;return false;}
   categories.push(classifySql(d.value));
  }
  const b=bins[r.phase];add(b,'submittedStatements',categories.length);for(const cat of categories)add(b.categories[cat],'submitted');
  // Only SQL categories are attached once; request-start ownership cannot be supplied or changed.
  requests.set(token,Object.freeze({...r,categories:Object.freeze(categories)}));return true;
 }

 function finishRequest(token,{durationMs=0,injectedDelayMs=0,successMask=[],requestError=false,responseError=false}={}){
  const r=requests.get(token);if(!r){dropped++;return emptyBegins();}requests.delete(token);
  const b=bins[r.phase];add(b,'sumRequestDurationMs',durationMs);b.maxRequestDurationMs=Math.max(b.maxRequestDurationMs,finite(durationMs));add(b,'sumInjectedDelayMs',injectedDelayMs);if(requestError)add(b,'requestErrors');if(responseError)add(b,'responseErrors');
  // Dense own boolean data properties only: holes, accessors, non-arrays or transport errors are not ACKs.
  const mask=[];let valid=r.categories!==null&&Array.isArray(successMask)&&successMask.length===r.categories.length&&!requestError;
  if(valid)for(let i=0;i<r.categories.length;i++){const d=Object.getOwnPropertyDescriptor(successMask,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='boolean'){valid=false;break;}mask.push(d.value);}
  if(!valid){add(b,'unknownReplies');return emptyBegins();}
  const begins=[];
  r.categories.forEach((cat,i)=>{
   if(!mask[i])return;
   add(b,'observedExecutedStatements');add(b.categories[cat],'executed');b.lastStorageCategory=cat;
   if(cat!=='TX_BEGIN')return;
   // Mint only after the adapter observed this exact statement's successful native BEGIN ACK.
   add(b.transactions,'begun');add(b.transactions,'open');
   if(retained()>=maxInflight){dropped++;return;}
   const owner=Object.freeze({});
   acknowledgedBegins.set(owner,Object.freeze({phase:r.phase,unit:r.unit,callOrdinal:r.callOrdinal,requestOrdinal:r.requestOrdinal,statementOrdinal:i+1,kind:'TX_BEGIN',requestToken:token}));
   begins.push(Object.freeze({statementOrdinal:i+1,owner}));
  });return Object.freeze(begins);
 }
 function startTransaction(acknowledgedBeginOwner,requestToken,statementOrdinal){
  const owner=acknowledgedBegins.get(acknowledgedBeginOwner);
  if(!owner||owner.requestToken!==requestToken||owner.statementOrdinal!==statementOrdinal||owner.kind!=='TX_BEGIN'||!Number.isSafeInteger(owner.callOrdinal)||owner.callOrdinal<0||owner.callOrdinal>3||!Number.isSafeInteger(owner.requestOrdinal)||owner.requestOrdinal<1||!Number.isSafeInteger(owner.statementOrdinal)||owner.statementOrdinal<1){dropped++;return null;}
  // Single use: a foreign observer, forged object, request token, clone or replay cannot rebind ownership.
  acknowledgedBegins.delete(acknowledgedBeginOwner);const token=Object.freeze({});transactions.set(token,{...owner,last:'TX_BEGIN'});return token;
 }
 function transactionStorage(token,category){const t=transactions.get(token);if(t)t.last=member(CATEGORIES,category,'OTHER');else dropped++;}
 function finishTransaction(token,{outcome,durationUpperBoundMs=0}={}){
  const t=transactions.get(token);if(!t){dropped++;return;}transactions.delete(token);const b=bins[t.phase],z=b.transactions;z.open=Math.max(0,z.open-1);
  const o=outcome==='COMMITTED'?'committed':outcome==='ROLLED_BACK'?'rolledBack':'unknownTerminal';add(z,o);add(z,'sumDurationUpperBoundMs',durationUpperBoundMs);z.maxDurationUpperBoundMs=Math.max(z.maxDurationUpperBoundMs,finite(durationUpperBoundMs));if(durationUpperBoundMs>=5000)add(z,'atOrAbove5s');
  if(samples.length<maxTransactionSamples)samples.push({startedPhase:t.phase,endedPhase:phase,outerWorkUnit:t.unit,callOrdinal:t.callOrdinal,requestOrdinal:t.requestOrdinal,beginStatementOrdinal:t.statementOrdinal,innerSemanticWorkUnit:'UNKNOWN_NOT_INSTRUMENTED',lastStorageCategory:t.last,outcome:o,durationUpperBoundMs:finite(durationUpperBoundMs)});else droppedTransactionSamples++;
 }
 function typedCode(error){const code=ERRORS.has(error?.code)?error.code:'OTHER';bins[phase].lastTypedCode=code;return code;}
 function snapshot(){
  const out=structuredClone(bins);add(out[phase],'phaseWallMs',now()-phaseStarted);
  const observationCoverageComplete=dropped===0,allRequestsSettled=requests.size===0,allAcknowledgedBeginsLinked=acknowledgedBegins.size===0;
  const allTransactionsSettled=Object.values(out).every(b=>b.transactions.open===0),allRepliesKnown=Object.values(out).every(b=>b.unknownReplies===0);
  const allTransactionTerminalsKnown=allTransactionsSettled&&Object.values(out).every(b=>b.transactions.unknownTerminal===0);
  // Losing optional bounded sample detail is distinct from losing a request/BEGIN/transaction owner or terminal ACK.
  const transactionSampleCoverageComplete=droppedTransactionSamples===0;
  const physicalTerminalObservationComplete=observationCoverageComplete&&allRequestsSettled&&allAcknowledgedBeginsLinked&&allTransactionsSettled&&allRepliesKnown&&allTransactionTerminalsKnown;
  const terminalObservationComplete=physicalTerminalObservationComplete,attributionComplete=physicalTerminalObservationComplete&&transactionSampleCoverageComplete;
  return {contract:'safe-native-phase-sql-attribution-proposal-v3',productionEvidence:false,diagnosticOnly:true,capacityQualified:false,bins:out,transactionSamples:structuredClone(samples),inflightRequests:requests.size,pendingAcknowledgedBegins:acknowledgedBegins.size,unsettledTransactions:transactions.size,droppedObservations:dropped,droppedTransactionSamples,transactionSampleCoverageComplete,physicalTerminalObservationComplete,observationCoverageComplete,allRequestsSettled,allAcknowledgedBeginsLinked,allTransactionsSettled,allRepliesKnown,allTransactionTerminalsKnown,terminalObservationComplete,attributionComplete,rawSqlOrIdentityOrPayloadPersisted:false,durationMeaning:'Request/transaction sums are inclusive observations, not additive wall time or a measured server absolute transaction cap.'};
 }
 return Object.freeze({setPhase,startRequest,bindRequestStatements,finishRequest,startTransaction,transactionStorage,finishTransaction,typedCode,snapshot});
}

export const EXECUTION_STATES=Object.freeze(['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','UNKNOWN']);
export const RESULT_OUTCOMES=Object.freeze(['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','FAILED','UNKNOWN']);
export const CALL_ACKNOWLEDGEMENTS=Object.freeze(['RETURNED','THREW','ACK_LOST','UNKNOWN']);
/** Allowlist mapping only. The future reader must bind actual records to the original identity and authenticate results before supplying fields. This helper creates no durable authority. */
export function safeExecutionObservation({executionState,resultOutcome,callAcknowledgement}={}){
 const state=member(EXECUTION_STATES,executionState),outcome=member(RESULT_OUTCOMES,resultOutcome),ack=member(CALL_ACKNOWLEDGEMENTS,callAcknowledgement);
 return Object.freeze({executionState:state,executionStateKnown:state!=='UNKNOWN',terminalStateObserved:state==='FINALIZED_SUCCESS'||state==='FINALIZED_FAILURE',resultOutcome:outcome,callAcknowledgement:ack});
}

const SOURCE_BASENAMES=new Set(['stage8LiveProducer.js','stage8LiveExecution.js','phase4Cache.js','executionBudget.js','processingTransaction.js','db.js','phase4Reanalysis.js','phase4Core.js','phase4QueueStore.js','phase4ExecutionContext.js','phase4Coordination.js']);
export function safeFailureFrames(error){
 const stack=typeof error?.stack==='string'?error.stack.slice(0,32768):'',out=[],seen=new Set();
 for(const line of stack.split('\n').slice(1,40)){
  const m=/\/src\/([A-Za-z0-9]+\.js):(\d+):\d+(?:\)|\s|$)/.exec(line);if(!m||!SOURCE_BASENAMES.has(m[1]))continue;
  const at=Number(m[2]),key=m[1]+':'+at;if(!Number.isSafeInteger(at)||at<1||at>1000000||seen.has(key))continue;
  seen.add(key);out.push({sourceBasename:m[1],line:at});if(out.length===8)break;
 }
 return out;
}
