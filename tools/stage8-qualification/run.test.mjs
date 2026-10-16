import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {candidateSha,dockerArguments,summarize,controlFailure,LIMITS} from './run.mjs';

const sha='a'.repeat(40);
const plan=()=>({name:'stage8-qualification-123-1',image:'stage8-live-qualification:123-1',checkout:'/runner/work/candidate',commonGit:'/runner/repository/.git',output:'/runner/private/output',uid:1001,gid:1001});
const profile=name=>({profile:name,productionEvidence:false,releaseSha:sha,callsStarted:7,status:'LOCAL_LIVE_HTTP_VERIFIED',node:'v22.23.3',architecture:'x64',elapsedMs:100,
 input:{expectedTotalRows:{sleep:name==='dense'?40:0,recovery:name==='dense'?40:0,cycle:name==='dense'?40:0,workout:name==='dense'?40:0}},
 seededRows:{whoop_sleeps:name==='dense'?40:0,whoop_recoveries:name==='dense'?40:0,whoop_cycles:name==='dense'?40:0,whoop_workouts:name==='dense'?40:0},
 preflight:{memoryMaxBytes:536870912,swapMaxBytes:0,cpuQuota:50000,cpuPeriod:100000},finishedUsers:['a','b','c'],blockedUsers:[],failures:[],explicitEmptyVerified:name==='empty',
 final:{jobs:Array.from({length:6},()=>({state:'COMPLETED',requested_generation:1,completed_generation:1})),publications:3,completionProofs:6},
 resources:{finalCgroup:{memoryMax:'536870912',swapMax:'0',cpuMax:'50000 100000',memoryPeak:'200000000'},cgroupMemoryEventDelta:{oom:0,oom_kill:0},cgroupCpuDelta:{usage_usec:1234},sampledRssPeak:150000000},
 http:{requests:1000,requestErrors:0,responseErrors:0,openTransactions:0,transactionDurationUpperBounds:{maximumMs:100}}});
