// Synthetic component qualification only. The Hrana transport uses installed
// SQLite in the owned container; it is not a native SQLD or six-job proof.
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const mode=process.argv[2],sha=process.env.PHASE4_RELEASE_SHA;
assert.ok(['guards','runtime','native-runtime','native-live-completion','native-live-prefix-profile','native-live-cold-profile'].includes(mode));assert.match(sha??'',/^[a-f0-9]{40}$/);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha);
const scalar=name=>readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();
assert.equal(scalar('memory.max'),'536870912');assert.equal(scalar('memory.swap.max'),'0');assert.equal(scalar('cpu.max'),'50000 100000');
const coldProfile=mode==='native-live-cold-profile',prefixProfile=mode==='native-live-prefix-profile',profile=prefixProfile||coldProfile;
const args=['--expose-gc','--max-old-space-size=128','--max-semi-space-size=4',...(profile?['--import=./test/stage6RawReplayProfile.mjs']:[]),'--test','--test-concurrency=1',
 ...(['native-live-completion','native-live-prefix-profile','native-live-cold-profile'].includes(mode)?['test/stage6-live-native-completion.mjs']:mode==='guards'?['test/stage6-snapshot-guard.test.js','test/exact-real-statement.test.js']
  :['--test-name-pattern=authority: NONE$','test/stage6-shadow-publication-runtime.test.js'])];
const at=performance.now(),child=spawn(process.execPath,args,{stdio:'inherit',detached:true,env:{...process.env,STAGE6_SHADOW_NATIVE_SQLD:['native-runtime','native-live-completion','native-live-prefix-profile','native-live-cold-profile'].includes(mode)?'1':'0',STAGE6_NATIVE_PREFIX_PROFILE:prefixProfile?'1':'0',STAGE6_NATIVE_COLD_PROFILE:coldProfile?'1':'0'}});
let timedOut=false,spawnError=false,killTimer;
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);};
const timer=setTimeout(()=>{timedOut=true;stop();},profile?180000:mode==='native-live-completion'?900000:120000);
child.once('error',()=>{spawnError=true;});
const terminal=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
clearTimeout(timer);clearTimeout(killTimer);
let groupStillPresent=false;try{process.kill(-child.pid,0);groupStillPresent=true;}catch(error){if(error.code!=='ESRCH')groupStillPresent=true;}
if(groupStillPresent){try{process.kill(-child.pid,'SIGKILL');}catch{}}
const events=Object.fromEntries(scalar('memory.events').split('\n').map(line=>{const [k,v]=line.split(/\s+/);return [k,Number(v)];}));
const peak=Number(scalar('memory.peak'));
const passed=terminal.code===0&&!terminal.signal&&!timedOut&&!spawnError&&!groupStillPresent&&events.oom===0&&events.oom_kill===0&&Number.isSafeInteger(peak)&&peak>0&&peak<=536870912;
console.log('SYNTHETIC_SHADOW_LINUX_COMPONENT '+JSON.stringify({contract:'isolated-shadow-snapshot-linux-component-v1',sha,mode,diagnosticOnly:profile,status:passed?(profile?'DIAGNOSTIC_COMPLETED':'COMPONENT_PASS'):'COMPONENT_FAILED',terminal,timedOut,spawnError,groupStillPresent,elapsedMs:performance.now()-at,memoryMaxBytes:536870912,memoryPeakBytes:peak,memoryEvents:events,cpuMax:scalar('cpu.max'),swapMaxBytes:0,childPhysicalCloseObserved:true,transport:['native-runtime','native-live-completion','native-live-prefix-profile','native-live-cold-profile'].includes(mode)?'OWNED_PINNED_NATIVE_SQLD_HRANA_HTTP':'INSTALLED_HRANA_CLIENT_ISOLATED_SQLITE_TEST_TRANSPORT',nativeSQLDQualified:false,sixJobCompletionQualified:false,capacityQualified:false,productionEvidence:false}));
process.exitCode=passed?0:1;
