import assert from 'node:assert/strict';
import {Session} from 'node:inspector';
// Finite names from pinned public source/V8 only. Unknown frames retain no
// arbitrary basename, function name or line. No profile-supplied name is added.
export const CPU_PUBLIC_FILES=Object.freeze(['stage6-native-diagnostic-observer.mjs','stage6-native-attribution.mjs','V8_OR_OTHER','index.js','sqlite3.js','async_hooks','harness','node:inspector','undici','hash','phase4EntityStore.js','phase4IntelligenceStore.js','phase4ResultAuthority.js','phase4OperationReceipts.js','phase4EpisodeStore.js','phase4FamilyDirectory.js','phase4Repositories.js','phase4Time.js','processingReadSnapshot.js','processingTransaction.js','processingInflightControlReads.js','phase4Core.js','phase4Cache.js','phase4ReanalysisQueue.js','phase4Reanalysis.js','stage8LiveExecution.js','stage8WorkReceiptAuthority.js','phase4ExecutionContext.js','phase4ExecutionMarker.js','sqlSyntaxMemo.js','canonicalJson.js','phase4Keys.js','executionBudget.js','exactReal.js','file.js','http.js','stream.js','client.js','result.js','json_decode.js','json_encode.js','proto_encode.js','proto_decode.js','value.js','stmt.js']);
export const CPU_PUBLIC_FUNCTIONS=Object.freeze(['OTHER','_propagate','registerDestroyHook','emitInitNative','init','post','rowFromSql','readSnapshotKey','canonicalInstant','promiseInitHookWithDestroyTracking','destroy','libsql_js::statement::Rows::js_next','columns','parse','fetch','update','createHmac','','(root)','(program)','(idle)','(garbage collector)','object','cloneResult','primitive','cloneArgument','cloneArguments','statement','structuredClone','normalized','normalize','assertContext','assertControl','assertLease','projectContextLeaseData','projectContextLeaseDataOriginal','processingContextLeaseDataEligible','contextLeaseDataReadKey','inflightControlReadKey','ownershipControlReadKey','get','put','run','clear','close','ownership','array','execute','batch','readOnlyStatement','json','encode','decode','digest','lookup','canonicalJson','compile','currentExecutionBudget','measure','owned','ownedOriginal','withOwnership','resolve','next','main','profileCpuWork','validateRoots','revalidateSources','performMetricFamily','metricPreparation','analyzeMetric','validateStoredGraph','authenticate','prepare','read','metricEvidencePlan','durableEvidence','validateManifest','seal']);
const publicFiles=new Set(CPU_PUBLIC_FILES),publicFunctions=new Set(CPU_PUBLIC_FUNCTIONS);

export const CPU_SOURCE_BUCKETS=Object.freeze(['OBSERVER_SELF','ATTRIBUTION_SELF','ALLOWLISTED_APP_SELF','OTHER_ALLOWLISTED_SELF','GC','IDLE','UNKNOWN_OR_OTHER_SELF']);
const appFiles=new Set(CPU_PUBLIC_FILES.filter(f=>/^(phase4|processing|stage8)/.test(f)||['sqlSyntaxMemo.js','canonicalJson.js','executionBudget.js','exactReal.js'].includes(f)));
function sourceBucket(file,fn){
 if(fn==='(garbage collector)')return 'GC';if(fn==='(idle)')return 'IDLE';
 if(file==='stage6-native-diagnostic-observer.mjs')return 'OBSERVER_SELF';
 if(file==='stage6-native-attribution.mjs')return 'ATTRIBUTION_SELF';
 return appFiles.has(file)?'ALLOWLISTED_APP_SELF':file==='V8_OR_OTHER'?'UNKNOWN_OR_OTHER_SELF':'OTHER_ALLOWLISTED_SELF';
}


