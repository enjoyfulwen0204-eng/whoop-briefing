// Public synthetic fixture only. No network, provider credentials, Production DB or events.
import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat,open,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import assert from 'node:assert/strict';
const candidateSha=process.env.EXPECTED_CANDIDATE_SHA;
assert.match(candidateSha??'',/^[a-f0-9]{40}$/);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');
assert.deepEqual(Object.keys(networkInterfaces()).sort(),['lo']);
const read=async name=>(await readFile('/sys/fs/cgroup/'+name,'utf8')).trim();
assert.equal(await read('memory.max'),'536870912');assert.equal(await read('memory.swap.max'),'0');assert.equal(await read('cpu.max'),'50000 100000');
const path='/tmp/finalization-native.tap',fd=await open(path,'wx',0o600),started=performance.now();
const child=spawn(process.execPath,['--expose-gc','--test','--test-concurrency=1','test/stage6-six-job-finalization.test.js','test/processing-principal-readiness-snapshot.test.mjs'],{stdio:['ignore',fd.fd,fd.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test'}});
let spawnError=false;child.on('error',()=>{spawnError=true;});
const timer=setTimeout(()=>{child.kill('SIGTERM');},195000);
const terminal=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);await fd.close();
const size=(await stat(path)).size;assert.ok(size<16*1024*1024,'BOUNDED_SYNTHETIC_TAP_REQUIRED');const tap=await readFile(path,'utf8');
const totals={};for(const key of ['tests','pass','fail','cancelled','skipped','todo']){const all=[...tap.matchAll(new RegExp('^# '+key+' (\\d+)\\r?$','gm'))];assert.equal(all.length,1);totals[key]=Number(all[0][1]);}
function profile(label){const matches=[...tap.matchAll(new RegExp('^# '+label+' (\\{[^\\n]+\\})\\r?$','gm'))];assert.equal(matches.length,1);return JSON.parse(matches[0][1]);}
const six=profile('SYNTHETIC_SIX_JOB_COMPLETION'),eof=profile('SYNTHETIC_EOF_HTTP_PROFILE');
const memoryEvents=Object.fromEntries((await read('memory.events')).split('\n').map(l=>l.split(/\s+/)).map(([k,v])=>[k,Number(v)]));
const memoryPeakBytes=Number(await read('memory.peak')),elapsedMs=performance.now()-started;
assert.equal(spawnError,false);assert.deepEqual(terminal,{code:0,signal:null});assert.deepEqual(totals,{tests:13,pass:13,fail:0,cancelled:0,skipped:0,todo:0});
assert.equal(six.jobs,6);assert.equal(six.users,3);assert.equal(six.sourceRows,0);assert.ok(six.calls>=3&&six.calls<=18);assert.equal(six.reopenedOwnedConnection,true);assert.equal(six.productionEvidence,false);
assert.equal(eof.addedLatencyMs,115);assert.equal(eof.modeledTransactionLimitMs,5000);assert.ok(eof.elapsedMs>0&&eof.elapsedMs<45000);assert.equal(eof.productionEvidence,false);
assert.ok(elapsedMs>0&&elapsedMs<195000);assert.equal(memoryEvents.oom,0);assert.equal(memoryEvents.oom_kill,0);assert.ok(memoryPeakBytes>0&&memoryPeakBytes<=536870912);
await rm(path);
console.log('STAGE6_FINALIZATION_NATIVE_RESULT '+JSON.stringify({contract:'stage6-finalization-native-regression-v1',candidateSha,status:'PASS_EMPTY_SIX_JOB_AND_MODELED_EOF_ONLY',tests:totals,resources:{node:process.version,platform:process.platform,architecture:process.arch,memoryMaxBytes:536870912,memoryPeakBytes,cpuMax:'50000 100000',swapMaxBytes:0,oom:memoryEvents.oom,oomKills:memoryEvents.oom_kill,network:'none'},elapsedMs,sixEmptyJobs:{users:six.users,jobs:six.jobs,calls:six.calls,sourceHealthRows:0,reopenedOwnedConnection:six.reopenedOwnedConnection},modeledEOF:{elapsedMs:eof.elapsedMs,httpRequests:eof.httpRequests,addedLatencyMs:115,modeledTransactionLimitMs:5000},tapSha256:createHash('sha256').update(tap).digest('hex'),productionEvidence:false,denseCapacityQualified:false,realUserInteraction:false,genuineSQLDHttpPath:false,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN'}));
