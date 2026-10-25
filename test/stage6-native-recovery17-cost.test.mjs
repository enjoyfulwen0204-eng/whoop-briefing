import test from 'node:test';import assert from 'node:assert/strict';
import {createRecovery17CostProbe,parseOwnedStat,parseCPUStat} from './stage6-native-recovery17-cost.mjs';
const stat=(pid=71,start='99',user=20,system=4)=>{const f=Array(30).fill('0');f[0]='S';f[11]=String(user);f[12]=String(system);f[19]=start;return pid+' (isolated-sqld) '+f.join(' ');};
const group=n=>'usage_usec '+n*1000+'\nuser_usec '+n*700+'\nsystem_usec '+n*300+'\nnr_periods '+n+'\nnr_throttled '+n+'\nthrottled_usec '+n*200+'\n';
function setup(change={}){
 const packets=[];let procCalls=0,groupCalls=0,cpuCalls=0,clocks=0;
 const child={pid:71,spawnfile:'/usr/local/bin/isolated-sqld',spawnargs:['/usr/local/bin/isolated-sqld'],exitCode:null,signalCode:null};
 const options={candidateSHA:'a'.repeat(40),readText(path){if(path==='/proc/71/stat')return stat(71,'99',20*(++procCalls),4*procCalls);if(path==='/sys/fs/cgroup/cpu.stat')return group(++groupCalls);if(path==='/proc/self/cgroup'||path==='/proc/71/cgroup')return '0::/\n';if(path==='/sys/fs/cgroup/cpu.max')return '50000 100000\n';throw Error('UNEXPECTED_PATH');},
  cpu:()=>({user:100*(++cpuCalls),system:40*cpuCalls}),clock:()=>10*(++clocks),ticks:()=>100,emit:p=>packets.push(p),...change};
 const probe=createRecovery17CostProbe(options);probe.setOwnedServer(child);probe.setPreparation(17);
 const correlation=createWorkCorrelation(),decorated=probe.decorate(correlation);
 const runAt=(ordinal,fn)=>correlation.preparation(ordinal,async()=>{
  await decorated.owned({workKind:'stage6.body-source'},()=>null);
  return decorated.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>decorated.phase('METRIC_LIFECYCLE',fn));
 });
 const run=fn=>runAt(17,fn);return {probe,packets,run,runAt,decorated,child,correlation};
}
test('one exact phase preserves original value and emits bounded metadata once',async()=>{
 const x=setup(),value={original:true};assert.equal(await x.run(()=>value),value);assert.equal(x.packets.length,1);
 const p=x.packets[0];assert.equal(p.status,'OBSERVED_DIAGNOSTIC_COST_ONLY');assert.equal(p.preparationOrdinal,17);assert.equal(p.workInvocationOrdinal,2);
 assert.equal(p.measurement.clientUserUs,100);assert.equal(p.measurement.ownedSqldUserTicks,20);assert.equal(p.measurement.clockTicksPerSecond,100);
 assert.equal(p.intervalsNotAtomic,true);assert.equal(p.capacityQualified,false);assert.equal(x.probe.snapshot().observerFaults,0);
 assert.equal(await x.run(()=>value),value);assert.equal(x.packets.length,1);
});
test('original error identity survives failed observations and failed emit',async()=>{
 for(const change of [{},{readText(){throw Error('sensor');}},{cpu(){throw Error('sensor');}},{clock(){throw Error('sensor');}},{ticks(){throw Error('sensor');}},{emit(){throw Error('sink');}}]){
  const x=setup(change),original={original:'private_error'};
  await assert.rejects(x.run(()=>{throw original;}),e=>e===original);
 }
});
test('missing changed or decreasing counters are UNKNOWN and keep return identity',async()=>{
 const cases=[{ticks:()=>0},{ticks:()=>1e9},{cpu:()=>({user:-1,system:0})},{readText:()=>''}];
 for(const change of cases){const x=setup(change),value={};assert.equal(await x.run(()=>value),value);assert.equal(x.packets.length,1);assert.equal(x.packets[0].status,'UNKNOWN_COST');assert.ok(x.probe.snapshot().observerFaults>0);}
 let n=0;const x=setup({readText(path){if(path==='/proc/71/stat')return stat(71,++n>2?'100':'99');if(path==='/proc/self/cgroup'||path==='/proc/71/cgroup')return '0::/';if(path==='/sys/fs/cgroup/cpu.max')return '50000 100000';return group(1);}});
 assert.equal(await x.run(()=>7),7);assert.equal(x.packets[0].status,'UNKNOWN_COST');
 let c=0;const y=setup({cpu:()=>({user:++c===1?200:100,system:0})});assert.equal(await y.run(()=>7),7);assert.equal(y.packets[0].status,'UNKNOWN_COST');
});
test('other preparations and phases never sample or claim target',async()=>{
 const x=setup();x.probe.setPreparation(16);assert.equal(await x.run(()=>4),4);assert.equal(x.packets.length,0);
 x.probe.setPreparation(17);assert.equal(await x.decorated.owned({workKind:'stage6.family',workFacts:['hrv']},()=>x.decorated.phase('METRIC_LIFECYCLE',()=>5)),5);
 assert.equal(x.packets.length,0);assert.equal(x.probe.snapshot().claimed,false);
});
test('owned stat and cgroup parsers reject malformed identity or missing duplicate fields',()=>{
 assert.deepEqual(parseOwnedStat(stat(),71),{user:20n,system:4n,start:'99'});assert.equal(parseCPUStat(group(2)).usage_usec,2000n);
 for(const v of ['',stat(72),stat(71,'bad'),stat(71,'99',-1), 'x'.repeat(8193)])assert.throws(()=>parseOwnedStat(v,71));
 for(const v of ['',group(2)+'usage_usec 3\n',group(2).replace('user_usec 1400\n',''),group(2).replace('nr_periods 2','nr_periods nope')])assert.throws(()=>parseCPUStat(v));
});

