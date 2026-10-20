// Opt-in one EMPTY synthetic user on real loopback sqld. No Production caller,
// health records, credentials, fake cursor/completion or algorithm override.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {offlineLiveFixtureInput,OFFLINE_LIVE_RESOURCES,OFFLINE_LIVE_TABLES} from './stage8LiveLinuxFixture.js';
import {assertNativeResources,assertNativeEmptyCompletion,retainNativeBatonObservation,NATIVE_LIMITS,NATIVE_NODE} from './stage6-linux-native-contract.mjs';
const mode=process.argv[2];assert.ok(['produce','restart'].includes(mode)&&process.argv.length===3,'EXPLICIT_OFFLINE_PHASE_REQUIRED');
const root=fileURLToPath(new URL('..',import.meta.url)),OUT='/qualification',hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
assert.ok(existsSync('/.dockerenv'));assert.equal(realpathSync(process.cwd()),realpathSync(root));assert.equal(realpathSync(OUT),OUT);
for(const name of Object.keys(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!process.env[name],'EXTERNAL_ENVIRONMENT_FORBIDDEN');
const text=path=>readFileSync(path,'utf8').trim();
const resources=()=>({node:process.version,platform:process.platform,architecture:process.arch,memoryMax:text('/sys/fs/cgroup/memory.max'),swapMax:text('/sys/fs/cgroup/memory.swap.max'),cpuMax:text('/sys/fs/cgroup/cpu.max'),interfaces:readdirSync('/sys/class/net').sort(),memoryPeak:text('/sys/fs/cgroup/memory.peak'),memoryEvents:text('/sys/fs/cgroup/memory.events')});
assertNativeResources(resources());assert.equal(process.version,NATIVE_NODE);
const resumePath=OUT+'/original-restart-intent.json',prior=mode==='restart'?JSON.parse(readFileSync(resumePath,'utf8')):null;
const startedAtMs=prior?.startedAtMs??Date.now(),deadlineAtMs=startedAtMs+NATIVE_LIMITS.wallMs,sha=runningReleaseSha({}),keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});
if(prior){assert.equal(prior.synthetic,true);assert.equal(prior.releaseSha,sha);assert.notEqual(prior.producerPid,process.pid,'ACTUAL_NEW_NODE_PROCESS_REQUIRED');}
const tracked=['src/phase4Reanalysis.js','src/stage8LiveProducer.js','src/stage8LiveExecution.js','src/stage8LivePublication.js','test/stage6-linux-live-restart.mjs','test/stage6-linux-native-contract.mjs'];
const sourceHashes=Object.fromEntries(tracked.map(p=>[p,hash(readFileSync(resolve(root,p)))]));if(prior)assert.deepEqual(sourceHashes,prior.sourceHashes,'NO_SOURCE_CHANGE_BETWEEN_PROCESSES');
const http={requests:0,requestErrors:0,responseErrors:0,openTransactions:0,droppedTransactions:0,transactions:[]},streams=new Map();let latency=false;
const remaining=()=>{const ms=deadlineAtMs-Date.now();assert.ok(ms>0&&Date.now()>=startedAtMs,'ORIGINAL_15_MINUTE_DEADLINE');return ms;};
const checkError=result=>{for(const item of result.results??[]){if(item.type==='error')http.responseErrors++;for(const e of item.response?.result?.step_errors??[])if(e)http.responseErrors++;}};
const networkFetch=globalThis.fetch.bind(globalThis);
const offlineFetch=async(input,init)=>{const r=new Request(input,init),u=new URL(r.url);assert.ok(u.origin==='http://127.0.0.1:18080'&&!u.username&&!u.password,'ONLY_FRESH_LOOPBACK_SQLD_ALLOWED');return networkFetch(r,{signal:AbortSignal.any([r.signal,AbortSignal.timeout(Math.min(60000,remaining()))])});};
globalThis.fetch=offlineFetch;
const observedFetch=async(input,init)=>{
 const request=new Request(input,init),body=await request.clone().json(),at=performance.now(),stream=streams.get(body.baton)??{sql:new Map(),transaction:null};http.requests++;
 for(const item of body.requests??[])if(item.type==='store_sql')stream.sql.set(item.sql_id,item.sql);
 try{
  if(latency)await new Promise((ok,no)=>{const onAbort=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);no(request.signal.reason);},timer=setTimeout(()=>{request.signal.removeEventListener('abort',onAbort);ok();},NATIVE_LIMITS.addedHttpLatencyMs);if(request.signal.aborted)onAbort();else request.signal.addEventListener('abort',onAbort,{once:true});});
  const response=await offlineFetch(request),result=await response.clone().json(),finished=performance.now();if(!response.ok)http.responseErrors++;checkError(result);
  for(let i=0;i<(body.requests??[]).length;i++){
   const item=body.requests[i],reply=result.results?.[i],statements=item.type==='execute'?[item.stmt]:item.type==='batch'?item.batch.steps.map(s=>s.stmt):[];
   for(let j=0;j<statements.length;j++){
    const stmt=statements[j],verb=/^\s*([A-Z]+)/i.exec(stmt.sql??stream.sql.get(stmt.sql_id)??'')?.[1].toUpperCase(),success=reply?.type==='ok'&&(item.type==='execute'||reply.response?.result?.step_results?.[j]!=null);
    if(verb==='BEGIN'&&success){assert.equal(stream.transaction,null,'NO_HIDDEN_PRIOR_TRANSACTION');stream.transaction={startedMono:at,phase};}
    if(['COMMIT','ROLLBACK'].includes(verb)&&success&&stream.transaction){if(http.transactions.length<16384)http.transactions.push({phase:stream.transaction.phase,outcome:verb,durationUpperBoundMs:finished-stream.transaction.startedMono});else http.droppedTransactions++;stream.transaction=null;}
   }
   if(item.type==='close'&&reply?.type==='ok'&&stream.transaction){if(http.transactions.length<16384)http.transactions.push({phase:stream.transaction.phase,outcome:'CLOSE_WITH_UNRESOLVED_TRANSACTION',durationUpperBoundMs:finished-stream.transaction.startedMono});else http.droppedTransactions++;stream.transaction=null;}
   if(item.type==='close_sql')stream.sql.delete(item.sql_id);
  }
  retainNativeBatonObservation(streams,{priorBaton:body.baton,nextBaton:result.baton,stream,http,finishedMono:finished});assert.equal(http.droppedTransactions,0,'UNKNOWN_NATIVE_TRANSACTION_STOP_QUALIFICATION');return response;
 }catch(error){http.requestErrors++;throw error;}
};
let db,callsStarted=prior?.callsStarted??0,phase=mode==='produce'?'SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY':'COLD_REPLAY',report={contract:'stage6-native-empty-cold-replay-v1',productionEvidence:false,status:'RUNNING',mode,releaseSha:sha,sourceHashes,startedAtMs,callsStarted,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN',productionAmd64Qualified:false,transactionScope:'All observed transactions; synthetic SETUP_SCHEMA1_TO35 separately labeled, not actual controlled Production33to35 migration'};
const save=()=>writeFileSync(OUT+'/'+mode+'-report.json',JSON.stringify({...report,callsStarted,http,resources:resources()},null,2)+'\n',{mode:0o600});
async function bounded(work){const budget=createExecutionBudget({budgetMs:Math.min(60000,remaining())});try{return await withExecutionBudget(budget,work);}finally{budget.close();}}
async function snapshot(){
 const names=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'stage8_live_%' OR name IN ('phase4_jobs','phase4_computation_state')) ORDER BY name")).rows.map(r=>r.name),facts=[];
 for(const name of names){assert.match(name,/^[a-z0-9_]+$/);const rows=(await db.raw.execute('SELECT * FROM '+name)).rows;assert.ok(rows.length<=4096);facts.push([name,rows.map(r=>JSON.stringify(r)).sort()]);}
 const jobs=(await db.raw.execute("SELECT state,requested_generation,completed_generation,scope_kind,full_scan_cursor FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
 const computation=(await db.raw.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
 const count=async table=>Number((await db.raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);
 return {canonicalDigest:hash(facts),originalJobsCompleted:jobs.length===2&&jobs.every(r=>r.state==='COMPLETED'&&r.scope_kind==='NONE'&&r.full_scan_cursor===null&&r.requested_generation===r.completed_generation)?2:0,currentComputation:Boolean(computation&&computation.input_generation===computation.last_completed_generation),currentPublications:await count('stage8_live_publications'),sourceRows:(await Promise.all(Object.values(OFFLINE_LIVE_TABLES).map(count))).reduce((a,b)=>a+b,0),outboundMessages:await count('outbound_messages'),pilotLedgers:Number((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE scope='global' AND component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n)};
}
try{
 db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:observedFetch});assert.equal(db.raw.protocol,'http');
 if(mode==='produce'){
  assert.equal(Number((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n),0,'FRESH_DATABASE_ONLY');
  await db.migrate({targetVersion:35});const stores=await createPhase4Foundation({db,keys}),asOf=Date.now()-1000;
  await db.createUser({id:'a',displayName:'Synthetic empty Linux qualification',timezone:'Asia/Taipei',status:'ACTIVE'});await stores.initializeTenant('a','SHADOW');
  await db.transaction(()=>seedBodyInput(db,offlineLiveFixtureInput({profile:'empty',userId:'a',asOf})));await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});await db.setLocale('a','en');
  for(const resource of OFFLINE_LIVE_RESOURCES)await db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date(asOf).toISOString()});await stores.preferences.read(await stores.captureControl('a'));
 }
 phase=mode==='produce'?'GENUINE_LIVE_PRODUCER':'COLD_REPLAY';latency=true;const admission=await bounded(()=>db.admitRuntime({fresh:true})),eligible=id=>id==='a',producer=await bounded(()=>createStage8LiveProducer({db,keys,admission,userIds:['a'],enabled:()=>true,eligible,environment:{}}));
 if(mode==='produce'){
  let completed=false;
  while(callsStarted<NATIVE_LIMITS.maximumCalls-1){
   remaining();const requestId='synthetic-linux-empty-'+callsStarted;callsStarted++;report.activeCall={ordinal:callsStarted,kind:'GENUINE_ORIGINAL_PRODUCER'};save();
   const value=await bounded(()=>producer.run({userId:'a',requestId})),state=await bounded(snapshot);report.lastObserved={outcome:value.result.outcome,publication:value.publication.status,...state};save();
   if(value.publication.status==='CURRENT'&&state.originalJobsCompleted===2&&state.currentComputation){
    const intent={synthetic:true,releaseSha:sha,sourceHashes,startedAtMs,callsStarted,producerPid:process.pid,requestId,resultDigest:hash(value.result),canonicalDigest:state.canonicalDigest,producerHttp:http};writeFileSync(resumePath,JSON.stringify(intent,null,2)+'\n',{mode:0o600});completed=true;break;
   }
   assert.notEqual(value.result.outcome,'FAILED','GENUINE_PRODUCER_FAILED_NO_NEW_CAMPAIGN');
  }
  assert.equal(completed,true,'BOUNDED_EMPTY_CONVERGENCE_NOT_QUALIFIED');report.status='GENUINE_EMPTY_CURRENT_PENDING_NEW_PROCESS_REPLAY';
 }else{
  const before=await bounded(snapshot);assert.equal(before.canonicalDigest,prior.canonicalDigest);assert.equal(before.originalJobsCompleted,2);callsStarted++;assert.ok(callsStarted<=NATIVE_LIMITS.maximumCalls);save();
  const replay=await bounded(()=>producer.run({userId:'a',requestId:prior.requestId})),after=await bounded(snapshot);assert.equal(replay.replayed,true);assert.equal(hash(replay.result),prior.resultDigest);assert.equal(after.canonicalDigest,before.canonicalDigest);
  const reader=createStage8DerivedReader({db,keys,admission,eligible}),scopes=await createScopedHealthContext({db,keys,admission,derivedReader:reader}),typed=[];
  for(const kind of ['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']){const value=await bounded(async()=>{const scope=await scopes.open({user:await db.getUser('a'),chatId:'10001',text:'/insights'});return scopes.derived(scope,kind);});assert.equal(value.status,'CURRENT');if(kind!=='EVIDENCE')assert.equal(value.items.length,0);typed.push(kind);}
  report={...report,...after,status:'ACTUAL_LINUX_EMPTY_CURRENT_COLD_REPLAY_OBSERVED',elapsedMs:Date.now()-startedAtMs,coldProcessRestart:true,exactOriginalIdentityReplay:true,replayPreservedCanonicalMetadata:true,typedCurrentKinds:typed,producerHttp:prior.producerHttp,restartHttp:http,resources:resources(),callsStarted};
  assertNativeEmptyCompletion(report);
 }
 report.activeCall=null;
}catch(error){report.status='UNQUALIFIED_FAILURE_OR_UNKNOWN';report.failure={phase,code:String(error.code??error.name??'ERROR').replace(/[^A-Za-z0-9_:-]/g,'').slice(0,80),messageSha256:hash(String(error.message??error))};process.exitCode=2;}
finally{report.elapsedMs=Date.now()-startedAtMs;save();db?.close();console.log(JSON.stringify({productionEvidence:false,mode,status:report.status,callsStarted,originalJobsCompleted:report.originalJobsCompleted??report.lastObserved?.originalJobsCompleted??0,output:OUT+'/'+mode+'-report.json'}));}
