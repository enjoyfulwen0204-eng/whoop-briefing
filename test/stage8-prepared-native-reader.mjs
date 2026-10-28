// Reader-only native qualification. Fixture rows are an exact copy of genuine
// canonical synthetic computations; importing them is NOT native WORK/EOF.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createDb} from '../src/db.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {publishStage8Live,verifyStage8LivePublication} from '../src/stage8LivePublication.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {exactRealStatement} from '../src/exactRealStatement.js';
import {fixtureKeys as keys} from './localDb.js';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
import {assertPreparedNativeFinalObservation} from './stage8-prepared-native-final-observation.mjs';
import {preparedNativeFailure,preparedNativeErrorSummary} from './stage8-prepared-native-outcome.mjs';
import {log} from '../src/logger.js';
for(const name of ['info','warn','error'])log[name]=()=>{};
assert.equal(process.argv.length,2);assert.equal(process.version,'v22.23.2');assert.equal(process.platform,'linux');
for(const [name,value]of Object.entries(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!value,'NO_EXTERNAL_ENVIRONMENT');
const root=resolve(new URL('..',import.meta.url).pathname),manifest=JSON.parse(readFileSync(resolve(root,'source-manifest.json'),'utf8'));
for(const [path,sha]of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),sha,'EXACT_LOADED_SOURCE_AND_FIXTURE');
const {seal,...fixture}=JSON.parse(readFileSync(resolve(root,'test/native-reader-fixture.json'),'utf8'));
assert.equal(fixture.contract,'r22-canonical-synthetic-reader-fixture-v1');assert.equal(seal,keys.lookup([fixture.contract,fixture]));
assert.equal(fixture.genuineWorkCalls,8);assert.equal(fixture.sourceRows,17);assert.ok(fixture.tables.length<=128);
const q=value=>'"'+value.replaceAll('"','""')+'"';
const observer=createPreparedNativeObserver(),nativeFetch=globalThis.fetch.bind(globalThis),url='http://127.0.0.1:18083';
let phase='SETUP',requests=0,pending=0,errors=0,requestErrors=0,primaryFailure,cleanupFailure,failure,report;
const fetchOwned=async(input,init)=>{
 pending++;
 try{const req=new Request(input,init);assert.equal(new URL(req.url).origin,url);const event=observer.submitted(await req.clone().json(),phase,performance.now());requests++;
  const response=await nativeFetch(req,{signal:AbortSignal.any([req.signal,AbortSignal.timeout(10000)]),redirect:'error'}),reply=await response.clone().json();
  assert.ok(response.ok);observer.acknowledged(event,reply,performance.now());
  for(const item of reply.results??[]){if(item.type==='error')errors++;for(const error of item.response?.result?.step_errors??[])if(error)errors++;}return response;
 }catch(error){requestErrors++;throw error;}finally{pending--;}
};
globalThis.fetch=fetchOwned;const db=createDb({url,phase4Keys:keys,fetch:fetchOwned});
const checked=name=>{const tx=observer.assertComplete(name);assert.ok(tx.every(t=>t.outcome==='COMMIT'&&t.upperBoundMs<5000),'ALL_EXPLICIT_READER_TX_BELOW_5S');return tx;};
const retainedTables=fixture.tables.filter(t=>!new Set(['resource_locks','stage8_scoped_read_audit','stage8_live_publications']).has(t.name));
const retainedDigest=groups=>keys.lookup(['r22-reader-retained-graph-v1',groups]);
const fixtureHealthDigest=retainedDigest(retainedTables.map(t=>[t.name,t.rows.map(row=>JSON.stringify(t.columns.map((c,i)=>[c,row[i]]).sort(([a],[b])=>a<b?-1:a>b?1:0))).sort()]));
async function healthDigest(){
 const values=await db.raw.batch(retainedTables.map(t=>'SELECT * FROM '+q(t.name)),'deferred');
 return retainedDigest(values.map((value,i)=>[retainedTables[i].name,value.rows.map(row=>JSON.stringify(value.columns.slice().sort().map(c=>[c,row[c]]))).sort()]));
}
try{
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);
 const statements=[...fixture.schema.filter(r=>r.type==='table').map(r=>r.sql),'PRAGMA defer_foreign_keys=ON'];
 for(const table of fixture.tables)for(const row of table.rows)statements.push(exactRealStatement({sql:`INSERT INTO ${q(table.name)}(${table.columns.map(q).join(',')}) VALUES(${row.map(()=>'?').join(',')})`,args:row}));
 statements.push(...fixture.schema.filter(r=>r.type!=='table').map(r=>r.sql));await db.raw.batch(statements,'write');
 assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 const admission=await db.admitRuntime(),capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:manifest.baseCommit,configProof:keys.lookup(['r22-reader-only-native',manifest.files]),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,
  processing:{client:db.raw,transaction:db.transaction,withReadSnapshot:db.withProcessingReadSnapshot,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.equal(id,'a');}});
 phase='VERIFY';const before=await healthDigest();assert.equal(before,fixtureHealthDigest,'EXACT_IMPORTED_CANONICAL_GRAPH_REQUIRED');checked(phase);
 phase='PUBLICATION';const ctx=await core.capture('a',{executionMode:'LIVE',providerRequired:true});await publishStage8Live(core,ctx,capability);assert.equal(await verifyStage8LivePublication(core,ctx),true);checked(phase);
 const reader=createStage8DerivedReader({db,keys,admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({db,keys,admission,derivedReader:reader}),kinds=[];
 phase='SCOPE';const scope=await scopes.open({user:await db.getUser('a'),chatId:'10001',text:'/insights'});checked(phase);
 for(const kind of ['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']){
  phase='READER_'+kind;const start=performance.now(),http=requests,value=await scopes.derived(scope,kind);
  assert.equal(value.status,'CURRENT');if(kind==='EVIDENCE')assert.equal(value.items.length,8);if(kind==='EPISODES'||kind==='INSIGHTS')assert.equal(value.items.length,0,'NO_MANUFACTURED_RESULT');
  if(kind==='BODY_ENERGY')assert.ok(value.items.length===1&&value.items.every(item=>item.quality==='LIMITED'&&item.provisional===true&&item.estimated===true&&Number.isInteger(item.value)&&item.value>=0&&item.value<=100));
  const tx=checked(phase),packet={kind,status:value.status,items:value.items.length,http:requests-http,elapsedMs:performance.now()-start,transactions:tx};kinds.push(packet);console.log('R22_NATIVE_READER_KIND '+JSON.stringify(packet));
 }
 phase='REPLY_VERIFY';const reply=await scopes.sealReply(scope,{text:'SYNTHETIC_CANONICAL_REPLY'});
 assert.equal(reply.stage8ReplyGuard.derivedReads.length,4);
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),true,'ORIGINAL_FOUR_KIND_REPLY_GUARD');checked(phase);
 console.log('R22_NATIVE_READER_REPLY '+JSON.stringify({verified:true,kinds:4,diagnostics:reader.preparedStatus(),transactions:observer.transactions.filter(t=>t.phase===phase)}));
 phase='VERIFY';assert.equal(await healthDigest(),before,'READER_CHANGED_RETAINED_HEALTH_OR_ORIGINAL_AUTHORITY');assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);checked(phase);
 report={status:'NATIVE_READER_ONLY_COMPONENT_PASS',sourceRows:17,kinds,originalFourKindReplyGuardVerified:true,preparedDiagnostics:reader.preparedStatus(),retainedHealthAndOriginalAuthorityUnchanged:true,fixture:'EXACT_GENUINE_PROTOCOL_COMPUTATION_COPY_NOT_NATIVE_WORK',nativeWorkInvocations:0,fullProducerQualified:false,stage6HranaQualified:false,actualProviderEvidence:false,productionEvidence:false};
}catch(error){primaryFailure=error;report={status:'NATIVE_READER_ONLY_COMPONENT_FAILED',phase,errorCode:error.code??error.name,message:String(error.message).slice(0,300),nativeWorkInvocations:0,stage6HranaQualified:false,productionEvidence:false};}
finally{
 try{db.close();}catch(error){cleanupFailure=error;}
 try{const until=performance.now()+4000;while((observer.streams.size||pending)&&performance.now()<until)await new Promise(r=>setTimeout(r,20));assertPreparedNativeFinalObservation(observer,pending);assert.equal(errors,0,'NATIVE_SQL_RESPONSE_ERRORS');assert.equal(requestErrors,0,'NATIVE_REQUEST_ERRORS_EVEN_IF_RECOVERED');}catch(error){cleanupFailure=preparedNativeFailure(cleanupFailure,error);}
 failure=preparedNativeFailure(primaryFailure,cleanupFailure);
 if(!failure)try{
  const body={contract:'r22-native-reader-only-ack-v1',manifestDigest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),pid:process.pid,report:{...report,requestErrors,responseErrors:errors,openStreams:observer.streams.size,pendingRequests:pending,ownedMemoryPerTransaction:'UNKNOWN'},transportJoined:true},file=await open(resolve(root,'..','native-reader-ack.json'),'wx',0o600);
  try{await file.writeFile(JSON.stringify({...body,seal:keys.lookup(['r22-native-reader-only-ack-v1',body])}));await file.sync();}finally{await file.close();}
  const directory=await open(resolve(root,'..'),'r');try{await directory.sync();}finally{await directory.close();}
 }catch(error){cleanupFailure=error;failure=preparedNativeFailure(primaryFailure,cleanupFailure);}
 console.log('R22_NATIVE_READER_WORKER '+JSON.stringify({...report,status:failure?'NATIVE_READER_ONLY_COMPONENT_FAILED':report.status,primaryError:preparedNativeErrorSummary(primaryFailure),cleanupError:preparedNativeErrorSummary(cleanupFailure),failure:preparedNativeErrorSummary(failure),requests,errors,requestErrors,openStreams:observer.streams.size,pendingRequests:pending,ownedMemoryPerTransaction:'UNKNOWN',transactions:observer.transactions,observation:observer.counts}));
}
if(failure)process.exitCode=1;
