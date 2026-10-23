import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
import {CPU_PUBLIC_FILES,CPU_PUBLIC_FUNCTIONS} from '../../test/stage6-native-cpu-profile.mjs';
const publicFiles=new Set(CPU_PUBLIC_FILES),publicFunctions=new Set(CPU_PUBLIC_FUNCTIONS);
export function exactKeys(value,names){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Reflect.ownKeys(value).sort(),[...names].sort());
}
export function validateLeg(x,i){
  exactKeys(x,['ordinal','kind','postconditionsNotYetChecked','replayed','wallMs','processedItems','unitsCommitted','failedJobs','contextLeaseSupportedProjections','contextLeaseUnsupportedProjections','ownedWork','cpu']);
  assert.equal(x.kind,'RETURNED_CANONICAL_PREPARATION');assert.equal(x.postconditionsNotYetChecked,true);assert.equal(typeof x.replayed,'boolean');
  assert.equal(x.ordinal,i+1);assert.ok(Number.isFinite(x.wallMs)&&x.wallMs>0);
  for(const k of ['processedItems','unitsCommitted','failedJobs','contextLeaseSupportedProjections','contextLeaseUnsupportedProjections'])assert.ok(Number.isSafeInteger(x[k])&&x[k]>=0);
  assert.ok(x.ownedWork&&Object.keys(x.ownedWork).length<=32);
  for(const [key,c]of Object.entries(x.ownedWork)){
   assert.ok(/^(READ_ONLY_OR_OTHER|stage6\.(end|family-inventory|family|body-source|associations|checkpoint|source):(NA|UNKNOWN|recovery_score|hrv|rhr|sleep_performance|sleep_duration_minutes|sleep_efficiency|respiratory_rate|cycle_strain|body_energy))$/.test(key));
   exactKeys(c,['calls','inclusiveMs','maxInclusiveMs']);assert.ok(Number.isSafeInteger(c.calls)&&c.calls>0);assert.ok(Number.isFinite(c.inclusiveMs)&&Number.isFinite(c.maxInclusiveMs)&&c.inclusiveMs>=c.maxInclusiveMs&&c.maxInclusiveMs>=0);
  }
  const cpu=x.cpu;exactKeys(cpu,['sampledMs','sampleCount','rawProfilePersisted','top20','wallMs','nodeUserCpuMs','nodeSystemCpuMs','onlyPreparationOrdinal','setupIncluded','includesOriginalPostSettlementContextCleanup','profilingOverheadNotSubtracted','qualification']);assert.ok(Number.isFinite(cpu.sampledMs)&&cpu.sampledMs>=0);assert.ok(Number.isSafeInteger(cpu.sampleCount)&&cpu.sampleCount>=0&&cpu.sampleCount<=200000);
  for(const k of ['wallMs','nodeUserCpuMs','nodeSystemCpuMs'])assert.ok(Number.isFinite(cpu[k])&&cpu[k]>=0);
  assert.equal(cpu.qualification,false);assert.equal(cpu.rawProfilePersisted,false);assert.equal(cpu.setupIncluded,false);assert.equal(cpu.onlyPreparationOrdinal,i+1);
  assert.equal(cpu.includesOriginalPostSettlementContextCleanup,true);assert.equal(cpu.profilingOverheadNotSubtracted,true);
  assert.ok(Array.isArray(cpu.top20)&&cpu.top20.length<=20);
  for(const f of cpu.top20){exactKeys(f,['file','fn','line','sampledMs','percent']);assert.ok(publicFiles.has(f.file));assert.ok(publicFunctions.has(f.fn));assert.ok(Number.isSafeInteger(f.line)&&f.line>=0&&f.line<=100000);if(f.file==='V8_OR_OTHER')assert.equal(f.line,0);for(const k of ['sampledMs','percent'])assert.ok(Number.isFinite(f[k])&&f[k]>=0);assert.ok(f.percent<=100.00001);}
}
export function validateDiagnostic(v){
 exactKeys(v,['contract','status','applicationSource','diagnosticLegs','preparationTransactions','httpRequests','statementCount','maxPreparations','sourceHealthRows','users','addedLatencyMs','rawCpuProfilePersisted','setupIncludedInCpuProfile','profiledOrdinals','productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified','elapsedMs','ownedServerExited','originalPostconditionsPassed']);
 assert.equal(v.contract,'one-native-first17-cpu-diagnostic-v1');assert.equal(v.status,'DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION');
 assert.equal(v.applicationSource,'de262df36aea6199db41405963fb7cf45a0453f4');
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified','rawCpuProfilePersisted','setupIncludedInCpuProfile'])assert.equal(v[k],false);
 assert.deepEqual(v.profiledOrdinals,Array.from({length:17},(_,i)=>i+1));assert.equal(v.maxPreparations,17);assert.equal(v.sourceHealthRows,160);assert.equal(v.users,1);assert.equal(v.addedLatencyMs,0);
 assert.ok(Array.isArray(v.diagnosticLegs));assert.equal(v.diagnosticLegs.length,17);
 for(const [i,x]of v.diagnosticLegs.entries()){validateLeg(x,i);assert.equal(x.failedJobs,0);assert.equal(x.replayed,false);}
 assert.equal(v.originalPostconditionsPassed,true);assert.equal(v.ownedServerExited,true);assert.ok(Number.isFinite(v.elapsedMs)&&v.elapsedMs>=0);
 for(const k of ['httpRequests','statementCount'])assert.ok(Number.isSafeInteger(v[k])&&v[k]>=0);
 const t=v.preparationTransactions;exactKeys(t,['begun','committed','rolledBack','unknownTerminal','open','sumDurationUpperBoundMs','maxDurationUpperBoundMs','atOrAbove5s']);
 for(const k of ['begun','committed','rolledBack','unknownTerminal','open','atOrAbove5s'])assert.ok(Number.isSafeInteger(t[k])&&t[k]>=0);
 for(const k of ['sumDurationUpperBoundMs','maxDurationUpperBoundMs'])assert.ok(Number.isFinite(t[k])&&t[k]>=0);
 assert.ok(t.begun>0);assert.equal(t.open,0);assert.equal(t.unknownTerminal,0);assert.equal(t.begun,t.committed+t.rolledBack);assert.ok(t.sumDurationUpperBoundMs>=t.maxDurationUpperBoundMs);
 // A >=5s metric is diagnostic evidence, never waived EOF qualification.
 return true;
}
export function projectFailure(f){
 const member=(value,allowed)=>allowed.includes(value)?value:'OTHER';
 const progress={};const p=f?.progress;
 for(const k of ['startedPreparations','completedPreparations','sourceAcknowledgments','unitsCommitted','lastPendingJobs','lastBudgetPerTenant','catalogRows','preparationTransactionCount','preparationMaxUpperMs','preparationAtOrAbove5s','preparationUnknown','preparationOpen','joinInitialIdleWithinBudget','joinInitialActive','joinInitialRetained','joinInitialAdapterTerminal','joinInitialPhysicalTerminal','joinElapsedMs','joinProbes','joinWithinBudget'])if(Number.isFinite(p?.[k])&&p[k]>=0)progress[k]=p[k];
 if(p&&Object.hasOwn(p,'check'))progress.check=member(p.check,['NOT_STARTED','CANONICAL_WORK','NOT_REPLAYED','NO_FAILED_JOBS','SETUP_TIME','JOIN_INITIAL_IDLE','JOIN_PHYSICAL_DEADLINE','JOIN_ADAPTER_TERMINAL','JOIN_RETAINED_STREAMS','JOIN_PHYSICAL_TERMINAL']);
 if(p&&Object.hasOwn(p,'preparationSnapshotState'))progress.preparationSnapshotState=member(p.preparationSnapshotState,['NOT_STARTED','PROVISIONAL','TERMINAL','UNKNOWN']);
 return {stage:member(f?.stage,['SERVER_START','SYNTHETIC_SETUP','BOUNDED_CANONICAL_NONEMPTY_PREPARATIONS','FIRST17_CPU_DIAGNOSTIC_CLEANUP']),type:member(f?.type,['Error','AssertionError','TypeError']),code:member(f?.code,['ERR_ASSERTION','OTHER']),classification:member(f?.classification,['BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED','OTHER_ASSERTION','OTHER_ERROR']),progress,elapsedMs:Number.isFinite(f?.elapsedMs)&&f.elapsedMs>=0?f.elapsedMs:null};
}
export function projectTerminal(t){return{closed:t?.closed===true,ownedServerExited:t?.ownedServerExited===true,clientTerminalComplete:t?.clientTerminalComplete===true,retainedStreams:Number.isSafeInteger(t?.retainedStreams)&&t.retainedStreams>=0?t.retainedStreams:null,physicalTerminalObservationComplete:t?.physicalTerminalObservationComplete===true};}
async function main(){
 const candidateSha=process.env.EXPECTED_CANDIDATE_SHA,read=async n=>(await readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
 assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);
 assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
 const path='/tmp/native-first17-cpu.log',fd=await open(path,'wx',0o600),started=performance.now();
 const child=spawn(process.execPath,['--experimental-loader','./test/stage6-native-first17-cpu-loader.mjs','--max-old-space-size=96','--max-semi-space-size=2','test/stage6-native-first17-cpu.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test'}});
 let spawnError=false;child.on('error',()=>{spawnError=true;});const timer=setTimeout(()=>child.kill('SIGTERM'),300000);
 const terminal=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));clearTimeout(timer);await fd.close();
 assert.ok((await stat(path)).size<16*1024*1024);const raw=await readFile(path,'utf8');
 const memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)])),memoryPeakBytes=Number(await read('memory.peak'));
 const lines=prefix=>raw.split('\n').filter(l=>l.startsWith(prefix)).map(l=>JSON.parse(l.slice(prefix.length)));
 let failure=null,observed=null,fixtureTerminal=null,status='DIAGNOSTIC_FAILED_OR_UNKNOWN';
 let partialLegs=null;try{const legs=lines('STAGE6_FIRST17_CPU_RETURNED ');assert.ok(legs.length<=17);for(const [i,x]of legs.entries())validateLeg(x,i);partialLegs=legs;}catch{}
 const failures=lines('STAGE6_NATIVE_POSITIVE_EOF_FAILURE ');if(failures.length===1)failure=projectFailure(failures[0]);
 const terminals=lines('STAGE6_NATIVE_POSITIVE_EOF_TERMINAL ');if(terminals.length===1)fixtureTerminal=projectTerminal(terminals[0]);
 try{
  assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});const values=lines('STAGE6_NATIVE_POSITIVE_EOF_RESULT ');assert.equal(values.length,1);validateDiagnostic(values[0]);
  assert.ok(fixtureTerminal?.closed&&fixtureTerminal.ownedServerExited&&fixtureTerminal.clientTerminalComplete&&fixtureTerminal.physicalTerminalObservationComplete);assert.equal(fixtureTerminal.retainedStreams,0);
  assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);assert.ok(performance.now()-started<300000);
  observed=values[0];status='DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION';
 }catch{}
 await rm(path);console.log('STAGE6_FIRST17_CPU_SUPERVISOR '+JSON.stringify({contract:'one-native-first17-cpu-supervisor-v1',candidateSha,status,terminal,spawnError,failure,fixtureTerminal,observed,partialLegs:observed?null:partialLegs,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs:performance.now()-started,childLogSha256:createHash('sha256').update(raw).digest('hex'),productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false}));
 process.exitCode=status==='DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION'?0:2;
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])main();
