import {projectEOFFailure} from '../../test/stage6-native-eof-failure-profile.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {validateChildResourceSample,validateChildResourceShape} from '../../test/stage6-native-file48-eof-resource.mjs';
export function projectChildResources(raw,candidateSha,identity){
 const projection={contract:'one-original-child-file48-eof-resource-preservation-v1',status:'UNKNOWN_RESOURCE_OBSERVATION',reason:'INVALID_INPUT',packet:null,productionEvidence:false,capacityQualified:false};
 let reason='INVALID_INPUT';
 try{
  assert.equal(typeof raw,'string');assert.ok(raw.length<16*1024*1024);
  const prefix='STAGE6_FILE48_EOF_CHILD_RESOURCE ',rows=raw.split('\n').filter(l=>l.startsWith(prefix));
  reason='MISSING_OR_DUPLICATE_PACKET';assert.equal(rows.length,1);reason='INVALID_PACKET';assert.ok(rows[0].length<4096);
  const packet=JSON.parse(rows[0].slice(prefix.length));validateChildResourceShape(packet,candidateSha,identity);projection.packet=packet;
  reason='SAMPLE_OUTSIDE_SELECTED_MEMORY_PROFILE';validateChildResourceSample(packet,candidateSha,identity);
  projection.status='OBSERVED_SAMPLE_WITHIN_SELECTED_MEMORY_BOUNDS';projection.reason='EXACT_ORIGINAL_CHILD_IDENTITY';
 }catch{projection.reason=reason;if(projection.packet)projection.status='OBSERVED_SAMPLE_OUTSIDE_SELECTED_MEMORY_PROFILE';}
 return projection;
}

export function validateFreshParentFileVerification(v,{candidateSha,parentPID,lastEvidence,applicationTables}){
 const exact=(o,n)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Reflect.ownKeys(o).length===n.length&&n.every(k=>Object.hasOwn(o,k));
 const int=x=>Number.isSafeInteger(x)&&x>=0,hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 assert.ok(exact(v,['contract','candidateSha','parentPID','finalWorkerPID','finalWorkerOrdinal','lastWorkerDescriptorSHA256','snapshot','schemaVersion','freshAdmissionVerified','quickCheckPassed','authenticatedLastChildFingerprintMatches','allTypedApplicationRowsAndSchemaCaptured','fileClientClosed','WALAndSHMVerified','applicationTables','elapsedMs']));
 assert.equal(v.contract,'fresh-parent-owned-file-verification-v1');assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(v.candidateSha,candidateSha);assert.ok(int(parentPID)&&parentPID>0);assert.equal(v.parentPID,parentPID);
 assert.equal(lastEvidence.mode,'BATCH');assert.equal(lastEvidence.parentPID,parentPID);assert.ok(int(lastEvidence.pid)&&lastEvidence.pid>0&&lastEvidence.pid!==parentPID);assert.equal(lastEvidence.physicalChildJoined,true);assert.deepEqual(lastEvidence.terminal,{code:0,signal:null});assert.equal(lastEvidence.packet.ready,true);
 assert.equal(v.finalWorkerPID,lastEvidence.pid);assert.equal(v.finalWorkerOrdinal,lastEvidence.ordinal);assert.ok(hex(v.lastWorkerDescriptorSHA256));assert.equal(v.lastWorkerDescriptorSHA256,lastEvidence.packet.descriptorSHA256);assert.equal(v.schemaVersion,35);
 for(const k of ['freshAdmissionVerified','quickCheckPassed','authenticatedLastChildFingerprintMatches','allTypedApplicationRowsAndSchemaCaptured','fileClientClosed','WALAndSHMVerified'])assert.equal(v[k],true);
 assert.ok(int(applicationTables)&&applicationTables>0);assert.equal(v.applicationTables,applicationTables);
 const p=v.snapshot;assert.ok(exact(p,['durableDigest','sourceDigest','generationDigest','executionCount','receiptCount','jobsCount','sourceRows']));for(const k of ['durableDigest','sourceDigest','generationDigest'])assert.ok(hex(p[k]));for(const k of ['executionCount','receiptCount','jobsCount','sourceRows'])assert.ok(int(p[k]));assert.equal(p.jobsCount,2);assert.equal(p.sourceRows,160);assert.deepEqual(p,lastEvidence.packet.after);
 assert.ok(Number.isFinite(v.elapsedMs)&&v.elapsedMs>=0&&v.elapsedMs<120000);return true;
}

