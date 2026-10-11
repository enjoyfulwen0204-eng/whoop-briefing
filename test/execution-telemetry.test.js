import test from 'node:test';
import assert from 'node:assert/strict';
import {withPhaseTelemetry,traceExecutionOperation,countExecutionTelemetry} from '../src/executionTelemetry.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {operationalLogFields} from '../src/logger.js';
import {processingTransactions} from '../src/processingTransaction.js';
import {createWhoopClient} from '../src/whoop.js';
import {withRuntimeMetadata} from '../src/runtimeMetadataContext.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
const metadata={phase:'SYNC',source:'manual',releaseSha:'a'.repeat(40)};
const successful=()=>({body:{result:{outcome:'NO_NEW_DATA_SUCCESS'}}});
const summaryOf=c=>c.lines.find(l=>l.event==='phase4_trace_summary');
const collector=()=>{const lines=[];return {lines,emit:(event,fields)=>lines.push({event,...operationalLogFields(fields)})};};

test('operation diagnostics preserve results and errors while accepting no health/identity/error contents',async()=>{
 const c=collector(),health={userId:'PRIVATE_USER',healthDate:'PRIVATE_DATE',sql:'PRIVATE_SQL',token:'PRIVATE_TOKEN',score:91};
 const result=await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
  assert.equal(await traceExecutionOperation('WHOOP_SYNC',async()=>health),health);
  countExecutionTelemetry('query_count',4);countExecutionTelemetry('PRIVATE_COUNTER',100);
  const error=Object.assign(Error('PRIVATE_ERROR_TEXT'),{code:'PRIVATE_ERROR_CODE'});
  await assert.rejects(()=>traceExecutionOperation('DAILY_REPORT',async()=>{throw error;}),e=>e===error);
  assert.equal(await traceExecutionOperation('PRIVATE_OPERATION',async()=>health),health);
  return successful();
 });
 assert.deepEqual(result,successful());assert.match(c.lines[0].request_id,/^[a-f0-9-]{36}$/);
 assert.equal(summaryOf(c).query_count,4);assert.equal(summaryOf(c).outstanding_operations,0);
 assert.equal(c.lines.filter(l=>l.operation==='DAILY_REPORT'&&l.event==='phase4_operation_end')[0].outcome,'FAILED');
 assert.doesNotMatch(JSON.stringify(c.lines),/PRIVATE_|healthDate|score|sql|token/);
 assert.ok(c.lines.every(l=>l.duration_ms===undefined||Number.isSafeInteger(l.duration_ms)&&l.duration_ms>=0));
});

test('parallel admitted phases have distinct correlations and isolated counters; diagnostic failure cannot change work',async()=>{
 const a=collector(),b=collector();
 await Promise.all([withPhaseTelemetry({...metadata,emit:a.emit},async()=>{countExecutionTelemetry('whoop_requests',2);await traceExecutionOperation('WHOOP_HTTP',async()=>{await new Promise(r=>setTimeout(r,5));});return successful();}),
  withPhaseTelemetry({...metadata,emit:b.emit},async()=>{countExecutionTelemetry('telegram_requests',1);return successful();})]);
 assert.notEqual(a.lines[0].request_id,b.lines[0].request_id);assert.equal(summaryOf(a).whoop_requests,2);assert.equal(summaryOf(a).telegram_requests,0);assert.equal(summaryOf(b).whoop_requests,0);
 let work=0;assert.deepEqual(await withPhaseTelemetry({...metadata,emit:()=>{throw Error('logger down');}},async()=>{work++;return successful();}),successful());assert.equal(work,1);
});

test('timeout snapshot retains outstanding operation and never logs late work as success or grants a continuation',async()=>{
 const c=collector(),budget=createExecutionBudget({budgetMs:25});let release,lateCalls=0;
 const late=new Promise(r=>release=r);
 try{
  const result=await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
   try{await withExecutionBudget(budget,()=>budget.run(()=>traceExecutionOperation('WHOOP_HTTP',async()=>{await late;budget.assert();lateCalls++;})));}
   catch(error){assert.equal(error.code,'SYNC_TIMEOUT');return {body:{result:{outcome:'TIMEOUT'},syncComplete:false,drainAuthorized:false}};}
  });
  assert.equal(result.body.drainAuthorized,false);
  const summary=c.lines.find(l=>l.event==='phase4_trace_summary');assert.equal(summary.outcome,'TIMEOUT');assert.equal(summary.outstanding_operations,1);
  assert.equal(c.lines.at(-1).event,'phase4_operation_outstanding');assert.equal(c.lines.at(-1).operation,'WHOOP_HTTP');assert.equal(c.lines.at(-1).outcome,'PENDING');
  const count=c.lines.length;release();await new Promise(r=>setTimeout(r,5));assert.equal(lateCalls,0);assert.equal(c.lines.length,count);
 }finally{budget.close();}
});

test('parent cancellation remains typed and outstanding operations are bounded without another provider request',async()=>{
 const c=collector(),controller=new AbortController(),budget=createExecutionBudget({budgetMs:1000,signal:controller.signal});let requests=0;
 try{
  await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
   try{await withExecutionBudget(budget,()=>budget.run(()=>traceExecutionOperation('MODEL_HTTP',async()=>{requests++;controller.abort();budget.assert();})));}
   catch(error){assert.ok(['AbortError','ExecutionBudgetError'].includes(error.name));assert.throws(()=>budget.assert(),e=>e.code==='SYNC_CANCELLED');return {body:{result:{outcome:'CANCELLED'}}};}
  });
  assert.equal(requests,1);assert.equal(c.lines.find(l=>l.event==='phase4_trace_summary').outcome,'CANCELLED');
  assert.equal(c.lines.find(l=>l.event==='phase4_operation_end').outcome,'CANCELLED');
 }finally{budget.close();}
});

