// Synthetic diagnostics only: exact original observer ownership, one slow sample.
import {AsyncLocalStorage} from 'node:async_hooks';
import {CATEGORIES} from './stage6-native-attribution.mjs';
const roots=new WeakMap(),rootScope=new AsyncLocalStorage();
const names=new Set(['processingTransaction.js','phase4Core.js','phase4IntelligenceStore.js','phase4Reanalysis.js','phase4ReanalysisQueue.js','phase4EntityStore.js','phase4ResultAuthority.js','phase4OperationReceipts.js','stage8LiveExecution.js','stage8LiveProducer.js']);
export function captureRootPhase({readOnly,from,fixed,stack}={}){
 const frames=[];
 if(typeof stack==='string')for(const line of stack.slice(0,32768).split('\n').slice(1,40)){
  const m=/\/src\/([A-Za-z0-9_.-]+\.js):(\d+):\d+(?:\)|\s|$)/.exec(line);if(!m||!names.has(m[1]))continue;
  const at=Number(m[2]);if(!Number.isSafeInteger(at)||at<1||at>1000000||frames.some(x=>x.sourceBasename===m[1]&&x.line===at))continue;
  frames.push(Object.freeze({sourceBasename:m[1],line:at}));if(frames.length===8)break;
 }
 const token=Object.freeze({});roots.set(token,Object.freeze({readOnly:readOnly===true,hasWorkStepFrom:from===true,hasFixedStep:fixed===true,frames:Object.freeze(frames)}));return token;
}
// Only the exact original bootstrap callback (BEGIN/SELECT1) enters this scope.
// Async descendants keep their own immutable metadata; no global current root.
export function withRootPhase(token,work){return rootScope.run(roots.get(token)??null,work);}
export const closeRootPhase=()=>rootScope.disable();
export function createSlowRootAttribution({observer,ordinal=()=>0,onLongest=()=>{},onSaturated=()=>{}}={}){
 const requests=new Map(),begins=new WeakMap(),transactions=new Map();let sequence=0,longest=null,dropped=0,earlyAttempts=0,earlyFailures=0,earlySaturated=false;
 const emitLongest=()=>{if(earlyAttempts<32){earlyAttempts++;try{onLongest({contract:'one-original-physical-slow-root-early-v1',sample:structuredClone(longest),physicalTransactionTerminalObserved:longest.outcome!=='UNKNOWN',runnerSettled:false});}catch{earlyFailures++;}}else if(!earlySaturated){earlySaturated=true;try{onSaturated();}catch{earlyFailures++;}}};
 const safeOwner=()=>{try{const n=ordinal();return Object.freeze({ordinal:Number.isSafeInteger(n)&&n>=1&&n<=20?n:0,root:rootScope.getStore()??null});}catch{return Object.freeze({ordinal:0,root:null});}};
 const api={...observer,
  startRequest(...args){const owner=safeOwner(),token=observer.startRequest(...args);if(token&&requests.size<128)requests.set(token,owner);else if(token)dropped++;return token;},
  finishRequest(token,...args){let out;try{out=observer.finishRequest(token,...args);const metadata=requests.get(token);if(metadata)for(const begin of out)begins.set(begin.owner,metadata);return out;}finally{requests.delete(token);}},
  startTransaction(owner,...args){const token=observer.startTransaction(owner,...args),metadata=begins.get(owner);if(token)begins.delete(owner);if(token&&metadata&&transactions.size<128)transactions.set(token,{...metadata,sequence:++sequence,categories:Object.fromEntries(CATEGORIES.map(x=>[x,0]))});else if(token)dropped++;return token;},
  transactionStorage(token,category){const out=observer.transactionStorage(token,category),t=transactions.get(token);if(t)t.categories[CATEGORIES.includes(category)?category:'OTHER']++;return out;},
  finishTransaction(token,options={}){const t=transactions.get(token);try{const out=observer.finishTransaction(token,options),ms=options.durationUpperBoundMs;if(t?.ordinal&&Number.isFinite(ms)&&ms>=0&&(!longest||ms>longest.durationUpperBoundMs)){longest={ordinal:t.ordinal,sequence:t.sequence,rootObserved:t.root!==null,root:t.root,outcome:options.outcome==='COMMITTED'?'COMMITTED':options.outcome==='ROLLED_BACK'?'ROLLED_BACK':'UNKNOWN',durationUpperBoundMs:ms,categories:{...t.categories}};emitLongest();}return out;}finally{transactions.delete(token);}},
  snapshot(){return {...observer.snapshot(),longestPreparationTransaction:longest?structuredClone(longest):null,slowRootMetadata:{dropped,earlyProjectionAttempts:earlyAttempts,earlyProjectionFailures:earlyFailures,earlyProjectionSaturated:earlySaturated,retainedRequests:requests.size,retainedTransactions:transactions.size,scope:'Top1 client interval only; original BEGIN/terminal ownership unchanged; root metadata activated only in original bootstrap; no server-duration claim'}};}
 };
 return Object.freeze(api);
}

