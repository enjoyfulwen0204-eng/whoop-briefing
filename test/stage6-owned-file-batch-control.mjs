// Test-only physical FILE preparation. No activity occurs on import.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {OFFLINE_LIVE_TABLES} from './stage8LiveLinuxFixture.js';
import {FILE48_ARGV,FILE48_TOKEN,validateChildResourceSample,validateChildResourceShape} from './stage6-native-file48-eof-resource.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const HEX=/^[a-f0-9]{64}$/,integer=x=>Number.isSafeInteger(x)&&x>=0;
const exact=(o,names)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Reflect.ownKeys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k));
export function canonicalOwnedRow(row){const value=x=>x===null?['null']:typeof x==='string'?['string',x]:typeof x==='number'&&Number.isFinite(x)?['number',x]:typeof x==='bigint'?['bigint',String(x)]:x instanceof ArrayBuffer?['bytes',Buffer.from(x).toString('base64')]:ArrayBuffer.isView(x)?['bytes',Buffer.from(x.buffer,x.byteOffset,x.byteLength).toString('base64')]:(()=>{throw Error('UNSUPPORTED_ROW_VALUE');})();return JSON.stringify(Object.keys(row).sort().map(k=>[k,value(row[k])]));}
export async function fingerprintOwnedFile(db,keys){
 const rows=async table=>(await db.raw.execute('SELECT * FROM '+table)).rows;
 const durable={},sources={};
 for(const table of ['stage8_live_executions','stage8_live_execution_work_receipts','phase4_jobs','phase4_computation_state'])durable[table]=(await rows(table)).map(canonicalOwnedRow).sort();
 let sourceRows=0;for(const table of Object.values(OFFLINE_LIVE_TABLES)){sources[table]=(await rows(table)).map(canonicalOwnedRow).sort();sourceRows+=sources[table].length;}
 sources.phase4_user_state=(await rows('phase4_user_state')).map(canonicalOwnedRow).sort();
 const generations=(await db.raw.execute('SELECT user_id,execution_mode,input_generation,source_generation_seen,algorithm_set_version FROM phase4_computation_state ORDER BY user_id,execution_mode')).rows.map(canonicalOwnedRow);
 const executions=await rows('stage8_live_executions');for(const row of executions){assert.equal(row.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(keys,row);}
 assert.equal(sourceRows,160);assert.equal(durable.phase4_jobs.length,2);
 const digest=o=>keys.lookup(['native-physical-batch-fingerprint-v1',o]);
 return {durableDigest:digest(durable),sourceDigest:digest(sources),generationDigest:digest(generations),executionCount:executions.length,receiptCount:durable.stage8_live_execution_work_receipts.length,jobsCount:2,sourceRows};
}
export function validateFingerprint(v){
 assert.ok(exact(v,['durableDigest','sourceDigest','generationDigest','executionCount','receiptCount','jobsCount','sourceRows']));
 for(const k of ['durableDigest','sourceDigest','generationDigest'])assert.match(v[k]??'',HEX);
 for(const k of ['executionCount','receiptCount','jobsCount','sourceRows'])assert.ok(integer(v[k]));
 assert.equal(v.jobsCount,2);assert.equal(v.sourceRows,160);return true;
}
export function validateBatchPacket(v,{mode,ordinal,pid,parentPID}){
 assert.ok(exact(v,['contract','mode','ordinal','pid','parentPID','closed','failed','failureType','completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted','ready','descriptorSHA256','after','catalogDigest','elapsedMs','memory','productionEvidence','LinuxQualification','EOFQualified','capacityQualified']));
 assert.equal(v.contract,'native-physical-owned-file-batch-child-v1');assert.equal(v.mode,mode);assert.equal(v.ordinal,ordinal);assert.equal(v.pid,pid);assert.equal(v.parentPID,parentPID);
 for(const k of ['ordinal','pid','parentPID','completedCalls','callsWithUnitsOrCompletedJobs','sourceAcknowledgments','unitsCommitted'])assert.ok(integer(v[k]));
 assert.ok(v.pid>0&&v.parentPID>0&&v.completedCalls<=2&&v.callsWithUnitsOrCompletedJobs<=1&&v.callsWithUnitsOrCompletedJobs<=v.completedCalls&&(v.unitsCommitted===0||v.callsWithUnitsOrCompletedJobs===1)&&v.sourceAcknowledgments+v.unitsCommitted<=48);
 for(const k of ['closed','failed','ready'])assert.equal(typeof v[k],'boolean');assert.ok([null,'Error','AssertionError','OTHER','CLOSE_FAILURE'].includes(v.failureType));
 assert.ok(Number.isFinite(v.elapsedMs)&&v.elapsedMs>=0);assert.ok(exact(v.memory,['rss','heapUsed','heapTotal','external'])&&Object.values(v.memory).every(x=>Number.isFinite(x)&&x>=0));
 for(const k of ['productionEvidence','LinuxQualification','EOFQualified','capacityQualified'])assert.equal(v[k],false);
 if(v.after!==null)validateFingerprint(v.after);if(v.catalogDigest!==null)assert.match(v.catalogDigest,HEX);
 if(v.failed)assert.equal(v.descriptorSHA256,null);
 else{assert.equal(v.closed,true);assert.equal(v.failureType,null);assert.match(v.descriptorSHA256??'',HEX);assert.match(v.catalogDigest??'',HEX);validateFingerprint(v.after);assert.equal(v.after.executionCount,ordinal+v.completedCalls);assert.ok(mode==='BATCH'?v.completedCalls>=1:v.completedCalls===0);}
 return true;
}
export function validateBatchAck(v,packet,keys){
 assert.ok(exact(v,['contract','selected','mode','ordinal','nextOrdinal','snapshot','catalogDigest','closed','ready','seal']));
 const {seal,...body}=v;assert.match(seal??'',HEX);assert.equal(seal,keys.lookup(['native-owned-file-batch-ack-v1',body]));
 assert.equal(body.contract,'native-owned-file-batch-durable-ack-v1');assert.equal(body.mode,packet.mode);assert.equal(body.ordinal,packet.ordinal);assert.ok(integer(body.ordinal)&&integer(body.nextOrdinal));
 assert.equal(body.selected,body.mode==='INIT'?'init':body.mode==='VERIFY'?'verify-'+body.ordinal:'batch-'+body.ordinal);
 assert.equal(body.nextOrdinal,packet.ordinal+packet.completedCalls);assert.equal(body.closed,true);assert.equal(body.ready,packet.ready);assert.deepEqual(body.snapshot,packet.after);assert.equal(body.catalogDigest,packet.catalogDigest);return body;
}
async function until(promise,end){let timer;try{return await Promise.race([promise.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,end-performance.now()));})]);}finally{clearTimeout(timer);}}
async function runOne({directory,mode,ordinal,previous,deadline,candidateSha,keys}){
 const remaining=deadline-performance.now();assert.ok(remaining>0,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 let child,closed=false,terminal=null,firstError=null,wake,resolveClose,totalBytes=0,overflow=false,term=false,killed=false;
 const awakened=new Promise(r=>{wake=r;}),joined=new Promise(r=>{resolveClose=r;}),stdout=[],stderr=[],outHash=createHash('sha256'),errHash=createHash('sha256');
 const fault=code=>{if(firstError===null)firstError=code;wake();};
 try{child=spawn(process.execPath,[...FILE48_ARGV,'test/stage6-owned-file-physical-batch-worker.mjs',directory,mode,String(ordinal),previous],{cwd:ROOT,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8',NODE_ENV:'test',EXPECTED_CANDIDATE_SHA:candidateSha,STAGE6_CHILD_PROFILE:FILE48_TOKEN}});}
 catch{throw Error('BATCH_SPAWN_FAILED');}
 const collect=(target,hash)=>chunk=>{try{hash.update(chunk);totalBytes+=chunk.length;if(totalBytes>4*1024*1024){overflow=true;fault('BATCH_LOG_OVERFLOW');}else if(!overflow)target.push(chunk);}catch{fault('BATCH_LOG_IO_ERROR');}};
 child.on('error',()=>fault('BATCH_PROCESS_ERROR'));
 child.once('close',(code,signal)=>{closed=true;terminal={code,signal};resolveClose();wake();});
 try{
  child.stdout.on('data',collect(stdout,outHash));child.stderr.on('data',collect(stderr,errHash));
  child.stdout.on('error',()=>fault('BATCH_STDOUT_ERROR'));child.stderr.on('error',()=>fault('BATCH_STDERR_ERROR'));
 }catch{fault('BATCH_STDIO_SETUP_ERROR');}
 if(!await until(awakened,deadline))fault('BATCH_AGGREGATE_DEADLINE');
 if(!closed){
  const cleanupStart=performance.now();
  if(Number.isSafeInteger(child.pid)&&child.pid>0){try{process.kill(-child.pid,'SIGTERM');term=true;}catch(error){if(error.code!=='ESRCH')fault('BATCH_TERM_FAILED');}}
  if(!await until(joined,cleanupStart+3000)){
   if(Number.isSafeInteger(child.pid)&&child.pid>0){try{process.kill(-child.pid,'SIGKILL');killed=true;}catch(error){if(error.code!=='ESRCH')fault('BATCH_KILL_FAILED');}}
   await until(joined,cleanupStart+8000);
  }
 }
 if(!closed){
  // Do not orphan or advance. The original300/330/350 outer authorities remain.
  console.log('STAGE6_NATIVE_BATCH_JOIN_UNKNOWN '+JSON.stringify({mode,ordinal,pid:Number.isSafeInteger(child.pid)?child.pid:null,physicalChildJoined:false,productionEvidence:false}));
  await new Promise(()=>{});
 }
 const evidence={mode,ordinal,pid:Number.isSafeInteger(child.pid)?child.pid:null,parentPID:process.pid,terminal,physicalChildJoined:true,TERMRequested:term,KILLRequested:killed,error:firstError,totalLogBytes:totalBytes,stdoutSHA256:outHash.digest('hex'),stderrSHA256:errHash.digest('hex'),packet:null,resource:null};
 let packet=null,resource=null;
 try{
  assert.equal(overflow,false);const lines=Buffer.concat(stdout).toString('utf8').split('\n'),packets=lines.filter(s=>s.startsWith('STAGE6_NATIVE_PHYSICAL_BATCH_PACKET '));assert.equal(packets.length,1);
  const value=JSON.parse(packets[0].split('STAGE6_NATIVE_PHYSICAL_BATCH_PACKET ')[1]);validateBatchPacket(value,{mode,ordinal,pid:child.pid,parentPID:process.pid});packet=value;evidence.packet=value;
 }catch{fault('BATCH_PACKET_UNAVAILABLE_OR_INVALID');}
 try{
  assert.equal(overflow,false);const resources=Buffer.concat(stdout).toString('utf8').split('\n').filter(s=>s.startsWith('STAGE6_FILE48_EOF_CHILD_RESOURCE '));assert.equal(resources.length,1);
  const value=JSON.parse(resources[0].split('STAGE6_FILE48_EOF_CHILD_RESOURCE ')[1]);validateChildResourceShape(value,candidateSha,{pid:child.pid,parentPid:process.pid});resource=value;evidence.resource=value;
 }catch{fault('BATCH_RESOURCE_UNAVAILABLE_OR_INVALID');}
 evidence.error=firstError;
 try{
  assert.equal(firstError,null);assert.equal(overflow,false);assert.deepEqual(terminal,{code:0,signal:null});assert.ok(performance.now()<deadline,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
  validateChildResourceSample(resource,candidateSha,{pid:child.pid,parentPid:process.pid});
  assert.equal(packet.failed,false);const name=mode==='INIT'?'init':mode==='VERIFY'?'verify-'+ordinal:'batch-'+ordinal,path=join(directory,name+'.private.json');assert.equal((await lstat(path)).isSymbolicLink(),false);
  const raw=await readFile(path);assert.ok(raw.length<32768);assert.equal(createHash('sha256').update(raw).digest('hex'),packet.descriptorSHA256);const ack=validateBatchAck(JSON.parse(raw),packet,keys);
  return {ok:true,evidence,ack};
 }catch{if(evidence.error===null)evidence.error='BATCH_ACK_RESOURCE_OR_JOIN_INVALID';return {ok:false,evidence,ack:null};}
}
export async function runOwnedPreparationBatches({directory,keys,started,candidateSha,onProgress=()=>{}}){
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.match(candidateSha??'',/^[a-f0-9]{40}$/);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',timeout:2000}).trim(),candidateSha);
 const root=await realpath(directory);assert.equal(root,directory);assert.equal(dirname(root),await realpath(tmpdir()));assert.match(basename(root),/^healthos-local-owned-file-batch-[a-zA-Z0-9_-]+$/);assert.equal((await lstat(root)).isSymbolicLink(),false);
 assert.ok(Number.isFinite(started)&&started<=performance.now());const deadline=started+120000,evidence=[];let ordinal=0,previous='NONE',last=null,batches=0,sourceAcknowledgments=0,unitsCommitted=0;
 const issue=async(mode,index)=>{
  const result=await runOne({directory,mode,ordinal:index,previous,deadline,candidateSha,keys});evidence.push(result.evidence);
  onProgress({physicalChildrenJoined:evidence.length,preparationBatches:batches,lastBatchOrdinal:index,completedPreparations:ordinal,sourceAcknowledgments,unitsCommitted});
  if(!result.ok){console.log('STAGE6_NATIVE_BATCH_FAILURE '+JSON.stringify(result.evidence));throw Error('OWNED_PREPARATION_BATCH_FAILED');}
  const ack=result.ack;
  if(last){assert.equal(ack.snapshot.sourceDigest,last.snapshot.sourceDigest);assert.equal(ack.snapshot.generationDigest,last.snapshot.generationDigest);assert.equal(ack.catalogDigest,last.catalogDigest);assert.ok(ack.snapshot.receiptCount>=last.snapshot.receiptCount);}
  last=ack;previous=ack.selected;return result;
 };
 await issue('INIT',0);assert.equal(last.snapshot.executionCount,0);assert.equal(last.ready,false);
 while(!last.ready&&ordinal<64){
  const next=await issue('BATCH',ordinal);assert.ok(next.evidence.packet.completedCalls>=1&&next.evidence.packet.completedCalls<=2);ordinal=next.ack.nextOrdinal;batches++;
  sourceAcknowledgments+=next.evidence.packet.sourceAcknowledgments;unitsCommitted+=next.evidence.packet.unitsCommitted;
  onProgress({physicalChildrenJoined:evidence.length,preparationBatches:batches,lastBatchOrdinal:next.evidence.ordinal,completedPreparations:ordinal,sourceAcknowledgments,unitsCommitted});
 }
 assert.equal(last.ready,true,'ORIGINAL_NONEMPTY_CURSOR_REQUIRED');
 // The existing fresh parent FILE readback must verify this authenticated
 // snapshot, quick_check, typed rows/schema and close before the same120s limit.
 assert.ok(performance.now()<deadline,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 assert.equal(evidence.length,batches+1);assert.equal(ordinal,last.snapshot.executionCount);
 return {ready:true,workCalls:ordinal,batches,physicalChildrenJoined:evidence.length,snapshot:last.snapshot,catalogDigest:last.catalogDigest,sourceAcknowledgments,unitsCommitted,evidence};
}
