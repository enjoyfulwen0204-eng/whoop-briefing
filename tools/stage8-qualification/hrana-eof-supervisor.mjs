import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
const candidateSha=process.env.EXPECTED_CANDIDATE_SHA,read=async n=>(await readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
const path='/tmp/native-eof-hrana.log',fd=await open(path,'wx',0o600),started=performance.now();
const child=spawn(process.execPath,['--max-old-space-size=96','--max-semi-space-size=2','test/stage6-native-eof-hrana.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test'}});
let spawnError=false;child.on('error',()=>{spawnError=true;});const timer=setTimeout(()=>child.kill('SIGTERM'),195000);const terminal=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));clearTimeout(timer);await fd.close();
const size=(await stat(path)).size;assert.ok(size<16*1024*1024);const raw=await readFile(path,'utf8'),memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)])),memoryPeakBytes=Number(await read('memory.peak'));
let failure=null,observed=null,status='FAILED_OR_UNKNOWN_NO_QUALIFICATION';
const matches=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_EOF_RESULT '));
const failures=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_EOF_FAILURE '));
if(failures.length===1){const f=JSON.parse(failures[0].split('STAGE6_NATIVE_EOF_FAILURE ')[1]);failure={stage:/^[A-Z_]{1,80}$/.test(f.stage??'')?f.stage:'UNKNOWN',type:['Error','AssertionError'].includes(f.type)?f.type:'OTHER',code:/^[A-Z0-9_]{1,80}$/.test(f.code??'')?f.code:'OTHER'};}
try{
 assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});assert.equal(matches.length,1);observed=JSON.parse(matches[0].split('STAGE6_NATIVE_EOF_RESULT ')[1]);
 assert.equal(observed.status,'PASS_NATIVE_SQLD_EOF_EMPTY_ONLY');assert.equal(observed.sourceHealthRows,0);assert.equal(observed.users,1);assert.equal(observed.jobsCompleted,2);assert.equal(observed.setupProducerCalls,2);assert.equal(observed.original115msCalls,1);assert.equal(observed.exactOriginalReplays,1);assert.equal(observed.addedLatencyMs,115);assert.ok(Number.isSafeInteger(observed.originalReceiptCount)&&observed.originalReceiptCount>0);assert.ok(observed.eofMs>0&&observed.eofMs<45000);assert.ok(observed.maxObservedTransactionUpperBoundMs>0&&observed.maxObservedTransactionUpperBoundMs<5000);
 for(const k of ['allOriginalExecutionsAndReceiptsPreserved','exactReplayVerified','priorClientTerminalComplete','finalClientTerminalComplete','physicalTerminalObservationComplete','ownedServerExited'])assert.equal(observed[k],true);assert.equal(observed.finalRetainedStreams,0);assert.equal(observed.absoluteServerDeadline,'UNKNOWN');assert.equal(observed.productionEvidence,false);assert.equal(observed.denseCapacityQualified,false);assert.equal(observed.representativeWholePipelineQualified,false);
 assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);assert.ok(performance.now()-started<195000);status='PASS_NATIVE_SQLD_EOF_EMPTY_ONLY';
}catch{observed=null;}
await rm(path);
console.log('STAGE6_HRANA_EOF_SUPERVISOR '+JSON.stringify({contract:'one-native-hrana-eof-supervisor-v1',candidateSha,status,terminal,spawnError,failure,observed,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs:performance.now()-started,childLogSha256:createHash('sha256').update(raw).digest('hex'),productionEvidence:false,denseCapacityQualified:false,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN'}));
process.exitCode=status==='PASS_NATIVE_SQLD_EOF_EMPTY_ONLY'?0:2;
