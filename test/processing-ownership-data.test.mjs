import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createInflightControlReads,inflightControlReadKey,ownershipControlReadKey} from '../src/processingInflightControlReads.js';
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
function result(){const row={state:'RUNNING',lease_expires_at:1000};Object.defineProperty(row,'0',{value:'RUNNING',enumerable:false,writable:true});return Object.assign(new Result(),{columns:['state'],columnTypes:['TEXT'],rows:[row],rowsAffected:0,lastInsertRowid:undefined});}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const marker=()=>Object.freeze({});

function fixture({protocol='http',privateRuntime=true,mode='LIVE',phase='STAGE6_DRAIN'}={}){
 const h={context:context(),physical:[],logical:0,postPredicates:0,phase:'BODY',commits:0,rollbacks:0};
 h.execution={receipts:false,pending:new Set(),claim:{request:{executionMode:mode,phase}},authority:{assert(){}}};
 h.clock={signal:new AbortController().signal,deadlineAt:Date.now()+100000,assert(){},remainingMs:()=>100000};
 async function execute(q){const sql=typeof q==='string'?q:q.sql;h.physical.push({sql,phase:h.phase});await setImmediate();if(sql===OWN&&h.holdQuery)await h.holdQuery.promise;if(h.failQuery&&sql===OWN)throw h.failQuery;return result();}
 const base={protocol,execute,batch:qs=>Promise.all(qs.map(execute)),async transaction(){return {closed:false,execute,batch:qs=>Promise.all(qs.map(execute)),async commit(){h.commits++;this.closed=true;},async rollback(){h.rollbacks++;this.closed=true;},close(){this.closed=true;}};}};
 h.api=processingTransactions(base,{privateRuntime});h.query=()=>h.api.client.execute(own());
 h.check=readOnlyProcessingCheck(async()=>{h.logical++;const r=await h.query();h.postPredicates++;if(r.rows[0].state!=='RUNNING')throw Error('OWNERSHIP_REJECTED');h.onPredicate?.(r);});
 h.scope=fn=>withExecutionBudget(h.clock,()=>withDurableExecution(h.execution,()=>h.api.withReadSnapshot(h.context,fn)));
 h.checks=()=>Promise.all(Array.from({length:32},()=>h.api.transaction(()=>{}, {before:h.check,after:h.check})));
 h.count=phase=>h.physical.filter(x=>x.sql===OWN&&(!phase||x.phase===phase)).length;return h;
}

