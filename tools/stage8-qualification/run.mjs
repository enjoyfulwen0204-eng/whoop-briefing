// Trusted CI orchestration only. Candidate code runs only inside the offline,
// resource-limited container. This module has no import-time side effects.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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
export function dockerArguments({name,image,checkout,commonGit,output,uid,gid}){
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
  'test "$(node --version)" = v22.23.3 && exec /bin/sh test/stage8-live-linux-http.sh');
 return args;
}
const number=(value,label)=>{assert.ok(Number.isSafeInteger(value)&&value>=0,`INVALID_METRIC:${label}`);return value;};
function safeProfile(report,expectedSha){
 assert.ok(['empty','dense'].includes(report.profile),'PROFILE_REQUIRED');
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
 const decimal=value=>/^\d+$/.test(String(value??''))?Number(value):null;
 return {profile:report.profile,status:['LOCAL_LIVE_HTTP_VERIFIED','LOCAL_LIVE_HTTP_PARTIAL','LOCAL_LIVE_HTTP_FAILED','INTERRUPTED_UNKNOWN_IN_FLIGHT'].includes(report.status)?report.status:'UNKNOWN',
  calls,elapsedMs:number(report.elapsedMs??0,'elapsedMs'),finishedUsers:report.finishedUsers?.length??0,blockedUsers:report.blockedUsers?.length??0,
  completedJobs:(final.jobs??[]).filter(row=>row.state==='COMPLETED'&&row.completed_generation===row.requested_generation).length,
  currentPublications:number(final.publications??0,'publications'),completionProofs:number(final.completionProofs??0,'completionProofs'),
  explicitEmptyVerified:report.explicitEmptyVerified===true,
  resources:{memoryPeakBytes:decimal(finalMemory.memoryPeak),sampledNodeRssPeakBytes:decimal(report.resources?.sampledRssPeak),
   cpuUsageMicroseconds:report.resources?.cgroupCpuDelta?.usage_usec??null,oom:number(memory.oom??0,'oom'),oomKills:number(memory.oom_kill??0,'oomKills')},
  http:{requests:number(http.requests??0,'httpRequests'),requestErrors:number(http.requestErrors??0,'requestErrors'),responseErrors:number(http.responseErrors??0,'responseErrors'),
   unresolvedTransactions:number(http.openTransactions??0,'openTransactions'),transactionMaximumMs:number(http.transactionDurationUpperBounds?.maximumMs??0,'transactionMaximumMs')},
  failureCount:report.failures?.length??0};
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
function readReport(path){regularFile(path);assert.ok(lstatSync(path).size<8*1024*1024,'BOUNDED_REPORT_REQUIRED');return JSON.parse(readFileSync(path,'utf8'));}
export function main(repository,expectedSha){
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
 let exitCode=2,result=null;
 try{
  run('git',['worktree','add','--detach',checkout,expectedSha],{cwd:source,git:true});
  const commonGit=realpathSync(resolve(checkout,run('git',['rev-parse','--git-common-dir'],{cwd:checkout,git:true,capture:true}).stdout.trim()));
  regularFile(join(checkout,'.git'));
  for(const path of ['package.json','package-lock.json','test/stage8-live-linux-http.sh','test/stage8-live-linux-http.mjs','test/stage8-live-linux-preflight.test.js'])regularFile(join(checkout,path));
  for(const file of ['package.json','package-lock.json'])copyFileSync(join(checkout,file),join(context,file));
  copyFileSync(join(sourceDirectory,'Dockerfile'),join(context,'Dockerfile'));
  const build=spawnSync('timeout',['--signal=TERM','--kill-after=10s','600s','docker','build','--pull','--platform','linux/amd64','--tag',image,
   '--build-arg',`QUALIFICATION_ROOT=${checkout}`,'--build-arg',`QUALIFICATION_UID=${uid}`,'--build-arg',`QUALIFICATION_GID=${gid}`,context],{stdio:'inherit'});
  assert.ifError(build.error);assert.equal(build.status,0,'PINNED_IMAGE_BUILD_REQUIRED');
  const qualification=spawnSync('timeout',['--signal=TERM','--kill-after=10s',`${LIMITS.wallSeconds}s`,'docker',...dockerArguments({name,image,checkout,commonGit,output,uid,gid})],{stdio:'inherit'});
  assert.ifError(qualification.error);exitCode=qualification.status??2;
  result=summarize({reports:['empty','dense'].map(profile=>readReport(join(output,profile,'report.json'))),expectedSha,exitCode});
 }finally{
  // A watchdog can kill the Docker client while its container still exists.
  // Remove that exact run name even after partial/failing qualification.
  const removed=spawnSync('timeout',['--signal=KILL','15s','docker','rm','-f',name],{stdio:'ignore'});
  const stillPresent=run('docker',['ps','-aq','--filter',`name=^/${name}$`],{capture:true});
  assert.equal(stillPresent.stdout.trim(),'','CONTAINER_CLEANUP_UNCONFIRMED');
  run('git',['worktree','remove','--force',checkout],{cwd:source,git:true,check:false});
  if(removed.error)throw removed.error;
 }
 assert.ok(result,'NO_QUALIFICATION_RESULT');console.log(JSON.stringify(result,null,2));
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(result,null,2)+'\n```\n');
 return result.status==='ISOLATED_LINUX_LIVE_HTTP_VERIFIED'?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{process.exitCode=main(process.argv[2],process.argv[3]);}catch(error){console.error(`ISOLATED_LINUX_QUALIFICATION_UNVERIFIED: ${error.code??error.name}`);process.exitCode=2;}
}
