// Trusted CI orchestration only. Candidate code runs only inside the offline,
// resource-limited container. This module has no import-time side effects.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,lstatSync,realpathSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const OWNER_REPOSITORY='enjoyfulwen0204-eng/whoop-briefing';
const sourceDirectory=dirname(fileURLToPath(import.meta.url));
export const LIMITS=Object.freeze({memoryBytes:536870912,cpu:'0.5',pids:128,wallSeconds:1920,maximumCalls:64});
export function candidateSha(value){assert.match(value??'',/^[0-9a-f]{40}$/,'FULL_CANDIDATE_SHA_REQUIRED');return value;}
const privateDirectory=path=>mkdirSync(path,{mode:0o700});
const regularFile=path=>assert.ok(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),`REGULAR_FILE_REQUIRED:${path}`);
const cleanGitEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_')));
function run(command,args,{cwd,git=false,capture=false,check=true}={}){
 const result=spawnSync('timeout',['--signal=TERM','--kill-after=5s','30s',command,...args],{cwd,env:git?cleanGitEnvironment():process.env,encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit',maxBuffer:1024*1024});
 if(check){assert.ifError(result.error);assert.equal(result.status,0,`CONTROL_COMMAND_FAILED:${command}`);}
 return result;
}
const modes=new Set(['qualification','diagnostic-empty-one']);
export function dockerArguments({name,image,checkout,commonGit,output,uid,gid,mode='qualification'}){
 assert.ok(modes.has(mode),'EXPLICIT_MODE_REQUIRED');
 for(const path of [checkout,commonGit,output])assert.ok(path===resolve(path)&&!/[\r\n,:]/.test(path),'CANONICAL_MOUNT_PATH_REQUIRED');
 assert.match(name,/^stage8-qualification-[0-9]+-[0-9]+$/,'RUN_CONTAINER_NAME_REQUIRED');
 assert.match(image,/^stage8-live-qualification:[0-9]+-[0-9]+$/,'LOCAL_IMAGE_NAME_REQUIRED');
 for(const id of [uid,gid])assert.ok(Number.isSafeInteger(id)&&id>0,'NONROOT_OWNER_REQUIRED');
 const args=['run','--name',name,'--label',`healthos.stage8.qualification=${name}`,'--platform','linux/amd64','--network','none',
  '--memory',String(LIMITS.memoryBytes),'--memory-swap',String(LIMITS.memoryBytes),'--cpus',LIMITS.cpu,'--pids-limit',String(LIMITS.pids),
  '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cgroupns','private','--user',`${uid}:${gid}`,
  '--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=67108864','--env','HOME=/tmp','--workdir',checkout];
 for(const path of [join(checkout,'src'),join(checkout,'test'),join(checkout,'package.json'),join(checkout,'package-lock.json'),join(checkout,'.git'),commonGit])args.push('--mount',`type=bind,src=${path},dst=${path},readonly`);
 args.push('--mount',`type=bind,src=${output},dst=/qualification`,'--entrypoint','/bin/sh',image,'-c',
  'test "$(node --version)" = v22.23.3 && exec /bin/sh test/stage8-live-linux-http.sh'+(mode==='diagnostic-empty-one'?' diagnostic-empty-one':''));
 return args;
}
const number=(value,label)=>{assert.ok(Number.isSafeInteger(value)&&value>=0,`INVALID_METRIC:${label}`);return value;};
const phases=new Set(['PRECHECK','CHECKOUT','IMAGE_BUILD','QUALIFICATION','REPORT','CLEANUP','SUMMARY']);
const codePattern=/^[A-Za-z][A-Za-z0-9_:-]{0,79}$/;
export function controlFailure(error,phase){
 const message=String(error?.message??error),candidate=/^[A-Z][A-Z0-9_]{1,79}$/.test(message)?message:String(error?.code??error?.name??'ERROR');
 return {phase:phases.has(phase)?phase:'UNKNOWN',code:codePattern.test(candidate)?candidate:'ERROR',messageSha256:createHash('sha256').update(message).digest('hex')};
}
const tagFailure=(error,phase)=>Object.assign(new Error('ISOLATED_QUALIFICATION_CONTROL_FAILED',{cause:error}),{qualificationDiagnostic:controlFailure(error,phase)});
function sourceCounts(report){
 const tables={sleep:'whoop_sleeps',recovery:'whoop_recoveries',cycle:'whoop_cycles',workout:'whoop_workouts'},expected=report.input?.expectedTotalRows,actual=report.seededRows;
 if(expected===undefined||actual===undefined){assert.notEqual(report.status,'LOCAL_LIVE_HTTP_VERIFIED','VERIFIED_SOURCE_COUNTS_REQUIRED');return null;}
 const counts={expected:{},actual:{}};
 for(const [kind,table] of Object.entries(tables)){counts.expected[kind]=number(expected[kind],`expected:${kind}`);counts.actual[kind]=number(actual[table],`actual:${kind}`);}
 if(report.status==='LOCAL_LIVE_HTTP_VERIFIED')assert.deepEqual(counts.actual,counts.expected,'VERIFIED_SOURCE_COUNTS_MUST_MATCH');
 return counts;
}
function sourceFailures(report){
 const failures=report.failures??[];assert.ok(Array.isArray(failures)&&failures.length<=1024,'BOUNDED_FAILURES_REQUIRED');
 return failures.slice(0,16).map(failure=>{
  assert.ok(sourcePhaseNames.has(failure.stage)||/^(LEG|READBACK):[abc]$/.test(failure.stage??''),'FAILURE_STAGE_REQUIRED');
  assert.match(failure.code??'',codePattern,'FAILURE_CODE_REQUIRED');assert.match(failure.messageSha256??'',/^[a-f0-9]{64}$/,'FAILURE_HASH_REQUIRED');
  return {stage:failure.stage,code:failure.code,messageSha256:failure.messageSha256};
 });
}
const sourcePhaseNames=new Set(['SETUP','ANALYSIS','MIGRATION','FOUNDATION','SEED','ADMISSION','PRODUCER_CONSTRUCTOR','READER_CONSTRUCTOR','LEG_BEFORE','PRODUCER_LEG','LEG_READBACK','VERIFY','FINAL']);
const sourceStages=new Set(['UNCLASSIFIED','TENANT_INITIALIZATION','ALGORITHM_ROLLOUT','FRESH_GENERATION','WORKER_DRAIN','DURABLE_EXECUTION','CONTEXT_CAPTURE','PRINCIPAL_READY']);
const sqlCategories=new Set(['PRINCIPAL_READY_METADATA','LIVE_EXECUTION','LIVE_RESULT','DURABLE_JOBS','SCHEMA','TENANT_FENCE','OTHER']);
const sqlVerbs=new Set(['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','PRAGMA','CREATE','ALTER','DROP','SAVEPOINT','RELEASE','OTHER']);
function safePhase(name){assert.ok(sourcePhaseNames.has(name),'DIAGNOSTIC_PHASE_REQUIRED');return name;}
function phaseCounts(value){
 if(value===undefined)return null;assert.ok(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=sourcePhaseNames.size,'BOUNDED_PHASE_COUNTS_REQUIRED');
 return Object.fromEntries(Object.entries(value).map(([name,n])=>[safePhase(name),number(n,'phaseRequests')]));
}
function durableCounts(value){
 if(value===undefined||value===null)return null;
 return Object.fromEntries(['jobs','completedJobs','runningJobs','pendingJobs','jobsWithCursor','fullScopes','currentComputations','completionProofs','publications','workReceipts','operationReceipts','executions','ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE'].map(key=>[key,number(value[key],'durable:'+key)]));
}
function safeLegs(value){
 if(value===undefined)return null;assert.ok(Array.isArray(value)&&value.length<=64,'BOUNDED_LEGS_REQUIRED');
 return value.map(leg=>({call:number(leg.call,'legCall'),elapsedMs:leg.elapsedMs===undefined?null:number(leg.elapsedMs,'legElapsed'),failedPhase:leg.failedPhase===undefined?null:safePhase(leg.failedPhase),
  error:['SYNC_TIMEOUT','SYNC_CANCELLED','COMMIT_INDETERMINATE','REQUEST_OWNER_FENCED','STAGE8_LIVE_PRINCIPAL_FENCED'].includes(leg.error?.code)?leg.error.code:leg.error?'OTHER':null,
  before:durableCounts(leg.beforeCounts),after:durableCounts(leg.afterCounts),reportedMetadataProgress:typeof leg.businessProgress==='boolean'?leg.businessProgress:null,
  exactReplayVerified:leg.exactReplayVerified===true}));
}
function safePhaseDiagnostics(value){
 if(value===undefined)return null;assert.equal(value.contract,'stage8-safe-http-phase-diagnostics-v1');assert.equal(value.sqlDetailPhase,'PRODUCER_LEG','WORKLOAD_DETAIL_RESERVATION_REQUIRED');
 assert.ok(Array.isArray(value.phases)&&value.phases.length<=sourcePhaseNames.size&&Array.isArray(value.sqlGroups)&&value.sqlGroups.length<=128,'BOUNDED_DIAGNOSTICS_REQUIRED');
 const phases=value.phases.map(row=>({phase:safePhase(row.phase),...Object.fromEntries(['elapsedMs','requests','attemptedStatements','requestErrors','httpEnvelopeMs'].map(key=>[key,number(row[key],key)]))}));
 const sqlGroups=value.sqlGroups.slice(0,16).map(row=>{
  assert.equal(row.phase,'PRODUCER_LEG','ONLY_WORKLOAD_SQL_DETAIL_REQUIRED');assert.ok(sourceStages.has(row.stage)&&sqlCategories.has(row.category)&&sqlVerbs.has(row.verb),'SQL_ENUMS_REQUIRED');assert.match(row.template??'',/^[a-f0-9]{64}$/,'SQL_TEMPLATE_HASH_REQUIRED');
  return {phase:safePhase(row.phase),stage:row.stage,category:row.category,verb:row.verb,template:row.template,...Object.fromEntries(['statements','envelopes','requestErrors','envelopeUpperBoundMsSum','maximumEnvelopeMs'].map(key=>[key,number(row[key],key)]))};
 });
 return {sqlDetailPhase:'PRODUCER_LEG',phases,sqlGroups,retainedSqlGroups:sqlGroups.length,totalSqlGroups:value.sqlGroups.length,overflowStatements:number(value.overflowStatements,'overflowStatements'),openRequests:number(value.openRequests,'openRequests'),timing:'HTTP envelope upper bounds include injected latency; SQL group durations overlap, not server SQL timings.'};
}
function safeProfile(report,expectedSha,{diagnostic=false}={}){
 assert.ok(['empty','dense'].includes(report.profile),'PROFILE_REQUIRED');
 if(diagnostic){assert.equal(report.diagnosticOnly,true);assert.equal(report.profile,'empty');assert.equal(report.input?.syntheticUsers,1);assert.ok(report.callsStarted<=1,'ONE_DIAGNOSTIC_CALL_REQUIRED');}else assert.notEqual(report.diagnosticOnly,true,'DIAGNOSTIC_CANNOT_QUALIFY');
 assert.equal(report.productionEvidence,false);assert.equal(report.releaseSha,expectedSha,'CANDIDATE_IDENTITY_CHANGED');
 const calls=number(report.callsStarted,'callsStarted');assert.ok(calls<=64,'CALL_LIMIT_EXCEEDED');
 assert.equal(report.preflight?.memoryMaxBytes,LIMITS.memoryBytes);assert.equal(report.preflight?.swapMaxBytes,0);
 assert.ok(Number.isSafeInteger(report.preflight?.cpuQuota)&&report.preflight.cpuQuota>0,'FINITE_CPU_QUOTA_REQUIRED');
 assert.ok(Number.isSafeInteger(report.preflight?.cpuPeriod)&&report.preflight.cpuPeriod>0,'FINITE_CPU_PERIOD_REQUIRED');
 assert.equal(report.preflight?.cpuQuota*2,report.preflight?.cpuPeriod,'HALF_CPU_PREFLIGHT_REQUIRED');
 assert.equal(report.node,'v22.23.3','PINNED_NODE_REQUIRED');assert.equal(report.architecture,'x64','AMD64_REQUIRED');
 const memory=report.resources?.cgroupMemoryEventDelta??{},http=report.http??{},final=report.final??{};
 const finalMemory=report.resources?.finalCgroup??{};
 if(report.status==='LOCAL_LIVE_HTTP_VERIFIED'){
  assert.equal(finalMemory.memoryMax,'536870912','FINAL_MEMORY_CGROUP_REQUIRED');assert.equal(finalMemory.swapMax,'0','FINAL_ZERO_SWAP_REQUIRED');
  const cpu=String(finalMemory.cpuMax??'').trim().split(/\s+/);assert.equal(cpu.length,2);assert.ok(cpu.every(v=>/^[1-9][0-9]*$/.test(v)));
  assert.equal(BigInt(cpu[0])*2n,BigInt(cpu[1]),'FINAL_HALF_CPU_REQUIRED');
  for(const field of ['oom','oom_kill'])number(memory[field],field);
  assert.ok(/^\d+$/.test(String(finalMemory.memoryPeak??'')),'ACTUAL_CGROUP_PEAK_REQUIRED');
 }
 const decimal=value=>/^\d+$/.test(String(value??''))?number(Number(value),'decimal'):null;
 return {profile:report.profile,status:['LOCAL_LIVE_HTTP_VERIFIED','LOCAL_LIVE_HTTP_PARTIAL','LOCAL_LIVE_HTTP_FAILED','INTERRUPTED_UNKNOWN_IN_FLIGHT','LOCAL_LIVE_HTTP_DIAGNOSTIC_ONLY'].includes(report.status)?report.status:'UNKNOWN',
  calls,elapsedMs:number(report.elapsedMs??0,'elapsedMs'),finishedUsers:report.finishedUsers?.length??0,blockedUsers:report.blockedUsers?.length??0,
  completedJobs:(final.jobs??[]).filter(row=>row.state==='COMPLETED'&&row.completed_generation===row.requested_generation).length,
  currentPublications:number(final.publications??0,'publications'),completionProofs:number(final.completionProofs??0,'completionProofs'),
  explicitEmptyVerified:report.explicitEmptyVerified===true,
  sourceRows:sourceCounts(report),
  resources:{memoryPeakBytes:decimal(finalMemory.memoryPeak),sampledNodeRssPeakBytes:decimal(report.resources?.sampledRssPeak),
   cpuUsageMicroseconds:report.resources?.cgroupCpuDelta?.usage_usec===undefined?null:number(report.resources.cgroupCpuDelta.usage_usec,'cpuUsageMicroseconds'),oom:number(memory.oom??0,'oom'),oomKills:number(memory.oom_kill??0,'oomKills')},
  http:{requests:number(http.requests??0,'httpRequests'),requestErrors:number(http.requestErrors??0,'requestErrors'),responseErrors:number(http.responseErrors??0,'responseErrors'),
   sqlStatements:http.sqlStatements===undefined?null:number(http.sqlStatements,'sqlStatements'),byPhase:phaseCounts(http.byPhase),
   unresolvedTransactions:number(http.openTransactions??0,'openTransactions'),transactionMaximumMs:number(http.transactionDurationUpperBounds?.maximumMs??0,'transactionMaximumMs')},
  failureCount:report.failures?.length??0,failures:sourceFailures(report),legs:safeLegs(report.legs),phaseDiagnostics:safePhaseDiagnostics(report.phaseDiagnostics)};
}
export function summarize({reports,expectedSha,exitCode}){
 candidateSha(expectedSha);assert.equal(reports.length,2,'TWO_PROFILES_REQUIRED');
 const profiles=reports.map(report=>safeProfile(report,expectedSha));assert.deepEqual(profiles.map(row=>row.profile),['empty','dense']);
 const totalCalls=profiles.reduce((sum,row)=>sum+row.calls,0);assert.ok(totalCalls<=64,'GLOBAL_CALL_LIMIT_EXCEEDED');
 const verified=exitCode===0&&profiles.every(row=>row.status==='LOCAL_LIVE_HTTP_VERIFIED'&&row.completedJobs===6&&row.currentPublications===3&&row.finishedUsers===3&&row.failureCount===0
  &&row.resources.oom===0&&row.resources.oomKills===0&&row.http.requestErrors===0&&row.http.responseErrors===0&&row.http.unresolvedTransactions===0)&&profiles[0].explicitEmptyVerified;
 return {contract:'stage8-isolated-linux-http-ci-v1',productionEvidence:false,candidateSha:expectedSha,
  status:verified?'ISOLATED_LINUX_LIVE_HTTP_VERIFIED':'ISOLATED_LINUX_LIVE_HTTP_PARTIAL',limits:LIMITS,totalCalls,profiles,
  scope:'Synthetic producer and typed self-reader only. Includes Node, sqld and shell in one enforced cgroup. Does not qualify Telegram/SYNC concurrency, real Turso limits, or Production operation.'};
}
export function summarizeDiagnostic({report,expectedSha}){
 candidateSha(expectedSha);const profile=safeProfile(report,expectedSha,{diagnostic:true});
 return {contract:'stage8-isolated-linux-http-diagnostic-v1',productionEvidence:false,candidateSha:expectedSha,status:'ISOLATED_LINUX_LIVE_HTTP_DIAGNOSTIC_ONLY',maximumCalls:1,totalCalls:profile.calls,limits:{...LIMITS,wallSeconds:600,maximumCalls:1},profiles:[profile],qualificationPassed:false,scope:'Single empty synthetic user and one genuine producer call; diagnostic only, never a capacity or Production qualification.'};
}
function readReport(path){regularFile(path);assert.ok(lstatSync(path).size<8*1024*1024,'BOUNDED_REPORT_REQUIRED');return JSON.parse(readFileSync(path,'utf8'));}
export function main(repository,expectedSha,mode='qualification'){
 assert.ok(modes.has(mode),'EXPLICIT_MODE_REQUIRED');
 candidateSha(expectedSha);assert.equal(process.platform,'linux','LINUX_CI_REQUIRED');assert.equal(process.arch,'x64','AMD64_CI_REQUIRED');
 assert.equal(process.env.GITHUB_REPOSITORY,OWNER_REPOSITORY,'OWNER_REPOSITORY_REQUIRED');assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
 assert.equal(process.env.GITHUB_REF,'refs/heads/main','REVIEWED_MAIN_WORKFLOW_REQUIRED');assert.match(process.env.GITHUB_RUN_ID??'',/^[0-9]+$/);assert.match(process.env.GITHUB_RUN_ATTEMPT??'',/^[0-9]+$/);
 const uid=process.getuid(),gid=process.getgid();assert.ok(uid>0&&gid>0,'NONROOT_RUNNER_REQUIRED');
 const source=realpathSync(repository);assert.ok(lstatSync(join(source,'.git')).isDirectory(),'AUTHENTIC_CHECKOUT_GIT_REQUIRED');
 assert.equal(run('git',['remote','get-url','origin'],{cwd:source,git:true,capture:true}).stdout.trim(),`https://github.com/${OWNER_REPOSITORY}`,'FIXED_ORIGIN_REQUIRED');
 assert.equal(run('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:source,git:true,capture:true}).stdout.trim(),expectedSha);
 assert.equal(run('git',['status','--porcelain','--untracked-files=normal'],{cwd:source,git:true,capture:true}).stdout.trim(),'','CLEAN_CANDIDATE_REQUIRED');
 const sandbox=mkdtempSync(join(process.env.RUNNER_TEMP??tmpdir(),'stage8-offline-')),checkout=join(sandbox,'candidate'),context=join(sandbox,'image'),output=join(sandbox,'qualification');
 privateDirectory(context);privateDirectory(output);
 const suffix=`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,name=`stage8-qualification-${suffix}`,image=`stage8-live-qualification:${suffix}`;
 let exitCode=2,result=null,primaryError=null,phase='CHECKOUT';
 try{
  run('git',['worktree','add','--detach',checkout,expectedSha],{cwd:source,git:true});
  const commonGit=realpathSync(resolve(checkout,run('git',['rev-parse','--git-common-dir'],{cwd:checkout,git:true,capture:true}).stdout.trim()));
  regularFile(join(checkout,'.git'));
  for(const path of ['package.json','package-lock.json','test/stage8-live-linux-http.sh','test/stage8-live-linux-http.mjs','test/stage8-live-linux-preflight.test.js'])regularFile(join(checkout,path));
  for(const file of ['package.json','package-lock.json'])copyFileSync(join(checkout,file),join(context,file));
  copyFileSync(join(sourceDirectory,'Dockerfile'),join(context,'Dockerfile'));
  phase='IMAGE_BUILD';
  const build=spawnSync('timeout',['--signal=TERM','--kill-after=10s','600s','docker','build','--pull','--platform','linux/amd64','--tag',image,
   '--build-arg',`QUALIFICATION_ROOT=${checkout}`,'--build-arg',`QUALIFICATION_UID=${uid}`,'--build-arg',`QUALIFICATION_GID=${gid}`,context],{stdio:'inherit'});
  assert.ifError(build.error);assert.equal(build.status,0,'PINNED_IMAGE_BUILD_REQUIRED');
  phase='QUALIFICATION';
  const qualification=spawnSync('timeout',['--signal=TERM','--kill-after=10s',`${mode==='diagnostic-empty-one'?600:LIMITS.wallSeconds}s`,'docker',...dockerArguments({name,image,checkout,commonGit,output,uid,gid,mode})],{stdio:'inherit'});
  assert.ifError(qualification.error);exitCode=qualification.status??2;
  phase='REPORT';
  result=mode==='diagnostic-empty-one'?summarizeDiagnostic({report:readReport(join(output,'empty','report.json')),expectedSha}):summarize({reports:['empty','dense'].map(profile=>readReport(join(output,profile,'report.json'))),expectedSha,exitCode});
 }catch(error){primaryError=tagFailure(error,phase);}finally{
  // A watchdog can kill the Docker client while its container still exists.
  // Remove that exact run name even after partial/failing qualification.
  try{
   const removed=spawnSync('timeout',['--signal=KILL','15s','docker','rm','-f',name],{stdio:'ignore'});
   const stillPresent=run('docker',['ps','-aq','--filter',`name=^/${name}$`],{capture:true});
   assert.equal(stillPresent.stdout.trim(),'','CONTAINER_CLEANUP_UNCONFIRMED');
   run('git',['worktree','remove','--force',checkout],{cwd:source,git:true,check:false});
   if(removed.error)throw removed.error;
  }catch(error){console.error('ISOLATED_QUALIFICATION_CONTROL_FAILURE '+JSON.stringify(controlFailure(error,'CLEANUP')));if(!primaryError)primaryError=tagFailure(error,'CLEANUP');}
 }
 if(primaryError)throw primaryError;
 try{
  assert.ok(result,'NO_QUALIFICATION_RESULT');console.log(JSON.stringify(result,null,2));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(result,null,2)+'\n```\n');
 }catch(error){throw tagFailure(error,'SUMMARY');}
 return result.status==='ISOLATED_LINUX_LIVE_HTTP_VERIFIED'?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{process.exitCode=main(process.argv[2],process.argv[3],process.argv[4]??'qualification');}catch(error){console.error('ISOLATED_LINUX_QUALIFICATION_UNVERIFIED '+JSON.stringify(error.qualificationDiagnostic??controlFailure(error,'PRECHECK')));process.exitCode=2;}
}
