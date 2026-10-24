// Exact-source test-only numerical admission telemetry. No cache limits change.
import assert from 'node:assert/strict';
export const MEMO_EVENTS=Object.freeze(['ROW_PUT','DATA_PUT','ROW_ROWS','DATA_ROWS','ROW_SIZE','DATA_SIZE','ROW_DUPLICATE','DATA_DUPLICATE','ROW_ADMIT','DATA_ADMIT','CLEAR','CLOSE']);
const counters=Object.freeze(['rowPuts','dataPuts','closedRefusals','epochRefusals','entryRefusals','rowChecks','rowRefusals','sizeChecks','resultByteRefusals','totalByteRefusals','duplicateChecks','duplicateRefusals','rowAdmissions','dataAdmissions','clears','closes']);
const limits={records:64,events:1000000,instances:1000000,numeric:2**40};
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0&&n<=limits.numeric;
function exact(v,k){assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Reflect.ownKeys(v).sort(),[...k].sort());}
export function validateMemoProbe(v){
 exact(v,['contract','diagnosticOnly','productionEvidence','capacityQualified','scope','registeredInstances','observations','droppedObservations','records']);
 assert.equal(v.contract,'native-memo-admission-probe-v1');assert.equal(v.diagnosticOnly,true);assert.equal(v.productionEvidence,false);assert.equal(v.capacityQualified,false);assert.equal(v.scope,'PREPARATION17_INVOCATION2_RECOVERY_SCORE_ONLY');
 for(const k of ['registeredInstances','observations','droppedObservations'])assert.ok(nonnegative(v[k]));assert.ok(v.registeredInstances<=limits.instances);assert.ok(v.observations<=limits.events);assert.ok(Array.isArray(v.records)&&v.records.length<=limits.records);
 let sum=0;const seen=new Set();for(const r of v.records){exact(r,['memoOrdinal','epoch','observations','counts','maxEntries','maxBytes','minEntryFullBytes','maxEntryFullBytes','maxRows','maxSize']);
  for(const k of ['memoOrdinal','epoch','observations','maxEntries','maxBytes','maxEntryFullBytes','maxRows','maxSize'])assert.ok(nonnegative(r[k]));assert.ok(r.memoOrdinal>=1&&r.memoOrdinal<=v.registeredInstances);assert.ok(r.maxEntries<=256&&r.maxBytes<=4194304);exact(r.counts,counters);for(const n of Object.values(r.counts))assert.ok(nonnegative(n)&&n<=r.observations);
  if(r.counts.entryRefusals){assert.ok(nonnegative(r.minEntryFullBytes));assert.ok(r.minEntryFullBytes<=r.maxEntryFullBytes&&r.maxEntryFullBytes<=r.maxBytes);}else assert.equal(r.minEntryFullBytes,null);
  const key=r.memoOrdinal+':'+r.epoch;assert.equal(seen.has(key),false);seen.add(key);sum+=r.observations;
 }assert.equal(sum,v.observations);return true;
}
export function createMemoProbe(scope){
 assert.equal(typeof scope,'function');let registeredInstances=0,observations=0,droppedObservations=0;const records=new Map();
 const drop=()=>{if(droppedObservations<limits.numeric)droppedObservations++;};
 function register(){if(registeredInstances>=limits.instances){drop();return 0;}return ++registeredInstances;}
 function note(id,event,epoch,entries,bytes,a=0,b=0){
  try{
   const s=scope();if(s?.preparationOrdinal!==17||s?.workInvocationOrdinal!==2||s?.workLabel!=='stage6.family:recovery_score')return;
   if(!MEMO_EVENTS.includes(event)||![id,epoch,entries,bytes,a,b].every(nonnegative)||id<1||id>registeredInstances||entries>256||bytes>4194304||observations>=limits.events){drop();return;}
   const key=id+':'+epoch;let r=records.get(key);if(!r){if(records.size>=limits.records){drop();return;}r={memoOrdinal:id,epoch,observations:0,counts:Object.fromEntries(counters.map(k=>[k,0])),maxEntries:0,maxBytes:0,minEntryFullBytes:null,maxEntryFullBytes:0,maxRows:0,maxSize:0};records.set(key,r);}
   observations++;r.observations++;r.maxEntries=Math.max(r.maxEntries,entries);r.maxBytes=Math.max(r.maxBytes,bytes);const c=r.counts;
   if(event==='ROW_PUT'||event==='DATA_PUT'){c[event==='ROW_PUT'?'rowPuts':'dataPuts']++;if(a===1)c.closedRefusals++;else if(a===2)c.epochRefusals++;else if(entries>=256){c.entryRefusals++;r.minEntryFullBytes=r.minEntryFullBytes===null?bytes:Math.min(r.minEntryFullBytes,bytes);r.maxEntryFullBytes=Math.max(r.maxEntryFullBytes,bytes);}}
   else if(event.endsWith('_ROWS')){c.rowChecks++;if(a>128)c.rowRefusals++;r.maxRows=Math.max(r.maxRows,a);}
   else if(event.endsWith('_SIZE')){c.sizeChecks++;if(a>262144)c.resultByteRefusals++;if(bytes+a>4194304)c.totalByteRefusals++;r.maxSize=Math.max(r.maxSize,a);}
   else if(event.endsWith('_DUPLICATE')){c.duplicateChecks++;if(a===1)c.duplicateRefusals++;}
   else if(event==='ROW_ADMIT')c.rowAdmissions++;else if(event==='DATA_ADMIT')c.dataAdmissions++;else if(event==='CLEAR')c.clears++;else if(event==='CLOSE')c.closes++;
  }catch{drop();}
 }
 function snapshot(){const v={contract:'native-memo-admission-probe-v1',diagnosticOnly:true,productionEvidence:false,capacityQualified:false,scope:'PREPARATION17_INVOCATION2_RECOVERY_SCORE_ONLY',registeredInstances,observations,droppedObservations,records:structuredClone([...records.values()])};validateMemoProbe(v);return v;}
 return Object.freeze({register,note,snapshot});
}
