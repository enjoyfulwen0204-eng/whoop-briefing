import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
const candidateSha=process.env.EXPECTED_CANDIDATE_SHA,read=async n=>(await readFile('/sys/fs/cgroup/'+n,'utf8')).trim();
assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
const path='/tmp/native-first20-diagnostic.log',fd=await open(path,'wx',0o600),started=performance.now();
const child=spawn(process.execPath,['--max-old-space-size=96','--max-semi-space-size=2','test/stage6-native-first20-diagnostic.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test'}});
let spawnError=false;child.on('error',()=>{spawnError=true;});const timer=setTimeout(()=>child.kill('SIGTERM'),360000);const terminal=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));clearTimeout(timer);await fd.close();
const size=(await stat(path)).size;assert.ok(size<16*1024*1024);const raw=await readFile(path,'utf8'),memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)])),memoryPeakBytes=Number(await read('memory.peak'));

function validateObservation(v){
 const outcomes=['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','FAILED'];
 const codes=['INVARIANT_VIOLATION','CALCULATION_FAILED','STALE_GENERATION','SOURCE_UNAVAILABLE','AUTH_CHANGED','LIFECYCLE_CHANGED','CONTENT_REDACTED','LEASE_LOST','REPAIR_REQUIRED','OTHER'];
 assert.equal(v.contract,'one-native-first20-worker-diagnostic-v1');assert.equal(v.maxPreparations,20);assert.equal(v.syntheticWHOOPRows,160);
 assert.ok(Array.isArray(v.preparations)&&v.preparations.length>=1&&v.preparations.length<=20);
 for(const [i,leg]of v.preparations.entries()){
  assert.equal(leg.ordinal,i+1);assert.ok(outcomes.includes(leg.outcome));
  for(const field of ['processedItems','unitsCommitted','completedJobs','failedJobs','remainingJobs'])assert.ok(Number.isSafeInteger(leg[field])&&leg[field]>=0);
  assert.ok(Array.isArray(leg.failures)&&leg.failures.length<=8);for(const x of leg.failures){assert.ok(['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS','OTHER'].includes(x.kind));assert.ok(codes.includes(x.code));}
  assert.equal(leg.failedJobs===0,leg.failures.length===0);if(i<v.preparations.length-1)assert.equal(leg.failedJobs,0);
 }
 if(v.status==='DIAGNOSTIC_FIRST20_NO_WORKER_FAILURE'){assert.equal(v.preparations.length,20);for(const x of v.preparations)assert.equal(x.failedJobs,0);}
 else{assert.equal(v.status,'DIAGNOSTIC_WORKER_FAILURE_OBSERVED');assert.ok(v.preparations.at(-1).failedJobs>0);}
 for(const field of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'])assert.equal(v[field],false);
 return true;
}
let failure=null,observed=null,status='DIAGNOSTIC_FAILED_OR_UNKNOWN';
const workerReturned=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_WORKER_RETURNED ')).slice(0,20).map(l=>JSON.parse(l.split('STAGE6_NATIVE_FIRST20_WORKER_RETURNED ')[1]));
const settledPartial=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_SETTLED ')).slice(0,20).map(l=>JSON.parse(l.split('STAGE6_NATIVE_FIRST20_SETTLED ')[1]));
const observationLines=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_OBSERVATION '));let diagnosticObservation=observationLines.length===1?JSON.parse(observationLines[0].split('STAGE6_NATIVE_FIRST20_OBSERVATION ')[1]):null;
const fatalLines=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_FAILURE '));if(fatalLines.length===1)failure=JSON.parse(fatalLines[0].split('STAGE6_NATIVE_FIRST20_FAILURE ')[1]);
const matches=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_RESULT '));
const terminalLines=raw.split('\n').filter(l=>l.startsWith('STAGE6_NATIVE_FIRST20_TERMINAL '));let fixtureTerminal=null;
if(terminalLines.length===1){const x=JSON.parse(terminalLines[0].split('STAGE6_NATIVE_FIRST20_TERMINAL ')[1]);fixtureTerminal={closed:x.closed===true,ownedServerExited:x.ownedServerExited===true,clientTerminalComplete:x.clientTerminalComplete===true,retainedStreams:Number.isSafeInteger(x.retainedStreams)?x.retainedStreams:null,physicalTerminalObservationComplete:x.physicalTerminalObservationComplete===true};}
try{
 assert.ok(fixtureTerminal?.closed&&fixtureTerminal.ownedServerExited&&fixtureTerminal.clientTerminalComplete&&fixtureTerminal.physicalTerminalObservationComplete&&fixtureTerminal.retainedStreams===0);assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});assert.equal(matches.length,1);observed=JSON.parse(matches[0].split('STAGE6_NATIVE_FIRST20_RESULT ')[1]);
 validateObservation(observed);
 assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);assert.ok(performance.now()-started<360000);status='DIAGNOSTIC_COMPLETED_NO_QUALIFICATION';
}catch{observed=null;}
await rm(path);console.log('STAGE6_NATIVE_FIRST20_SUPERVISOR '+JSON.stringify({contract:'one-native-first20-supervisor-v1',candidateSha,status,terminal,spawnError,failure,fixtureTerminal,observed,workerReturned:observed||diagnosticObservation?[]:workerReturned,diagnosticObservation:observed?null:diagnosticObservation,settledPartial:observed||diagnosticObservation?[]:settledPartial,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs:performance.now()-started,childLogSha256:createHash('sha256').update(raw).digest('hex'),productionEvidence:false,capacityQualified:false}));process.exitCode=status==='DIAGNOSTIC_COMPLETED_NO_QUALIFICATION'?0:2;
