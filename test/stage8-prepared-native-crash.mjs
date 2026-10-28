// Opt-in native COMMIT-before-application-ACK crash and same-RID cold probe.
// Synthetic only. Never clears the disposal hold or renews original authority.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {createDb} from '../src/db.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createStage8LivePreparedWorker} from '../src/stage8LivePreparedWork.js';
import {currentDurableExecution} from '../src/phase4ExecutionContext.js';
import {currentExecutionBudget} from '../src/executionBudget.js';
import {fixtureKeys as keys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
import {log} from '../src/logger.js';
for(const name of ['info','warn','error'])log[name]=()=>{};
const mode=process.argv[2];assert.ok(['PREPARE_CRASH','COLD_REPLAY'].includes(mode));assert.equal(process.argv.length,3);
assert.equal(process.version,'v22.23.2');assert.equal(process.platform,'linux');
for(const [name,value] of Object.entries(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!value);
const root=resolve(new URL('..',import.meta.url).pathname),manifest=JSON.parse(readFileSync(resolve(root,'source-manifest.json'),'utf8')),statePath=resolve(root,'..','native-crash-intent.json');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
for(const [path,sha] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),sha);
const request={userId:'a',requestId:'r22-native-exact-prepared-crash'},url='http://127.0.0.1:18083',nativeFetch=globalThis.fetch.bind(globalThis),observer=createPreparedNativeObserver();
let phase='SETUP',requests=0,pending=0,original,publicationStream,witnessKey,crashStarted=false,callbackEntered=false;
const decode=value=>value?.type==='text'?value.value:null;
async function oracleSnapshot(){
 const batons=new Set();let active=0,oracleFailure;
 const reader=createClient({url,fetch:async(input,init)=>{
  const req=new Request(input,init);assert.equal(new URL(req.url).origin,url);const body=await req.clone().json();active++;
  try{
   const response=await nativeFetch(req,{signal:AbortSignal.timeout(1500),redirect:'error'}),reply=await response.clone().json();assert.ok(response.ok);
   assert.equal(reply.results?.length,body.requests.length);assert.ok(reply.results.every(r=>r.type==='ok'));
   for(let i=0;i<body.requests.length;i++)if(body.requests[i].type==='close')assert.equal(reply.results[i].response?.type,'close');
   if(body.baton)batons.delete(body.baton);if(reply.baton)batons.add(reply.baton);return response;
  }catch(error){oracleFailure=error;throw error;}finally{active--;}
 }});
 try{
  const names=(await reader.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'resource_locks' ORDER BY name")).rows.map(r=>r.name);
  assert.ok(names.length<128);for(const name of names)assert.match(name,/^[a-z0-9_]+$/);
  const results=await reader.batch(names.map(name=>'SELECT * FROM '+name+' LIMIT 4097'),'deferred');assert.ok(results.every(r=>r.rows.length<=4096));
  const graph=names.map((name,i)=>[name,results[i].rows.map(row=>JSON.stringify(row)).sort()]);
  const execution=(await reader.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
  const receipts=(await reader.execute({sql:'SELECT * FROM stage8_live_execution_work_receipts WHERE execution_id=? ORDER BY receipt_key',args:[request.requestId]})).rows;
  const holds=(await reader.execute("SELECT * FROM resource_locks WHERE name LIKE '%:prepared-disposal:%' ORDER BY name")).rows;
  return {graphDigest:digest(graph),execution:JSON.parse(JSON.stringify(execution)),receiptsDigest:digest(receipts),receiptCount:receipts.length,holds:JSON.parse(JSON.stringify(holds)),witness:receipts.find(r=>r.receipt_key===witnessKey)};
 }finally{
  reader.close();const until=performance.now()+1500;while((active||batons.size)&&performance.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(active,0);assert.equal(batons.size,0);assert.equal(oracleFailure,undefined);
 }
}
const fetchOwned=async(input,init)=>{
 const req=new Request(input,init);assert.equal(new URL(req.url).origin,url);const body=await req.clone().json(),event=observer.submitted(body,phase,performance.now());requests++;pending++;
 const statements=(body.requests??[]).flatMap(item=>item.type==='execute'?[item.stmt]:item.type==='batch'?item.batch.steps.map(s=>s.stmt):[]),commands=statements.map(stmt=>({stmt,sql:stmt.sql??event.stream.sql.get(stmt.sql_id)??''}));
 if(commands.some(c=>c.sql.includes('LIVE_PREPARED_AUTHORITY_REVOKED'))&&commands.some(c=>c.sql.includes('json_each(?) AS __stage6_expected')))publicationStream=event.stream;
 if(event.stream===publicationStream)for(const {stmt,sql} of commands)if(/^INSERT INTO stage8_live_execution_work_receipts\(/.test(sql))witnessKey=decode(stmt.args?.[1]);
 try{
  const response=await nativeFetch(req,{signal:AbortSignal.any([req.signal,AbortSignal.timeout(10000)]),redirect:'error'}),reply=await response.clone().json();assert.ok(response.ok);
  observer.acknowledged(event,reply,performance.now());
  const commit=commands.some(c=>/^\s*COMMIT\s*$/i.test(c.sql));
  if(mode==='PREPARE_CRASH'&&!crashStarted&&commit&&event.stream===publicationStream){
   crashStarted=true;const actual=observer.assertComplete('WORK');assert.ok(actual.every(t=>t.outcome==='COMMIT'&&t.upperBoundMs<5000));
   assert.match(witnessKey??'',/^[a-f0-9]{64}$/);const snapshot=await oracleSnapshot(),claim=original.claim;
   assert.equal(snapshot.execution.state,'ESTABLISHED');assert.equal(snapshot.execution.result_json,null);assert.equal(snapshot.execution.owner,claim.owner);assert.equal(snapshot.execution.generation,1);
   assert.equal(snapshot.execution.deadline_at-snapshot.execution.created_at,45000);assert.equal(snapshot.execution.lease_until-snapshot.execution.created_at,60000);
   assert.equal(snapshot.witness?.execution_id,claim.executionId);assert.equal(snapshot.witness?.request_digest,claim.identity);assert.equal(snapshot.witness?.scope_key,claim.scopeKey);assert.equal(snapshot.witness?.generation,1);assert.match(snapshot.witness?.result_json??'',/^"[a-f0-9]{64}"$/);assert.equal(snapshot.holds.length,1);
   const intent={contract:'r22-native-prepared-beforeack-crash-v1',manifestDigest:digest(manifest),baseCommit:manifest.baseCommit,producerPid:process.pid,request,claim,snapshot,witnessKey};
   const file=await open(statePath,'wx',0o600);try{await file.writeFile(JSON.stringify(intent));await file.sync();}finally{await file.close();}
   currentExecutionBudget().assert();assert.equal(original.indeterminate,undefined);
   const packet={status:'ACTUAL_NATIVE_PUBLICATION_COMMIT_SECOND_CONNECTION_VISIBLE_BEFORE_APP_ACK',pid:process.pid,receiptCount:snapshot.receiptCount,graphDigest:snapshot.graphDigest,originalState:snapshot.execution.state,originalGeneration:1,deadlineWidthMs:45000,leaseWidthMs:60000,workTransactions:actual,applicationAckDelivered:false,physicalCrashNotYetObserved:true,productionEvidence:false};
   process.stdout.write('R22_NATIVE_CRASH_COMMIT '+JSON.stringify(packet)+'\n',()=>process.kill(process.pid,'SIGKILL'));
   return await new Promise(()=>{});
  }
  return response;
 }finally{pending--;}
};
globalThis.fetch=fetchOwned;const db=createDb({url,phase4Keys:keys,fetch:fetchOwned});let failure,report;
try{
 if(mode==='PREPARE_CRASH'){
  assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);
  await db.migrate({targetVersion:35});await db.createUser({id:'a',displayName:'Synthetic native crash gate',timezone:'Asia/Taipei',status:'ACTIVE'});
  const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});await foundation.initializeTenant('a','SHADOW');await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:0})));await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});
 }
 const prior=mode==='COLD_REPLAY'?JSON.parse(readFileSync(statePath,'utf8')):null;
 if(prior){assert.notEqual(prior.producerPid,process.pid);assert.equal(prior.manifestDigest,digest(manifest));assert.equal(prior.baseCommit,manifest.baseCommit);witnessKey=prior.witnessKey;assert.deepEqual(request,prior.request);}
 const admission=await db.admitRuntime(),capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:manifest.baseCommit,configProof:keys.lookup(['isolated-r22-native-crash',manifest.files]),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.equal(id,'a');}});
 if(!prior){await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});}
 const prepared=createStage8LivePreparedWorker({db,keys,capability}),run=createStage8LiveExecutionRunner({db,keys,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:c=>core.assertContext(c),work:async(userId,context)=>{
  callbackEntered=true;assert.equal(mode,'PREPARE_CRASH','COLD_REPLAY_MUST_NOT_ENTER_WORK');original=currentDurableExecution();return prepared.drain({userId,context});
 }});
 phase='WORK';
 if(!prior){await run(request);assert.fail('EXPECTED_COMMIT_BOUNDARY_SIGKILL_NOT_REACHED');}
 const before=await oracleSnapshot();assert.equal(before.graphDigest,prior.snapshot.graphDigest);assert.deepEqual(before.execution,prior.snapshot.execution);assert.equal(before.receiptsDigest,prior.snapshot.receiptsDigest);assert.deepEqual(before.holds,prior.snapshot.holds);
 assert.ok(Date.now()<prior.snapshot.execution.deadline_at,'ORIGINAL_PENDING_WINDOW_ALREADY_EXPIRED');
 await assert.rejects(run(request),error=>error.code==='STAGE8_LIVE_REQUEST_PENDING');assert.equal(callbackEntered,false);
 const after=await oracleSnapshot();assert.equal(after.graphDigest,before.graphDigest);assert.deepEqual(after.execution,before.execution);assert.equal(after.receiptsDigest,before.receiptsDigest);assert.deepEqual(after.holds,before.holds);
 assert.ok(await core.contextRegistry.pending('a',JSON.parse(after.holds[0].owner)[0]+1)>0);
 const coldTransactions=observer.assertComplete('WORK');assert.ok(coldTransactions.every(t=>t.upperBoundMs<5000));
 report={status:'ACTUAL_COLD_SAME_RID_PENDING_REJECTION_ORIGINAL_DURABLE_GRAPH_PRESERVED',producerPid:prior.producerPid,coldPid:process.pid,workCallbackEntered:false,originalState:after.execution.state,originalGeneration:after.execution.generation,receiptCount:after.receiptCount,graphDigest:after.graphDigest,disposalHoldPreserved:true,sourceOrGenerationReinitialized:false,coldTransactions,oldWorkerStreamFinality:'NOT_INFERRED_FROM_COLD_CLIENT_JOIN',expiredWindowTested:false,futureSyncRecoveryQualified:false,fullEOFQualified:false,stage6HranaQualified:false,productionEvidence:false};
}catch(error){failure=error;report={status:'NATIVE_CRASH_GATE_FAILED',mode,errorCode:error.code??error.name,message:String(error.message).slice(0,250),crashStarted,callbackEntered,productionEvidence:false};}
finally{
 db.close();const until=performance.now()+4000;while((observer.streams.size||pending)&&performance.now()<until)await new Promise(r=>setTimeout(r,20));
 if(observer.streams.size||pending)failure??=Error('NATIVE_COLD_STREAMS_NOT_JOINED');
 console.log('R22_NATIVE_CRASH_WORKER '+JSON.stringify({...report,status:failure?'NATIVE_CRASH_GATE_FAILED':report.status,cleanupError:failure?.message,mode,requests,openStreams:observer.streams.size,pendingRequests:pending,observation:observer.counts}));
}
if(failure)process.exitCode=1;
