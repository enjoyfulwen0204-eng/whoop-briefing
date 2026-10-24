// Pure fake transport: no network, database creation or user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {inflightControlReadKey,ownershipControlReadKey,contextLeaseDataReadKey,tenantLeaseDataReadKey} from '../src/processingInflightControlReads.js';
import {processingTransactions,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution,withExecutionReceiptTransaction} from '../src/phase4ExecutionContext.js';
import {withExecutionBudget} from '../src/executionBudget.js';
globalThis.fetch=()=>{throw Error('PURE_TEST_NETWORK_FORBIDDEN');};
const UID='synthetic-pending-principal';
const STATE=`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,
 COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
 LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`;
const READY=`SELECT u.status,o.state,COALESCE(t.auth_generation,0) auth_generation,p.pending_purge_count
 FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
 LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`;
const normal=s=>s.replace(/\s+/g,' ').trim();
const context=()=>Object.freeze({userId:UID,executionMode:'LIVE',providerRequired:true});
const query=sql=>({sql,args:[UID]});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
class Result{toJSON(){return this.rows;}}
function result(status='ACTIVE'){
 const row={status,state:'READY',auth_generation:1,pending_purge_count:0};
 Object.defineProperty(row,'0',{value:status,writable:true,enumerable:false});
 return Object.assign(new Result(),{columns:['status','state','auth_generation','pending_purge_count'],columnTypes:['TEXT','TEXT','INTEGER','INTEGER'],rows:[row],rowsAffected:0,lastInsertRowid:undefined});
}
function fixture(sql,{protocol='http',privateRuntime=true,mode='LIVE',phase='STAGE6_DRAIN',providerRequired=true}={}){
 const h={context:Object.freeze({...context(),executionMode:mode,providerRequired}),reads:[],checks:0,predicates:0,bodies:0,commits:0,rollbacks:0,status:'ACTIVE'};
 h.execution={receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}};
 let expired=false;const ac=new AbortController();h.expire=()=>{expired=true;};h.abort=()=>ac.abort();
 h.clock={signal:ac.signal,deadlineAt:Date.now()+100000,assert(){if(expired||ac.signal.aborted)throw Error('SYNC_TIMEOUT');},remainingMs:()=>expired?0:100000};
 async function execute(q){const text=typeof q==='string'?q:q.sql;
  if(normal(text)===normal(sql)){const captured=h.status;h.reads.push(text);await setImmediate();if(h.hold)await h.hold.promise;if(h.fail)throw h.fail;return result(captured);}
  if(text==='UPDATE synthetic_control SET n=1')h.status='SUSPENDED';return result();
 }
 const base={protocol,execute,batch:qs=>Promise.all(qs.map(execute)),async transaction(){return {closed:false,execute,batch:qs=>Promise.all(qs.map(execute)),async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});h.query=()=>h.api.client.execute(query(sql));
 h.check=readOnlyProcessingCheck(async()=>{const index=++h.checks,r=await h.query();h.predicates++;
  assert.equal(Object.getPrototypeOf(r),Result.prototype);assert.equal(r.rows[0][0],r.rows[0].status);
  if(r.rows[0].status!=='ACTIVE'||h.denyIndex===index)throw Error('ORIGINAL_PRINCIPAL_REJECTED');
  r.rows[0].status='PRIVATE_MUTATION';r.rows[0][0]='PRIVATE_MUTATION';
 });
 h.scope=fn=>withExecutionBudget(h.clock,()=>withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,fn)));
 h.all=()=>Promise.all(Array.from({length:32},()=>h.api.transaction(()=>{h.bodies++;},{before:h.check})));
 return h;
}
for(const [name,sql]of [['user-state',STATE],['principal-readiness',READY]]){
 test(name+': only exact LIVE tenant-bound non-health shapes enter pending-only pool',()=>{
  const c=context(),q=query(sql);assert.ok(inflightControlReadKey(q,c));
  for(const key of [ownershipControlReadKey,contextLeaseDataReadKey,tenantLeaseDataReadKey])assert.equal(key(q,c),null);
  for(const bad of [{...q,args:['other']},{...q,args:[UID,'extra']},{...q,args:[UID,1]},{...q,sql:sql+' OR 1=1'},{...q,sql:sql+';'}, {sql:'SELECT status FROM users WHERE id=?',args:[UID]}])assert.equal(inflightControlReadKey(bad,c),null);
  for(const c2 of [{...c,providerRequired:false},{...c,executionMode:'SHADOW'}])assert.equal(inflightControlReadKey(q,c2),null);
  assert.notEqual(inflightControlReadKey(q,c),inflightControlReadKey({sql:normal(sql),args:[UID]},c));
 });
 test(name+': 32 cold guards submit one read, preserve all predicates and independent row clones',async()=>{
  const h=fixture(sql);await h.scope(()=>h.api.transaction(async()=>{await h.all();assert.equal(h.reads.length,1);assert.equal(h.checks,32);assert.equal(h.predicates,32);assert.equal(h.bodies,32);}));assert.equal(h.commits,1);assert.equal(h.rollbacks,0);
 });
 test(name+': own mutation prevents joining an earlier pending epoch and freshly rejects revoked principal',async()=>{
  const h=fixture(sql);h.hold=deferred();let first,second;
  await assert.rejects(h.scope(()=>h.api.transaction(async()=>{
   first=h.api.transaction(()=>{}, {before:h.check});while(h.reads.length<1)await setImmediate();
   await h.api.client.execute('UPDATE synthetic_control SET n=1');
   second=h.api.transaction(()=>{}, {before:h.check});while(h.reads.length<2)await setImmediate();
   h.hold.resolve();await Promise.all([first,second]);
  })),/ORIGINAL_PRINCIPAL_REJECTED/);assert.equal(h.reads.length,2);assert.equal(h.predicates,2);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
 });
 test(name+': each caller still rejects its own changed predicate after a shared result',async()=>{
  const h=fixture(sql);h.denyIndex=7;
  await assert.rejects(h.scope(()=>h.api.transaction(h.all)),/ORIGINAL_PRINCIPAL_REJECTED/);
  assert.equal(h.reads.length,1);assert.equal(h.checks,32);assert.equal(h.predicates,32);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
 });
 test(name+': physical rejection preserves original error and rollback for all guards',async()=>{
  const h=fixture(sql);h.fail=Error('ORIGINAL_QUERY_FAILURE');
  await assert.rejects(h.scope(()=>h.api.transaction(h.all)),e=>e===h.fail);
  assert.equal(h.reads.length,1);assert.equal(h.predicates,0);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
 });
 test(name+': exact context, budget, execution and receipt marker remain isolated',async()=>{
  for(const kind of ['context','budget','execution','marker']){
   const h=fixture(sql);await h.scope(()=>h.api.transaction(async()=>{
    const check=readOnlyProcessingCheck(async()=>{const a=h.query();
     const b=kind==='context'?h.api.withReadSnapshot({...h.context},h.query):kind==='budget'?withExecutionBudget({...h.clock},h.query):kind==='execution'?withDurableExecution({...h.execution},h.query):withExecutionReceiptTransaction(h.query);
     await Promise.all([a,b]);
    });await h.api.transaction(()=>{}, {before:check});assert.equal(h.reads.length,2);
   }));
  }
 });
 test(name+': public, file, SHADOW, SYNC and non-provider paths keep their original physical observations',async()=>{
  for(const options of [{privateRuntime:false},{protocol:'file'},{mode:'SHADOW'},{phase:'SYNC'},{providerRequired:false}]){
   const h=fixture(sql,options);await h.scope(()=>h.api.transaction(h.all));assert.equal(h.reads.length,32);assert.equal(h.predicates,32);
  }
 });
 test(name+': deadline and abort remain authoritative after a warmed snapshot',async()=>{
  for(const action of ['expire','abort']){const h=fixture(sql);await assert.rejects(h.scope(()=>h.api.transaction(async()=>{await h.api.transaction(()=>{}, {before:h.check});h[action]();await h.api.transaction(()=>{}, {before:h.check});})),/SYNC_TIMEOUT/);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);}
 });
}
test('allowlisted projections match original producers without changing producer predicates',()=>{
 const state=readFileSync(new URL('../src/phase4Core.js',import.meta.url),'utf8');
 const producer=readFileSync(new URL('../src/stage8LiveProducer.js',import.meta.url),'utf8');
 assert.ok(normal(state).includes(normal(STATE)));assert.ok(normal(producer).includes(normal(READY)));
});
