import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createInflightControlReads,inflightControlReadKey} from '../src/processingInflightControlReads.js';
import {processingTransactions,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution,withExecutionReceiptTransaction} from '../src/phase4ExecutionContext.js';
import {withExecutionBudget} from '../src/executionBudget.js';
const uid='synthetic-control',context=()=>Object.freeze({userId:uid,executionMode:'LIVE',providerRequired:true});
const OWN=`SELECT state,lease_owner,lease_expires_at,requested_generation,
 claimed_generation,scope_revision,claimed_scope_revision,claimed_purge_generation,claimed_lifecycle_generation,
 claimed_auth_generation FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?`;
const LOCK='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';
const own=()=>({sql:OWN,args:[uid,'LIVE','RECOMPUTE_DERIVED']});
const lock=(at='2026-10-24T00:00:00.000Z')=>({sql:LOCK,args:[`phase4-stage6-pass:${JSON.stringify([uid,'LIVE'])}`,'synthetic-owner','2026-10-24T00:01:00.000Z',at]});
class Result{toJSON(){return this.rows;}}
function result(){const row={state:'RUNNING'};Object.defineProperty(row,'0',{value:'RUNNING',enumerable:false,writable:true});return Object.assign(new Result(),{columns:['state'],columnTypes:['TEXT'],rows:[row],rowsAffected:0,lastInsertRowid:undefined});}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const marker=()=>Object.freeze({});

