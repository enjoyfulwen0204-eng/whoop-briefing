import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFamilyPhaseCorrelation,FAMILY_PHASES,validateFamilyPhaseJoin} from './stage6-native-family-phases.mjs';
import {createWorkCorrelation} from './stage6-native-work-join.mjs';
import {createAttribution} from './stage6-native-attribution.mjs';
import {FAMILY_URL,transformFamilyPhases,inverseFamilyPhases} from './stage6-native-family-phase-loader.mjs';
const sourceFile=process.env.STAGE6_FAMILY_SOURCE_FILE??new URL('../src/phase4Reanalysis.js',import.meta.url);
const original=await readFile(sourceFile,'utf8'),transformed=transformFamilyPhases(FAMILY_URL,original);
const metadata=(metric='recovery_score')=>({preparationOrdinal:17,workInvocationOrdinal:2,workLabel:'stage6.family:'+metric});
const start=o=>{const r=o.startRequest(['BEGIN']),b=o.finishRequest(r,{successMask:[true]});return o.startTransaction(b[0].owner,r,1);};
test('original physical token plus work owner binds finite phase window and exact result once',async()=>{
 let n=10,calls=0;const a=createFamilyPhaseCorrelation({now:()=>n}),owner={},token={},value={};a.enter(token,owner,metadata());
 assert.equal(await a.phase(owner,'RECURRENCE',async()=>{calls++;n=15;return value;}),value);a.finish(token,{outcome:'COMMITTED',durationUpperBoundMs:10});const v=a.snapshot();assert.equal(validateFamilyPhaseJoin(v),true);assert.equal(v.coverageComplete,true);assert.equal(calls,1);assert.deepEqual(v.slowest8[0].phases.RECURRENCE,{calls:1,completed:1,failed:0,sumInclusiveMs:5,maxInclusiveMs:5});assert.equal(v.slowest8[0].phaseWindowsWithinClientUpper,true);
});
test('sync and async original rejections preserve identity and are counted without retry',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},token={},e=Error('PRIVATE');a.enter(token,owner,metadata());let n=0;
 for(const work of [()=>{n++;throw e;},async()=>{n++;throw e;}])await assert.rejects(a.phase(owner,'PREPARATION_REPLAY',work),x=>x===e);
 a.finish(token,{outcome:'ROLLED_BACK',durationUpperBoundMs:100});const v=a.snapshot();assert.equal(n,2);assert.equal(v.slowest8[0].phases.PREPARATION_REPLAY.failed,2);assert.equal(JSON.stringify(v).includes('PRIVATE'),false);
});
test('unknown phase invokes original but cannot emit private label or claim complete coverage',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},token={};a.enter(token,owner,metadata());let n=0;assert.equal(await a.phase(owner,'PRIVATE_SQL',()=>++n),1);a.finish(token,{outcome:'COMMITTED',durationUpperBoundMs:10});const v=a.snapshot();assert.equal(v.coverageComplete,false);assert.equal(v.rootsWithoutPhaseWindows,1);assert.equal(v.lostObservations,1);assert.equal(JSON.stringify(v).includes('PRIVATE_SQL'),false);
});
test('a different owner cannot borrow the acknowledged family root',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},token={};a.enter(token,owner,metadata());assert.equal(await a.phase({},'RECURRENCE',()=>7),7);a.finish(token,{outcome:'COMMITTED',durationUpperBoundMs:10});const v=a.snapshot();assert.equal(v.coverageComplete,false);assert.equal(v.outsideFamilyPhases,1);assert.equal(v.rootsWithoutPhaseWindows,1);
});
test('ambiguous concurrent physical roots cannot be credited to one phase',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},tokens=[{},{}];for(const t of tokens)a.enter(t,owner,metadata());assert.equal(await a.phase(owner,'RECURRENCE',()=>7),7);for(const t of tokens)a.finish(t,{outcome:'COMMITTED',durationUpperBoundMs:10});const v=a.snapshot();assert.equal(v.coverageComplete,false);assert.equal(v.lostObservations,1);
});
test('physical termination before phase settlement stays incomplete',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},token={};a.enter(token,owner,metadata());let release;const p=a.phase(owner,'RECURRENCE',()=>new Promise(r=>release=r));a.finish(token,{outcome:'COMMITTED',durationUpperBoundMs:10});release(7);assert.equal(await p,7);const v=a.snapshot();assert.equal(v.coverageComplete,false);assert.equal(v.lostObservations,2);assert.equal(v.completedFamilyRoots,0);
});
test('nested phase windows are not silently summed as independent complete coverage',async()=>{
 const a=createFamilyPhaseCorrelation(),owner={},token={};a.enter(token,owner,metadata());await a.phase(owner,'RECURRENCE',()=>a.phase(owner,'TIP_VERIFY',()=>9));a.finish(token,{outcome:'COMMITTED',durationUpperBoundMs:20});assert.equal(a.snapshot().coverageComplete,false);
});
test('clock errors, backwards clocks and unknown terminal remain diagnostic losses',async()=>{
 for(const mode of ['throws','backwards','unknown']){let calls=0,n=0;const a=createFamilyPhaseCorrelation({now:()=>{n++;if(mode==='throws')throw Error('PRIVATE');return mode==='backwards'?10-n:n;}}),owner={},token={};a.enter(token,owner,metadata());assert.equal(await a.phase(owner,'RECURRENCE',()=>{calls++;return 7;}),7);a.finish(token,{outcome:mode==='unknown'?'UNRESOLVED':'COMMITTED',durationUpperBoundMs:10});assert.equal(a.snapshot().coverageComplete,false);assert.equal(calls,1);}
});
test('metadata getters and proxies add no reads or coercion and no private output',()=>{
 let n=0;const a=createFamilyPhaseCorrelation();a.enter({}, {},{get workLabel(){n++;return 'PRIVATE';}});a.enter({}, {},new Proxy({},{getOwnPropertyDescriptor(){n++;throw Error('PRIVATE');}}));assert.equal(n,0);assert.equal(a.snapshot().completedFamilyRoots,0);assert.equal(JSON.stringify(a.snapshot()).includes('PRIVATE'),false);
});
test('root bound records loss and never grows beyond128; all finite terminal windows bounded to8',async()=>{
 const a=createFamilyPhaseCorrelation(),owners=Array.from({length:129},()=>({})),tokens=owners.map(()=>({}));for(let i=0;i<129;i++)a.enter(tokens[i],owners[i],metadata());assert.equal(a.snapshot().activeRoots,128);assert.equal(a.snapshot().lostObservations,1);for(let i=0;i<129;i++){await a.phase(owners[i],'RECURRENCE',()=>1);a.finish(tokens[i],{outcome:'COMMITTED',durationUpperBoundMs:100});}const v=a.snapshot();assert.equal(v.activeRoots,0);assert.equal(v.retainedOwners,0);assert.equal(v.slowest8.length,8);assert.equal(v.completedFamilyRoots,128);assert.equal(v.coverageComplete,false);
});
test('real work correlation retains same original terminal and phase metadata through async descendants',async()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());let n=0;
 await c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{const token=start(o);await c.phase('RECURRENCE',async()=>{await new Promise(r=>setImmediate(r));n++;o.transactionStorage(token,'SOURCE_DATA');});o.finishTransaction(token,{outcome:'COMMITTED',durationUpperBoundMs:100});}));
 const s=o.snapshot();assert.equal(n,1);assert.equal(s.namedWorkJoin.terminalJoinComplete,true);assert.equal(s.familyPhaseJoin.coverageComplete,true);assert.deepEqual(s.familyPhaseJoin.slowest8.map(x=>[x.preparationOrdinal,x.workInvocationOrdinal,x.workLabel]),s.namedWorkJoin.slowest8.map(x=>[x.preparationOrdinal,x.workInvocationOrdinal,x.workLabel]));assert.equal(s.familyPhaseJoin.slowest8[0].phases.RECURRENCE.calls,1);
});
test('phase owner cannot be rebound by later work context or delayed BEGIN ACK',async()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());let request;
 c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>{request=o.startRequest(['BEGIN']);}));
 await c.preparation(2,()=>c.owned({workKind:'stage6.family',workFacts:['hrv']},async()=>{const ack=o.finishRequest(request,{successMask:[true]}),t=o.startTransaction(ack[0].owner,request,1);await c.phase('RECURRENCE',()=>1);o.finishTransaction(t,{outcome:'COMMITTED',durationUpperBoundMs:100});}));
 const s=o.snapshot();assert.equal(s.namedWorkJoin.slowest8[0].preparationOrdinal,17);assert.equal(s.familyPhaseJoin.slowest8[0].preparationOrdinal,17);assert.equal(s.familyPhaseJoin.coverageComplete,false);assert.equal(s.familyPhaseJoin.rootsWithoutPhaseWindows,1);
});
test('source transform is exact reversible and rejects drift or unrelated URLs',()=>{
 assert.equal(inverseFamilyPhases(transformed),original);assert.equal(transformFamilyPhases('file:///OTHER','PRIVATE'),'PRIVATE');assert.throws(()=>transformFamilyPhases(FAMILY_URL,original+' '),/EXACT_FAMILY_SOURCE_REQUIRED/);for(const p of FAMILY_PHASES)assert.ok(transformed.includes("observeFamilyPhase('"+p+"'"));assert.equal(transformed.includes('stage6.family-partial'),false);
});
const extract=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const originalFamily=extract(original,'  async function performMetricFamily(','  async function metricsV30('),observedFamily=extract(transformed,'  async function performMetricFamily(','  async function metricsV30(');
async function familyCase(source,{failure,already=false,replay=false,noEpisode=false}={}){
 const trace=[],entry={family_key:'f'},inventory={entries:already?[entry]:[],unknownEntries:[]};let invocations=0,works=0;
 const observeFamilyPhase=async(_p,fn)=>fn(),fail=code=>{throw Object.assign(Error(code),{code});};
 const hit=(name,value)=>{trace.push(name);if(failure===name)throw failure;return value;};
 const directory={inventory:async()=>hit('inventory'+(++invocations),invocations===1?inventory:{entries:noEpisode?[]:[entry],unknownEntries:[]}),work:async()=>hit('work'+(++works),{due:!already}),complete:async()=>hit('complete',undefined)};
 // Current completion verifier needs work.due=false after signed completion.
 directory.complete=async()=>{hit('complete',undefined);directory.work=async()=>hit('verify',{due:false});};
 const stores={intelligence:{replayExistingMetricPreparation:async()=>hit('replay',{})}},core={},createOperationReceipts=()=>({episodeRecurrenceInventory:async()=>hit('recurrence',{latest:new Map(),histories:new Map()})}),metric=async()=>hit('metric',noEpisode?'VALID_NO_EPISODE':'CREATED');
 const fn=new Function('familyDirectory','stores','core','createOperationReceipts','metric','fail','observeFamilyPhase',source+';return performMetricFamily;')(directory,stores,core,createOperationReceipts,metric,fail,observeFamilyPhase);
 try{return {result:await fn({}, {metricKey:'recovery_score',asOfUtc:'2026-01-01'}, {familyKey:'f',windowFamily:'fixed'},'f',{reportCompletion:true,replayOnly:replay}),trace};}catch(error){return {error,trace};}
}
for(const options of [{},{already:true},{replay:true},{noEpisode:true},...['inventory1','recurrence','metric','inventory2','complete','verify'].map(failure=>({failure}))])test('actual family body pass-through keeps result/error and exact original call order '+JSON.stringify(options),async()=>{assert.deepEqual(await familyCase(observedFamily,options),await familyCase(originalFamily,options));});
test('closed output schema rejects unapproved fields and coerced completeness',()=>{const a=createFamilyPhaseCorrelation(),s=a.snapshot();assert.throws(()=>validateFamilyPhaseJoin({...s,privateSQL:'PRIVATE'}));assert.throws(()=>validateFamilyPhaseJoin({...s,coverageComplete:true}));});

