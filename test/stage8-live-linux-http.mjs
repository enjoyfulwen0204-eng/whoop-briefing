// Opt-in, offline Linux qualification only. Uses the genuine HTTP database and
// LIVE producer; no Stage6 pilot, campaign authority, or native-memory receiver.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {getHeapStatistics} from 'node:v8';
import {createDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {OFFLINE_LIVE_USERS,OFFLINE_LIVE_RESOURCES,OFFLINE_LIVE_TABLES,offlineLiveFixtureShape,offlineLiveFixtureInput} from './stage8LiveLinuxFixture.js';
import {assertOfflineLiveLinuxPreflight,collectOfflineLiveLinuxPreflight} from './stage8-live-linux-preflight.test.js';

const [profile,rawLimit]=process.argv.slice(2),maxLegs=Number(rawLimit);
assert.ok(['empty','dense'].includes(profile)&&Number.isSafeInteger(maxLegs)&&maxLegs>=1&&maxLegs<=64,'EXPLICIT_BOUNDED_PROFILE_REQUIRED');
assert.equal(process.platform,'linux','LINUX_CONTAINER_REQUIRED');
assert.ok(existsSync('/.dockerenv'),'ISOLATED_CONTAINER_REQUIRED');
assert.deepEqual(readdirSync('/sys/class/net').sort(),['lo'],'NETWORK_NONE_REQUIRED');
assert.equal(realpathSync('/qualification'),'/qualification','FRESH_QUALIFICATION_DIRECTORY_REQUIRED');
for(const name of ['PHASE4_RELEASE_SHA','RENDER_GIT_COMMIT','GITHUB_ACTIONS','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE',
 'GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TELEGRAM_BOT_TOKEN',
 'WHOOP_CLIENT_ID','WHOOP_CLIENT_SECRET','OPENROUTER_API_KEY'])assert.ok(!process.env[name],`EXTERNAL_ENVIRONMENT_FORBIDDEN:${name}`);
const root=fileURLToPath(new URL('..',import.meta.url)),output=`/qualification/${profile}/report.json`;
assert.equal(realpathSync(process.cwd()),realpathSync(root),'REAL_CHECKOUT_CWD_REQUIRED');
assert.ok(existsSync(resolve(root,'.git')),'REAL_CHECKOUT_GIT_REQUIRED');
const preflight=assertOfflineLiveLinuxPreflight(collectOfflineLiveLinuxPreflight({root,stage:'running',profile}));
const sha=runningReleaseSha({}),startedAt=Date.now(),keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});
const users=OFFLINE_LIVE_USERS,LATENCY_MS=115,LEG_SUPERVISION_MS=90000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const tracked=['src/db.js','src/phase4Reanalysis.js','src/stage8LiveProducer.js','src/stage8LiveExecution.js','src/stage8LivePublication.js','src/stage8Runtime.js','src/stage8PostSync.js',
 'test/stage8-live-linux-http.mjs','test/stage8LiveLinuxFixture.js','test/bodyEnergyFixture.js'];
const sourceHashes=()=>Object.fromEntries(tracked.map(path=>[path,hash(readFileSync(resolve(root,path)))]));
const initialHashes=sourceHashes();
const readText=path=>{try{return readFileSync(path,'utf8').trim();}catch{return null;}};
const fields=text=>Object.fromEntries(String(text??'').split('\n').filter(Boolean).map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));
const cgroup=()=>({memoryCurrent:readText('/sys/fs/cgroup/memory.current'),memoryPeak:readText('/sys/fs/cgroup/memory.peak'),
 memoryMax:readText('/sys/fs/cgroup/memory.max'),swapMax:readText('/sys/fs/cgroup/memory.swap.max'),memoryEvents:fields(readText('/sys/fs/cgroup/memory.events')),
 cpuMax:readText('/sys/fs/cgroup/cpu.max'),cpu:fields(readText('/sys/fs/cgroup/cpu.stat'))});