test('closed templates bind exact tenant/mode and every clock value without volatile SQL',()=>{
 const c=context();assert.ok(inflightControlReadKey(own(),c));assert.ok(inflightControlReadKey(lock(),c));
 for(const q of [{...own(),args:['other','LIVE','RECOMPUTE_DERIVED']},{...own(),args:[uid,'SHADOW','RECOMPUTE_DERIVED']},{...own(),sql:OWN+' OR 1=1'}, {...lock(),args:['other','owner','expiry','now']}, {...own(),args:[uid,'LIVE',12]}])assert.equal(inflightControlReadKey(q,c),null);
 assert.notEqual(inflightControlReadKey(lock('one'),c),inflightControlReadKey(lock('two'),c));
 for(const c2 of [{...c,providerRequired:false},{...c,executionMode:'SHADOW'}])assert.equal(inflightControlReadKey(own(),c2),null);
});
test('pending-only raw results are independently cloned with row aliases and prototype; settled call rereads',async()=>{
 const pool=createInflightControlReads(),c=context(),m=marker(),d=deferred();let n=0;const read=()=>{n++;return d.promise;};
 const a=pool.run(c,m,'key',0,read),b=pool.run(c,m,'key',0,read);assert.equal(n,1);d.resolve(result());const [x,y]=await Promise.all([a,b]);
 assert.equal(Object.getPrototypeOf(x),Result.prototype);assert.equal(y.rows[0][0],'RUNNING');x.rows[0].state='changed';x.rows[0][0]='changed';assert.equal(y.rows[0].state,'RUNNING');assert.equal(y.rows[0][0],'RUNNING');
 await pool.run(c,m,'key',0,read);assert.equal(n,2);
});
test('context, receipt marker, mutation epoch and closed root cannot borrow an in-flight result',async()=>{
 const pool=createInflightControlReads(),c=context(),m=marker(),d=deferred();let n=0;const read=()=>{n++;return d.promise;};
 const all=[pool.run(c,m,'key',0,read),pool.run({...c},m,'key',0,read),pool.run(c,marker(),'key',0,read),pool.run(c,m,'key',1,read)];assert.equal(n,4);
 pool.close();all.push(pool.run(c,m,'key',0,read));assert.equal(n,5);d.resolve(result());await Promise.all(all);
});
test('original physical rejection reaches every pending logical call and does not cache a failure',async()=>{
 const pool=createInflightControlReads(),c=context(),m=marker(),d=deferred(),error=Error('SYNTHETIC_QUERY_FAILURE');let n=0;const read=()=>{n++;return d.promise;};
 const all=[pool.run(c,m,'key',0,read),pool.run(c,m,'key',0,read)];d.reject(error);const r=await Promise.allSettled(all);assert.equal(n,1);assert.ok(r.every(x=>x.reason===error));
 await assert.rejects(pool.run(c,m,'key',0,read),x=>x===error);assert.equal(n,2);
});
test('pool bounds active keys and never delays physical submission behind a new queue',async()=>{
 const pool=createInflightControlReads(),c=context(),m=marker(),d=deferred();let n=0;const read=()=>{n++;return d.promise;};const all=[];
 for(let i=0;i<129;i++)all.push(pool.run(c,m,String(i),0,read));all.push(pool.run(c,m,'128',0,read));assert.equal(n,130);d.resolve(result());await Promise.all(all);
});
function fixture({protocol='http',privateRuntime=true,mode='LIVE',phase='STAGE6_DRAIN'}={}){
 const h={context:context(),physical:[],logical:0,postPredicates:0,phase:'BODY',commits:0,rollbacks:0};
 h.execution={receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}};
 h.clock={signal:new AbortController().signal,deadlineAt:Date.now()+100000,assert(){},remainingMs:()=>100000};
 async function execute(q){const sql=typeof q==='string'?q:q.sql;h.physical.push({sql,phase:h.phase});await setImmediate();if(sql===OWN&&h.holdQuery)await h.holdQuery.promise;if(h.failQuery&&sql===OWN)throw h.failQuery;return result();}
 const base={protocol,execute,batch:qs=>Promise.all(qs.map(execute)),async transaction(){return {closed:false,execute,batch:qs=>Promise.all(qs.map(execute)),async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});h.query=()=>h.api.client.execute(own());
 h.check=readOnlyProcessingCheck(async()=>{h.logical++;const r=await h.query();h.postPredicates++;if(r.rows[0].state!=='RUNNING')throw Error('OWNERSHIP_REJECTED');});
 h.scope=fn=>withExecutionBudget(h.clock,()=>withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,fn)));
 h.checks=()=>Promise.all(Array.from({length:32},()=>h.api.transaction(()=>{}, {before:h.check,after:h.check})));
 h.count=phase=>h.physical.filter(x=>x.sql===OWN&&(!phase||x.phase===phase)).length;return h;
}
test('all32 original before predicates still run; terminal32 observations are freshly physical',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(async()=>{await h.checks();assert.equal(h.count('BODY'),1);assert.equal(h.logical,32);assert.equal(h.postPredicates,32);h.phase='TERMINAL';}));
 assert.equal(h.logical,64);assert.equal(h.postPredicates,64);assert.equal(h.count('TERMINAL'),32);assert.equal(h.commits,1);assert.equal(h.rollbacks,0);
});
for(const [name,options]of [['public',{privateRuntime:false}],['file',{protocol:'file'}],['SHADOW',{mode:'SHADOW'}],['SYNC',{phase:'SYNC'}]])test('unrelated '+name+' keeps all32 original physical reads',async()=>{
 const h=fixture(options);await h.scope(()=>h.api.transaction(async()=>{await h.checks();assert.equal(h.count('BODY'),32);h.phase='TERMINAL';}));assert.equal(h.logical,64);assert.equal(h.count('TERMINAL'),32);
});
test('business SELECT outside trusted readonly check remains physical for every call',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(async()=>{await Promise.all(Array.from({length:12},h.query));assert.equal(h.count(),12);}));
});
test('different execution, budget or receipt marker cannot join another logical observation',async()=>{
 for(const changed of ['execution','budget','marker']){const h=fixture();await h.scope(()=>h.api.transaction(async()=>{
  const before=readOnlyProcessingCheck(async()=>{
   const a=h.query();const invoke=()=>h.query();const b=changed==='execution'?withDurableExecution({...h.execution},invoke):changed==='budget'?withExecutionBudget({...h.clock},invoke):withExecutionReceiptTransaction(invoke);await Promise.all([a,b]);
  });await h.api.transaction(()=>{}, {before});assert.equal(h.count(),2);
 }));}
});
test('own mutation invalidates pending joins before submission; same original root still commits once',async()=>{
 const h=fixture();h.holdQuery=deferred();await h.scope(()=>h.api.transaction(async()=>{
  const first=h.api.transaction(()=>{}, {before:h.check});while(h.count()<1)await setImmediate();
  await h.api.client.execute('UPDATE synthetic_control SET n=1');
  const second=h.api.transaction(()=>{}, {before:h.check});while(h.count()<2)await setImmediate();
  h.holdQuery.resolve();await Promise.all([first,second]);assert.equal(h.count(),2);assert.equal(h.postPredicates,2);
 }));assert.equal(h.commits,1);assert.equal(h.rollbacks,0);
});
test('a readonly callback attempting mutation is rejected and original root rolls back',async()=>{
 const h=fixture(),before=readOnlyProcessingCheck(()=>h.api.client.execute('UPDATE synthetic_control SET n=1'));
 await assert.rejects(h.scope(()=>h.api.transaction(()=>h.api.transaction(()=>{}, {before}))),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(h.commits,0);assert.equal(h.rollbacks,1);assert.equal(h.physical.some(x=>x.sql.startsWith('UPDATE')),false);
});
test('shared read failure prevents callback/commit and original rollback still runs',async()=>{
 const h=fixture();h.failQuery=Error('ORIGINAL_OWNERSHIP_READ_FAILURE');await assert.rejects(h.scope(()=>h.api.transaction(h.checks)),x=>x===h.failQuery);assert.equal(h.logical,32);assert.equal(h.postPredicates,0);assert.equal(h.count(),1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});

test('unsupported row clone after close fails the joined caller without a new physical submission or getter',async()=>{
 const pool=createInflightControlReads(),c=context(),m=marker(),d=deferred();let reads=0,getters=0;const read=()=>{reads++;return d.promise;};
 const a=pool.run(c,m,'key',0,read),b=pool.run(c,m,'key',0,read),raw=result();Object.defineProperty(raw.rows[0],'unsupported',{get(){getters++;return 'never';}});
 pool.close();d.resolve(raw);const out=await Promise.allSettled([a,b]);assert.equal(out[0].status,'fulfilled');assert.equal(out[0].value,raw);assert.equal(out[1].status,'rejected');assert.match(out[1].reason.message,/UNSUPPORTED_RESULT_DESCRIPTOR/);assert.equal(reads,1);assert.equal(getters,0);
});
test('an execution without an original budget cannot opt in',async()=>{
 const h=fixture();h.clock=undefined;await h.scope(()=>h.api.transaction(async()=>{await h.checks();assert.equal(h.count('BODY'),32);h.phase='TERMINAL';}));assert.equal(h.logical,64);
});
