import test from 'node:test';
import assert from 'node:assert/strict';
import {processingTransactions,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
const q=()=>({sql:'SELECT ? AS value',args:[Math.exp(-1/14)]});
const context=(mode='LIVE',phase='STAGE6_DRAIN')=>({receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}});
function fixture({protocol='http',privateRuntime=true}={}){
 const seen=[],txs=[];let fault=null;
 const observe=(receiver,key,args)=>{seen.push({receiver,key,args});if(fault)throw fault;return {rows:[],rowsAffected:0};};
 const base={protocol,async execute(...args){assert.equal(this,base);return observe(this,'execute',args);},async batch(...args){assert.equal(this,base);return observe(this,'batch',args);},async transaction(mode){assert.equal(this,base);assert.equal(mode,'write');const tx={closed:false,commits:0,rollbacks:0,async execute(...args){assert.equal(this,tx);return observe(this,'execute',args);},async batch(...args){assert.equal(this,tx);return observe(this,'batch',args);},async commit(){assert.equal(this,tx);tx.commits++;tx.closed=true;},async rollback(){assert.equal(this,tx);tx.rollbacks++;tx.closed=true;},close(){assert.equal(this,tx);tx.closed=true;}};txs.push(tx);return tx;}};
 return {api:processingTransactions(base,{privateRuntime}),base,seen,txs,setFault:x=>{fault=x;}};
}
function compiled(statement){assert.ok(statement.sql.includes('CAST(? AS REAL)'));assert.ok(statement.args.some(x=>typeof x==='bigint'));assert.ok(statement.args.every(x=>typeof x!=='number'||Number.isSafeInteger(x)));}

test('private LIVE HTTP root execute and batch serialize exact numbers without replacing receiver, batch mode or caller statements',async()=>{
 const h=fixture(),a=q(),b=q(),frozen=JSON.stringify([a,b]);
 await withDurableExecution(context(),async()=>{await h.api.client.execute(a);await h.api.client.batch([a,b],'read');});
 assert.equal(h.seen.length,2);compiled(h.seen[0].args[0]);h.seen[1].args[0].forEach(compiled);assert.equal(h.seen[1].args[1],'read');assert.equal(JSON.stringify([a,b]),frozen);assert.equal(h.seen[0].receiver,h.base);assert.notEqual(h.seen[0].args[0],a);
});
test('transaction uses original acknowledged BEGIN and same execute/batch/commit receivers',async()=>{
 const h=fixture(),a=q();await withDurableExecution(context(),()=>h.api.transaction(async()=>{await h.api.client.execute(a);await h.api.client.batch([a],'write');return true;}));
 assert.equal(h.txs.length,1);assert.equal(h.seen[0].args[0],'SELECT 1');compiled(h.seen[1].args[0]);compiled(h.seen[2].args[0][0]);assert.equal(h.seen[2].args[1],'write');assert.ok(h.seen.every(x=>x.receiver===h.txs[0]));assert.equal(h.txs[0].commits,1);assert.equal(h.txs[0].rollbacks,0);
});
for(const [name,options,execution]of [
 ['public facade',{privateRuntime:false},context()],['file runtime',{protocol:'file'},context()],['SHADOW',{},context('SHADOW')],['SYNC',{},context('LIVE','SYNC')],['no durable execution',{},null]
])test(`unrelated ${name} transport stays unchanged`,async()=>{const h=fixture(options),a=q();await withDurableExecution(execution,async()=>{await h.api.client.execute(a);await h.api.client.batch([a]);});assert.equal(h.seen[0].args[0],a);assert.equal(h.seen[1].args[0][0],a);});
test('transaction cannot borrow the exact transport opt-in from a different execution context',async()=>{const h=fixture(),a=q();await withDurableExecution(context(),()=>h.api.transaction(()=>withDurableExecution(context(),()=>h.api.client.execute(a))));assert.equal(h.seen[1].args[0],a);});
test('read-only fence rejects mutation before serialization/physical submission',async()=>{const h=fixture();const guard=readOnlyProcessingCheck(()=>h.api.client.execute({sql:'UPDATE synthetic SET n=?',args:[.1]}));await assert.rejects(withDurableExecution(context(),()=>h.api.withFence(guard,()=>h.api.transaction(()=>assert.fail('business callback')))),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);assert.equal(h.seen.length,0);assert.equal(h.txs.length,0);});
test('closed compiler shape fails before any business SQL and causes original rollback',async()=>{const h=fixture();await assert.rejects(withDurableExecution(context(),()=>h.api.transaction(()=>h.api.client.execute({sql:'SELECT ?1',args:[.1]}))),/EXACT_REAL_STATEMENT_UNSUPPORTED/);assert.equal(h.seen.length,1);assert.equal(h.seen[0].args[0],'SELECT 1');assert.equal(h.txs[0].commits,0);assert.equal(h.txs[0].rollbacks,1);});
test('indeterminate durable execution remains rejected before transaction opening',async()=>{const h=fixture(),c=context();c.indeterminate=true;await assert.rejects(withDurableExecution(c,()=>h.api.transaction(()=>h.api.client.execute(q()))),/COMMIT_INDETERMINATE/);assert.equal(h.txs.length,0);assert.equal(h.seen.length,0);});
test('integer/null/string statements preserve original identity',async()=>{const h=fixture(),a={sql:'SELECT ?,?,?',args:[7,null,'unchanged']};await withDurableExecution(context(),()=>h.api.client.execute(a));assert.equal(h.seen[0].args[0],a);});
