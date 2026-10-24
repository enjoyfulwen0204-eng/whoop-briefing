// Diagnostic only: process-wide V8 self samples during one fixed owned-work
// window, including profiler overhead. Not per-physical-transaction CPU.
import assert from 'node:assert/strict';
import {Session} from 'node:inspector';
import {isProxy} from 'node:util/types';
import {summarizeCpuProfile,CPU_PUBLIC_FILES,CPU_PUBLIC_FUNCTIONS,CPU_SOURCE_BUCKETS} from './stage6-native-cpu-profile.mjs';
const files=new Set(CPU_PUBLIC_FILES),functions=new Set(CPU_PUBLIC_FUNCTIONS);
const target=Object.freeze({preparationOrdinal:17,workInvocationOrdinal:2,workLabel:'stage6.family:recovery_score'});
const finite=n=>Number.isFinite(n)&&n>=0;
function keys(v,k){assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Reflect.ownKeys(v).sort(),[...k].sort());}
const reasons=['NONE','PROFILE_SETUP','PROFILE_STOP','PROFILE_DISABLE','PROFILE_DISCONNECT','PROFILE_PACKET'];
export function validateFamilyCPU(v){
 keys(v,['contract','diagnosticOnly','productionEvidence','capacityQualified','processWideSelfSamples','physicalTransactionCPUAttribution','samplingOverheadNotSubtracted','target','targetCalls','profileCaptures','profileFailures','droppedReports','originalOutcome','lastProfileFailure','profilerDisabled','sessionDisconnected','profile']);
 assert.equal(v.contract,'fixed-owned-recovery-cpu-window-v1');for(const k of ['diagnosticOnly','processWideSelfSamples','samplingOverheadNotSubtracted'])assert.equal(v[k],true);for(const k of ['productionEvidence','capacityQualified','physicalTransactionCPUAttribution'])assert.equal(v[k],false);assert.deepEqual(v.target,target);
 for(const k of ['targetCalls','profileCaptures','profileFailures','droppedReports'])assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=1000000);assert.ok(v.profileCaptures<=1);assert.ok(['NOT_STARTED','RETURNED','THREW'].includes(v.originalOutcome));assert.ok(reasons.includes(v.lastProfileFailure));for(const k of ['profilerDisabled','sessionDisconnected'])assert.equal(typeof v[k],'boolean');
 const p=v.profile;if(p===null)return true;
 keys(p,['sampledMs','sampleCount','rawProfilePersisted','sourceTotalsMs','top20','workWallMs','nodeUserCpuMs','nodeSystemCpuMs']);assert.equal(p.rawProfilePersisted,false);assert.ok(Number.isSafeInteger(p.sampleCount)&&p.sampleCount>=0&&p.sampleCount<=200000);for(const k of ['sampledMs','workWallMs','nodeUserCpuMs','nodeSystemCpuMs'])assert.ok(finite(p[k]));keys(p.sourceTotalsMs,CPU_SOURCE_BUCKETS);for(const n of Object.values(p.sourceTotalsMs))assert.ok(finite(n));assert.ok(Math.abs(Object.values(p.sourceTotalsMs).reduce((a,b)=>a+b,0)-p.sampledMs)<=Math.max(.01,p.sampledMs*1e-9));
 assert.ok(Array.isArray(p.top20)&&p.top20.length<=20);let prior=Infinity;for(const f of p.top20){keys(f,['file','fn','line','sampledMs','percent']);assert.ok(files.has(f.file)&&functions.has(f.fn));assert.ok(Number.isSafeInteger(f.line)&&f.line>=0&&f.line<=100000);assert.ok(finite(f.sampledMs)&&f.sampledMs<=prior);prior=f.sampledMs;assert.ok(finite(f.percent)&&f.percent<=100.00001);}
 return true;
}
const own=(o,k)=>{if(!o||typeof o!=='object'||isProxy(o))return;const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
export function createFamilyCPU({emit=()=>{},sessionFactory=()=>new Session()}={}){
 assert.equal(typeof emit,'function');assert.equal(typeof sessionFactory,'function');let targetCalls=0,profileCaptures=0,profileFailures=0,droppedReports=0,profile=null,originalOutcome='NOT_STARTED',lastProfileFailure='NONE',profilerDisabled=false,sessionDisconnected=false;
 const fail=reason=>{profileFailures=Math.min(1000000,profileFailures+1);lastProfileFailure=reason;};
 function snapshot(){const v={contract:'fixed-owned-recovery-cpu-window-v1',diagnosticOnly:true,productionEvidence:false,capacityQualified:false,processWideSelfSamples:true,physicalTransactionCPUAttribution:false,samplingOverheadNotSubtracted:true,target:{...target},targetCalls,profileCaptures,profileFailures,droppedReports,originalOutcome,lastProfileFailure,profilerDisabled,sessionDisconnected,profile:profile?structuredClone(profile):null};validateFamilyCPU(v);return v;}
 function publish(){try{emit(snapshot());}catch{droppedReports=Math.min(1000000,droppedReports+1);}}
 async function around(metadata,call){
  if(own(metadata,'preparationOrdinal')!==17||own(metadata,'workInvocationOrdinal')!==2||own(metadata,'workLabel')!==target.workLabel)return call();
  targetCalls=Math.min(1000000,targetCalls+1);if(targetCalls!==1)return call();
  let session=null,enabled=false,started=false,value,error,failed=false,workWallMs=0,nodeUserCpuMs=0,nodeSystemCpuMs=0;
  const post=method=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PROFILE_CONTROL_TIMEOUT')),1000);try{session.post(method,(e,v)=>{clearTimeout(timer);e?reject(e):resolve(v);});}catch(e){clearTimeout(timer);reject(e);}});
  try{session=sessionFactory();session.connect();await post('Profiler.enable');enabled=true;await post('Profiler.start');started=true;}catch{fail('PROFILE_SETUP');if(session&&!sessionDisconnected)try{session.disconnect();sessionDisconnected=true;}catch{fail('PROFILE_DISCONNECT');}enabled=false;started=false;}
  // Diagnostic faults never suppress, replay, or replace this original call.
  const before=process.cpuUsage(),at=performance.now();
  try{value=await call();originalOutcome='RETURNED';}catch(e){failed=true;error=e;originalOutcome='THREW';}
  finally{
   const usage=process.cpuUsage(before);workWallMs=performance.now()-at;nodeUserCpuMs=usage.user/1000;nodeSystemCpuMs=usage.system/1000;
   if(started)try{const raw=await post('Profiler.stop');const summary=summarizeCpuProfile(raw.profile);const candidate={...summary,workWallMs,nodeUserCpuMs,nodeSystemCpuMs};validateFamilyCPU({...snapshot(),profile:candidate});profile=candidate;profileCaptures=1;}catch{fail('PROFILE_STOP');}
   if(enabled)try{await post('Profiler.disable');profilerDisabled=true;}catch{fail('PROFILE_DISABLE');}
   if(session&&!sessionDisconnected)try{session.disconnect();sessionDisconnected=true;}catch{fail('PROFILE_DISCONNECT');}
   publish();
  }
  if(failed)throw error;return value;
 }
 return Object.freeze({around,snapshot,publish});
}