const originalMetric=extract(original,'  async function metric(context,req,history,','  const insightIdentity='),observedMetric=extract(transformed,'  async function metric(context,req,history,','  const insightIdentity=');
async function metricCase(source,options={}){
 const trace=[],marker=Error('SYNTHETIC'),hit=(name,value)=>{trace.push(name);if(options.failure===name)throw marker;return value;},context={inputGeneration:1,userId:'synthetic',executionMode:'LIVE'},request={metricKey:'recovery_score',asOfUtc:'2026-01-04T00:00:00.000Z',windowFamily:'fixed'};
 const prepared={quality:{status:options.insufficient?'INSUFFICIENT':'LIMITED',confidence:1},calculation:{qualified:!options.noEpisode,direction:'LOWER',severity:1,semanticHash:'fixed'},run:{row:{input_manifest_json:JSON.stringify({current:{value:1}})}},item:{row:{evidence_item_id:'synthetic',provenance_json:JSON.stringify({confidence:{score:.5}})}}};
 const prepare=async name=>hit(name,prepared),stores={intelligence:{resumeMetricPreparation:()=>prepare('resume'),replayExistingMetricPreparation:()=>prepare('replay'),analyzeMetric:()=>prepare('analyze')},episodes:{read:async()=>hit('read',{}),refresh:async()=>hit('refresh',{row:{state:options.resolved?'RESOLVED':'OPEN',resolution_reason:options.reversal?'DIRECTION_REVERSAL':null}}),open:async()=>hit('open',{})}};
 const row={episode_id:'synthetic',revision:1,direction:'LOWER',input_generation:options.current?1:0},rows=options.duplicate?[row,row]:options.prior?[row]:[];
 const client={execute:async()=>hit('query',{rows})},core={schemaVersion:options.oldSchema?28:33},keys={lookup:()=>hit('lookup','fixed')},phase4Metric=()=>hit('metric',{domain:'RECOVERY'}),canonicalEpisodeData=()=>hit('data',{expires_at:options.expired?'2026-01-01T00:00:00.000Z':'2026-01-05T00:00:00.000Z'}),INTELLIGENCE_VERSIONS={algorithm:'fixed'},executionMode='LIVE',fail=code=>{throw Object.assign(Error(code),{code});},observeFamilyPhase=(_name,call)=>call();
 const fn=new Function('stores','core','keys','phase4Metric','canonicalEpisodeData','INTELLIGENCE_VERSIONS','executionMode','client','fail','observeFamilyPhase',source+';return metric;')(stores,core,keys,phase4Metric,canonicalEpisodeData,INTELLIGENCE_VERSIONS,executionMode,client,fail,observeFamilyPhase);
 try{return {result:await fn(context,request,{latest:new Map()},{replayOnly:options.replay===true,replayPrepared:options.prepared?prepared:null}),trace};}catch(error){return {error:error===marker?'EXACT_ORIGINAL_ERROR':error.code??error.message,trace};}
}
for(const options of [{},{insufficient:true},{noEpisode:true},{expired:true},{prior:true,current:true},{prior:true},{prior:true,resolved:true},{prior:true,resolved:true,reversal:true},{duplicate:true},{replay:true},{prepared:true},{oldSchema:true},...['resume','query','open'].map(failure=>({failure}))])test('actual metric body preserves preparation/lifecycle guards and return/error '+JSON.stringify(options),async()=>{assert.deepEqual(await metricCase(observedMetric,options),await metricCase(originalMetric,options));});

