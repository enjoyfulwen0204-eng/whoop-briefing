// Test-only counters for one existing Linux Recovery lifecycle. No SQL,
// profiler attachment, authority, deadline change or work-result replacement.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isProxy} from 'node:util/types';
import assert from 'node:assert/strict';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const closed=(v,keys)=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Reflect.ownKeys(v).sort(),[...keys].sort());};
export function validateRecovery17CostState(v){
 closed(v,['contract','claimed','observerFaults','productionEvidence','capacityQualified']);
 assert.equal(v.contract,'recovery17-test-counter-observer-state-v1');assert.equal(typeof v.claimed,'boolean');
 assert.ok(integer(v.observerFaults)&&v.observerFaults<=1000000);assert.equal(v.productionEvidence,false);assert.equal(v.capacityQualified,false);return true;
}
export function validateRecovery17CostPacket(v,candidateSHA){
 assert.match(candidateSHA??'',/^[a-f0-9]{40}$/);
 closed(v,['contract','candidateSHA','preparationOrdinal','workInvocationOrdinal','workLabel','phase','status','measurement','observerFaults','originalCallOutcome','originalReturnOrErrorPreserved','intervalsNotAtomic','sumsNotExclusive','processWideAndContainerCounters','productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified']);
 assert.equal(v.contract,'one-original-recovery17-lifecycle-cpu-cost-v1');assert.equal(v.candidateSHA,candidateSHA);assert.equal(v.preparationOrdinal,17);
 assert.equal(v.workInvocationOrdinal,2);
 assert.equal(v.workLabel,'stage6.family:recovery_score');assert.equal(v.phase,'METRIC_LIFECYCLE');
 assert.ok(['OBSERVED_DIAGNOSTIC_COST_ONLY','UNKNOWN_COST'].includes(v.status));assert.ok(['RETURNED','THREW'].includes(v.originalCallOutcome));
 assert.ok(integer(v.observerFaults)&&v.observerFaults<=1000000);
 for(const k of ['originalReturnOrErrorPreserved','intervalsNotAtomic','sumsNotExclusive','processWideAndContainerCounters'])assert.equal(v[k],true);
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'])assert.equal(v[k],false);
 if(v.measurement!==null){
  const m=v.measurement;closed(m,['wallMs','clientUserUs','clientSystemUs','ownedSqldUserTicks','ownedSqldSystemTicks','clockTicksPerSecond','containerDelta']);
  assert.ok(Number.isFinite(m.wallMs)&&m.wallMs>=0&&m.wallMs<=300000);
  for(const k of ['clientUserUs','clientSystemUs','ownedSqldUserTicks','ownedSqldSystemTicks'])assert.ok(integer(m[k]));
  assert.ok(integer(m.clockTicksPerSecond)&&m.clockTicksPerSecond>=1&&m.clockTicksPerSecond<=1000000);
  closed(m.containerDelta,cgroupFields);for(const k of cgroupFields)assert.ok(integer(m.containerDelta[k]));
 }
 if(v.status==='OBSERVED_DIAGNOSTIC_COST_ONLY'){assert.notEqual(v.measurement,null);assert.equal(v.observerFaults,0);}
 else assert.ok(v.observerFaults>0);
 return true;
}
const scalar=(o,k)=>{if(!o||typeof o!=='object'||isProxy(o))return undefined;const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
export function parseOwnedStat(text,pid){
 if(typeof text!=='string'||text.length>8192)throw Error('INVALID_OWNED_STAT');
 const end=text.lastIndexOf(')'),head=text.slice(0,text.indexOf(' ')),parts=text.slice(end+2).trim().split(/\s+/);
 if(!text.startsWith(String(pid)+' (')||end<String(pid).length+2||text[end+1]!==' '||head!==String(pid)||parts.length<20||![parts[11],parts[12],parts[19]].every(s=>/^\d+$/.test(s??'')))throw Error('INVALID_OWNED_STAT');
 return {user:BigInt(parts[11]),system:BigInt(parts[12]),start:parts[19]};
}
const cgroupFields=['usage_usec','user_usec','system_usec','nr_periods','nr_throttled','throttled_usec'];
export function parseCPUStat(text){
 if(typeof text!=='string'||text.length>4096)throw Error('INVALID_CONTAINER_STAT');
 const result={};for(const line of text.trim().split('\n')){
  const m=/^([A-Za-z_][A-Za-z0-9_.]*)\s+(\d+)$/.exec(line);if(!m)throw Error('INVALID_CONTAINER_STAT');
  if(cgroupFields.includes(m[1])){if(Object.hasOwn(result,m[1]))throw Error('DUPLICATE_CONTAINER_FIELD');result[m[1]]=BigInt(m[2]);}
 }
 if(cgroupFields.some(k=>!Object.hasOwn(result,k)))throw Error('MISSING_CONTAINER_FIELD');return result;
}
export function createRecovery17CostProbe({readText=p=>readFileSync(p,'utf8'),cpu=()=>process.cpuUsage(),
 clock=()=>performance.now(),ticks=()=>Number(execFileSync('/usr/bin/getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000,maxBuffer:1024}).trim()),
 candidateSHA=process.env.EXPECTED_CANDIDATE_SHA,emit=p=>console.log('STAGE6_RECOVERY17_CPU_COST '+JSON.stringify(p))}={}){
 let preparation=0,server,serverPID,startIdentity,hz,faults=0,claimed=false;
 const fault=()=>{if(faults<1000000)faults++;};
 const safeNumber=n=>{if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('UNKNOWN_COUNTER_DELTA');return Number(n);};
 function alive(){return server&&server.pid===serverPID&&server.exitCode===null&&server.signalCode===null;}
 function observe(){
  if(!alive())throw Error('OWNED_PROCESS_NOT_ALIVE');
  // Both captured processes must remain in the same private container root
  // cgroup, with the original verified half-CPU setting at each endpoint.
  if(readText('/proc/self/cgroup').trim()!=='0::/'||readText('/proc/'+serverPID+'/cgroup').trim()!=='0::/'
   ||readText('/sys/fs/cgroup/cpu.max').trim()!=='50000 100000')throw Error('OWNED_CGROUP_REQUIRED');
  const client=cpu(),sqld=parseOwnedStat(readText('/proc/'+serverPID+'/stat'),serverPID),container=parseCPUStat(readText('/sys/fs/cgroup/cpu.stat'));
  if(!integer(client.user)||!integer(client.system)||sqld.start!==startIdentity||!alive())throw Error('OWNED_PROCESS_IDENTITY_CHANGED');
  return {client:{user:client.user,system:client.system},sqld,container};
 }
 function setup(child){try{
  if(!child||child.spawnfile!=='/usr/local/bin/isolated-sqld'||!Array.isArray(child.spawnargs)||child.spawnargs[0]!==child.spawnfile
   ||!integer(child.pid)||child.pid===0||child.exitCode!==null||child.signalCode!==null)throw Error('ORIGINAL_OWNED_CHILD_REQUIRED');
  if(server)throw Error('OWNED_CHILD_ALREADY_BOUND');server=child;serverPID=child.pid;
  startIdentity=parseOwnedStat(readText('/proc/'+serverPID+'/stat'),serverPID).start;
  hz=ticks();if(!integer(hz)||hz===0||hz>1000000)throw Error('CLOCK_TICKS_REQUIRED');
 }catch{fault();}}
 async function measure(owner,call){
  if(claimed)return call();claimed=true;
  let before,after,began,ended,returned=false;
  try{before=observe();}catch{fault();}
  try{began=clock();}catch{fault();}
  try{const value=await call();returned=true;return value;}
  finally{
   try{ended=clock();}catch{fault();}
   try{after=observe();}catch{fault();}
   let measurement=null;
   try{
    if(!before||!after||!Number.isFinite(began)||!Number.isFinite(ended)||ended<began||!integer(hz)||hz===0)throw Error('UNKNOWN_MEASUREMENT');
    const du=after.client.user-before.client.user,ds=after.client.system-before.client.system;
    if(!integer(du)||!integer(ds))throw Error('UNKNOWN_CLIENT_COUNTER');
    measurement={wallMs:ended-began,clientUserUs:du,clientSystemUs:ds,ownedSqldUserTicks:safeNumber(after.sqld.user-before.sqld.user),
     ownedSqldSystemTicks:safeNumber(after.sqld.system-before.sqld.system),clockTicksPerSecond:hz,
     containerDelta:Object.fromEntries(cgroupFields.map(k=>[k,safeNumber(after.container[k]-before.container[k])]))};
   }catch{fault();}
   const packet={contract:'one-original-recovery17-lifecycle-cpu-cost-v1',candidateSHA,
    preparationOrdinal:owner.preparation,workInvocationOrdinal:owner.invocation,workLabel:'stage6.family:recovery_score',phase:'METRIC_LIFECYCLE',
    status:measurement&&faults===0?'OBSERVED_DIAGNOSTIC_COST_ONLY':'UNKNOWN_COST',measurement,observerFaults:faults,
    originalCallOutcome:returned?'RETURNED':'THREW',originalReturnOrErrorPreserved:true,
    intervalsNotAtomic:true,sumsNotExclusive:true,processWideAndContainerCounters:true,
    productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};
   // Observer failure must never replace the original return/error.
   try{if(!/^[a-f0-9]{40}$/.test(candidateSHA??''))throw Error('CANDIDATE_REQUIRED');emit(packet);}catch{fault();}
  }
 }
 function decorate(base){return Object.freeze({...base,
  phase(name,call){
   if(preparation!==17||name!=='METRIC_LIFECYCLE')return base.phase(name,call);
   return base.phase(name,()=>{
    let target=false;
    try{
     const owner=base.currentWorkScope();
     if(!owner||isProxy(owner)||!Object.isFrozen(owner))throw Error('ORIGINAL_IMMUTABLE_SCOPE_REQUIRED');
     target=scalar(owner,'preparationOrdinal')===17&&scalar(owner,'workInvocationOrdinal')===2&&scalar(owner,'workLabel')==='stage6.family:recovery_score';
    }catch{fault();}
    return target?measure({preparation:17,invocation:2},call):call();
   });
  },
 });}
 return Object.freeze({setOwnedServer:setup,setPreparation(n){if(!integer(n)||n<1||n>17){fault();preparation=0;return;}preparation=n;},
  decorate,snapshot:()=>({contract:'recovery17-test-counter-observer-state-v1',claimed,observerFaults:faults,productionEvidence:false,capacityQualified:false})});
}