const initialCgroup=cgroup(),initialCpu=process.cpuUsage();
const report={contract:'stage8-live-offline-linux-http-v2',profile,productionEvidence:false,status:'RUNNING',releaseSha:sha,sourceHashes:initialHashes,preflight,
 startedAt:new Date(startedAt).toISOString(),node:process.version,architecture:process.arch,heapLimitBytes:getHeapStatistics().heap_size_limit,
 input:offlineLiveFixtureShape(profile),
 limits:{totalProducerCalls:maxLegs,liveExecutionDeadlineMs:45000,workerWallMs:45000,workerSafetyMarginMs:15000,workerEffectiveMs:30000,maxItemsPerTenant:6,
  legSupervisionMs:LEG_SUPERVISION_MS,addedWorkloadHttpLatencyMs:LATENCY_MS,postSyncParentUsed:false,parentTtlExtended:false},
 productionTransactionCeiling:'UNKNOWN; unmodified local sqld behavior is recorded without inventing a server cap',
 scope:'Producer and typed self-reader only; no SYNC/webhook responsiveness or Production sizing claim. Cgroup includes shell, sqld and this Node; dense peak may include earlier empty profile.',
 callsStarted:0,legs:[],readers:{},http:{requests:0,sqlStatements:0,responseErrors:0,requestErrors:0,byPhase:{},errorCodes:{},transactions:[],openTransactions:0,droppedTransactions:0},
 resources:{initialCgroup,sampledRssPeak:process.memoryUsage().rss},failures:[]};
let db,phase='SETUP',latency=false,activeLeg=null,stopping=false;
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const failure=(error,stage)=>{const code=String(error?.code??error?.name??'ERROR');report.failures.push({stage,code:/^[A-Za-z0-9_:-]{1,100}$/.test(code)?code:'ERROR',messageSha256:hash(String(error?.message??error))});};
const sample=setInterval(()=>{report.resources.sampledRssPeak=Math.max(report.resources.sampledRssPeak,process.memoryUsage().rss);},20);sample.unref();
process.once('SIGTERM',()=>{stopping=true;report.status='INTERRUPTED_UNKNOWN_IN_FLIGHT';report.activeLeg=activeLeg;report.resources.finalCgroup=cgroup();save();process.exit(143);});
save();

// Labels/counters only: no statement arguments, source values, HTTP credentials,
// health rows, or SQL bodies are retained in the evidence report.
const originalFetch=globalThis.fetch.bind(globalThis),streams=new Map();
const label=sql=>({verb:/^\s*([A-Za-z]+)/.exec(sql??'')?.[1]?.toUpperCase()??'OTHER',template:hash(String(sql??'').replace(/\s+/g,' ').trim())});
const errorCode=error=>{const code=String(error?.code??error?.name??'ERROR');return /^[A-Za-z0-9_:-]{1,100}$/.test(code)?code:'ERROR';};
const countError=error=>{report.http.responseErrors++;const code=errorCode(error);report.http.errorCodes[code]=(report.http.errorCodes[code]??0)+1;};
const offlineFetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 assert.ok(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port==='18080'&&!url.username&&!url.password,'ONLY_FRESH_LOOPBACK_SQLD_ALLOWED');
 return originalFetch(request);
};
globalThis.fetch=offlineFetch;
const observedFetch=async(input,init)=>{
 const request=new Request(input,init),body=await request.clone().json(),observedAt=Date.now();
 const stream=streams.get(body.baton)??{sql:new Map(),transaction:null};
 report.http.requests++;report.http.byPhase[phase]=(report.http.byPhase[phase]??0)+1;
 try{
  if(latency)await new Promise((resolve,reject)=>{
   const onAbort=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);reject(request.signal.reason);};
   const timer=setTimeout(()=>{request.signal.removeEventListener('abort',onAbort);resolve();},LATENCY_MS);
   if(request.signal.aborted)onAbort();else request.signal.addEventListener('abort',onAbort,{once:true});
  });
  const response=await offlineFetch(request),result=await response.clone().json(),finishedAt=Date.now();
  if(!response.ok)countError({code:`HTTP_${response.status}`});
  if(stream.transaction)stream.transaction.httpRequests++;
  for(let i=0;i<(body.requests??[]).length;i++){
   const item=body.requests[i],reply=result.results?.[i];
   if(item.type==='store_sql')stream.sql.set(item.sql_id,label(item.sql));
   if(item.type==='close_sql')stream.sql.delete(item.sql_id);
   const statements=item.type==='execute'?[item.stmt]:item.type==='batch'?item.batch.steps.map(step=>step.stmt):[];
   report.http.sqlStatements+=statements.length;
   if(reply?.type==='error')countError(reply.error);
   const errors=reply?.response?.result?.step_errors??[];for(const error of errors)if(error)countError(error);
   for(let j=0;j<statements.length;j++){
    const stmt=statements[j],entry=stmt.sql!==undefined?label(stmt.sql):stream.sql.get(stmt.sql_id)??label('');
    const success=reply?.type==='ok'&&(item.type==='execute'||reply.response?.result?.step_results?.[j]!=null);
    if(success&&entry.verb==='BEGIN')stream.transaction={phase,startedAt:observedAt,httpRequests:1,statements:0};
    if(stream.transaction)stream.transaction.statements++;
    if(success&&['COMMIT','ROLLBACK'].includes(entry.verb)&&stream.transaction){
     if(report.http.transactions.length<4096)report.http.transactions.push({...stream.transaction,outcome:entry.verb,finishedAt,durationUpperBoundMs:finishedAt-stream.transaction.startedAt});else report.http.droppedTransactions++;
     stream.transaction=null;
    }
   }
   if(item.type==='close'&&reply?.type==='ok'&&stream.transaction){
    if(report.http.transactions.length<4096)report.http.transactions.push({...stream.transaction,outcome:'CLOSE_WITH_UNRESOLVED_TRANSACTION',finishedAt,durationUpperBoundMs:finishedAt-stream.transaction.startedAt});else report.http.droppedTransactions++;
    stream.transaction=null;
   }
  }
  if(body.baton)streams.delete(body.baton);if(result.baton)streams.set(result.baton,stream);
  report.http.openTransactions=[...new Set(streams.values())].filter(s=>s.transaction).length;
  return response;
 }catch(error){report.http.requestErrors++;const code=errorCode(error);report.http.errorCodes[code]=(report.http.errorCodes[code]??0)+1;throw error;}
};