test('input cannot supply a branch, repository or shell expression instead of the full commit',()=>{
 assert.equal(candidateSha(sha),sha);for(const value of ['main','owner/repo@'+sha,sha+'\n',sha.toUpperCase(),'$(secret)',undefined])assert.throws(()=>candidateSha(value));
});
test('strict sqld check accepts the exact pinned image output and rejects a different version or build',()=>{
 const dockerfile=readFileSync(new URL('./Dockerfile',import.meta.url),'utf8'),expression=/grep -Eq '([^']+)' \/tmp\/sqld-version/.exec(dockerfile)?.[1];
 assert.ok(expression);const check=value=>spawnSync('grep',['-Eq',expression],{input:value,encoding:'utf8'}).status;
 assert.equal(check('sqld sqld 0.24.33 (f8fb14f3 2026-08-11)\n'),0);
 for(const value of ['sqld 0.24.33 (f8fb14f3 2026-08-11)\n','sqld sqld 0.24.32 (f8fb14f3 2026-08-11)\n','sqld sqld 0.24.33 (00000000 2026-08-11)\n','sqld sqld 0.24.33 (f8fb14f3 2026-08-12)\n','prefix sqld sqld 0.24.33 (f8fb14f3 2026-08-11)\n'])assert.equal(check(value),1);
 assert.match(dockerfile,/QUALIFICATION_NODE_VERSION=/);assert.match(dockerfile,/QUALIFICATION_SQLD_VERSION=/);assert.match(dockerfile,/test "\$\(cat \/tmp\/node-version\)" = v22[.]23[.]3/);
});
test('summary retains bounded failure hashes and numeric aggregate densities without messages or user IDs',()=>{
 const reports=[profile('empty'),profile('dense')];reports[1].status='LOCAL_LIVE_HTTP_PARTIAL';
 reports[1].failures=Array.from({length:18},()=>({stage:'LEG:a',code:'HTTP_ABORTED',messageSha256:'b'.repeat(64),message:'PRIVATE_HEALTH_RECORD',userId:'PRIVATE_USER'}));
 const result=summarize({reports,expectedSha:sha,exitCode:2}),row=result.profiles[1];
 assert.deepEqual(row.sourceRows,{expected:{sleep:40,recovery:40,cycle:40,workout:40},actual:{sleep:40,recovery:40,cycle:40,workout:40}});
 assert.equal(row.failures.length,16);assert.equal(row.failureCount,18);assert.deepEqual(row.failures[0],{stage:'LEG:a',code:'HTTP_ABORTED',messageSha256:'b'.repeat(64)});
 assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
 for(const change of [r=>r[0].seededRows.whoop_sleeps=1,r=>delete r[1].input,r=>r[0].resources.cgroupCpuDelta.usage_usec='PRIVATE_HEALTH_RECORD',r=>r[1].resources.cgroupCpuDelta.usage_usec=Infinity]){
  const copy=[profile('empty'),profile('dense')];change(copy);assert.throws(()=>summarize({reports:copy,expectedSha:sha,exitCode:0}));
 }
});
test('wrapper failure diagnostics emit only a trusted phase, bounded code and SHA256',()=>{
 const error=new Error('private health record and token must never be printed');error.code='EIO';
 const value=controlFailure(error,'IMAGE_BUILD');assert.equal(value.phase,'IMAGE_BUILD');assert.equal(value.code,'EIO');assert.match(value.messageSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(Object.keys(value).sort(),['code','messageSha256','phase']);assert.ok(!JSON.stringify(value).includes('private'));
 assert.equal(controlFailure(error,'private phase').phase,'UNKNOWN');error.code='private token';assert.equal(controlFailure(error,'REPORT').code,'ERROR');
 assert.equal(controlFailure(new Error('PINNED_IMAGE_BUILD_REQUIRED'),'IMAGE_BUILD').code,'PINNED_IMAGE_BUILD_REQUIRED');
});
test('resource and network isolation include sqld and the application in one container',()=>{
 const argv=dockerArguments(plan());
 const option=name=>argv[argv.indexOf(name)+1];
 assert.equal(option('--network'),'none');assert.equal(option('--memory'),'536870912');assert.equal(option('--memory-swap'),'536870912');assert.equal(option('--cpus'),'0.5');
 assert.equal(option('--pids-limit'),'128');assert.ok(argv.includes('--read-only'));assert.equal(option('--cap-drop'),'ALL');assert.equal(option('--security-opt'),'no-new-privileges');
 assert.equal(option('--platform'),'linux/amd64');assert.equal(option('--user'),'1001:1001');
 const mounts=argv.filter((_value,i)=>argv[i-1]==='--mount');assert.equal(mounts.length,7);
 assert.ok(mounts.slice(0,6).every(value=>value.endsWith(',readonly')));assert.equal(mounts.at(-1),'type=bind,src=/runner/private/output,dst=/qualification');
 assert.ok(!argv.some(value=>/docker[.]sock|--privileged|--env-file|TURSO_|GITHUB_TOKEN|PHASE4_RELEASE_SHA/.test(value)));
 assert.match(argv.at(-1),/exec \/bin\/sh test\/stage8-live-linux-http[.]sh$/);assert.equal(LIMITS.wallSeconds,1920);assert.equal(LIMITS.maximumCalls,64);
});
test('reject mount argument injection, source remapping and root user before Docker',()=>{
 for(const field of ['checkout','commonGit','output'])for(const value of ['relative','/path,readonly=false','/path\nother','/path:other'])assert.throws(()=>dockerArguments({...plan(),[field]:value}));
 assert.throws(()=>dockerArguments({...plan(),uid:0}));assert.throws(()=>dockerArguments({...plan(),name:'other-container'}));
});
test('genuine completed reports qualify only with exact current resources and identities',()=>{
 const reports=[profile('empty'),profile('dense')],result=summarize({reports,expectedSha:sha,exitCode:0});
 assert.equal(result.status,'ISOLATED_LINUX_LIVE_HTTP_VERIFIED');assert.equal(result.totalCalls,14);assert.equal(result.productionEvidence,false);
 assert.ok(!JSON.stringify(result).includes('requested_generation'));assert.match(result.scope,/Does not qualify Telegram\/SYNC/);
 for(const change of [r=>r[0].releaseSha='b'.repeat(40),r=>r[1].preflight.memoryMaxBytes=1073741824,r=>r[0].resources.finalCgroup.cpuMax='max 100000',
  r=>delete r[0].resources.finalCgroup.memoryPeak,r=>delete r[0].resources.cgroupMemoryEventDelta.oom,r=>r[1].callsStarted=64]){
  const copy=structuredClone(reports);change(copy);assert.throws(()=>summarize({reports:copy,expectedSha:sha,exitCode:0}));
 }
});
test('timeouts, incomplete business work and OOM remain PARTIAL despite a success-looking label',()=>{
 for(const [change,exitCode] of [[()=>{},124],[r=>r[0].final.jobs[0].state='PENDING',0],[r=>r[1].resources.cgroupMemoryEventDelta.oom_kill=1,0],
  [r=>r[0].explicitEmptyVerified=false,0],[r=>r[1].final.publications=2,0],[r=>r[1].http.responseErrors=1,0],[r=>r[1].http.openTransactions=1,0]]){
  const reports=[profile('empty'),profile('dense')];change(reports);assert.equal(summarize({reports,expectedSha:sha,exitCode}).status,'ISOLATED_LINUX_LIVE_HTTP_PARTIAL');
 }
});
test('workflow is manual-only, main-scoped, read-only and does not reference Production secrets or artifacts',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/stage8-live-linux-qualification.yml',import.meta.url),'utf8');
 assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/github.ref == 'refs\/heads\/main'/);assert.match(workflow,/contents: read/);assert.match(workflow,/runs-on: ubuntu-24[.]04/);
 assert.ok(!/schedule:|pull_request:|push:|secrets[.]|environment:|id-token:|upload-artifact|cache:/.test(workflow));
 assert.equal((workflow.match(/persist-credentials: false/g)??[]).length,2);assert.ok(!workflow.includes('briefing.yml'));
 const dockerfile=readFileSync(new URL('./Dockerfile',import.meta.url),'utf8');
 assert.equal((dockerfile.match(/^FROM [^\n]+@sha256:[a-f0-9]{64}/gm)??[]).length,2);assert.match(dockerfile,/npm ci --ignore-scripts --no-audit --no-fund/);
 assert.ok(!/COPY [.]|git init|git hash-object|qualification-commit/.test(dockerfile));
});

