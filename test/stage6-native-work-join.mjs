// Test-only, bounded semantic ownership joined to original native ACK tokens.
// Does not execute SQL, grant authority, retry, adjust clocks or qualify capacity.
import {AsyncLocalStorage} from 'node:async_hooks';
import {isProxy} from 'node:util/types';
import assert from 'node:assert/strict';
import {CATEGORIES} from './stage6-native-attribution.mjs';
export const WORK_LABELS=Object.freeze(['OUTSIDE','READ_ONLY_OR_OTHER','stage6.end','stage6.family-inventory','stage6.body-source','stage6.associations','stage6.checkpoint','stage6.source',...['recovery_score','hrv','rhr','sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain','body_energy','UNKNOWN'].map(x=>'stage6.family:'+x)]);
const labels=new Set(WORK_LABELS),blankCategories=()=>Object.fromEntries(CATEGORIES.map(x=>[x,0]));
const finite=n=>Number.isFinite(n)&&n>=0;
const keys=(v,n)=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Reflect.ownKeys(v).sort(),[...n].sort());};
export function validateWorkJoin(v){
 keys(v,['contract','diagnosticOnly','productionEvidence','capacityQualified','requestStartOwnership','allPhysicalTransactions','linkedTransactionCount','unsettledJoinedTransactions','retainedRequestOwners','retainedBeginOwners','lostJoins','terminalJoinComplete','byWork','slowest8']);
 assert.equal(v.contract,'native-request-start-work-join-v1');for(const k of ['diagnosticOnly','requestStartOwnership'])assert.equal(v[k],true);for(const k of ['productionEvidence','capacityQualified'])assert.equal(v[k],false);
 for(const k of ['allPhysicalTransactions','linkedTransactionCount','unsettledJoinedTransactions','retainedRequestOwners','retainedBeginOwners','lostJoins'])assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0);
 assert.equal(typeof v.terminalJoinComplete,'boolean');assert.ok(Array.isArray(v.byWork)&&v.byWork.length<=18*WORK_LABELS.length);assert.ok(Array.isArray(v.slowest8)&&v.slowest8.length<=8);
 let total=0;const seen=new Set();
 const label=x=>{assert.ok(Number.isSafeInteger(x.preparationOrdinal)&&x.preparationOrdinal>=0&&x.preparationOrdinal<=17);assert.ok(labels.has(x.workLabel));};
 for(const x of v.byWork){keys(x,['preparationOrdinal','workLabel','transactions','committed','rolledBack','unknownTerminal','atOrAbove5s','sumUpperMs','maxUpperMs']);label(x);const key=x.preparationOrdinal+':'+x.workLabel;assert.equal(seen.has(key),false);seen.add(key);
  for(const k of ['transactions','committed','rolledBack','unknownTerminal','atOrAbove5s'])assert.ok(Number.isSafeInteger(x[k])&&x[k]>=0);
  assert.equal(x.transactions,x.committed+x.rolledBack+x.unknownTerminal);assert.ok(x.atOrAbove5s<=x.transactions);for(const k of ['sumUpperMs','maxUpperMs'])assert.ok(finite(x[k]));assert.ok(x.sumUpperMs>=x.maxUpperMs);total+=x.transactions;
 }
 assert.ok(total<=v.linkedTransactionCount);assert.equal(total+v.unsettledJoinedTransactions,v.linkedTransactionCount);
 let prior=Infinity;for(const x of v.slowest8){keys(x,['preparationOrdinal','workInvocationOrdinal','workLabel','outcome','durationUpperBoundMs','categories']);label(x);assert.ok(Number.isSafeInteger(x.workInvocationOrdinal)&&x.workInvocationOrdinal>=0&&x.workInvocationOrdinal<=4096);assert.ok(['COMMITTED','ROLLED_BACK','UNKNOWN'].includes(x.outcome));assert.ok(finite(x.durationUpperBoundMs)&&x.durationUpperBoundMs<=prior);prior=x.durationUpperBoundMs;keys(x.categories,CATEGORIES);for(const n of Object.values(x.categories))assert.ok(Number.isSafeInteger(n)&&n>=0);assert.equal(x.categories.TX_BEGIN,1);assert.ok(x.categories.TX_COMMIT+x.categories.TX_ROLLBACK<=1);}
 if(v.terminalJoinComplete){assert.equal(v.allPhysicalTransactions,v.linkedTransactionCount);for(const k of ['unsettledJoinedTransactions','retainedRequestOwners','retainedBeginOwners','lostJoins'])assert.equal(v[k],0);assert.equal(total,v.allPhysicalTransactions);}
 return true;
}
export function createWorkCorrelation({emit=()=>{},around=(_metadata,call)=>call()}={}){
 assert.equal(typeof emit,'function');assert.equal(typeof around,'function');
 const scope=new AsyncLocalStorage(),ordinals=new Uint32Array(18),outside=Object.freeze({preparationOrdinal:0,workInvocationOrdinal:0,workLabel:'OUTSIDE'});let scopeLoss=0;
 const data=(o,k)=>{if(!o||typeof o!=='object'||isProxy(o))return undefined;const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
 function preparation(ordinal,call){assert.ok(Number.isSafeInteger(ordinal)&&ordinal>=1&&ordinal<=17);return scope.run(Object.freeze({preparationOrdinal:ordinal,workInvocationOrdinal:0,workLabel:'READ_ONLY_OR_OTHER'}),call);}
 function owned(options,call){
  const parent=scope.getStore();if(!parent)return call();
  let workLabel='READ_ONLY_OR_OTHER';
  try{const kind=data(options,'workKind'),facts=data(options,'workFacts'),metric=Array.isArray(facts)?data(facts,'0'):undefined;
   if(kind==='stage6.family')workLabel=typeof metric==='string'&&labels.has('stage6.family:'+metric)?'stage6.family:'+metric:'stage6.family:UNKNOWN';
   else if(typeof kind==='string'&&labels.has(kind))workLabel=kind;
  }catch{scopeLoss++;}
  let workInvocationOrdinal=0;if(ordinals[parent.preparationOrdinal]<4096)workInvocationOrdinal=++ordinals[parent.preparationOrdinal];else{scopeLoss++;workLabel='READ_ONLY_OR_OTHER';}
  // Only immutable telemetry metadata enters the diagnostic ALS. The original
  // options/arguments/callable are untouched; no accessor or coercion is added.
  const metadata=Object.freeze({preparationOrdinal:parent.preparationOrdinal,workInvocationOrdinal,workLabel});
  return scope.run(metadata,()=>around(metadata,call));
 }
 function decorate(base){
  const requests=new Map(),begins=new Map(),transactions=new Map(),counts=new Map(),slowest=[];let lost=0,linked=0,emissions=0;
  const keep=(m,k,v)=>{if(k&&m.size<128){m.set(k,v);return true;}lost++;return false;};
  function startRequest(...args){const owner=scope.getStore()??outside,token=base.startRequest(...args);keep(requests,token,owner);return token;}
  function finishRequest(token,...args){const owner=requests.get(token),observed=base.finishRequest(token,...args);requests.delete(token);if(!owner)lost++;
   for(const begin of observed)keep(begins,begin.owner,owner??outside);return observed;
  }
  function startTransaction(owner,...args){const captured=begins.get(owner),token=base.startTransaction(owner,...args);if(token)begins.delete(owner);if(!captured)lost++;
   if(token&&keep(transactions,token,{...(captured??outside),categories:{...blankCategories(),TX_BEGIN:1}}))linked++;return token;
  }
  function transactionStorage(token,category){base.transactionStorage(token,category);const t=transactions.get(token);if(t&&CATEGORIES.includes(category))t.categories[category]++;else lost++;}
  function finishTransaction(token,options={}){base.finishTransaction(token,options);const t=transactions.get(token);if(!t){lost++;return;}transactions.delete(token);
   const ms=options.durationUpperBoundMs;if(!finite(ms)){lost++;return;}
   const outcome=['COMMITTED','ROLLED_BACK'].includes(options.outcome)?options.outcome:'UNKNOWN';if(outcome==='COMMITTED')t.categories.TX_COMMIT++;if(outcome==='ROLLED_BACK')t.categories.TX_ROLLBACK++;
   const key=t.preparationOrdinal+':'+t.workLabel;let c=counts.get(key);if(!c){if(counts.size>=18*WORK_LABELS.length){lost++;return;}c={preparationOrdinal:t.preparationOrdinal,workLabel:t.workLabel,transactions:0,committed:0,rolledBack:0,unknownTerminal:0,atOrAbove5s:0,sumUpperMs:0,maxUpperMs:0};counts.set(key,c);}
   c.transactions++;c[outcome==='COMMITTED'?'committed':outcome==='ROLLED_BACK'?'rolledBack':'unknownTerminal']++;if(ms>=5000)c.atOrAbove5s++;c.sumUpperMs+=ms;c.maxUpperMs=Math.max(c.maxUpperMs,ms);
   const newSlowest=ms>=5000&&(!slowest.length||ms>slowest[0].durationUpperBoundMs);
   slowest.push({preparationOrdinal:t.preparationOrdinal,workInvocationOrdinal:t.workInvocationOrdinal,workLabel:t.workLabel,outcome,durationUpperBoundMs:ms,categories:t.categories});slowest.sort((a,b)=>b.durationUpperBoundMs-a.durationUpperBoundMs);if(slowest.length>8)slowest.pop();
   // Preserve a completed slow transaction before any subsequent work or
   // cleanup can hang. Fixed-count sink, finite snapshot, no outcome changes.
   if(newSlowest&&emissions<64){emissions++;try{emit(snapshot().namedWorkJoin);}catch{lost++;}}
  }
  function snapshot(){const s=base.snapshot(),allPhysicalTransactions=Object.values(s.bins).reduce((a,b)=>a+b.transactions.begun,0);
   const work={contract:'native-request-start-work-join-v1',diagnosticOnly:true,productionEvidence:false,capacityQualified:false,requestStartOwnership:true,allPhysicalTransactions,linkedTransactionCount:linked,unsettledJoinedTransactions:transactions.size,retainedRequestOwners:requests.size,retainedBeginOwners:begins.size,lostJoins:lost+scopeLoss,
    terminalJoinComplete:s.physicalTerminalObservationComplete&&lost===0&&scopeLoss===0&&requests.size===0&&begins.size===0&&transactions.size===0&&allPhysicalTransactions===linked,byWork:structuredClone([...counts.values()]),slowest8:structuredClone(slowest)};
   validateWorkJoin(work);return {...s,namedWorkJoin:work};
  }
  return Object.freeze({...base,startRequest,finishRequest,startTransaction,transactionStorage,finishTransaction,snapshot});
 }
 return Object.freeze({preparation,owned,decorate});
}