async function bounded(work){
 const budget=createExecutionBudget({budgetMs:LEG_SUPERVISION_MS});
 try{return await withExecutionBudget(budget,async()=>{budget.assert();const value=await work();budget.assert();return value;});}
 finally{budget.close();}
}
async function snapshot(){
 const jobs=(await db.raw.execute("SELECT user_id,job_kind,state,requested_generation,completed_generation,scope_kind,scope_revision,full_scan_cursor,attempt,last_error_code FROM phase4_jobs WHERE execution_mode='LIVE' ORDER BY user_id,job_kind")).rows.map(row=>{
  const {full_scan_cursor,...metadata}=row;return {...metadata,cursorSha256:full_scan_cursor===null?null:hash(full_scan_cursor)};
 });
 const computation=(await db.raw.execute("SELECT user_id,input_generation,last_completed_generation,source_generation_seen FROM phase4_computation_state WHERE execution_mode='LIVE' ORDER BY user_id")).rows;
 const count=async table=>Number((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);
 return {jobs,computation,completionProofs:await count('stage8_live_job_completions'),publications:await count('stage8_live_publications'),
  workReceipts:await count('stage8_live_execution_work_receipts'),operationReceipts:await count('stage8_live_operation_receipts'),
  executions:(await db.raw.execute('SELECT state,count(*) n FROM stage8_live_executions GROUP BY state ORDER BY state')).rows};
}
const progress=(before,after,userId)=>JSON.stringify({jobs:before.jobs.filter(row=>row.user_id===userId),computation:before.computation.filter(row=>row.user_id===userId),workReceipts:before.workReceipts,operationReceipts:before.operationReceipts})!==JSON.stringify({jobs:after.jobs.filter(row=>row.user_id===userId),computation:after.computation.filter(row=>row.user_id===userId),workReceipts:after.workReceipts,operationReceipts:after.operationReceipts});

try{
 db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:observedFetch});assert.equal(db.raw.protocol,'http','REAL_HTTP_DATABASE_REQUIRED');
 const existing=(await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n;
 assert.equal(Number(existing),0,'EMPTY_DATABASE_REQUIRED');await db.migrate({targetVersion:35});
 assert.equal(Number((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v),35);
 const stores=await createPhase4Foundation({db,keys}),asOf=Date.now()-1000;
 for(const [index,userId] of users.entries()){
  await db.createUser({id:userId,displayName:'Synthetic offline qualification',timezone:'Asia/Taipei',status:'ACTIVE'});
  await stores.initializeTenant(userId,'SHADOW');
  const input=offlineLiveFixtureInput({profile,userId,asOf});
  await db.transaction(()=>seedBodyInput(db,input));await db.ensureOnboarding(userId,{state:'READY'});
  await db.linkTelegram({userId,chatId:String(10001+index)});await db.setLocale(userId,'en');
  for(const resource of OFFLINE_LIVE_RESOURCES)await db.saveSyncState(userId,resource,{backfillComplete:true,lastSuccessAt:new Date(asOf).toISOString()});
  await stores.preferences.read(await stores.captureControl(userId));
 }
 report.seededRowsPerUser=Object.fromEntries(await Promise.all(users.map(async userId=>[userId,Object.fromEntries(await Promise.all(
  OFFLINE_LIVE_RESOURCES.map(async type=>[type,Number((await db.raw.execute({sql:`SELECT count(*) n FROM ${OFFLINE_LIVE_TABLES[type]} WHERE user_id=?`,args:[userId]})).rows[0].n)])))])));
 report.seededRows=Object.fromEntries(await Promise.all(Object.values(OFFLINE_LIVE_TABLES).map(async table=>[table,Number((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n)])));
 assert.deepEqual(report.seededRowsPerUser,report.input.expectedRowsPerUser,'EXACT_SYNTHETIC_USER_SHAPE_REQUIRED');
 assert.deepEqual(report.seededRows,Object.fromEntries(OFFLINE_LIVE_RESOURCES.map(type=>[OFFLINE_LIVE_TABLES[type],report.input.expectedTotalRows[type]])),'EXACT_SYNTHETIC_TOTAL_SHAPE_REQUIRED');
 report.resources.afterSeedCgroup=cgroup();report.resources.afterSeedMemory=process.memoryUsage();
 latency=true;phase='ANALYSIS';
 const admission=await bounded(()=>db.admitRuntime({fresh:true})),eligible=id=>users.includes(id);
 const producer=await bounded(()=>createStage8LiveProducer({db,keys,admission,userIds:users,enabled:()=>true,eligible,environment:{}}));
 const reader=createStage8DerivedReader({db,keys,admission,eligible}),scopes=await createScopedHealthContext({db,keys,admission,derivedReader:reader});
 const finished=new Set(),blocked=new Set(),noProgress=new Map();let next=0;
 while(report.callsStarted<maxLegs&&finished.size+blocked.size<users.length&&!stopping){
  const userId=users[next++%users.length];if(finished.has(userId)||blocked.has(userId))continue;
  const before=await bounded(snapshot),requestId=`offline-${profile}-${userId}-${report.callsStarted}`;
  activeLeg={userId,requestId,startedAt:new Date().toISOString()};report.callsStarted++;save();
  const leg={...activeLeg,call:report.callsStarted};report.legs.push(leg);
  try{
   const result=await bounded(()=>producer.run({userId,requestId}));
   leg.elapsedMs=Date.now()-Date.parse(leg.startedAt);leg.executionId=result.executionId;leg.result=result.result;leg.publication=result.publication;leg.replayed=result.replayed;
   const after=await bounded(snapshot);leg.persisted=after;
   const moved=progress(before,after,userId);leg.businessProgress=moved;noProgress.set(userId,moved?0:(noProgress.get(userId)??0)+1);
   if(result.publication.status==='CURRENT'){
    phase='VERIFY';const verified={};report.readers[userId]=verified;
    for(const kind of ['INSIGHTS','EPISODES','BODY_ENERGY','EVIDENCE']){
     const value=await bounded(async()=>{const scope=await scopes.open({user:await db.getUser(userId),chatId:String(10001+users.indexOf(userId)),text:'/insights'});return scopes.derived(scope,kind);});
     verified[kind]={status:value.status,itemCount:value.items.length};
    }
    assert.ok(Object.values(verified).every(value=>value.status==='CURRENT'),'TYPED_CURRENT_READER_REQUIRED');
    if(profile==='empty')for(const kind of ['INSIGHTS','EPISODES','BODY_ENERGY'])assert.equal(verified[kind].itemCount,0,'GENUINE_EMPTY_OUTCOME_REQUIRED');
    if(report.callsStarted<maxLegs){
     const replayBefore=await bounded(snapshot);report.callsStarted++;
     activeLeg={userId,requestId,kind:'EXACT_REPLAY',call:report.callsStarted,startedAt:new Date().toISOString()};leg.replay=activeLeg;save();
     const replay=await bounded(()=>producer.run({userId,requestId})),replayAfter=await bounded(snapshot);
     assert.equal(replay.replayed,true);assert.deepEqual(replayAfter,replayBefore,'EXACT_REPLAY_MUST_PRESERVE_DURABLE_WORK');leg.exactReplayVerified=true;
    }else leg.exactReplayVerified=false;
    finished.add(userId);phase='ANALYSIS';
   }else if(result.result.outcome==='FAILED'||(noProgress.get(userId)??0)>=2){blocked.add(userId);leg.stopped='FAILED_OR_REPEATED_NO_BUSINESS_PROGRESS';}
  }catch(error){failure(error,`LEG:${userId}`);leg.error=report.failures.at(-1);blocked.add(userId);phase='ANALYSIS';try{leg.persisted=await bounded(snapshot);}catch(readError){failure(readError,`READBACK:${userId}`);}}
  activeLeg=null;save();
 }
 phase='FINAL';report.final=await bounded(snapshot);report.finishedUsers=[...finished];report.blockedUsers=[...blocked];
 report.finalReaderStatus={};
 for(const userId of finished){
  const value=await bounded(async()=>{const scope=await scopes.open({user:await db.getUser(userId),chatId:String(10001+users.indexOf(userId)),text:'/insights'});return scopes.derived(scope,'INSIGHTS');});
  report.finalReaderStatus[userId]=value.status;
 }
 report.outboundMessages=Number((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n);
 report.pilotLedgers=Number((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE scope='global' AND component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n);
 assert.equal(report.outboundMessages,0,'NO_SENDS_ALLOWED');assert.equal(report.pilotLedgers,0,'NO_PILOT_LEDGER_ALLOWED');
 assert.equal(runningReleaseSha({}),sha,'CHECKOUT_HEAD_CHANGED');assert.deepEqual(sourceHashes(),initialHashes,'RUNTIME_SOURCE_CHANGED');
 const complete=users.every(userId=>finished.has(userId)&&report.finalReaderStatus[userId]==='CURRENT'
  &&report.legs.some(leg=>leg.userId===userId&&leg.exactReplayVerified===true)
  &&report.final.jobs.filter(row=>row.user_id===userId).length===2
  &&report.final.jobs.filter(row=>row.user_id===userId).every(row=>row.state==='COMPLETED'&&row.scope_kind==='NONE'&&row.requested_generation===row.completed_generation));
 report.status=complete&&report.failures.length===0?'LOCAL_LIVE_HTTP_VERIFIED':'LOCAL_LIVE_HTTP_PARTIAL';
 report.explicitEmptyVerified=profile==='empty'&&complete;
}catch(error){failure(error,phase);report.status='LOCAL_LIVE_HTTP_FAILED';}
finally{
 clearInterval(sample);report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-startedAt;
 const cpu=process.cpuUsage(initialCpu),usage=process.resourceUsage(),finalCgroup=cgroup();
 const cpuDelta=Object.fromEntries(Object.entries(finalCgroup.cpu).map(([key,value])=>[key,value-(initialCgroup.cpu[key]??0)]));
 const memoryEventDelta=Object.fromEntries(Object.entries(finalCgroup.memoryEvents).map(([key,value])=>[key,value-(initialCgroup.memoryEvents[key]??0)]));
 report.resources={...report.resources,finalCgroup,cgroupCpuDelta:cpuDelta,cgroupMemoryEventDelta:memoryEventDelta,processCpuMicroseconds:cpu,processMaxRssKiB:usage.maxRSS,finalMemory:process.memoryUsage()};
 report.http.transactionTimingMeaning='Upper bounds from observed HTTP envelopes; not an inspected Production server transaction ceiling.';
 report.http.transactionDurationUpperBounds={maximumMs:Math.max(0,...report.http.transactions.map(row=>row.durationUpperBoundMs)),over5000Ms:report.http.transactions.filter(row=>row.durationUpperBoundMs>5000).length};
 report.activeLeg=activeLeg;save();db?.close();
 console.log('STAGE8_LIVE_HTTP_RESULT '+JSON.stringify({profile,status:report.status,callsStarted:report.callsStarted,maxLegs,completedJobs:report.final?.jobs.filter(row=>row.state==='COMPLETED'&&row.requested_generation===row.completed_generation).length??0,verifiedCurrentUsers:Object.keys(report.readers).length,output}));
 process.exitCode=report.status==='LOCAL_LIVE_HTTP_VERIFIED'?0:2;
}