export function validatePhysicalPreparationEvidence(report,candidateSha,parentPID){
 const exact=(v,n)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
 const int=v=>Number.isSafeInteger(v)&&v>=0,hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const fingerprint=v=>{assert.ok(exact(v,['durableDigest','sourceDigest','generationDigest','executionCount','receiptCount','jobsCount','sourceRows']));for(const k of ['durableDigest','sourceDigest','generationDigest'])assert.ok(hex(v[k]));for(const k of ['executionCount','receiptCount','jobsCount','sourceRows'])assert.ok(int(v[k]));assert.equal(v.jobsCount,2);assert.equal(v.sourceRows,160);};
 assert.equal(report.preparationLifecycle,'PHYSICAL_JOINED_BATCHES_FRESH_PARENT_VERIFIED');assert.equal(report.allPhysicalBatchAcksAndResourceSamplesVerified,true);
 assert.ok(int(report.physicalPreparationBatches)&&report.physicalPreparationBatches>=1&&report.physicalPreparationBatches<=64);assert.equal(report.physicalPreparationChildrenJoined,report.physicalPreparationBatches+1);
 const rows=report.physicalPreparationEvidence;assert.ok(Array.isArray(rows)&&rows.length===report.physicalPreparationChildrenJoined);let ordinal=0,prior=null;const pids=new Set();
 for(let i=0;i<rows.length;i++){
  const e=rows[i],mode=i===0?'INIT':'BATCH';
  assert.ok(exact(e,['mode','ordinal','pid','parentPID','terminal','physicalChildJoined','TERMRequested','KILLRequested','error','totalLogBytes','stdoutSHA256','stderrSHA256','packet','resource']));
  assert.equal(e.mode,mode);assert.equal(e.ordinal,ordinal);assert.ok(int(e.pid)&&e.pid>0&&!pids.has(e.pid));pids.add(e.pid);assert.equal(e.parentPID,parentPID);assert.deepEqual(e.terminal,{code:0,signal:null});assert.equal(e.physicalChildJoined,true);assert.equal(e.TERMRequested,false);assert.equal(e.KILLRequested,false);assert.equal(e.error,null);assert.ok(int(e.totalLogBytes)&&e.totalLogBytes<=4*1024*1024);assert.ok(hex(e.stdoutSHA256)&&hex(e.stderrSHA256));
  validateChildResourceSample(e.resource,candidateSha,{pid:e.pid,parentPid:parentPID});
  const p=e.packet;assert.ok(exact(p,['contract','mode','ordinal','pid','parentPID','closed','failed','failureType','completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted','ready','descriptorSHA256','after','catalogDigest','elapsedMs','memory','productionEvidence','LinuxQualification','EOFQualified','capacityQualified']));
  assert.equal(p.contract,'native-physical-owned-file-batch-child-v1');assert.equal(p.mode,mode);assert.equal(p.ordinal,ordinal);assert.equal(p.pid,e.pid);assert.equal(p.parentPID,parentPID);assert.equal(p.closed,true);assert.equal(p.failed,false);assert.equal(p.failureType,null);
  for(const k of ['completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted'])assert.ok(int(p[k]));assert.ok(mode==='BATCH'?p.completedCalls>=1&&p.completedCalls<=2:p.completedCalls===0);assert.ok(p.sourceAcknowledgments+p.unitsCommitted<=48);assert.ok(p.callsWithUnitsOrCompletedJobs<=1&&p.callsWithUnitsOrCompletedJobs<=p.completedCalls&&(p.unitsCommitted===0||p.callsWithUnitsOrCompletedJobs===1));assert.equal(typeof p.ready,'boolean');assert.ok(hex(p.descriptorSHA256)&&hex(p.catalogDigest));fingerprint(p.after);assert.equal(p.after.executionCount,ordinal+p.completedCalls);
  assert.ok(Number.isFinite(p.elapsedMs)&&p.elapsedMs>=0);assert.ok(exact(p.memory,['rss','heapUsed','heapTotal','external'])&&Object.values(p.memory).every(x=>Number.isFinite(x)&&x>=0));for(const k of ['productionEvidence','LinuxQualification','EOFQualified','capacityQualified'])assert.equal(p[k],false);
  if(prior){assert.equal(p.after.sourceDigest,prior.after.sourceDigest);assert.equal(p.after.generationDigest,prior.after.generationDigest);assert.equal(p.catalogDigest,prior.catalogDigest);assert.ok(p.after.receiptCount>=prior.after.receiptCount);}
  if(mode==='INIT')assert.equal(p.ready,false);if(mode==='BATCH')assert.equal(p.ready,i===rows.length-1);
  ordinal+=p.completedCalls;prior=p;
 }
 assert.equal(ordinal,report.setupProducerCalls);assert.ok(!pids.has(parentPID));validateFreshParentFileVerification(report.parentFileVerification,{candidateSha,parentPID,lastEvidence:rows.at(-1),applicationTables:report.originalApplicationTablesPreserved});return true;
}