const exactKeys=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validEarlySlowRoot(v){
 const s=v?.sample,r=s?.root;
 if(!exactKeys(v,['contract','sample','physicalTransactionTerminalObserved','runnerSettled'])||!exactKeys(s,['ordinal','sequence','rootObserved','root','outcome','durationUpperBoundMs','categories'])||v?.contract!=='one-original-physical-slow-root-early-v1'||v.runnerSettled!==false||!s
  ||!Number.isSafeInteger(s.ordinal)||s.ordinal<1||s.ordinal>20||!Number.isSafeInteger(s.sequence)||s.sequence<1
  ||!Number.isFinite(s.durationUpperBoundMs)||s.durationUpperBoundMs<0||!['COMMITTED','ROLLED_BACK','UNKNOWN'].includes(s.outcome)
  ||v.physicalTransactionTerminalObserved!==(s.outcome!=='UNKNOWN')||typeof s.rootObserved!=='boolean'
  ||(s.rootObserved?(!r||typeof r!=='object'||Array.isArray(r)):r!==null))return false;
 if(r&&(!exactKeys(r,['readOnly','hasWorkStepFrom','hasFixedStep','frames'])||!['readOnly','hasWorkStepFrom','hasFixedStep'].every(k=>typeof r[k]==='boolean')||!Array.isArray(r.frames)||r.frames.length>8
  ||r.frames.some(x=>!exactKeys(x,['sourceBasename','line'])||!names.has(x.sourceBasename)||!Number.isSafeInteger(x.line)||x.line<1||x.line>1000000)))return false;
 if(!s.categories||Object.keys(s.categories).length!==CATEGORIES.length||!CATEGORIES.every(k=>Number.isSafeInteger(s.categories[k])&&s.categories[k]>=0))return false;
 return true;
}
export function parseEarlySlowRoot(raw){
 let sample=null,observedMarkers=0,invalid=0,saturated=false;
 if(typeof raw!=='string'||raw.length>16*1024*1024)return {sample:null,observedMarkers:0,coverage:'UNAVAILABLE_OR_OVERSIZED',runnerSettlementProven:false};
 for(const line of raw.split('\n')){
  if(line.startsWith('STAGE6_NATIVE_SLOW_ROOT_SATURATED ')){saturated=true;continue;}
  if(!line.startsWith('STAGE6_NATIVE_SLOW_ROOT_TOP1 '))continue;
  observedMarkers++;if(observedMarkers>32||line.length>8192){invalid++;continue;}
  try{const v=JSON.parse(line.slice('STAGE6_NATIVE_SLOW_ROOT_TOP1 '.length));if(!validEarlySlowRoot(v)){invalid++;continue;}sample=v;}catch{invalid++;}
 }
 return {sample,observedMarkers,invalid,saturated,coverage:invalid||saturated?'PARTIAL_OR_SATURATED_EARLY_SUBSET':'OBSERVED_EARLY_SUBSET_ONLY',runnerSettlementProven:false,scope:'Physical transaction terminal witnesses only; not complete global maximum or runner/job success'};
}