test('only the exact clock-free ownership projection qualifies; lock and context registry do not',()=>{
 const c=context();assert.ok(ownershipControlReadKey(own(),c));assert.equal(ownershipControlReadKey(lock(),c),null);
 assert.equal(ownershipControlReadKey({sql:'SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',args:['p4ctx:'+ 'a'.repeat(64)+':11111111-1111-4111-8111-111111111111','now']},c),null);
 for(const q of [{...own(),sql:OWN+' '},{...own(),args:[uid,'LIVE','OTHER_JOB']}])assert.ok(ownershipControlReadKey(q,c));
 for(const q of [{...own(),args:['other','LIVE','RECOMPUTE_DERIVED']},{...own(),sql:OWN+' OR 1=1'},{...own(),args:[uid,'LIVE',null]}])assert.equal(ownershipControlReadKey(q,c),null);
});
test('settled raw row is cloned for each logical observation; explicit clear invalidates it',async()=>{
 const p=createInflightControlReads(),c=context(),m=marker();let n=0;const read=()=>{n++;return result();};
 const a=await p.ownership(c,m,'own',0,read);a.rows[0].state='changed';a.rows[0][0]='changed';
 const b=await p.ownership(c,m,'own',0,read);assert.equal(n,1);assert.equal(b.rows[0].state,'RUNNING');assert.equal(b.rows[0][0],'RUNNING');assert.equal(Object.getPrototypeOf(b),Result.prototype);
 p.clear();await p.ownership(c,m,'own',1,read);assert.equal(n,2);p.close();await p.ownership(c,m,'own',1,read);assert.equal(n,3);
});
test('same key never crosses context, receipt marker or mutation epoch',async()=>{
 const p=createInflightControlReads(),c=context(),m=marker();let n=0;const read=()=>{n++;return result();};
 await p.ownership(c,m,'own',0,read);await p.ownership({...c},m,'own',0,read);await p.ownership(c,marker(),'own',0,read);await p.ownership(c,m,'own',1,read);assert.equal(n,4);
});
test('a late physical result after clear cannot refill the new mutation snapshot',async()=>{
 const p=createInflightControlReads(),c=context(),m=marker(),d=deferred();let n=0;
 const a=p.ownership(c,m,'own',0,()=>{n++;return d.promise;});p.clear();
 await p.ownership(c,m,'own',1,()=>{n++;const r=result();r.rows[0].state='NEW';return r;});d.resolve(result());await a;
 const b=await p.ownership(c,m,'own',1,()=>{throw Error('SHOULD_REUSE_NEW_ONLY');});assert.equal(n,2);assert.equal(b.rows[0].state,'NEW');
});
test('late close prevents population and never submits a replacement read for an unsupported clone',async()=>{
 const p=createInflightControlReads(),c=context(),m=marker(),d=deferred();let n=0,getters=0;const read=()=>{n++;return d.promise;};
 const a=p.ownership(c,m,'own',0,read),b=p.ownership(c,m,'own',0,read);p.close();const raw=result();Object.defineProperty(raw.rows[0],'bad',{get(){getters++;return 1;}});d.resolve(raw);const out=await Promise.allSettled([a,b]);assert.equal(n,1);assert.equal(getters,0);assert.equal(out[0].status,'fulfilled');assert.equal(out[1].status,'rejected');
 await p.ownership(c,m,'own',0,read);assert.equal(n,2);
});
test('scope capacity and oversize DATA bypass retention without dropping logical reads',async()=>{
 const p=createInflightControlReads(),m=marker(),cs=Array.from({length:65},context);let n=0;const read=()=>{n++;return result();};
 for(const c of cs)await p.ownership(c,m,'own',0,read);await p.ownership(cs[64],m,'own',0,read);assert.equal(n,66);await p.ownership(cs[0],m,'own',0,read);assert.equal(n,66);
 const q=createInflightControlReads(),c=context();const huge=()=>{n++;const r=result();r.rows[0].state='x'.repeat(300000);return r;};await q.ownership(c,m,'huge',0,huge);await q.ownership(c,m,'huge',0,huge);assert.equal(n,68);
});
test('24 sequential original ownership predicates run; terminal observations are all physical',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(async()=>{for(let i=0;i<24;i++)await h.api.transaction(()=>{}, {before:h.check,after:h.check});assert.equal(h.count('BODY'),1);assert.equal(h.logical,24);assert.equal(h.postPredicates,24);h.phase='TERMINAL';}));assert.equal(h.logical,48);assert.equal(h.count('TERMINAL'),24);assert.equal(h.commits,1);
});
test('fresh expiry predicate rejects the same cached row after the clock advances',async()=>{
 const h=fixture();let now=999;h.onPredicate=r=>{if(now>=r.rows[0].lease_expires_at)throw Error('FRESH_EXPIRY_REJECTED');};
 await assert.rejects(h.scope(()=>h.api.transaction(async()=>{await h.api.transaction(()=>{}, {before:h.check});assert.equal(h.count(),1);now=1000;await h.api.transaction(()=>{}, {before:h.check});})),/FRESH_EXPIRY_REJECTED/);
 assert.equal(h.logical,2);assert.equal(h.postPredicates,2);assert.equal(h.count(),1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});
test('a business mutation forces a new physical ownership row before the next predicate',async()=>{
 const h=fixture();await h.scope(()=>h.api.transaction(async()=>{await h.api.transaction(()=>{}, {before:h.check});assert.equal(h.count(),1);await h.api.client.execute('UPDATE synthetic_control SET n=1');await h.api.transaction(()=>{}, {before:h.check});assert.equal(h.count(),2);}));assert.equal(h.commits,1);
});
for(const [name,options]of [['public',{privateRuntime:false}],['file',{protocol:'file'}],['SHADOW',{mode:'SHADOW'}],['SYNC',{phase:'SYNC'}]])test('sequential '+name+' observations do not retain ownership DATA',async()=>{
 const h=fixture(options);await h.scope(()=>h.api.transaction(async()=>{for(let i=0;i<3;i++)await h.api.transaction(()=>{}, {before:h.check});assert.equal(h.count('BODY'),3);}));
});
test('different original budget, execution, marker and root do not borrow retained ownership DATA',async()=>{
 for(const changed of ['budget','execution','marker']){const h=fixture();await h.scope(()=>h.api.transaction(async()=>{await h.api.transaction(()=>{}, {before:h.check});const invoke=()=>h.api.transaction(()=>{}, {before:h.check});await(changed==='execution'?withDurableExecution({...h.execution},invoke):changed==='budget'?withExecutionBudget({...h.clock},invoke):withExecutionReceiptTransaction(invoke));assert.equal(h.count('BODY'),2);}));}
 const h=fixture();await h.scope(()=>h.api.transaction(()=>h.api.transaction(()=>{}, {before:h.check})));const before=h.count();await h.scope(()=>h.api.transaction(()=>h.api.transaction(()=>{}, {before:h.check})));assert.equal(h.count(),before+1);
});
test('original aborted budget rejects before a retained row and original rollback remains',async()=>{
 const h=fixture(),controller=new AbortController();h.clock.signal=controller.signal;h.clock.assert=()=>{if(controller.signal.aborted)throw Error('ORIGINAL_ABORT');};
 await assert.rejects(h.scope(()=>h.api.transaction(async()=>{await h.api.transaction(()=>{}, {before:h.check});controller.abort();await h.api.transaction(()=>{}, {before:h.check});})),/ORIGINAL_ABORT/);assert.equal(h.count(),1);assert.equal(h.commits,0);assert.equal(h.rollbacks,1);
});

test('unsupported own or inherited getters and toJSON methods are never invoked by retention',async()=>{
 for(const bad of ['ownGetter','inheritedGetter','method']){
  const p=createInflightControlReads(),c=context(),m=marker();let invoked=0,n=0;const raw=result();
  if(bad==='ownGetter')Object.defineProperty(raw.rows[0],'bad',{enumerable:true,get(){invoked++;return 'never';}});
  if(bad==='inheritedGetter')Object.setPrototypeOf(raw.rows[0],Object.create(Object.prototype,{toJSON:{get(){invoked++;return ()=>null;}}}));
  if(bad==='method')Object.setPrototypeOf(raw,Object.create(Object.getPrototypeOf(raw),{toJSON:{value(){invoked++;return null;}}}));
  const read=()=>{n++;return raw;};await p.ownership(c,m,'own',0,read);await p.ownership(c,m,'own',0,read);assert.equal(invoked,0);assert.equal(n,bad==='method'?1:2);
 }
});

test('unsupported rows accessor is not invoked again by ownership retention',async()=>{
 const c=context(),m=marker();
 const observe=async method=>{let rowsGetters=0,rowGetters=0,n=0;const raw=result(),rows=raw.rows;Object.defineProperty(rows[0],'bad',{get(){rowGetters++;return 'never';}});Object.defineProperty(raw,'rows',{get(){rowsGetters++;return rows;}});const value=await createInflightControlReads()[method](c,m,'own',0,()=>{n++;return raw;});assert.equal(value,raw);return {rowsGetters,rowGetters,n};};
 const original=await observe('run'),owned=await observe('ownership');assert.deepEqual(owned,original);assert.deepEqual(owned,{rowsGetters:1,rowGetters:0,n:1});
});
