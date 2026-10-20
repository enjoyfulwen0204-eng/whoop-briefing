/** SOURCE PROPOSAL ONLY. Explicit Linux container entry; no actual run authorized.
 * Materialize beside the existing tests only after independent review. All native
 * work requires future Root activation+host proofs mounted read-only. No fallback.
 */
import assert from 'node:assert/strict';
import {readFileSync,readSync,openSync,closeSync,fsyncSync,writeSync,lstatSync,realpathSync,readdirSync,existsSync}from 'node:fs';
import {createHash}from 'node:crypto';import {resolve,dirname,join}from 'node:path';import {fileURLToPath}from 'node:url';
import {createDb}from '../src/db.js';import {createPhase4Keys}from '../src/phase4Keys.js';
import {createPhase4Foundation}from '../src/phase4Foundation.js';import {createStage8LiveProducer}from '../src/stage8LiveProducer.js';
import {runningReleaseSha}from '../src/phase4Release.js';import {canonicalJson}from '../src/phase4EntityStore.js';
import {verifyLiveExecutionResult}from '../src/stage8LiveExecution.js';
import {createExecutionBudget,withExecutionBudget}from '../src/executionBudget.js';
import {seedBodyInput}from './bodyEnergyFixture.js';import {offlineLiveFixtureInput,OFFLINE_LIVE_RESOURCES,OFFLINE_LIVE_TABLES}from './stage8LiveLinuxFixture.js';
import {assertNativeResources,NATIVE_NODE}from './stage6-linux-native-contract.mjs';
import {createDiagnosticFetch}from './stage6-cold-three-observer.proposal.mjs';
import {PipelineRespBody}from '../node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js';
import {APPLICATION_BASELINE,PROFILE,KINDS,runLeg,safeFailureCode}from './stage6-cold-progress-contract.proposal.mjs';
const phase=process.argv[2];assert.ok(['A','B'].includes(phase)&&process.argv.length===3,'EXPLICIT_NATIVE_COLD_LEG');
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url))),OUT='/qualification',USER='a';
const digest=raw=>createHash('sha256').update(raw).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const REQUESTS=Object.freeze(['native-cold-progress-original-1','native-cold-progress-original-2','native-cold-progress-original-3']);
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,NATIVE_NODE);assert.ok(existsSync('/.dockerenv'));
assert.equal(realpathSync(process.cwd()),ROOT);assert.equal(realpathSync(OUT),OUT);
for(const name of Object.keys(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!process.env[name],'NO_EXTERNAL_ENVIRONMENT');
function privateRead(path,limit=4*1048576){const st=lstatSync(path);assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&63)===0&&st.size<=limit);assert.equal(realpathSync(path),path);return readFileSync(path);}
function once(path,value){const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');guard();const fd=openSync(path,'wx',0o600);try{guard();writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}return digest(bytes);}
const activationRaw=privateRead('/native-cold-source-activation.json'),activation=JSON.parse(activationRaw),activationHash=digest(activationRaw);
assert.equal(activation.contract,'root-technical-native-cold-progress-source-activation-v1');assert.equal(activation.sourceGO,true);assert.equal(activation.independentReviewAcceptedByRoot,true);
assert.ok(hex(activation.independentSourceReviewSha256));assert.equal(activation.applicationBaselineSha,APPLICATION_BASELINE);
assert.equal(activation.maximumOriginalCalls,3);assert.equal(activation.processLegs,2);assert.equal(activation.maximumWallMs,PROFILE.proposedOuterMs);
assert.equal(activation.maintenanceAuthorized,false);assert.equal(activation.productionActionsAuthorized,false);assert.equal(activation.newOwnerMaintenanceApprovalClaimed,false);
assert.deepEqual(activation.requestIds,REQUESTS);assert.equal(activation.maximumAttempts,1);assert.equal(activation.syntheticOnly,true);
const host=JSON.parse(privateRead('/native-host-proof.json'));assert.equal(host.contract,'stage6-native-host-observation-v1');assert.equal(host.diagnosticContract,'three-original-calls-two-os-300s-v1');
const candidateSha=runningReleaseSha({});assert.equal(host.candidateSha,candidateSha);assert.equal(activation.candidateSha,candidateSha);
const baselineRaw=privateRead('/ca01-application-source-manifest.json'),baseline=JSON.parse(baselineRaw);assert.equal(digest(baselineRaw),activation.applicationSourceManifestSha256);
assert.equal(baseline.applicationBaselineSha,APPLICATION_BASELINE);assert.equal(Object.keys(baseline.files).length,360);assert.equal(Object.keys(baseline.reusedHarnessFiles).length,7);
for(const [name,pin]of Object.entries({...baseline.files,...baseline.reusedHarnessFiles})){assert.ok(/^(?:src|test|tools)\/[A-Za-z0-9_./-]+$/.test(name)||['package.json','package-lock.json'].includes(name));assert.ok(!name.split('/').includes('..'));assert.equal(digest(readFileSync(join(ROOT,name))),pin,'CA01_APPLICATION_BYTES_REQUIRED');}
for(const [name,pin]of Object.entries(activation.proposalSourcePins)){assert.ok(name.startsWith('test/')&&!name.split('/').includes('..'));assert.ok(hex(pin));assert.equal(digest(readFileSync(join(ROOT,name))),pin);}
for(const name of ['test/stage6-native-cold-progress.mjs','test/stage6-cold-progress-contract.proposal.mjs','test/stage6-native-cold-progress.sh','test/stage6-cold-three-attribution.proposal.mjs','test/stage6-cold-three-observer.proposal.mjs'])assert.ok(hex(activation.proposalSourcePins[name]));
const startNs=BigInt(host.nativeStartedMonotonicNs),now=()=>Number(process.hrtime.bigint())/1e6,started=Number(startNs)/1e6,deadlineMs=started+PROFILE.proposedOuterMs;
function guard(){assert.ok(now()>=started&&now()<deadlineMs,'ORIGINAL_GLOBAL_300S_DEADLINE');}
guard();const abort=new AbortController(),wallTimer=setTimeout(()=>abort.abort(Error('GLOBAL_DEADLINE')),Math.max(1,deadlineMs-now()));
const text=path=>readFileSync(path,'utf8').trim();
const resources=()=>({node:process.version,platform:process.platform,architecture:process.arch,nativeHost:host,memoryMax:text('/sys/fs/cgroup/memory.max'),swapMax:text('/sys/fs/cgroup/memory.swap.max'),cpuMax:text('/sys/fs/cgroup/cpu.max'),interfaces:readdirSync('/sys/class/net').sort(),memoryPeak:text('/sys/fs/cgroup/memory.peak'),memoryEvents:text('/sys/fs/cgroup/memory.events')});
assertNativeResources(resources());const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});
const serverPid=Number(text(OUT+'/owned-server-pid.private.txt'));assert.ok(Number.isSafeInteger(serverPid)&&serverPid>0);process.kill(serverPid,0);
function physicalIdentity(){
 const physical=OUT+'/physical',dir=lstatSync(physical);assert.ok(dir.isDirectory()&&!dir.isSymbolicLink());const identities=[];let visited=0;
 function scan(path,depth){assert.ok(depth<=4);for(const name of readdirSync(path).sort()){assert.ok(++visited<=64);const target=join(path,name),st=lstatSync(target);assert.ok(!st.isSymbolicLink());if(st.isDirectory())scan(target,depth+1);else if(st.isFile()&&st.size>=16){const fd=openSync(target,'r'),header=Buffer.alloc(16);try{readSync(fd,header,0,16,0);}finally{closeSync(fd);}if(header.equals(Buffer.from('SQLite format 3\0')))identities.push(keys.lookup(['native-cold-sqlite-file-v1',target.slice(physical.length),st.dev,st.ino]));}}}
 scan(physical,0);assert.ok(identities.length>0,'ACTUAL_PERSISTENT_SQLITE_MAIN_FILE_REQUIRED');
 return keys.lookup(['native-cold-physical-owner-v1',dir.dev,dir.ino,serverPid,identities.sort()]);
}
const observedLog=createHash('sha256');let logBytes=0;const originalPrint=console.log.bind(console);
for(const name of ['log','info','warn','error'])console[name]=(...v)=>{let b;try{b=Buffer.from(JSON.stringify(v));}catch{b=Buffer.from('[UNSERIALIZABLE_APPLICATION_LOG]');}observedLog.update(b);logBytes+=b.length;};
let db,latency=false,callCount=phase==='A'?0:2,producer;const networkFetch=globalThis.fetch.bind(globalThis);
const transport=createDiagnosticFetch({fetch:(input,init)=>{guard();const r=new Request(input,init),url=new URL(r.url);assert.equal(url.origin,'http://127.0.0.1:18080');assert.ok(!url.username&&!url.password);return networkFetch(r,{signal:AbortSignal.any([r.signal,abort.signal,AbortSignal.timeout(Math.max(1,deadlineMs-now()))])});},decodePipelineReply:PipelineRespBody,latencyEnabled:()=>latency});
globalThis.fetch=(input,init)=>transport.fetch(input,init);
async function bounded(ms,work){guard();const b=createExecutionBudget({budgetMs:Math.max(1,Math.min(ms,Math.floor(deadlineMs-now()))),signal:abort.signal,localAuthority:guard});try{return await withExecutionBudget(b,async()=>{const v=await work();b.assert();guard();return v;});}finally{b.cancel();b.close();}}
const executionId=id=>keys.lookup(['stage8-live-request-v1',USER,id]);
async function executionRows(){
 const rows=(await db.raw.execute("SELECT * FROM stage8_live_executions ORDER BY execution_id")).rows;assert.equal(rows.length,callCount);
 const byId=new Map();for(const row of rows){assert.ok(REQUESTS.slice(0,callCount).some(id=>executionId(id)===row.execution_id));assert.equal(row.generation,1);assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.release_sha,candidateSha);assert.equal(row.phase,'STAGE6_DRAIN');assert.equal(row.execution_mode,'LIVE');assert.equal(row.trigger_source,'manual');
  const result=verifyLiveExecutionResult(keys,row);assert.equal(result.outcome,'PARTIAL');assert.ok(row.finalized_at<=row.deadline_at);byId.set(row.execution_id,row);}
 return byId;
}
async function capture(){transport.observer.setPhase('READBACK','READBACK',callCount);return bounded(PROFILE.readbackMs,async()=>{
 const count=async table=>Number((await db.raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);
 const sourceTables=[...Object.values(OFFLINE_LIVE_TABLES),'journal_events','journal_coverage_windows','experiment_field_groups'];
 const sourceRows=(await Promise.all(sourceTables.map(count))).reduce((a,b)=>a+b,0);
 const facts={candidateSha,applicationBaselineSha:APPLICATION_BASELINE,schema:35,sourceRows,outboundMessages:await count('outbound_messages'),pilotLedgers:Number((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE scope='global' AND component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n),currentPublications:await count('stage8_live_publications')};
 const computation=(await db.raw.execute("SELECT input_generation,last_completed_generation,algorithm_set_version FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 const jobs=(await db.raw.execute("SELECT job_kind,state,requested_generation,completed_generation,scope_revision,full_scan_cursor,updated_at,attempt,lease_owner,last_error_code FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
 const receipts=(await db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY receipt_key')).rows;assert.ok(receipts.length<=256);
 if(computation.length===0){assert.equal(callCount,0);assert.equal(jobs.length,0);assert.equal(receipts.length,0);return {...facts,initialized:false,inputGeneration:null,lastCompletedGeneration:0,jobs:[],receipts:[]};}
 assert.equal(computation.length,1);const c=computation[0],meta=(await db.raw.execute("SELECT p.source_generation,p.purge_generation,u.lifecycle_generation,u.timezone,COALESCE(t.auth_generation,0) auth_generation FROM users u JOIN phase4_user_state p ON p.user_id=u.id LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id='a'")).rows[0];
 const scopeHash=keys.lookup(['stage8-live-execution-scope-v1',USER,c.input_generation,meta.source_generation,meta.lifecycle_generation,meta.auth_generation,meta.purge_generation,c.algorithm_set_version,meta.timezone]);
 const execs=await executionRows();for(const e of execs.values())assert.equal(JSON.parse(e.canonical_request_json).tenantScope,scopeHash,'SAME_AUTHENTICATED_SCOPE');const receiptPins=receipts.map(r=>{const e=execs.get(r.execution_id);assert.ok(e);assert.equal(r.request_digest,e.identity_digest);assert.equal(r.scope_key,e.scope_key);assert.equal(r.generation,1);assert.equal(r.step_key,r.receipt_key);assert.ok(r.committed_at>=e.created_at&&r.committed_at<=e.finalized_at&&r.committed_at<=e.deadline_at);return {keyHash:keys.lookup(['native-cold-work-key-v1',r.receipt_key]),rowHash:keys.lookup(['native-cold-work-row-v1',canonicalJson(r)])};});
 const producerRows=(await db.raw.execute("SELECT * FROM stage8_live_execution_producers WHERE execution_mode='LIVE' ORDER BY producing_execution_id")).rows;assert.equal(producerRows.length,callCount);for(const pr of producerRows){const e=execs.get(pr.producing_execution_id);assert.ok(e);assert.equal(pr.user_id,USER);assert.equal(pr.input_generation,c.input_generation);assert.equal(pr.producing_generation,1);assert.equal(pr.execution_seq,e.execution_seq);assert.equal(pr.tenant_proof,keys.lookup(['execution-producer-v1',USER,'LIVE',c.input_generation,e.execution_id,e.execution_seq,1]));}
 return {...facts,initialized:true,inputGeneration:c.input_generation,lastCompletedGeneration:c.last_completed_generation,tenantScopeHash:scopeHash,
 producerPins:producerRows.map(pr=>({keyHash:keys.lookup(['native-cold-producer-key-v1',pr.producing_execution_id]),rowHash:keys.lookup(['native-cold-producer-row-v1',canonicalJson(pr)])})).sort((a,b)=>a.keyHash.localeCompare(b.keyHash)),
 jobs:jobs.map(j=>{if(j.full_scan_cursor!==null)assert.deepEqual(JSON.parse(j.full_scan_cursor),['USER',USER],'ONLY_GENUINE_EMPTY_USER_CURSOR');return {kind:j.job_kind,state:j.state,requestedGeneration:j.requested_generation,completedGeneration:j.completed_generation,scopeRevision:j.scope_revision,updatedAt:Date.parse(j.updated_at),attempt:j.attempt,leaseOwner:j.lease_owner,lastError:j.last_error_code,cursorRank:j.full_scan_cursor===null?0:1,cursorHash:j.full_scan_cursor===null?null:keys.lookup(['native-cold-empty-cursor-v1',j.full_scan_cursor])};}),receipts:receiptPins,
 executionPins:[...execs.values()].map(e=>({keyHash:keys.lookup(['native-cold-execution-key-v1',e.execution_id]),rowHash:keys.lookup(['native-cold-execution-row-v1',canonicalJson(e)])})).sort((a,b)=>a.keyHash.localeCompare(b.keyHash))};
});}
let report={contract:'stage6-three-call-two-os-cold-progress-proposal-v1',productionEvidence:false,capacityQualified:false,wholeJobCompletionQualified:false,actualNativeQualified:false,status:'UNQUALIFIED',candidateSha,applicationBaselineSha:APPLICATION_BASELINE,phase,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN'};
try{
 const startRecord=OUT+'/native-cold-original-operation.private.json';
 if(phase==='A')once(startRecord,{contract:'one-three-call-two-os-native-cold-operation-v1',activationHash,candidateSha,applicationBaselineSha:APPLICATION_BASELINE,startedMonotonicNs:String(startNs),deadlineMs,requestIdentityHashes:REQUESTS.map(id=>keys.lookup(['native-cold-request-v1',id])),maximumCalls:3,maximumAttempts:1});
 else{const start=JSON.parse(privateRead(startRecord));assert.equal(start.activationHash,activationHash);assert.equal(start.candidateSha,candidateSha);assert.equal(start.deadlineMs,deadlineMs);}
 db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:transport.fetch});assert.equal(db.raw.protocol,'http');
 if(phase==='A'){transport.observer.setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE',0);await bounded(70000,async()=>{
  assert.equal(Number((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n),0,'FRESH_DB_ONLY');
  await db.migrate({targetVersion:35});transport.observer.setPhase('SETUP_EMPTY_FIXTURE','SEED_EMPTY_FIXTURE',0);const stores=await createPhase4Foundation({db,keys}),asOf=Date.now()-1000;
  await db.createUser({id:USER,displayName:'Synthetic empty cold proof',timezone:'Asia/Taipei',status:'ACTIVE'});await stores.initializeTenant(USER,'SHADOW');
  await db.transaction(()=>seedBodyInput(db,offlineLiveFixtureInput({profile:'empty',userId:USER,asOf})));await db.ensureOnboarding(USER,{state:'READY'});await db.linkTelegram({userId:USER,chatId:'10001'});await db.setLocale(USER,'en');
  for(const resource of OFFLINE_LIVE_RESOURCES)await db.saveSyncState(USER,resource,{backfillComplete:true,lastSuccessAt:new Date(asOf).toISOString()});await stores.preferences.read(await stores.captureControl(USER));
 });}
 transport.observer.setPhase('ADMISSION_AND_COMPOSITION','BUILD_LIVE_PRODUCER',callCount);latency=true;const admission=await bounded(10000,()=>db.admitRuntime({fresh:true}));producer=await bounded(10000,()=>createStage8LiveProducer({db,keys,admission,userIds:[USER],enabled:()=>true,eligible:id=>id===USER,environment:{}}));
 let carry=null;
 if(phase==='B'){const prior=JSON.parse(privateRead(OUT+'/A-result.private.json'));assert.equal(prior.activationHash,activationHash);assert.equal(prior.physicalIdentityHash,physicalIdentity());assert.equal(prior.serverPid,serverPid);assert.notEqual(prior.pid,process.pid);assert.equal(prior.canonicalBoundaryDigest,digest(canonicalJson(prior.carry.afterA)));carry=prior.carry;}
 const runOriginal=async(requestId,ordinal)=>{
  assert.equal(ordinal,callCount+1);assert.equal(requestId,REQUESTS[callCount]);guard();once(OUT+'/original-call-'+ordinal+'.intent.private.json',{activationHash,candidateSha,ordinal,requestIdentityHash:keys.lookup(['native-cold-request-v1',requestId]),maximumRetries:0,pid:process.pid});callCount++;
  transport.observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',ordinal);const value=await bounded(50000,()=>producer.run({userId:USER,requestId}));assert.equal(value.replayed,false);
  return bounded(PROFILE.readbackMs,async()=>{const e=(await executionRows()).get(executionId(requestId));assert.ok(e);assert.equal(canonicalJson(value.result),canonicalJson(verifyLiveExecutionResult(keys,e)),'ACTUAL_RETURN_MATCHES_AUTHENTICATED_RESULT');const receipts=(await db.raw.execute({sql:'SELECT receipt_key FROM stage8_live_execution_work_receipts WHERE execution_id=?',args:[e.execution_id]})).rows;const ctx=JSON.parse(e.canonical_request_json);const current=(await db.raw.execute("SELECT input_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
   const claimed=KINDS.filter(kind=>{const logical=keys.lookup(['phase4-logical-work-v1','stage6.claim',[USER,'LIVE',kind,current.input_generation]]);const expected=keys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',logical]]);return receipts.some(r=>r.receipt_key===expected);});assert.equal(claimed.length,1,'ORIGINAL_NAMED_CLAIM_ACK_REQUIRED');
   return {requestId,selectedJobKind:claimed[0],replayed:value.replayed,executionState:e.state,executionGeneration:e.generation,outcome:value.result.outcome,unitsCommitted:value.result.unitsCommitted};});
 };
 const result=await runLeg({phase,pid:process.pid,requestIds:REQUESTS,carry,now,deadlineMs,capture,runOriginal});
 report={...report,status:phase==='A'?'TWO_PRODUCTIVE_ORIGINALS_AWAIT_NEW_OS_LEG':'ACTUAL_THREE_ORIGINAL_CALLS_COLD_PARTIAL_METADATA_OBSERVED',pid:process.pid,serverPid,activationHash,physicalIdentityHash:physicalIdentity(),callsStarted:callCount,
 ...(phase==='A'?{carry:result,canonicalBoundaryDigest:digest(canonicalJson(result.afterA))}:{metadataProof:result,coldProcessPidDifferent:true}),resources:resources(),elapsedMs:now()-started};
}catch(error){process.exitCode=2;report.failure={code:safeFailureCode(error),messageSha256:digest(String(error.message??error))};}
finally{
 try{await db?.close();await transport.awaitIdle();}catch{report.status='CLEANUP_OR_TERMINAL_UNKNOWN';process.exitCode=2;}
 const attribution=transport.snapshot();report.attribution=attribution;report.resources=resources();report.elapsedMs=now()-started;try{assertNativeResources(report.resources);}catch{report.status='FINAL_RESOURCE_CONTRACT_UNQUALIFIED';process.exitCode=2;}
 if(!attribution.adapter.terminalComplete||report.elapsedMs>=PROFILE.proposedOuterMs){report.status='CLEANUP_OR_GLOBAL_DEADLINE_UNKNOWN';process.exitCode=2;}
 clearTimeout(wallTimer);report.safeApplicationLog={bytes:logBytes,sha256:observedLog.digest('hex'),rawPersisted:false};
 // Terminal diagnostics survive a deadline refusal; they never create execution authority.
 const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n'),fd=openSync(OUT+'/'+phase+'-result.private.json','wx',0o600);try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(OUT,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 originalPrint(JSON.stringify({status:report.status,phase,callsStarted:callCount,capacityQualified:false,wholeJobCompletionQualified:false,productionEvidence:false,outputSha256:digest(bytes)}));
}
