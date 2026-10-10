#!/usr/bin/env node
// Local synthetic history benchmark. All v32 triggers stay installed. No env,
// production URL/credentials, mutation, deletion, or assertion of provider quota.
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {createOwnedDb} from '../test/stage5OwnedDb.js';import {openHttpFixture,fixtureKeys} from '../test/deliveryDefaultFixture.js';
import {canonicalPhaseRequest,configurationProof,reconcileExecution} from '../src/phase4ExecutionStore.js';
import {discoverExecutionContinuation} from '../src/phase4Execution.js';import {runningReleaseSha} from '../src/phase4Release.js';
const output=process.argv[2];if(!/^tmp\/[\w/-]+$/.test(output??''))throw Error('LOCAL_OUTPUT_REQUIRED');await mkdir(output,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),'ledger-capacity-')),url='file:'+join(dir,'db.sqlite');let http;
const db=createOwnedDb({url});const hash=s=>createHash('sha256').update(s).digest('hex');
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'},releaseSha=runningReleaseSha();
const proof=configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment,releaseSha);
const query={releaseSha,executionMode:'SHADOW',triggerSource:'cloudflare',configProof:proof};
const samples=[],requests=[];let last=0,discoveryStatement;
try {
 await db.migrate({targetVersion:32});for(const id of ['a','b','c'])await db.createUser({id,displayName:id,status:'ACTIVE'});
 http=openHttpFixture(url);const execute=http.db.raw.execute;http.db.raw.execute=statement=>{if(statement.sql?.startsWith('SELECT e.*'))discoveryStatement=statement;return execute(statement);};
 const tables=(await db.raw.execute("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE '%receipt%' OR name LIKE '%audit%' OR name LIKE '%producer%' OR name LIKE '%execution%') ORDER BY name")).rows.map(x=>x.name);
 async function add(request){
  const body=canonicalPhaseRequest(request),identity=hash(body),scope=hash(JSON.stringify(['phase4-execution-scope-v1',request.phase,'SHADOW',proof])),now=Date.now(),owner='synthetic-capacity-owner';
  const inserted=await db.raw.execute({sql:`INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,sync_execution_id,owner,generation,lease_until,deadline_at,state,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'SHADOW','cloudflare',?,?,?,1,?,?,'ESTABLISHED',?,?)`,args:[request.requestId,identity,scope,body,request.phase,releaseSha,proof,request.syncRequestId??null,owner,now+180000,now+180000,now,now]});
  const seq=Number(inserted.lastInsertRowid);
  for(const uid of ['a','b','c']) {
   const receipt=hash(request.requestId+uid);await db.raw.execute({sql:`INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,1,?,'true')`,args:[request.requestId,receipt,scope,identity,receipt,now]});
   if(request.phase==='STAGE6_DRAIN')await db.raw.execute({sql:`INSERT INTO phase4_execution_producers(user_id,execution_mode,input_generation,producing_execution_id,producing_generation,execution_seq,tenant_proof) VALUES(?,'SHADOW',0,?,1,?,?)`,args:[uid,request.requestId,seq,fixtureKeys.lookup(['execution-producer-v1',uid,'SHADOW',0,request.requestId,seq,1])]});
  }
  const result=JSON.stringify({version:2,releaseSha,phase:request.phase,source:'cloudflare',identity,executionMode:'SHADOW',configProof:proof,outcome:request.phase==='SYNC'?'NO_NEW_DATA_SUCCESS':'NO_WORK'});
  await db.raw.execute({sql:`UPDATE phase4_executions SET state='WORK_COMMITTED',result_json=?,result_digest=?,work_committed_at=?,updated_at=? WHERE execution_id=?`,args:[result,hash(result),now,now,request.requestId]});
  await db.raw.execute({sql:`UPDATE phase4_executions SET state='FINALIZED_SUCCESS',finalized_at=?,updated_at=? WHERE execution_id=?`,args:[now,now,request.requestId]});
 }
 for(const pairs of [0,100,1000,10000]) {
  const start=performance.now();
  await db.transaction(async()=>{for(let n=last;n<pairs;n++){
   const sync={...query,requestId:`p4c1_capacity_${String(n).padStart(10,'0')}_sync`,phase:'SYNC'};await add(sync);requests.push(sync);
   await add({...query,requestId:`p4c1_capacity_${String(n).padStart(10,'0')}_drain`,phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:'a'.repeat(64)});
  }});last=pairs;
  const timings=[];for(let n=0;n<10;n++){const at=performance.now();const found=await discoverExecutionContinuation({query,db:http.db,keys:fixtureKeys,environment});assert.equal(found.body.state,'NONE');timings.push(performance.now()-at);}
  const rows={};for(const table of tables)rows[table]=(await db.raw.execute(`SELECT count(*) n FROM "${table.replaceAll('"','""')}"`)).rows[0].n;
  const storage={pages:(await db.raw.execute('PRAGMA page_count')).rows[0].page_count,pageBytes:(await db.raw.execute('PRAGMA page_size')).rows[0].page_size};
  let objectBytes;try{objectBytes=(await db.raw.execute('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name')).rows.map(x=>({...x}));}catch{objectBytes='DBSTAT_UNAVAILABLE';}
  let replayMs=null;if(pairs){const at=performance.now();assert.equal((await reconcileExecution(http.db,requests[0],hash(canonicalPhaseRequest(requests[0])))).state,'FINALIZED_SUCCESS');replayMs=performance.now()-at;}
  const plan=(await db.raw.execute({sql:'EXPLAIN QUERY PLAN '+discoveryStatement.sql,args:discoveryStatement.args})).rows.map(x=>({...x}));
  samples.push({pairs,users:3,rows,storage,objectBytes,discoveryMs:timings,replayMs,plan,buildMs:performance.now()-start});
  await writeFile(join(output,'capacity.json'),JSON.stringify({node:process.version,head:releaseSha,fixture:'SYNTHETIC_V32_TRIGGER_ENFORCED_HISTORY_REAL_HTTP_HRANA_QUERIES',productionMutation:'NONE',cron:'*/10 0-3 * * *',cronInvocationsPerDay:24,samples,providerQuota:'UNVERIFIED'},null,2));
  console.log(JSON.stringify({pairs,rows,storage,discoveryMaxMs:Math.max(...timings),replayMs}));
 }
 await assert.rejects(()=>db.raw.execute('DELETE FROM phase4_executions'),/p4_execution_no_delete/);
 await assert.rejects(()=>db.raw.execute('DELETE FROM phase4_execution_work_receipts'),/p4_execution_receipt_no_delete/);
} finally {http?.close();await db.close();await rm(dir,{recursive:true,force:true});}