// Only closed process metadata is projected. Invalid/raw child text is hash-bound
// by the original main log receipt and never copied to the safe summary.
export function projectBatchFailure(raw,candidateSha,parentPID){
 const output={contract:'one-native-physical-batch-failure-projection-v1',status:'NO_BATCH_FAILURE_MARKER',evidence:null,joinUnknown:null,productionEvidence:false,capacityQualified:false};
 const exact=(v,n)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
 const int=v=>Number.isSafeInteger(v)&&v>=0,hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const identity=v=>{assert.ok(['INIT','BATCH','VERIFY'].includes(v.mode));assert.ok(int(v.ordinal)&&v.ordinal<=64);assert.ok(int(v.pid)&&v.pid>0);};
 const fingerprint=v=>{assert.ok(exact(v,['durableDigest','sourceDigest','generationDigest','executionCount','receiptCount','jobsCount','sourceRows']));for(const k of ['durableDigest','sourceDigest','generationDigest'])assert.ok(hex(v[k]));for(const k of ['executionCount','receiptCount','jobsCount','sourceRows'])assert.ok(int(v[k]));assert.equal(v.jobsCount,2);assert.equal(v.sourceRows,160);};
 try{
  assert.equal(typeof raw,'string');assert.ok(raw.length<16*1024*1024);assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.ok(int(parentPID)&&parentPID>0);
  const failed=raw.split('\n').filter(s=>s.startsWith('STAGE6_NATIVE_BATCH_FAILURE ')),unknown=raw.split('\n').filter(s=>s.startsWith('STAGE6_NATIVE_BATCH_JOIN_UNKNOWN '));
  if(!failed.length&&!unknown.length)return output;
  assert.equal(failed.length+unknown.length,1);
  if(unknown.length){
   assert.ok(unknown[0].length<4096);const v=JSON.parse(unknown[0].slice('STAGE6_NATIVE_BATCH_JOIN_UNKNOWN '.length));assert.ok(exact(v,['mode','ordinal','pid','physicalChildJoined','productionEvidence']));assert.ok(['INIT','BATCH','VERIFY'].includes(v.mode));assert.ok(int(v.ordinal)&&v.ordinal<=64);assert.ok(v.pid===null||int(v.pid)&&v.pid>0);assert.equal(v.physicalChildJoined,false);assert.equal(v.productionEvidence,false);output.status='PHYSICAL_JOIN_UNKNOWN_NO_ADVANCE';output.joinUnknown=v;return output;
  }
  assert.ok(failed[0].length<32768);const e=JSON.parse(failed[0].slice('STAGE6_NATIVE_BATCH_FAILURE '.length));assert.ok(exact(e,['mode','ordinal','pid','parentPID','terminal','physicalChildJoined','TERMRequested','KILLRequested','error','totalLogBytes','stdoutSHA256','stderrSHA256','packet','resource']));identity(e);assert.equal(e.parentPID,parentPID);
  assert.ok(exact(e.terminal,['code','signal']));assert.ok(e.terminal.code===null||int(e.terminal.code)&&e.terminal.code<=255);assert.ok(e.terminal.signal===null||['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGBUS','SIGILL','SIGFPE','SIGHUP','SIGINT','SIGQUIT','SIGPIPE','SIGUSR1','SIGUSR2'].includes(e.terminal.signal));
  assert.equal(e.physicalChildJoined,true);for(const k of ['TERMRequested','KILLRequested'])assert.equal(typeof e[k],'boolean');
  assert.ok(e.error===null||['BATCH_LOG_OVERFLOW','BATCH_LOG_IO_ERROR','BATCH_PROCESS_ERROR','BATCH_STDIO_SETUP_ERROR','BATCH_STDOUT_ERROR','BATCH_STDERR_ERROR','BATCH_AGGREGATE_DEADLINE','BATCH_TERM_FAILED','BATCH_KILL_FAILED','BATCH_PACKET_UNAVAILABLE_OR_INVALID','BATCH_RESOURCE_UNAVAILABLE_OR_INVALID','BATCH_ACK_RESOURCE_OR_JOIN_INVALID'].includes(e.error));assert.ok(int(e.totalLogBytes));assert.ok(hex(e.stdoutSHA256)&&hex(e.stderrSHA256));
  if(e.resource!==null)validateChildResourceShape(e.resource,candidateSha,{pid:e.pid,parentPid:parentPID});
  if(e.packet!==null){
   const p=e.packet;assert.ok(exact(p,['contract','mode','ordinal','pid','parentPID','closed','failed','failureType','completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted','ready','descriptorSHA256','after','catalogDigest','elapsedMs','memory','productionEvidence','LinuxQualification','EOFQualified','capacityQualified']));assert.equal(p.contract,'native-physical-owned-file-batch-child-v1');assert.equal(p.mode,e.mode);assert.equal(p.ordinal,e.ordinal);assert.equal(p.pid,e.pid);assert.equal(p.parentPID,parentPID);
   for(const k of ['closed','failed','ready'])assert.equal(typeof p[k],'boolean');assert.ok([null,'Error','AssertionError','OTHER','CLOSE_FAILURE'].includes(p.failureType));for(const k of ['completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted'])assert.ok(int(p[k]));assert.ok(p.completedCalls<=2&&p.sourceAcknowledgments+p.unitsCommitted<=48);assert.ok(p.callsWithUnitsOrCompletedJobs<=1&&p.callsWithUnitsOrCompletedJobs<=p.completedCalls&&(p.unitsCommitted===0||p.callsWithUnitsOrCompletedJobs===1));
   assert.ok(Number.isFinite(p.elapsedMs)&&p.elapsedMs>=0);assert.ok(exact(p.memory,['rss','heapUsed','heapTotal','external'])&&Object.values(p.memory).every(v=>Number.isFinite(v)&&v>=0));for(const k of ['productionEvidence','LinuxQualification','EOFQualified','capacityQualified'])assert.equal(p[k],false);
   if(p.after!==null)fingerprint(p.after);if(p.catalogDigest!==null)assert.ok(hex(p.catalogDigest));
   if(p.failed)assert.equal(p.descriptorSHA256,null);else{assert.equal(p.closed,true);assert.equal(p.failureType,null);assert.ok(hex(p.descriptorSHA256)&&hex(p.catalogDigest));fingerprint(p.after);assert.equal(p.after.executionCount,p.ordinal+p.completedCalls);assert.ok(p.mode==='BATCH'?p.completedCalls>=1:p.completedCalls===0);}
  }
  output.status='FAILED_BATCH_METADATA_PRESERVED_NO_QUALIFICATION';output.evidence=e;
 }catch{output.status='INVALID_BATCH_FAILURE_MARKER_NO_PROJECTION';output.evidence=null;output.joinUnknown=null;}
 return output;
}

