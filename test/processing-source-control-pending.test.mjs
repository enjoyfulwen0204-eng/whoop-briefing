// Isolated fake HTTP transport: no provider, database files or health records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {inflightSourceControlReadKey,inflightControlReadKey} from '../src/processingInflightControlReads.js';
import {processingTransactions,processingSourceControlStatement} from '../src/processingTransaction.js';
import {withDurableExecution,withExecutionReceiptTransaction} from '../src/phase4ExecutionContext.js';
import {withExecutionBudget} from '../src/executionBudget.js';
globalThis.fetch=()=>{throw Error('PURE_TEST_NETWORK_FORBIDDEN');};
const UID='synthetic-source-control';
const SQL={
 access:'SELECT status FROM whoop_resource_access WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?',
 capability:"SELECT 1 FROM whoop_capabilities WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')",
 tombstone:"SELECT 1 FROM whoop_resource_tombstones WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'",
};
const ctx=()=>Object.freeze({userId:UID,executionMode:'LIVE',providerRequired:true,authGeneration:2,lifecycleGeneration:3});
const query=(kind='access',id='synthetic-resource')=>({sql:SQL[kind],args:kind==='access'?[UID,'recovery',2,3]:[UID,'recovery',kind==='capability'?3:id]});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
class Result{toJSON(){return this.rows;}}
function result(status='ACTIVE'){
 const row={status};Object.defineProperty(row,'0',{value:status,writable:true,enumerable:false});
 return Object.assign(new Result(),{columns:['status'],columnTypes:['TEXT'],rows:[row],rowsAffected:0,lastInsertRowid:undefined});
}
function fixture({protocol='http',privateRuntime=true,mode='LIVE',phase='STAGE6_DRAIN',providerRequired=true}={}){
 const h={context:Object.freeze({...ctx(),executionMode:mode,providerRequired}),reads:[],fences:0,predicates:0,commits:0,rollbacks:0,status:'ACTIVE'};
 h.execution={receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}};
 let expired=false;const ac=new AbortController();h.expire=()=>{expired=true;};h.abort=()=>ac.abort();
 h.budget={signal:ac.signal,deadlineAt:Date.now()+100000,assert(){if(expired||ac.signal.aborted)throw Error('SYNC_TIMEOUT');},remainingMs:()=>expired?0:100000};
 async function execute(q){const sql=typeof q==='string'?q:q.sql;
  if(Object.values(SQL).includes(sql)||sql.startsWith('SELECT * FROM whoop_recoveries')){
   const captured=h.status;h.reads.push({sql,args:q.args});await setImmediate();if(h.hold)await h.hold.promise;
   if(h.fail)throw h.fail;return h.result?h.result(captured):result(captured);
  }
  if(sql==='UPDATE synthetic_control SET n=1')h.status='REVOKED';return result();
 }
 const base={protocol,execute,batch:qs=>Promise.all(qs.map(execute)),async transaction(){return {closed:false,execute,batch:qs=>Promise.all(qs.map(execute)),async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});
 h.mark=(q=query(),context=h.context,client=h.api.client)=>processingSourceControlStatement(client,context,q);
 h.query=(kind='access',id)=>h.api.client.execute(h.mark(query(kind,id)));
 h.scope=(fn,budget=h.budget)=>withExecutionBudget(budget,()=>withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,fn)));
 h.root=fn=>h.scope(()=>h.api.transaction(fn));return h;
}
for(const kind of Object.keys(SQL)){
 test(kind+': exact typed source-control DATA key excludes general controls, other tenants and changed generations',()=>{
  const q=query(kind),c=ctx();assert.ok(inflightSourceControlReadKey(q,c));assert.equal(inflightControlReadKey(q,c),null);
  for(const bad of [{...q,sql:q.sql+';'}, {...q,sql:q.sql+' OR 1=1'}, {...q,args:['other',...q.args.slice(1)]}, {...q,args:[...q.args,'extra']}, {...q,args:[q.args[0],'JOURNAL',...q.args.slice(2)]}])assert.equal(inflightSourceControlReadKey(bad,c),null);
  for(const c2 of [{...c,executionMode:'SHADOW'},{...c,providerRequired:false},{...c,userId:'other'}])assert.equal(inflightSourceControlReadKey(q,c2),null);
  if(kind==='access')for(const change of [{authGeneration:1},{lifecycleGeneration:4}])assert.equal(inflightSourceControlReadKey(q,{...c,...change}),null);
  if(kind==='capability')assert.equal(inflightSourceControlReadKey(q,{...c,lifecycleGeneration:4}),null);
  if(kind==='tombstone')assert.notEqual(inflightSourceControlReadKey(q,c),inflightSourceControlReadKey(query(kind,'other-id'),c));
 });
 test(kind+': 32 cold DATA reads share only physical dispatch, preserve 32 original fences and predicates',async()=>{
  const h=fixture();await h.root(()=>h.api.withFence(async()=>{h.fences++;},async()=>{
   const values=await Promise.all(Array.from({length:32},async()=>{
    const r=await h.query(kind);h.predicates++;assert.equal(r.rows[0][0],'ACTIVE');assert.equal(Object.getPrototypeOf(r),Result.prototype);
    r.rows[0].status='CALLER_PRIVATE';return r;
   }));assert.equal(h.reads.length,1);assert.equal(h.fences,32);assert.equal(h.predicates,32);
   assert.equal(new Set(values.map(x=>x.rows[0])).size,32);
  }));assert.equal(h.commits,1);assert.equal(h.rollbacks,0);
 });
 test(kind+': own mutation separates pending epochs and preserves changed DATA rejection',async()=>{
  const h=fixture();h.hold=deferred();await assert.rejects(h.root(async()=>{
   const first=h.query(kind);while(h.reads.length<1)await setImmediate();
   await h.api.client.execute('UPDATE synthetic_control SET n=1');
   const second=h.query(kind);while(h.reads.length<2)await setImmediate();h.hold.resolve();
   const values=await Promise.all([first,second]);assert.equal(values[0].rows[0].status,'ACTIVE');assert.equal(values[1].rows[0].status,'REVOKED');throw Error('ORIGINAL_SOURCE_REJECTED');
  }),/ORIGINAL_SOURCE_REJECTED/);assert.equal(h.reads.length,2);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
 });
}
test('descriptor-only eligibility never invokes getters, proxies, toJSON or coercions',()=>{
 let calls=0;const q=query(),c=ctx();
 const getter=Object.defineProperty({...q},'args',{get(){calls++;return q.args;}});
 const argsGetter=Object.defineProperty([...q.args],'1',{get(){calls++;return 'recovery';}});
 const uidGetter=Object.defineProperty({...c},'userId',{get(){calls++;return UID;}});
 const proxy=new Proxy(q,{get(){calls++;return q;},ownKeys(){calls++;return [];},getPrototypeOf(){calls++;return Object.prototype;}});
 for(const [bad,context]of [[getter,c],[{...q,args:argsGetter},c],[q,uidGetter],[proxy,c],[q,new Proxy(c,{getPrototypeOf(){calls++;return Object.prototype;}})], [{...q,args:new Proxy(q.args,{get(){calls++;return 1;}})},c],[{...q,args:[UID,'recovery',{toString(){calls++;return 2;}},3]},c], [{...q,toJSON(){calls++;}},c]])assert.equal(inflightSourceControlReadKey(bad,context),null);
 const revoked=Proxy.revocable([...q.args],{});revoked.revoke();assert.equal(inflightSourceControlReadKey({...q,args:revoked.proxy},c),null);
 assert.equal(calls,0);
 for(const args of [[UID,'recovery',2n,3],[UID,'recovery',2,NaN],[UID,'recovery',2,-1],[UID,'recovery',2,'3'],[UID,'recovery',2,3,undefined]])assert.equal(inflightSourceControlReadKey({sql:SQL.access,args},c),null);
 const sparse=[UID,'recovery',2,3];delete sparse[2];assert.equal(inflightSourceControlReadKey({sql:SQL.access,args:sparse},c),null);
 assert.equal(inflightSourceControlReadKey({sql:SQL.access,args:[UID,'recovery',2,3],extra:0},c),null);
 assert.equal(inflightSourceControlReadKey({sql:SQL.tombstone,args:[UID,'recovery','']},c),null);
});
test('unmarked and cloned statements plus canonical health-row queries retain separate physical reads',async()=>{
 for(const kind of ['unmarked','clone','health']){const h=fixture();await h.root(async()=>{
  const statements=Array.from({length:8},()=>{const q=kind==='health'?{sql:'SELECT * FROM whoop_recoveries WHERE user_id=? AND id=?',args:[UID,'synthetic']}:query();const mark=h.mark(q);return kind==='clone'?{...mark,args:[...mark.args]}:mark;});
  await Promise.all(statements.map(q=>h.api.client.execute(kind==='unmarked'?query():q)));assert.equal(h.reads.length,8);
 });}
});
test('distinct original tombstone IDs do not join while repeated IDs do',async()=>{
 const h=fixture();await h.root(async()=>{await Promise.all(['one','one','two','two','three','three'].map(id=>h.query('tombstone',id)));assert.equal(h.reads.length,3);});
});
test('mark is bound to exact context, budget, execution and receipt marker at execute time',async()=>{
 for(const kind of ['context','budget','execution','marker']){const h=fixture();await h.root(async()=>{
  const a=h.query(),q=h.mark();const call=()=>h.api.client.execute(q);
  const b=kind==='context'?h.api.withReadSnapshot({...h.context},call):kind==='budget'?withExecutionBudget({...h.budget},call):kind==='execution'?withDurableExecution({...h.execution},call):withExecutionReceiptTransaction(call);
  await Promise.all([a,b]);assert.equal(h.reads.length,2);
 });}
});
test('marks are single use before an awaited reentrant fence, never borrowed by the inner invocation',async()=>{
 const h=fixture();await h.root(async()=>{
  const q=h.mark();let entered=false;
  await h.api.withFence(async()=>{if(entered)return;entered=true;await Promise.all([h.api.client.execute(q),h.query()]);assert.equal(h.reads.length,2);},()=>h.api.client.execute(q));
  assert.equal(h.reads.length,2); // Outer original snapshot lookup remains valid.
 });
});
test('a statement changed after marking cannot join the original pending statement',async()=>{
 const h=fixture();await h.root(async()=>{const a=h.query(),q=h.mark();q.args[1]='sleep';await Promise.all([a,h.api.client.execute(q)]);assert.equal(h.reads.length,2);});
});
test('wrong-client and stale-root marks never transfer eligibility',async()=>{
 const h=fixture(),other=fixture();let q;await h.root(async()=>{q=h.mark();});
 await h.root(async()=>{await Promise.all([h.api.client.execute(q),h.query()]);assert.equal(h.reads.length,2);});
 await other.root(async()=>{const marked=h.mark(query(),h.context,other.api.client);await Promise.all([other.api.client.execute(marked),other.query()]);assert.equal(other.reads.length,2);});
});
for(const [label,options]of [['public',{privateRuntime:false}],['file',{protocol:'file'}],['SHADOW',{mode:'SHADOW'}],['SYNC',{phase:'SYNC'}],['no-provider',{providerRequired:false}]])test('unrelated '+label+' keeps every original physical observation',async()=>{
 const h=fixture(options);await h.root(async()=>{await Promise.all(Array.from({length:8},()=>h.query()));assert.equal(h.reads.length,8);});
});
test('missing original budget cannot opt in, and deadline/abort still reject without committing',async()=>{
 const h=fixture();await withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,()=>h.api.transaction(async()=>{await Promise.all([h.query(),h.query()]);assert.equal(h.reads.length,2);})));
 for(const action of ['expire','abort']){const h=fixture();await assert.rejects(h.root(async()=>{await h.query();h[action]();await h.query();}),/SYNC_TIMEOUT/);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);}
});
test('physical failure retains original error, one dispatch and rollback without resubmission',async()=>{
 const h=fixture();h.fail=Error('ORIGINAL_SOURCE_FAILURE');await assert.rejects(h.root(()=>Promise.all(Array.from({length:8},()=>h.query()))),e=>e===h.fail);assert.equal(h.reads.length,1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('joined unsupported clone outside the original snapshot row bound rejects without invoking getters or repeating SQL',async()=>{
 const h=fixture();let getterCalls=0;h.result=()=>{const r=result();r.rows.push(...Array.from({length:128},()=>({status:'ACTIVE'})));Object.defineProperty(r.rows[0],'status',{get(){getterCalls++;return 'ACTIVE';},enumerable:true});return r;};
 await assert.rejects(h.root(()=>Promise.all([h.query(),h.query()])),/UNSUPPORTED_RESULT_DESCRIPTOR/);assert.equal(h.reads.length,1);assert.equal(getterCalls,0);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('terminal after-checks cannot share pending DATA or reuse business results',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(async()=>{await Promise.all([h.query(),h.query()]);assert.equal(h.reads.length,1);},{after:async()=>{await Promise.all([h.query(),h.query()]);assert.equal(h.reads.length,3);}}));assert.equal(h.commits,1);
});

test('a mark captured before an original mutation cannot join new pending DATA',async()=>{
 const h=fixture();await h.root(async()=>{const old=h.mark();await h.api.client.execute('UPDATE synthetic_control SET n=1');await Promise.all([h.api.client.execute(old),h.query()]);assert.equal(h.reads.length,2);});
});