test('foreign or changed cgroup and CPU quota cannot become accepted measurements',async()=>{
 for(const badPath of ['/proc/self/cgroup','/proc/71/cgroup','/sys/fs/cgroup/cpu.max']){
  const x=setup({readText(path){if(path===badPath)return 'unexpected';if(path==='/proc/71/stat')return stat();if(path==='/proc/self/cgroup'||path==='/proc/71/cgroup')return '0::/';if(path==='/sys/fs/cgroup/cpu.max')return '50000 100000';return group(1);}});
  assert.equal(await x.run(()=>13),13);assert.equal(x.packets.length,1);assert.equal(x.packets[0].status,'UNKNOWN_COST');
 }
});

import {projectRecovery17Cost} from '../tools/stage8-qualification/first17-work-supervisor.mjs';
import {createWorkCorrelation} from './stage6-native-work-join.mjs';
import {createAttribution} from './stage6-native-attribution.mjs';
import {readFileSync} from 'node:fs';
async function joinedCost(){
 const x=setup();await x.run(()=>17);const p=structuredClone(x.packets[0]);p.measurement.wallMs=0;
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());
 await c.preparation(17,async()=>{
  await c.owned({workKind:'stage6.body-source'},()=>null);
  await c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{
   const r=o.startRequest(['BEGIN']),b=o.finishRequest(r,{successMask:[true]}),t=o.startTransaction(b[0].owner,r,1);
   await c.phase('METRIC_LIFECYCLE',()=>1);o.finishTransaction(t,{outcome:'COMMITTED',durationUpperBoundMs:100});
  });
 });
 const s=o.snapshot(),state=x.probe.snapshot();
 return {p,state,w:s.namedWorkJoin,f:s.familyPhaseJoin,raw:()=> 'STAGE6_RECOVERY17_CPU_COST '+JSON.stringify(p)+'\nSTAGE6_RECOVERY17_CPU_COST_STATE '+JSON.stringify(state)+'\n'};
}
test('supervisor preserves only the exact joined target cost with explicit qualification limits',async()=>{
 const x=await joinedCost(),v=projectRecovery17Cost(x.raw(),'a'.repeat(40),x.w,x.f);
 assert.equal(v.status,'OBSERVED_DIAGNOSTIC_COST_ONLY');assert.equal(v.targetJoin.workInvocationOrdinal,2);assert.equal(v.reason,'EXACT_ORIGINAL_TARGET_JOIN');
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'])assert.equal(v[k],false);
 const source=readFileSync(new URL('../tools/stage8-qualification/first17-work-supervisor.mjs',import.meta.url),'utf8');
 assert.match(source,/}catch\{\}\s+const recovery17Cost=projectRecovery17Cost\(raw,candidateSha,workJoin,familyPhaseJoin\);\s+await rm\(path\);console\.log/);
 assert.match(source,/observed,workJoin,familyPhaseJoin,recovery17Cost,partialLegs:/);
});
test('missing duplicate malformed packets and states remain explicit UNKNOWN without raw fields',async()=>{
 const x=await joinedCost(),packet='STAGE6_RECOVERY17_CPU_COST '+JSON.stringify(x.p)+'\n',state='STAGE6_RECOVERY17_CPU_COST_STATE '+JSON.stringify(x.state)+'\n';
 const cases=[['','MISSING_PACKET'],[state,'MISSING_PACKET'],[packet+packet+state,'DUPLICATE_PACKET'],[packet,'MISSING_STATE'],[packet+state+state,'DUPLICATE_STATE'],['STAGE6_RECOVERY17_CPU_COST {bad\n'+state,'INVALID_JSON']];
 for(const [raw,reason] of cases){const v=projectRecovery17Cost(raw,'a'.repeat(40),x.w,x.f);assert.equal(v.status,'UNKNOWN_COST');assert.equal(v.reason,reason);assert.equal(v.targetJoin,null);}
});
test('invalid numeric contract candidate and unexpected private fields cannot be forwarded',async()=>{
 for(const mutate of [p=>p.candidateSHA='b'.repeat(40),p=>p.workInvocationOrdinal=0,p=>p.measurement.wallMs=-1,p=>p.measurement.wallMs=Infinity,p=>p.measurement.clientUserUs=Number.MAX_SAFE_INTEGER+1,p=>p.measurement.containerDelta.nr_periods=-1,p=>p.measurement.clockTicksPerSecond=0,p=>p.privateHealth='PRIVATE',p=>p.measurement.rawSQL='PRIVATE',p=>p.productionEvidence=true]){
  const x=await joinedCost();mutate(x.p);const v=projectRecovery17Cost(x.raw(),'a'.repeat(40),x.w,x.f);assert.equal(v.status,'UNKNOWN_COST');assert.equal(v.reason,'INVALID_PACKET');assert.equal(v.packet,null);assert.ok(!JSON.stringify(v).includes('PRIVATE'));
 }
});
test('missing wrong or unsettled original physical target cannot confer a cost join',async()=>{
 for(const mutate of [x=>x.w=null,x=>x.f.slowest8[0].workInvocationOrdinal++,x=>x.w.slowest8[0].durationUpperBoundMs++,x=>x.w.terminalJoinComplete=false,x=>x.f.slowest8[0].phases.METRIC_LIFECYCLE.failed=1,x=>x.f.slowest8[0].phaseWindowsWithinClientUpper=false,x=>x.p.measurement.wallMs=101]){
  const x=await joinedCost();mutate(x);const v=projectRecovery17Cost(x.raw(),'a'.repeat(40),x.w,x.f);assert.equal(v.status,'UNKNOWN_COST');assert.equal(v.targetJoin,null);
 }
});
test('observer UNKNOWN or missing final state cannot be upgraded by a valid physical join',async()=>{
 for(const mutate of [x=>x.state.claimed=false,x=>x.state.observerFaults=1,x=>{x.p.status='UNKNOWN_COST';x.p.measurement=null;x.p.observerFaults=1;x.state.observerFaults=1;},x=>x.state.privateHealth='PRIVATE']){
  const x=await joinedCost();mutate(x);const v=projectRecovery17Cost(x.raw(),'a'.repeat(40),x.w,x.f);assert.equal(v.status,'UNKNOWN_COST');assert.equal(v.targetJoin,null);assert.ok(!JSON.stringify(v).includes('PRIVATE'));
 }
});