async function main(){
const candidateSha=process.env.EXPECTED_CANDIDATE_SHA,read=async n=>(await readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
const path='/tmp/native-physical-batch-file48-prepared-eof-hrana.log',fd=await open(path,'wx',0o600),started=performance.now();
const child=spawn(process.execPath,['--import','./test/stage6-native-file48-eof-resource.mjs','--max-old-space-size=48','--max-semi-space-size=4','test/stage6-owned-file-batched-prepared-native-eof.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test',EXPECTED_CANDIDATE_SHA:candidateSha,STAGE6_CHILD_PROFILE:'ONE_ORIGINAL_FILE48_POSITIVE_EOF_V1'}});
let spawnError=false;child.on('error',()=>{spawnError=true;});const timer=setTimeout(()=>child.kill('SIGTERM'),300000);const terminal=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));clearTimeout(timer);await fd.close();
const size=(await stat(path)).size;assert.ok(size<16*1024*1024);const raw=await readFile(path,'utf8'),memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)])),memoryPeakBytes=Number(await read('memory.peak'));
const childResources=projectChildResources(raw,candidateSha,{pid:child.pid,parentPid:process.pid});
const batchFailure=projectBatchFailure(raw,candidateSha,child.pid);
const failureProjection=projectEOFFailure(raw);let failure=failureProjection.failure,observed=null,status='FAILED_OR_UNKNOWN_NO_QUALIFICATION';
const matches=raw.split('\n').filter(l=>l.startsWith('STAGE6_FILE_PREPARED_NATIVE_EOF_RESULT '));
const terminalLines=raw.split('\n').filter(l=>l.startsWith('STAGE6_FILE_PREPARED_NATIVE_EOF_TERMINAL '));let fixtureTerminal=null;if(terminalLines.length===1){const x=JSON.parse(terminalLines[0].split('STAGE6_FILE_PREPARED_NATIVE_EOF_TERMINAL ')[1]);fixtureTerminal={closed:x.closed===true,ownedServerExited:x.ownedServerExited===true,clientTerminalComplete:x.clientTerminalComplete===true,retainedStreams:Number.isSafeInteger(x.retainedStreams)?x.retainedStreams:null,physicalTerminalObservationComplete:x.physicalTerminalObservationComplete===true};}
try{
 assert.equal(childResources.status,'OBSERVED_SAMPLE_WITHIN_SELECTED_MEMORY_BOUNDS');
 assert.ok(fixtureTerminal&&fixtureTerminal.closed&&fixtureTerminal.ownedServerExited&&fixtureTerminal.clientTerminalComplete&&fixtureTerminal.physicalTerminalObservationComplete&&fixtureTerminal.retainedStreams===0);assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});assert.equal(matches.length,1);observed=JSON.parse(matches[0].split('STAGE6_FILE_PREPARED_NATIVE_EOF_RESULT ')[1]);
 validatePhysicalPreparationEvidence(observed,candidateSha,child.pid);assert.equal(observed.contract,'one-owned-file-batched-parent-verified-native-hrana-positive-eof-component-v1');
 assert.equal(observed.preparationTransport,'OWNED_NATIVE_FILE_NOT_HTTP');assert.equal(observed.filePreparationBudgetMs,120000);assert.ok(Number.isSafeInteger(observed.originalApplicationTablesPreserved)&&observed.originalApplicationTablesPreserved>0);assert.equal(observed.allOriginalTypedApplicationRowsPreserved,true);assert.equal(observed.fileClientClosed,true);assert.equal(observed.originalHTTPPreparationQualified,false);assert.equal(observed.sixJobCompletionQualified,false);
 assert.equal(observed.status,'PASS_FILE_PREPARED_NATIVE_SQLD_EOF_COMPONENT_ONLY');assert.equal(observed.sourceHealthRows,160);assert.ok(observed.positiveEpisodeRows>=1);assert.equal(observed.users,1);assert.equal(observed.jobsCompleted,2);assert.ok(Number.isSafeInteger(observed.setupProducerCalls)&&observed.setupProducerCalls>=1&&observed.setupProducerCalls<=64);assert.equal(observed.original115msCalls,1);assert.equal(observed.exactOriginalReplays,1);assert.equal(observed.exactReplayLatencyMs,115);assert.equal(observed.addedLatencyMs,115);assert.ok(Number.isSafeInteger(observed.originalReceiptCount)&&observed.originalReceiptCount>0);assert.ok(observed.eofMs>0&&observed.eofMs<45000);assert.ok(observed.maxObservedTransactionUpperBoundMs>0&&observed.maxObservedTransactionUpperBoundMs<5000);
 for(const k of ['allOriginalExecutionsAndReceiptsPreserved','exactReplayVerified','finalClientTerminalComplete','physicalTerminalObservationComplete','ownedServerExited'])assert.equal(observed[k],true);assert.equal(observed.finalRetainedStreams,0);assert.equal(observed.absoluteServerDeadline,'UNKNOWN');assert.equal(observed.productionEvidence,false);assert.equal(observed.denseCapacityQualified,false);assert.equal(observed.representativeWholePipelineQualified,false);
 assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);assert.ok(performance.now()-started<300000);status='PASS_PHYSICAL_BATCH_FILE48_PARENT_VERIFIED_NATIVE_SQLD_EOF_COMPONENT_ONLY';
}catch{observed=null;}
await rm(path);
console.log('STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SUPERVISOR '+JSON.stringify({contract:'one-physical-batch-file48-parent-verified-native-eof-supervisor-v1',candidateSha,status,terminal,spawnError,failure,failureProjectionStatus:failureProjection.status,fixtureTerminal,observed,childResources,batchFailure,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs:performance.now()-started,childLogSha256:createHash('sha256').update(raw).digest('hex'),productionEvidence:false,denseCapacityQualified:false,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN'}));
process.exitCode=status==='PASS_PHYSICAL_BATCH_FILE48_PARENT_VERIFIED_NATIVE_SQLD_EOF_COMPONENT_ONLY'?0:2;

}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
