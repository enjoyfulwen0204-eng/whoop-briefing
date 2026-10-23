import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {processingTransactions,readOnlyProcessingCheck,processingContextLeaseDataEligible} from '../src/processingTransaction.js';
import {CONTEXT_LEASE_DATA_SQL,contextLeaseDataReadKey,inflightControlReadKey,ownershipControlReadKey} from '../src/processingInflightControlReads.js';
import {createPhase4ContextRegistry,projectContextLeaseData} from '../src/phase4Cache.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {withExecutionBudget} from '../src/executionBudget.js';
const NAME='p4ctx:'+ 'a'.repeat(64)+':11111111-1111-4111-8111-111111111111',OLD='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?';
const context=()=>Object.freeze({userId:'synthetic-lease',executionMode:'LIVE',providerRequired:true});
function result(rows=[]){return {columns:['owner','expires_at'],columnTypes:['TEXT','TEXT'],rows,rowsAffected:0,lastInsertRowid:undefined};}
function fixture({protocol='http',privateRuntime=true,mode='LIVE',phase='STAGE6_DRAIN',providerRequired=true,newId='11111111-1111-4111-8111-111111111111'}={}){
 const h={now:Date.parse('2026-10-24T00:00:00.000Z'),context:Object.freeze({...context(),executionMode:mode,providerRequired}),trace:[],clockCalls:0,checks:0,phase:'REGISTER',row:null};
 const clock={signal:new AbortController().signal,deadlineAt:Date.now()+100000,assert(){if(h.expired)throw Object.assign(Error('SYNC_TIMEOUT'),{code:'SYNC_TIMEOUT'});},remainingMs:()=>100000};
 h.execution={receipts:false,pending:new Set(),claim:{request:{phase,executionMode:mode}},authority:{assert(){clock.assert();}}};
 async function execute(q){const sql=typeof q==='string'?q:q.sql;h.trace.push({sql,args:typeof q==='string'?[]:q.args,phase:h.phase});
  if(sql==='SELECT 1')return result([{n:1}]);
  if(sql.startsWith('INSERT INTO resource_locks')){h.row={owner:q.args[1],expires_at:q.args[3]};return {...result(),rowsAffected:1};}
  if(sql===CONTEXT_LEASE_DATA_SQL){h.onRaw?.();return result(h.rawOverride?[h.rawOverride]:h.row?[{...h.row}]:[]);}
  if(sql===OLD)return result(h.row&&h.row.expires_at>q.args[1]?[{owner:h.row.owner}]:[]);
  if(sql==='UPDATE synthetic_business SET n=?'){h.onMutation?.();return {...result(),rowsAffected:1};}
  throw Error('UNEXPECTED_LOCAL_SQL');
 }
 const base={protocol,execute,batch:qs=>Promise.all(qs.map(execute)),async transaction(){return {closed:false,execute,batch:qs=>Promise.all(qs.map(execute)),async commit(){this.closed=true;},async rollback(){this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});h.registry=createPhase4ContextRegistry({client:h.api.client,keys:{lookup:()=> 'a'.repeat(64)},now:()=>new Date(h.now),timestamp:()=>{h.clockCalls++;return new Date(h.now).toISOString();},newId:()=>newId});
 h.guard=readOnlyProcessingCheck(async()=>{h.checks++;const before=h.clockCalls;await h.registry.assertLease(h.context);h.afterGuard?.();assert.equal(h.clockCalls-before,2);});
 h.register=async()=>{await h.registry.register(h.context);h.trace=[];h.clockCalls=0;h.phase='BODY';};
 h.scope=work=>withExecutionBudget(clock,()=>withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,work)));
 h.run=work=>h.scope(()=>h.api.transaction(work,{before:h.guard,after:h.guard}));
 h.check=()=>h.api.transaction(()=>{}, {before:h.guard});h.raws=()=>h.trace.filter(x=>x.sql===CONTEXT_LEASE_DATA_SQL);h.olds=()=>h.trace.filter(x=>x.sql===OLD);return h;
}
test('one exact clock-free lease row template; original filtered query remains pending-only',()=>{
 const c=context();assert.ok(contextLeaseDataReadKey({sql:CONTEXT_LEASE_DATA_SQL,args:[NAME]},c));assert.ok(inflightControlReadKey({sql:CONTEXT_LEASE_DATA_SQL,args:[NAME]},c));
 assert.equal(ownershipControlReadKey({sql:CONTEXT_LEASE_DATA_SQL,args:[NAME]},c),null);assert.equal(contextLeaseDataReadKey({sql:OLD,args:[NAME,'now']},c),null);
 for(const q of [{sql:CONTEXT_LEASE_DATA_SQL,args:[NAME,'extra']},{sql:CONTEXT_LEASE_DATA_SQL+' OR 1=1',args:[NAME]},{sql:CONTEXT_LEASE_DATA_SQL,args:['not-branded-name']}])assert.equal(contextLeaseDataReadKey(q,c),null);
 for(const c of [{...context(),executionMode:'SHADOW'},{...context(),providerRequired:false},{}])assert.equal(contextLeaseDataReadKey({sql:CONTEXT_LEASE_DATA_SQL,args:[NAME]},c),null);
});
test('canonical expiry projection exactly matches SQLite BINARY TEXT before/equal/after dates',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE resource_locks(name TEXT,owner TEXT,expires_at TEXT)');const insert=db.prepare('INSERT INTO resource_locks VALUES (?,?,?)'),del=db.prepare('DELETE FROM resource_locks'),old=db.prepare(OLD);
 const dates=['0000-01-01T00:00:00.000Z','2024-02-29T23:59:59.999Z','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.001Z','9999-12-31T23:59:59.999Z'];
 for(const expiry of dates)for(const at of dates){del.run();insert.run(NAME,'original-owner',expiry);assert.deepEqual(projectContextLeaseData({owner:'original-owner',expires_at:expiry},at),{supported:true,owner:old.get(NAME,at)?.owner});}db.close();
});
test('unsupported expiry/owner/accessor shapes never replace the original SQL comparator',()=>{
 for(const expiry of [null,1,'not-a-date','2026-10-24T08:00:00+08:00','2026-02-30T00:00:00.000Z','2026-10-24T00:00:00.000Z\0','\u{10000}'])assert.equal(projectContextLeaseData({owner:'x',expires_at:expiry},'2026-10-24T00:00:00.000Z').supported,false);
 let reads=0;const row={owner:'x'};Object.defineProperty(row,'expires_at',{get(){reads++;return 'x';}});assert.equal(projectContextLeaseData(row,'2026-10-24T00:00:00.000Z').supported,false);assert.equal(reads,0);
 assert.deepEqual(projectContextLeaseData(undefined,'bad-time'),{supported:true,owner:undefined});
});
test('32 fresh logical guards reuse only ROW DATA, while original terminal reads remain physical',async()=>{
 const h=fixture();await h.register();h.afterGuard=()=>{h.now++;};await h.run(async()=>{for(let i=0;i<32;i++)await h.check();});assert.ok(h.checks>=34);assert.equal(h.raws().length,1);assert.ok(h.olds().length>=1);assert.equal(h.clockCalls,2*h.checks);
});
test('cached row must still fail on fresh durable expiry without an intervening mutation',async()=>{
 const h=fixture();await h.register();h.row.expires_at=new Date(h.now+5).toISOString();h.afterGuard=()=>{h.now+=5;};await assert.rejects(h.run(async()=>h.check()),/PHASE4_CONTEXT_REVOKED/);assert.equal(h.raws().length,1);
});
test('original context entry lifetime still rejects before a raw lease read',async()=>{
 const h=fixture();await h.register();h.now+=15*60*1000;await assert.rejects(h.run(()=>{}),/PHASE4_CONTEXT_EXPIRED/);assert.equal(h.raws().length,0);
});
test('any original mutation invalidates lease DATA before the next owner guard',async()=>{
 const h=fixture();await h.register();h.onMutation=()=>{h.row.owner='revoked';};await assert.rejects(h.run(async()=>{await h.check();await h.api.client.execute({sql:'UPDATE synthetic_business SET n=?',args:[1]});await h.check();}),/PHASE4_CONTEXT_REVOKED/);assert.ok(h.raws().length>=2);
});
test('unsupported row fallback reuses the exact second captured timestamp without a third clock',async()=>{
 const h=fixture();await h.register();let invoked=false;h.rawOverride={owner:'x',expires_at:'unsupported'};h.onRaw=()=>{if(!invoked){invoked=true;h.now+=100;}};const at=new Date(h.now).toISOString();await h.run(async()=>h.check());assert.equal(h.olds()[0].args[1],at);assert.equal(h.clockCalls,2*h.checks);
});
test('original context registry brand rejects unregistered contexts',async()=>{
 const h=fixture();await h.register();await assert.rejects(h.scope(()=>h.api.transaction(async()=>h.registry.assertLease({...h.context}))),/PHASE4_CONTEXT_RELEASED/);
});
test('changed read context cannot select retained DATA for the original context',async()=>{
 const h=fixture();await h.register();await h.run(async()=>{await h.api.withReadSnapshot({...h.context},()=>h.check());});assert.ok(h.olds().length>=2);
});
test('outside private HTTP LIVE provider-required Stage6 scopes, original SQL remains unchanged',async()=>{
 for(const options of [{protocol:'file'},{privateRuntime:false},{mode:'SHADOW'},{phase:'SYNC'},{providerRequired:false},{newId:'ordinary-legacy-id'}]){const h=fixture(options);await h.register();await h.run(async()=>{for(let i=0;i<3;i++)await h.check();});assert.equal(h.raws().length,0);assert.ok(h.olds().length>=5);}
});
test('unregistered client never grants lease DATA eligibility',()=>{assert.equal(processingContextLeaseDataEligible({},context(),NAME),false);});
