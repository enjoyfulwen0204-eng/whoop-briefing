import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {validateChildResourceSample,validateChildResourceShape} from '../../test/stage6-native-semi4-eof-resource.mjs';
export function validatePreparationTransactions(t){
 assert.ok(t&&typeof t==='object'&&!Array.isArray(t));assert.deepEqual(Object.keys(t).sort(),['begun','committed','rolledBack','unknownTerminal','open','sumDurationUpperBoundMs','maxDurationUpperBoundMs','atOrAbove5s'].sort());
 for(const k of ['begun','committed','rolledBack','unknownTerminal','open','atOrAbove5s'])assert.ok(Number.isSafeInteger(t[k])&&t[k]>=0);
 for(const k of ['sumDurationUpperBoundMs','maxDurationUpperBoundMs'])assert.ok(Number.isFinite(t[k])&&t[k]>=0);
 assert.ok(t.begun>0);assert.equal(t.open,0);assert.equal(t.unknownTerminal,0);assert.equal(t.begun,t.committed+t.rolledBack);assert.equal(t.atOrAbove5s,0);assert.ok(t.maxDurationUpperBoundMs>0&&t.maxDurationUpperBoundMs<5000);assert.ok(t.sumDurationUpperBoundMs>=t.maxDurationUpperBoundMs);
 return true;
}
export function projectChildResources(raw,candidateSha,identity){
 const projection={contract:'one-original-child-semi4-eof-resource-preservation-v1',status:'UNKNOWN_RESOURCE_OBSERVATION',reason:'INVALID_INPUT',packet:null,productionEvidence:false,capacityQualified:false};
 let reason='INVALID_INPUT';
 try{
  assert.equal(typeof raw,'string');assert.ok(raw.length<16*1024*1024);
  const prefix='STAGE6_SEMI4_EOF_CHILD_RESOURCE ',rows=raw.split('\n').filter(l=>l.startsWith(prefix));
  reason='MISSING_OR_DUPLICATE_PACKET';assert.equal(rows.length,1);reason='INVALID_PACKET';assert.ok(rows[0].length<4096);
  const packet=JSON.parse(rows[0].slice(prefix.length));validateChildResourceShape(packet,candidateSha,identity);projection.packet=packet;
  reason='SAMPLE_OUTSIDE_SELECTED_MEMORY_PROFILE';validateChildResourceSample(packet,candidateSha,identity);
  projection.status='OBSERVED_SAMPLE_WITHIN_SELECTED_MEMORY_BOUNDS';projection.reason='EXACT_ORIGINAL_CHILD_IDENTITY';
 }catch{projection.reason=reason;if(projection.packet)projection.status='OBSERVED_SAMPLE_OUTSIDE_SELECTED_MEMORY_PROFILE';}
 return projection;
}
async function main(){
const candidateSha=process.env.EXPECTED_CANDIDATE_SHA,read=async n=>(await readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
const path='/tmp/native-live12-semi4-positive-eof-hrana.log',fd=await open(path,'wx',0o600),started=performance.now();
const child=spawn(process.execPath,['--import','./test/stage6-native-semi4-eof-resource.mjs','--max-old-space-size=96','--max-semi-space-size=4','test/stage6-native-live12-semi4-positive-eof.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test',EXPECTED_CANDIDATE_SHA:candidateSha,STAGE6_CHILD_PROFILE:'ONE_ORIGINAL_SEMI4_POSITIVE_EOF_V1'}});
let spawnError=false;child.on('error',()=>{spawnError=true;});const timer=setTimeout(()=>child.kill('SIGTERM'),300000);const terminal=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));clearTimeout(timer);await fd.close();
const size=(await stat(path)).size;assert.ok(size<16*1024*1024);const raw=await readFile(path,'utf8'),memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)])),memoryPeakBytes=Number(await read('memory.peak'));
const childResources=projectChildResources(raw,candidateSha,{pid:child.pid,parentPid:process.pid});
let failure=null,observed=null,status='FAILED_OR_UNKNOWN_NO_QUALIFICATION';
const matches=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_POSITIVE_EOF_RESULT '));
const failures=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_POSITIVE_EOF_FAILURE '));
if(failures.length===1){const f=JSON.parse(failures[0].split('STAGE6_NATIVE_POSITIVE_EOF_FAILURE ')[1]);failure={stage:/^[A-Z_]{1,80}$/.test(f.stage??'')?f.stage:'UNKNOWN',type:['Error','AssertionError'].includes(f.type)?f.type:'OTHER',code:/^[A-Z0-9_]{1,80}$/.test(f.code??'')?f.code:'OTHER',classification:['BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_NONEMPTY_CURSOR_REQUIRED','REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED','ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_RECEIPT_CHANGED_OR_MISSING','OTHER_ASSERTION','OTHER_ERROR'].includes(f.classification)?f.classification:'UNKNOWN',progress:f.progress&&Object.values(f.progress).every(v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0||typeof v==='string'&&/^[A-Z_]{1,40}$/.test(v))?f.progress:null,elapsedMs:Number.isFinite(f.elapsedMs)?f.elapsedMs:null};}
const terminalLines=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_POSITIVE_EOF_TERMINAL '));let fixtureTerminal=null;if(terminalLines.length===1){const x=JSON.parse(terminalLines[0].split('STAGE6_NATIVE_POSITIVE_EOF_TERMINAL ')[1]);fixtureTerminal={closed:x.closed===true,ownedServerExited:x.ownedServerExited===true,clientTerminalComplete:x.clientTerminalComplete===true,retainedStreams:Number.isSafeInteger(x.retainedStreams)?x.retainedStreams:null,physicalTerminalObservationComplete:x.physicalTerminalObservationComplete===true};}
try{
 assert.equal(childResources.status,'OBSERVED_SAMPLE_WITHIN_SELECTED_MEMORY_BOUNDS');
 assert.ok(fixtureTerminal&&fixtureTerminal.closed&&fixtureTerminal.ownedServerExited&&fixtureTerminal.clientTerminalComplete&&fixtureTerminal.physicalTerminalObservationComplete&&fixtureTerminal.retainedStreams===0);assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});assert.equal(matches.length,1);observed=JSON.parse(matches[0].split('STAGE6_NATIVE_POSITIVE_EOF_RESULT ')[1]);
 validatePreparationTransactions(observed.preparationTransactions);assert.equal(observed.preparationAddedLatencyMs,0);
 assert.equal(observed.status,'PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY');assert.equal(observed.sourceHealthRows,160);assert.ok(observed.positiveEpisodeRows>=1);assert.equal(observed.users,1);assert.equal(observed.jobsCompleted,2);assert.ok(Number.isSafeInteger(observed.setupProducerCalls)&&observed.setupProducerCalls>=1&&observed.setupProducerCalls<=512);assert.equal(observed.original115msCalls,1);assert.equal(observed.exactOriginalReplays,1);assert.equal(observed.exactReplayLatencyMs,115);assert.equal(observed.addedLatencyMs,115);assert.ok(Number.isSafeInteger(observed.originalReceiptCount)&&observed.originalReceiptCount>0);assert.ok(observed.eofMs>0&&observed.eofMs<45000);assert.ok(observed.maxObservedTransactionUpperBoundMs>0&&observed.maxObservedTransactionUpperBoundMs<5000);
 for(const k of ['allOriginalExecutionsAndReceiptsPreserved','exactReplayVerified','priorClientTerminalComplete','finalClientTerminalComplete','physicalTerminalObservationComplete','ownedServerExited'])assert.equal(observed[k],true);assert.equal(observed.finalRetainedStreams,0);assert.equal(observed.absoluteServerDeadline,'UNKNOWN');assert.equal(observed.productionEvidence,false);assert.equal(observed.denseCapacityQualified,false);assert.equal(observed.representativeWholePipelineQualified,false);
 assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);assert.ok(performance.now()-started<300000);status='PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY';
}catch{observed=null;}
await rm(path);
console.log('STAGE6_LIVE12_SEMI4_POSITIVE_EOF_SUPERVISOR '+JSON.stringify({contract:'one-native-live12-semi4-positive-eof-supervisor-v1',candidateSha,status,terminal,spawnError,failure,fixtureTerminal,observed,childResources,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs:performance.now()-started,childLogSha256:createHash('sha256').update(raw).digest('hex'),productionEvidence:false,denseCapacityQualified:false,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN'}));
process.exitCode=status==='PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY'?0:2;

}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
