import test from 'node:test';import assert from 'node:assert/strict';import {setImmediate} from 'node:timers/promises';
import {createPhase4ContextRegistry} from '../src/phase4Cache.js';
import {processingTransactions,readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {inflightControlReadKey,createInflightControlReads,CONTEXT_LEASE_DATA_SQL} from '../src/processingInflightControlReads.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {withExecutionBudget} from '../src/executionBudget.js';
const SQL='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',NAME='p4ctx:'+ 'a'.repeat(64)+':00000000-0000-4000-8000-000000000001';
const context=()=>Object.freeze({userId:'synthetic-context-owner',executionMode:'LIVE',providerRequired:true,purgeGeneration:0});
const query=(name=NAME,clock='2026-10-24T00:00:00.000Z')=>({sql:SQL,args:[name,clock]});
const result=rows=>({columns:['owner'],columnTypes:['TEXT'],rows,rowsAffected:0,lastInsertRowid:undefined});
test('context lease shape is eligibility only; full exact name and clock remain in key',()=>{
 const c=context();assert.ok(inflightControlReadKey(query(),c));
 for(const q of [query('p4ctx:invalid'),query(NAME+'extra'),{sql:SQL+' OR 1=1',args:query().args},{sql:SQL,args:[NAME,1]},{sql:SQL,args:[NAME]}])assert.equal(inflightControlReadKey(q,c),null);
 assert.notEqual(inflightControlReadKey(query(),c),inflightControlReadKey(query(NAME,'different-clock'),c));assert.notEqual(inflightControlReadKey(query(),c),inflightControlReadKey(query(NAME.replace(/001$/,'002')),c));
});
test('different context objects and full lease names or clock arguments never share a pending result',async()=>{
 const pool=createInflightControlReads(),c=context(),m={},pending=[];let resolve,reads=0;const p=new Promise(r=>{resolve=r;});const read=()=>{reads++;return p;};
 pending.push(pool.run(c,m,inflightControlReadKey(query(),c),0,read));pending.push(pool.run({...c,userId:'other'},m,inflightControlReadKey(query(),c),0,read));pending.push(pool.run(c,m,inflightControlReadKey(query(NAME.replace(/001$/,'002')),c),0,read));pending.push(pool.run(c,m,inflightControlReadKey(query(NAME,'changed-clock'),c),0,read));assert.equal(reads,4);resolve(result([{owner:'original'}]));await Promise.all(pending);
});
function harness(){
 const h={now:Date.parse('2026-10-24T00:00:00Z'),phase:'BODY',ownerReads:[],timestamps:0,logical:0,commits:0,rollbacks:0,rows:new Map()};
 const execute=async q=>{const sql=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args;
  if(sql==='SELECT 1')return result([{owner:'ACK'}]);
  if(sql===CONTEXT_LEASE_DATA_SQL){h.ownerReads.push({phase:h.phase,at:null,dataOnly:true});await setImmediate();const row=h.rows.get(args[0]);return {...result(row?[{...row}]:[]),columns:['owner','expires_at'],columnTypes:['TEXT','TEXT']};}
  if(sql===SQL){h.ownerReads.push({phase:h.phase,at:args[1]});await setImmediate();const row=h.rows.get(args[0]);return result(row&&row.expires_at>args[1]?[{owner:row.owner}]:[]);}
  if(sql.startsWith('INSERT INTO resource_locks')){h.rows.set(args[0],{owner:args[1],expires_at:args[3]});return {...result([]),rowsAffected:1};}
  if(sql.startsWith('DELETE FROM resource_locks')){h.rows.delete(args[0]);return {...result([]),rowsAffected:1};}
  if(sql==='UPDATE resource_locks SET owner=? WHERE name=?'){h.rows.get(args[1]).owner=args[0];return {...result([]),rowsAffected:1};}
  throw Error('UNEXPECTED_SYNTHETIC_SQL');};
 const base={protocol:'http',execute,async transaction(){return {closed:false,execute,async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime:true});h.context=context();h.registry=createPhase4ContextRegistry({client:h.api.client,keys:{lookup:()=> 'a'.repeat(64)},now:()=>new Date(h.now),timestamp:()=>{h.timestamps++;return new Date(h.now).toISOString();},newId:()=> '00000000-0000-4000-8000-000000000001'});
 const clock={signal:new AbortController().signal,deadlineAt:Date.now()+100000,remainingMs:()=>100000,assert(){}};const execution={receipts:false,pending:new Set(),claim:{request:{phase:'STAGE6_DRAIN',executionMode:'LIVE'}},authority:{assert(){}}};
 h.run=fn=>withExecutionBudget(clock,()=>withDurableExecution(execution,()=>h.api.withReadSnapshot(h.context,()=>h.api.transaction(fn))));
 h.check=readOnlyProcessingCheck(async()=>{h.logical++;return h.registry.assertLease(h.context);});return h;
}
test('real registry predicates all execute, and original terminal observations are freshly physical',async()=>{
 const h=harness();await h.registry.register(h.context);const before=h.timestamps;
 await h.run(async()=>{await Promise.all(Array.from({length:32},()=>h.api.transaction(()=>{}, {before:h.check,after:h.check})));assert.equal(h.logical,32);assert.equal(h.timestamps-before,64);assert.equal(h.ownerReads.filter(x=>x.phase==='BODY').length,1);h.phase='TERMINAL';});
 assert.equal(h.logical,64);assert.equal(h.timestamps-before,128);assert.equal(h.ownerReads.filter(x=>x.phase==='TERMINAL').length,32);assert.equal(h.commits,1);assert.equal(h.rollbacks,0);
});
for(const state of ['expired','released','revoked'])test('real registry '+state+' still rejects original callback and rolls back',async()=>{
 const h=harness();await h.registry.register(h.context);let callback=false;
 await assert.rejects(h.run(async()=>{
  await h.api.transaction(()=>{}, {before:h.check});
  if(state==='expired')h.now+=15*60000;
  else if(state==='released')await h.registry.release(h.context);
  else await h.api.client.execute({sql:'UPDATE resource_locks SET owner=? WHERE name=?',args:['revoked',NAME]});
  await h.api.transaction(()=>{callback=true;}, {before:h.check});
 }),new RegExp(state==='expired'?'PHASE4_CONTEXT_EXPIRED':state==='released'?'PHASE4_CONTEXT_RELEASED':'PHASE4_CONTEXT_REVOKED'));
 assert.equal(callback,false);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