test('event cap bounds resource use while aggregate query and retry counts remain truthful',async()=>{
 const c=collector();
 await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
  for(let i=0;i<300;i++)await traceExecutionOperation('DB_QUERY',async()=>{countExecutionTelemetry('query_count');});
  countExecutionTelemetry('retry_count',2);return successful();
 });
 assert.equal(c.lines.length,99);const summary=summaryOf(c);assert.equal(summary.query_count,300);assert.equal(summary.retry_count,2);assert.equal(summary.dropped_events,504);assert.equal(summary.outstanding_operations,0);
});

test('existing processing adapter counts query calls and preserves root serialization without SQL/params in diagnostics',async()=>{
 const c=collector(),calls=[];let active=0,maxActive=0;
 const base={protocol:'file',execute:async statement=>{calls.push(statement);active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,2));active--;return {rows:[{privateHealth:'PRIVATE_HEALTH'}]};},batch:async()=>({rows:[]})};
 const processing=processingTransactions(base);
 await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
  const returned=await Promise.all([processing.client.execute({sql:'SELECT PRIVATE_SQL',args:['PRIVATE_USER']}),processing.client.execute('SELECT PRIVATE_SQL2')]);
  assert.equal(returned[0].rows[0].privateHealth,'PRIVATE_HEALTH');return successful();
 });
 assert.equal(calls.length,2);assert.equal(maxActive,1);assert.equal(summaryOf(c).query_count,2);assert.doesNotMatch(JSON.stringify(c.lines),/PRIVATE_/);
});

test('real WHOOP retry and cancellation seams report request/retry counts without URL, tokens, dates or records',async()=>{
 const c=collector(),budget=createExecutionBudget({budgetMs:1000});let calls=0;
 const db={getTokens:async()=>({accessToken:'PRIVATE_ACCESS_TOKEN',refreshToken:'PRIVATE_REFRESH_TOKEN',expiresAt:new Date(Date.now()+3600000)})};
 const client=createWhoopClient({db,userId:'PRIVATE_USER',clientId:'PRIVATE_ID',clientSecret:'PRIVATE_SECRET',expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
  requestSignal:budget.signal,requestDeadlineAt:budget.deadlineAt,backoffFor:()=>1,sleepImpl:async()=>{},fetchImpl:async()=>{calls++;return calls===1?new Response('{}',{status:503}):new Response(JSON.stringify({records:[{id:'PRIVATE_RECORD'}]}));}});
 try{await withPhaseTelemetry({...metadata,emit:c.emit},async()=>withExecutionBudget(budget,async()=>{const rows=await client.sleeps(new Date(),new Date());assert.equal(rows[0].id,'PRIVATE_RECORD');return successful();}));}
 finally{budget.close();}
 const summary=summaryOf(c);assert.equal(calls,2);assert.equal(summary.whoop_requests,2);assert.equal(summary.retry_count,1);assert.doesNotMatch(JSON.stringify(c.lines),/PRIVATE_|https:|records|userId/);
});


test('reserved high-level events and unconditional per-category totals survive transport detail exhaustion',async()=>{
 const c=collector();await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{
  for(let i=0;i<100;i++)await traceExecutionOperation('DB_HTTP',async()=>{});
  await traceExecutionOperation('PROACTIVE',async()=>{});return successful();
 });
 assert.equal(c.lines.filter(l=>l.operation==='PROACTIVE'&&['phase4_operation_start','phase4_operation_end'].includes(l.event)).length,2);
 const total=c.lines.find(l=>l.operation==='DB_HTTP'&&l.event==='phase4_operation_totals');assert.equal(total.count,100);assert.equal(total.completed_operations,100);assert.equal(total.failed_operations,0);
});

test('metadata admission classification measures the existing five-read contract without issuing an extra query',async()=>{
 const c=collector(),sqls=[];
 const base={protocol:'file',execute:async sql=>{sqls.push(sql);return {rows:[]};},batch:async()=>({rows:[]})},p=processingTransactions(base);
 const contract=["SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger')",'SELECT version,note FROM schema_version','SELECT target_version,step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version IN (21,22,23,32)','PRAGMA foreign_keys','SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()'];
 p.setRootAdmission(()=>withRuntimeMetadata(async()=>{for(const sql of contract)await p.client.execute(sql);}));
 await withPhaseTelemetry({...metadata,emit:c.emit},async()=>{await p.client.execute('SELECT PRIVATE_HEALTH');await p.client.execute('SELECT PRIVATE_HEALTH2');return successful();});
 assert.equal(sqls.length,12);const summary=summaryOf(c);assert.equal(summary.query_count,12);assert.equal(summary.metadata_query_count,10);assert.equal(summary.runtime_readmissions,2);
 assert.equal(c.lines.find(l=>l.operation==='DB_METADATA'&&l.event==='phase4_operation_totals').count,10);assert.doesNotMatch(JSON.stringify(c.lines),/PRIVATE_|sqlite_master|schema_version/);
});