test('slow physical terminal emits phase proof before a later continuation can hang',{timeout:2000},async()=>{
 const packets=[],c=createWorkCorrelation({emitPhases:v=>packets.push(v)}),o=c.decorate(createAttribution());let reached,release,settled=false;const terminalReached=new Promise(r=>reached=r),value={};
 const result=c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{const token=start(o);await c.phase('RECURRENCE',()=>1);o.finishTransaction(token,{outcome:'COMMITTED',durationUpperBoundMs:6000});reached();await new Promise(r=>release=r);return value;}));result.then(()=>settled=true);
 try{await terminalReached;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(packets.length,1);assert.equal(packets[0].slowest8[0].phases.RECURRENCE.calls,1);assert.equal(packets[0].slowest8[0].outcome,'COMMITTED');assert.equal(packets[0].activeRoots,0);}finally{release?.();}
 assert.equal(await result,value);
});
test('each terminal sink is independent and its failure never changes the original result',async()=>{
 for(const failing of ['work','phase']){const packets=[],marker=Error('PRIVATE'),c=createWorkCorrelation({emit:()=>{if(failing==='work')throw marker;},emitPhases:v=>{if(failing==='phase')throw marker;packets.push(v);}}),o=c.decorate(createAttribution()),value={};
  assert.equal(await c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{const token=start(o);await c.phase('RECURRENCE',()=>1);o.finishTransaction(token,{outcome:'COMMITTED',durationUpperBoundMs:6000});return value;})),value);
  assert.equal(packets.length,failing==='work'?1:0);assert.ok(o.snapshot().namedWorkJoin.lostJoins>0);assert.equal(o.snapshot().namedWorkJoin.terminalJoinComplete,false);
 }
});
test('immediate phase terminal sink retains the original64 emission bound',async()=>{
 let work=0,phase=0;const c=createWorkCorrelation({emit:()=>work++,emitPhases:()=>phase++}),o=c.decorate(createAttribution());
 for(let i=0;i<70;i++)await c.preparation(i%17+1,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},async()=>{const token=start(o);await c.phase('RECURRENCE',()=>1);o.finishTransaction(token,{outcome:'COMMITTED',durationUpperBoundMs:6000+i});}));
 assert.equal(work,64);assert.equal(phase,64);assert.equal(o.snapshot().familyPhaseJoin.completedFamilyRoots,70);assert.equal(o.snapshot().namedWorkJoin.terminalJoinComplete,true);
});