// Test-only CPU samples. Original business calls run once and retain their
// existing budgets and authority. No raw profile, argument or health value is
// persisted. Sampling overhead makes this diagnosis, never qualification.
export function summarizeCpuProfile(profile){
 assert.ok(profile&&Array.isArray(profile.nodes)&&profile.nodes.length<=100000);
 assert.ok(Array.isArray(profile.samples)&&profile.samples.length<=200000);
 assert.ok(Array.isArray(profile.timeDeltas)&&profile.timeDeltas.length===profile.samples.length);
 const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame])),totals=new Map(),sourceTotalsMs=Object.fromEntries(CPU_SOURCE_BUCKETS.map(k=>[k,0]));let total=0;
 for(let i=0;i<profile.samples.length;i++){
  const us=profile.timeDeltas[i];assert.ok(Number.isFinite(us)&&us>=0);const ms=us/1000;total+=ms;
  const f=nodes.get(profile.samples[i]);assert.ok(f&&typeof f.functionName==='string'&&typeof f.url==='string');
  const tail=f.url.split('/').at(-1),file=publicFiles.has(tail)?tail:'V8_OR_OTHER';
  const fn=publicFunctions.has(f.functionName)?f.functionName:'OTHER';
  const line=file!=='V8_OR_OTHER'&&Number.isSafeInteger(f.lineNumber)&&f.lineNumber>=0&&f.lineNumber<100000?f.lineNumber+1:0;
  sourceTotalsMs[sourceBucket(file,fn)]+=ms;
  const key=JSON.stringify([file,fn,line]);totals.set(key,(totals.get(key)??0)+ms);
 }
 return {sampledMs:total,sampleCount:profile.samples.length,rawProfilePersisted:false,sourceTotalsMs,
  top20:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([key,ms])=>{
   const[file,fn,line]=JSON.parse(key);return{file,fn,line,sampledMs:ms,percent:total?100*ms/total:0};})};
}

export async function profileCpuWork(call,ordinal=17){
 assert.ok(Number.isSafeInteger(ordinal)&&ordinal>=1&&ordinal<=17);
 const session=new Session();session.connect();
 const post=method=>new Promise((resolve,reject)=>session.post(method,(e,v)=>e?reject(e):resolve(v)));
 let result,profile,error,failed=false,enabled=false;const before=process.cpuUsage(),at=performance.now();
 try{await post('Profiler.enable');enabled=true;await post('Profiler.start');result=await call();}
 catch(e){error=e;failed=true;}
 finally{
  try{if(enabled){const v=await post('Profiler.stop');profile=summarizeCpuProfile(v.profile);await post('Profiler.disable');}}
  catch(e){if(!failed){error=e;failed=true;}}
  finally{session.disconnect();}
 }
 if(failed)throw error;
 const cpu=process.cpuUsage(before);
 return {result,profile:{...profile,wallMs:performance.now()-at,nodeUserCpuMs:cpu.user/1000,nodeSystemCpuMs:cpu.system/1000,
  onlyPreparationOrdinal:ordinal,setupIncluded:false,includesOriginalPostSettlementContextCleanup:true,
  profilingOverheadNotSubtracted:true,qualification:false}};
}

const kinds=new Set(['stage6.end','stage6.family-inventory','stage6.family','stage6.body-source','stage6.associations','stage6.checkpoint','stage6.source']);
const metrics=new Set(['recovery_score','hrv','rhr','sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain','body_energy']);
export function createCpuDiagnosticStats(){
 let enabled=false,active=0,counts=new Map(),supported=0,unsupported=0;
 return {
  start(){assert.equal(active,0);assert.equal(enabled,false);counts=new Map();supported=0;unsupported=0;enabled=true;},
  project(ok){if(enabled){if(ok===true)supported++;else unsupported++;}},
  async measure(kind,metric,call){
   if(!enabled)return call();
   const label=kinds.has(kind)?kind+':'+(kind==='stage6.family'?(metrics.has(metric)?metric:'UNKNOWN'):'NA'):'READ_ONLY_OR_OTHER';
   const at=performance.now();active++;try{return await call();}finally{active--;const ms=performance.now()-at;
    const x=counts.get(label)??{calls:0,inclusiveMs:0,maxInclusiveMs:0};x.calls++;x.inclusiveMs+=ms;x.maxInclusiveMs=Math.max(x.maxInclusiveMs,ms);counts.set(label,x);}
  },
  finish(){assert.equal(active,0);assert.equal(enabled,true);enabled=false;return{contextLeaseSupportedProjections:supported,contextLeaseUnsupportedProjections:unsupported,ownedWork:Object.fromEntries(counts)};},
 };
}