test('diagnostic dispatch stays exact single empty-user call under the same isolation and never enters qualification summary',async()=>{
 const {summarizeDiagnostic}=await import('./run.mjs'),argv=dockerArguments({...plan(),mode:'diagnostic-empty-one'});
 assert.match(argv.at(-1),/stage8-live-linux-http[.]sh diagnostic-empty-one$/);assert.throws(()=>dockerArguments({...plan(),mode:'unbounded'}),/EXPLICIT_MODE/);
 const r=profile('empty');r.diagnosticOnly=true;r.callsStarted=1;r.input.syntheticUsers=1;r.status='LOCAL_LIVE_HTTP_DIAGNOSTIC_ONLY';r.finishedUsers=[];r.blockedUsers=['a'];r.explicitEmptyVerified=false;
 r.http.byPhase={MIGRATION:9000,PRODUCER_LEG:377};r.http.sqlStatements=10000;
 const counts={jobs:2,completedJobs:0,runningJobs:1,pendingJobs:1,jobsWithCursor:1,fullScopes:2,currentComputations:0,completionProofs:0,publications:0,workReceipts:4,operationReceipts:1,executions:1,ESTABLISHED:1,WORK_COMMITTED:0,FINALIZED_SUCCESS:0,FINALIZED_FAILURE:0};
 r.legs=[{call:1,elapsedMs:45725,failedPhase:'PRODUCER_LEG',error:{code:'SYNC_TIMEOUT',message:'PRIVATE_HEALTH'},beforeCounts:{...counts,workReceipts:0,ESTABLISHED:0},afterCounts:counts,businessProgress:true,userId:'PRIVATE_USER',requestId:'PRIVATE_REQUEST'}];
 r.phaseDiagnostics={contract:'stage8-safe-http-phase-diagnostics-v1',sqlDetailPhase:'PRODUCER_LEG',phases:[{phase:'PRODUCER_LEG',elapsedMs:45725,requests:377,attemptedStatements:725,requestErrors:2,httpEnvelopeMs:45000}],sqlGroups:[{phase:'PRODUCER_LEG',stage:'WORKER_DRAIN',category:'PRINCIPAL_READY_METADATA',verb:'SELECT',template:'c'.repeat(64),statements:296,envelopes:296,requestErrors:2,envelopeUpperBoundMsSum:35000,maximumEnvelopeMs:120,sql:'PRIVATE_SQL',args:['PRIVATE_ARGS']}],overflowStatements:0,openRequests:0,lastRequest:{sql:'PRIVATE_SQL'}};
 const result=summarizeDiagnostic({report:r,expectedSha:sha});assert.equal(result.qualificationPassed,false);assert.equal(result.totalCalls,1);assert.equal(result.maximumCalls,1);assert.equal(result.limits.wallSeconds,600);
 const summary=result.profiles[0];assert.deepEqual(summary.http.byPhase,{MIGRATION:9000,PRODUCER_LEG:377});assert.equal(summary.http.sqlStatements,10000);assert.equal(summary.legs[0].after.workReceipts,4);assert.equal(summary.legs[0].after.ESTABLISHED,1);assert.equal(summary.legs[0].error,'SYNC_TIMEOUT');assert.equal(summary.phaseDiagnostics.sqlDetailPhase,'PRODUCER_LEG');assert.equal(summary.phaseDiagnostics.sqlGroups[0].statements,296);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
 assert.throws(()=>summarize({reports:[r,profile('dense')],expectedSha:sha,exitCode:0}),/DIAGNOSTIC_CANNOT_QUALIFY/);
 for(const change of [v=>v.callsStarted=2,v=>v.input.syntheticUsers=3,v=>v.profile='dense',v=>v.http.byPhase.PRIVATE_HEALTH=1,v=>v.legs[0].afterCounts.workReceipts='PRIVATE_HEALTH',v=>v.phaseDiagnostics.sqlGroups[0].template='PRIVATE_HEALTH',v=>v.phaseDiagnostics.sqlGroups[0].phase='MIGRATION',v=>v.phaseDiagnostics.sqlDetailPhase='SEED']){
  const changed=structuredClone(r);change(changed);assert.throws(()=>summarizeDiagnostic({report:changed,expectedSha:sha}));
 }
});
test('manual workflow mode is an explicit bounded choice passed through environment; no new provider or scheduling authority',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/stage8-live-linux-qualification.yml',import.meta.url),'utf8');
 assert.match(workflow,/type: choice[\s\S]*?- qualification[\s\S]*?- diagnostic-empty-one/);assert.match(workflow,/QUALIFICATION_MODE: \$\{\{ inputs.mode \}\}/);assert.match(workflow,/"\$CANDIDATE_SHA" "\$QUALIFICATION_MODE"/);
 assert.ok(!/schedule:|pull_request:|push:|secrets[.]|environment:|id-token:|upload-artifact|cache:/.test(workflow));
});