test('global setter cannot relabel actual original preparation16 as target17',async()=>{
 const x=setup();assert.equal(await x.runAt(16,()=>19),19);assert.equal(x.packets.length,0);assert.equal(x.probe.snapshot().claimed,false);
});
test('first Recovery invocation cannot consume the second original target',async()=>{
 const x=setup(),original={};
 await x.correlation.preparation(17,async()=>{
  const run=fn=>x.decorated.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>x.decorated.phase('METRIC_LIFECYCLE',fn));
  assert.equal(await run(()=>original),original);assert.equal(x.packets.length,0);assert.equal(x.probe.snapshot().claimed,false);
  assert.equal(await run(()=>original),original);assert.equal(x.packets.length,1);assert.equal(x.packets[0].workInvocationOrdinal,2);
 });
});
test('missing or mutable original scope cannot claim a measurement or alter original call',async()=>{
 for(const currentWorkScope of [()=>null,()=>({preparationOrdinal:17,workInvocationOrdinal:2,workLabel:'stage6.family:recovery_score'}),()=>{throw Error('scope');}]){
  const x=setup(),d=x.probe.decorate({owned:(_o,f)=>f(),phase:(_n,f)=>f(),currentWorkScope});assert.equal(await d.phase('METRIC_LIFECYCLE',()=>21),21);assert.equal(x.packets.length,0);assert.equal(x.probe.snapshot().claimed,false);assert.ok(x.probe.snapshot().observerFaults>0);
 }
});
