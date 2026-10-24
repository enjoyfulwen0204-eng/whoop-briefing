// Synthetic diagnostics only. Finite phase timings on original physical tokens.
// No SQL, health values, context, receipt, authority, retry or clock changes.
import {isProxy} from 'node:util/types';
import assert from 'node:assert/strict';
export const FAMILY_PHASES=Object.freeze(['INITIAL_INVENTORY','ENTRY_WORK_CHECK','RECURRENCE','PREPARATION_REPLAY','METRIC_LIFECYCLE','FINAL_INVENTORY','TIP_COMPLETION','TIP_VERIFY']);
const phases=new Set(FAMILY_PHASES),metrics=new Set(['recovery_score','hrv','rhr','sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain','body_energy','UNKNOWN']);
const own=(o,k)=>{if(!o||typeof o!=='object'||isProxy(o))return undefined;const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
const validNumber=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const exact=(v,ks)=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Reflect.ownKeys(v).sort(),[...ks].sort());};
export function validateFamilyPhaseJoin(v){
 exact(v,['contract','diagnosticOnly','productionEvidence','capacityQualified','joinedByOriginalPhysicalToken','activeRoots','retainedOwners','lostObservations','outsideFamilyPhases','completedFamilyRoots','rootsWithoutPhaseWindows','unknownFamilyTerminals','coverageComplete','slowest8']);
 assert.equal(v.contract,'native-family-phase-original-token-v1');for(const k of ['diagnosticOnly','joinedByOriginalPhysicalToken'])assert.equal(v[k],true);for(const k of ['productionEvidence','capacityQualified'])assert.equal(v[k],false);
 for(const k of ['activeRoots','retainedOwners','lostObservations','outsideFamilyPhases','completedFamilyRoots','rootsWithoutPhaseWindows','unknownFamilyTerminals'])assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0);
 assert.equal(v.coverageComplete,v.lostObservations===0&&v.activeRoots===0&&v.retainedOwners===0&&v.completedFamilyRoots>0&&v.rootsWithoutPhaseWindows===0&&v.unknownFamilyTerminals===0);
 assert.ok(v.activeRoots<=128&&v.retainedOwners<=128);assert.ok(Array.isArray(v.slowest8)&&v.slowest8.length<=8);
 let prior=Infinity;
 for(const r of v.slowest8){
  exact(r,['preparationOrdinal','workInvocationOrdinal','workLabel','outcome','durationUpperBoundMs','phaseWindowsWithinClientUpper','phases']);
  assert.ok(Number.isSafeInteger(r.preparationOrdinal)&&r.preparationOrdinal>=1&&r.preparationOrdinal<=17);assert.ok(Number.isSafeInteger(r.workInvocationOrdinal)&&r.workInvocationOrdinal>=1&&r.workInvocationOrdinal<=4096);
  assert.ok(typeof r.workLabel==='string'&&r.workLabel.startsWith('stage6.family:')&&metrics.has(r.workLabel.slice(14)));assert.ok(['COMMITTED','ROLLED_BACK','UNKNOWN'].includes(r.outcome));
  assert.ok(validNumber(r.durationUpperBoundMs)&&r.durationUpperBoundMs<=prior);prior=r.durationUpperBoundMs;assert.equal(typeof r.phaseWindowsWithinClientUpper,'boolean');
  exact(r.phases,FAMILY_PHASES);
  for(const p of Object.values(r.phases)){exact(p,['calls','completed','failed','sumInclusiveMs','maxInclusiveMs']);for(const k of ['calls','completed','failed'])assert.ok(Number.isSafeInteger(p[k])&&p[k]>=0);assert.equal(p.calls,p.completed);assert.ok(p.failed<=p.completed);assert.ok(validNumber(p.sumInclusiveMs)&&validNumber(p.maxInclusiveMs)&&p.maxInclusiveMs<=p.sumInclusiveMs);}
 }
 return true;
}
export function createFamilyPhaseCorrelation({now=()=>performance.now()}={}){
 const roots=new Map(),owners=new WeakMap(),slowest=[];let lost=0,outside=0,completed=0,retainedOwners=0,unobserved=0,unknownTerminals=0;
 const tick=()=>{try{const n=now();return validNumber(n)?n:null;}catch{return null;}};
 function enter(token,owner,metadata){
  const label=own(metadata,'workLabel');if(typeof label!=='string'||!label.startsWith('stage6.family:'))return;
  const prep=own(metadata,'preparationOrdinal'),inv=own(metadata,'workInvocationOrdinal');
  if(!token||!owner||typeof owner!=='object'||isProxy(owner)||!metrics.has(label.slice(14))||!Number.isSafeInteger(prep)||prep<1||prep>17||!Number.isSafeInteger(inv)||inv<1||inv>4096||roots.has(token)||roots.size>=128){lost++;return;}
  let owned=owners.get(owner);if(!owned){owned=new Set();owners.set(owner,owned);retainedOwners++;}
  const record={owner,preparationOrdinal:prep,workInvocationOrdinal:inv,workLabel:label,pending:0,closed:false,phases:Object.fromEntries(FAMILY_PHASES.map(p=>[p,{calls:0,completed:0,failed:0,sumInclusiveMs:0,maxInclusiveMs:0}]))};
  roots.set(token,record);owned.add(token);
 }
 async function phase(owner,name,call){
  // These fixed callbacks occur at original await boundaries only. Diagnostic
  // loss is explicit; it never suppresses or retries original application work.
  const owned=owner&&typeof owner==='object'?owners.get(owner):null;
  if(!phases.has(name)){lost++;return call();}
  if(!owned?.size){outside++;return call();}
  if(owned.size!==1){lost++;return call();}
  const token=owned.values().next().value,r=roots.get(token);
  if(!r||r.closed||r.pending){lost++;return call();}
  const at=tick();if(at===null){lost++;return call();}
  const p=r.phases[name];p.calls++;r.pending++;let failed=false;
  try{return await call();}catch(error){failed=true;throw error;}
  finally{
   const end=tick();r.pending--;
   if(r.closed||roots.get(token)!==r||end===null||end<at){lost++;p.completed++;if(failed)p.failed++;}
   else{const ms=end-at;p.completed++;if(failed)p.failed++;p.sumInclusiveMs+=ms;p.maxInclusiveMs=Math.max(p.maxInclusiveMs,ms);}
  }
 }
 function finish(token,{outcome,durationUpperBoundMs}={}){
  const r=roots.get(token);if(!r)return;roots.delete(token);r.closed=true;
  const owned=owners.get(r.owner);if(owned){owned.delete(token);if(!owned.size){owners.delete(r.owner);retainedOwners--;}}
  if(r.pending||!validNumber(durationUpperBoundMs)){lost++;return;}
  const record={preparationOrdinal:r.preparationOrdinal,workInvocationOrdinal:r.workInvocationOrdinal,workLabel:r.workLabel,outcome:['COMMITTED','ROLLED_BACK'].includes(outcome)?outcome:'UNKNOWN',durationUpperBoundMs,
   phaseWindowsWithinClientUpper:Object.values(r.phases).reduce((n,p)=>n+p.sumInclusiveMs,0)<=durationUpperBoundMs,phases:r.phases};
  completed++;if(Object.values(r.phases).every(p=>p.calls===0))unobserved++;if(record.outcome==='UNKNOWN')unknownTerminals++;slowest.push(record);slowest.sort((a,b)=>b.durationUpperBoundMs-a.durationUpperBoundMs);if(slowest.length>8)slowest.pop();
 }
 function snapshot(){const v={contract:'native-family-phase-original-token-v1',diagnosticOnly:true,productionEvidence:false,capacityQualified:false,joinedByOriginalPhysicalToken:true,activeRoots:roots.size,retainedOwners,lostObservations:lost,outsideFamilyPhases:outside,completedFamilyRoots:completed,rootsWithoutPhaseWindows:unobserved,unknownFamilyTerminals:unknownTerminals,coverageComplete:lost===0&&roots.size===0&&retainedOwners===0&&completed>0&&unobserved===0&&unknownTerminals===0,slowest8:structuredClone(slowest)};validateFamilyPhaseJoin(v);return v;}
 return Object.freeze({enter,phase,finish,snapshot});
}
