// Pure transport and allocation witness. No network, health data or database.
import test from 'node:test';import assert from 'node:assert/strict';
import {processingTransactions,readObservationProcessingCheck} from '../src/processingTransaction.js';
import {withExecutionBudget} from '../src/executionBudget.js';import {withDurableExecution} from '../src/phase4ExecutionContext.js';
globalThis.fetch=()=>{throw Error('PURE_TEST_NETWORK_FORBIDDEN');};
const SQL='SELECT * FROM whoop_recoveries WHERE user_id=? AND sleep_id=?';
function fixture({privateRuntime=true,protocol='http',mode='LIVE',phase='STAGE6_DRAIN',durable=true}={}){
 const h={keyMaps:0,reads:[],guards:0,predicates:0,commits:0,rollbacks:0};h.context=Object.freeze({userId:'synthetic-key-owner',executionMode:mode,providerRequired:true});
 h.execution={receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}};
 const ac=new AbortController();h.budget={signal:ac.signal,deadlineAt:Date.now()+100000,remainingMs:()=>100000,assert(){if(ac.signal.aborted)throw Error('SYNC_CANCELLED');}};h.abort=()=>ac.abort();
 h.query=(id='one')=>{const args=[h.context.userId,id];Object.defineProperty(args,'map',{value:function(...values){h.keyMaps++;return Array.prototype.map.apply(this,values);}});return {sql:SQL,args};};
 const result=id=>({columns:['id'],columnTypes:['TEXT'],rows:[{id}],rowsAffected:0,lastInsertRowid:undefined});
 async function execute(q){if(typeof q==='object'&&q.sql===SQL){h.reads.push(q.args[1]);if(h.error)throw h.error;return result(q.args[1]);}return result('control');}
 const base={protocol,execute,batch:q=>Promise.all(q.map(execute)),async transaction(){return {closed:false,execute,batch:q=>Promise.all(q.map(execute)),async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});h.scope=fn=>withExecutionBudget(h.budget,()=>durable?withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,fn)):h.api.withReadSnapshot(h.context,fn));h.root=fn=>h.scope(()=>h.api.transaction(fn));return h;
}
test('owned LIVE skips only unused first key while every query retains fresh fence and later key',async()=>{
 const h=fixture();await h.root(()=>h.api.withFence(async()=>{h.guards++;},async()=>{for(let i=0;i<2;i++){assert.equal((await h.api.client.execute(h.query())).rows[0].id,'one');h.predicates++;}assert.equal(h.keyMaps,2);assert.equal(h.guards,2);assert.equal(h.predicates,2);assert.deepEqual(h.reads,['one']);}));assert.equal(h.commits,1);
});
for(const [name,options,expectedMaps,physical]of [['SHADOW',{mode:'SHADOW'},4,1],['file',{protocol:'file'},4,1],['SYNC',{phase:'SYNC'},4,1],['no-durable-execution',{durable:false},4,1],['public',{privateRuntime:false},0,2]])test(name+' retains original key and transport behavior',async()=>{
 const h=fixture(options);await h.root(async()=>{await h.api.client.execute(h.query());await h.api.client.execute(h.query());assert.equal(h.keyMaps,expectedMaps);assert.equal(h.reads.length,physical);});assert.equal(h.commits,1);
});
test('different original execution cannot borrow the LIVE skip or cached data',async()=>{
 const h=fixture();await h.root(async()=>{await withDurableExecution({...h.execution},async()=>{await h.api.client.execute(h.query());await h.api.client.execute(h.query());});assert.equal(h.keyMaps,2);assert.equal(h.reads.length,2);});
});
test('a fence changing statement arguments still uses fresh post-fence key and row',async()=>{
 const h=fixture();await h.root(async()=>{const q=h.query('one');await h.api.withFence(async()=>{q.args[1]='two';h.guards++;},async()=>assert.equal((await h.api.client.execute(q)).rows[0].id,'two'));
  assert.equal((await h.api.client.execute(h.query('one'))).rows[0].id,'one');assert.equal((await h.api.client.execute(h.query('two'))).rows[0].id,'two');assert.deepEqual(h.reads,['two','one']);assert.equal(h.keyMaps,3);assert.equal(h.guards,1);
 });
});
test('fresh failing fence rejects before optional LIVE key work and before physical source SQL',async()=>{
 const h=fixture(),error=Error('ORIGINAL_FENCE_FAILED');await assert.rejects(h.root(()=>h.api.withFence(async()=>{h.guards++;throw error;},()=>h.api.client.execute(h.query()))),e=>e===error);assert.equal(h.guards,1);assert.equal(h.keyMaps,0);assert.equal(h.reads.length,0);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('physical error remains original and cannot commit or resubmit',async()=>{
 const h=fixture();h.error=Error('ORIGINAL_SOURCE_ERROR');await assert.rejects(h.root(()=>h.api.client.execute(h.query())),e=>e===h.error);assert.equal(h.keyMaps,1);assert.equal(h.reads.length,1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('abort remains authoritative after cached business data',async()=>{
 const h=fixture();await assert.rejects(h.root(async()=>{await h.api.client.execute(h.query());h.abort();await h.api.client.execute(h.query());}),/SYNC_CANCELLED/);assert.equal(h.reads.length,1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('terminal checks still perform the original fresh source observation',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(()=>h.api.client.execute(h.query()),{after:()=>h.api.client.execute(h.query())}));assert.equal(h.reads.length,2);assert.equal(h.keyMaps,2);assert.equal(h.commits,1);
});

test('genuine SHADOW overlap still uses its original first key and fresh fence on cached reads',async()=>{
 const h=fixture({mode:'SHADOW'});let local=0;const check=readObservationProcessingCheck(async()=>{h.guards++;},()=>{local++;});
 await h.root(()=>h.api.withFence(check,async()=>{await h.api.client.execute(h.query());await h.api.client.execute(h.query());assert.equal(h.keyMaps,3);assert.equal(h.guards,2);assert.equal(local,2);assert.equal(h.reads.length,1);}));assert.equal(h.commits,1);
});
test('a stale LIVE flag cannot suppress the original key when the execution mode has changed',async()=>{
 const h=fixture();await h.root(async()=>{h.execution.claim.request.executionMode='SHADOW';await h.api.client.execute(h.query());await h.api.client.execute(h.query());assert.equal(h.keyMaps,4);assert.equal(h.reads.length,1);});
});
