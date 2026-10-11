import test from 'node:test';
import assert from 'node:assert/strict';
import {processingTransactions} from '../src/processingTransaction.js';
import {createReadSnapshotMemo,readSnapshotKey,READ_SNAPSHOT_LIMITS} from '../src/processingReadSnapshot.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
const context=Object.freeze({userId:'a'}),query={sql:'SELECT * FROM whoop_sleeps WHERE user_id=? AND id=?',args:['a','s']};
function result(value=1){
 const row={user_id:'a',id:'s',value};Object.defineProperty(row,'length',{value:3});
 for(const [i,key] of ['user_id','id','value'].entries())Object.defineProperty(row,i,{value:row[key]});
 return {columns:['user_id','id','value'],columnTypes:['TEXT','TEXT','REAL'],rows:[row],rowsAffected:0,lastInsertRowid:undefined};
}
function fixture(){
 let value=1,reads=0,commits=0,rollbacks=0,closed=0,delay;
 const base={protocol:'file',close(){closed++;},batch:async()=>[],execute:async()=>{reads++;return result(value);},transaction:async()=>{
  let local=value,ended=false;const savepoints=new Map();
  return {execute:async statement=>{
   if(ended)throw Error('SYNTHETIC_TX_CLOSED');
   if(/^SELECT/.test(statement.sql)){reads++;const answer=result(local);if(delay)await delay();return answer;}
   if(statement.sql==='THROWN_UNCERTAIN_WRITE')throw Error('SYNTHETIC_WRITE_FAILED');
   if(/^SAVEPOINT /.test(statement.sql))savepoints.set(statement.sql.slice(10),local);
   else if(/^ROLLBACK TO /.test(statement.sql))local=savepoints.get(statement.sql.slice(12));
   else if(/^RELEASE /.test(statement.sql))savepoints.delete(statement.sql.slice(8));
   else local=statement.args[0];return {rows:[],rowsAffected:1};},batch:async statements=>{local=statements[0].args[0];return [];},
   commit:async()=>{commits++;value=local;},rollback:async()=>{rollbacks++;},close(){ended=true;}};
 }};
 const p=processingTransactions(base,{privateRuntime:true});return {p,get reads(){return reads;},get value(){return value;},get commits(){return commits;},get rollbacks(){return rollbacks;},get closed(){return closed;},setDelay:fn=>{delay=fn;}};
}
test('one original transaction/context reuses equal data reads without sharing mutable results or numeric aliases',async()=>{
 const f=fixture();await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  const a=await f.p.client.execute(query);a.rows[0].value=99;a.columns[0]='changed';
  const b=await f.p.client.execute(query);assert.equal(b.rows[0].value,1);assert.equal(b.rows[0][2],1);assert.equal(b.rows[0].length,3);assert.equal(b.columns[0],'user_id');
  b.rows[0].value=100;assert.equal((await f.p.client.execute(query)).rows[0].value,1);
 }));assert.equal(f.reads,1);assert.equal(f.commits,1);
});
test('no cross-context, tenant, root, transaction or commit sharing',async()=>{
 const f=fixture(),other=Object.freeze({userId:'a'}),foreign=Object.freeze({userId:'b'});
 await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.withReadSnapshot(other,()=>f.p.client.execute(query));await f.p.withReadSnapshot(foreign,()=>f.p.client.execute(query));
 }));assert.equal(f.reads,3);
 await f.p.withReadSnapshot(context,()=>f.p.transaction(()=>f.p.client.execute(query)));assert.equal(f.reads,4);
 await f.p.withReadSnapshot(context,()=>f.p.client.execute(query));await f.p.withReadSnapshot(context,()=>f.p.client.execute(query));assert.equal(f.reads,6);
 let reads=0;const ownedByCaller=processingTransactions({execute:async()=>result(),transaction:async()=>({execute:async()=>{reads++;return result();},commit:async()=>{},rollback:async()=>{},close(){}})});
 await ownedByCaller.withReadSnapshot(context,()=>ownedByCaller.transaction(async()=>{await ownedByCaller.client.execute(query);await ownedByCaller.client.execute(query);}));assert.equal(reads,2,'unobservable caller-owned receiver lifetime never reuses data');
});
test('every write/batch invalidates every context before and after submission, and rollback cannot reuse speculative rows',async()=>{
 const f=fixture(),other={userId:'a'};await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.withReadSnapshot(other,()=>f.p.client.execute(query));
  await f.p.client.execute({sql:'UPDATE whoop_sleeps SET value=? WHERE user_id=?',args:[2,'a']});
  assert.equal((await f.p.client.execute(query)).rows[0].value,2);assert.equal((await f.p.withReadSnapshot(other,()=>f.p.client.execute(query))).rows[0].value,2);
  await f.p.client.batch([{sql:'UPDATE whoop_sleeps SET value=? WHERE user_id=?',args:[3,'a']}]);assert.equal((await f.p.client.execute(query)).rows[0].value,3);
 }));assert.equal(f.reads,5);assert.equal(f.value,3);
 await assert.rejects(f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.client.execute({sql:'UPDATE whoop_sleeps SET value=? WHERE user_id=?',args:[4,'a']});
  assert.equal((await f.p.client.execute(query)).rows[0].value,4);throw Error('SPECULATIVE_ROLLBACK');
 })),/SPECULATIVE_ROLLBACK/);
 await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>assert.equal((await f.p.client.execute(query)).rows[0].value,3)));
 assert.equal(f.rollbacks,1);assert.equal(f.value,3);assert.equal(f.reads,8);
});
test('late read cannot repopulate a snapshot after a concurrent write epoch',async()=>{
 const f=fixture();let resolve,once=true;f.setDelay(()=>{if(!once)return;once=false;return new Promise(r=>{resolve=r;});});
 await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  const old=f.p.client.execute(query);while(!resolve)await Promise.resolve();
  await f.p.client.execute({sql:'UPDATE whoop_sleeps SET value=? WHERE user_id=?',args:[2,'a']});resolve();await old;
  assert.equal((await f.p.client.execute(query)).rows[0].value,2);
 }));assert.equal(f.reads,2);
});
test('savepoint/rollback-to/release and a thrown uncertain write cannot preserve prior cached rows',async()=>{
 const f=fixture();await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.client.execute({sql:'SAVEPOINT point'});assert.equal((await f.p.client.execute(query)).rows[0].value,1);
  await f.p.client.execute({sql:'UPDATE whoop_sleeps SET value=?',args:[2]});assert.equal((await f.p.client.execute(query)).rows[0].value,2);
  await f.p.client.execute({sql:'ROLLBACK TO point'});assert.equal((await f.p.client.execute(query)).rows[0].value,1);
  await f.p.client.execute({sql:'RELEASE point'});assert.equal((await f.p.client.execute(query)).rows[0].value,1);
 }));assert.equal(f.reads,5);assert.equal(f.value,1);
 await assert.rejects(f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.client.execute({sql:'THROWN_UNCERTAIN_WRITE'});
 })),/SYNTHETIC_WRITE_FAILED/);
 await f.p.withReadSnapshot(context,()=>f.p.transaction(()=>f.p.client.execute(query)));assert.equal(f.reads,7);assert.equal(f.rollbacks,1);
});
test('an existing runtime fence still executes and can revoke a would-be cached read',async()=>{
 const f=fixture();let revoked=false,checks=0;
 await assert.rejects(f.p.withReadSnapshot(context,()=>f.p.withFence(()=>{checks++;if(revoked)throw Object.assign(Error('SYNTHETIC_AUTH_REVOKED'),{code:'SYNTHETIC_AUTH_REVOKED'});},()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);revoked=true;await f.p.client.execute(query);
 }))),error=>error.code==='SYNTHETIC_AUTH_REVOKED');assert.equal(f.reads,1);assert.ok(checks>=3);assert.equal(f.commits,0);assert.equal(f.rollbacks,1);
});
test('outside rollback/attempt, replaced budget and abandoned closed-transaction scope never share snapshot data',async()=>{
 const f=fixture();let providers=0;await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await f.p.outside('outside',async()=>{providers++;return 1;});await f.p.client.execute(query);
 }));assert.equal(f.reads,2);assert.equal(providers,1);assert.equal(f.rollbacks,1);
 const budget=createExecutionBudget({budgetMs:1000});try{await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
  await f.p.client.execute(query);await withExecutionBudget(budget,()=>f.p.client.execute(query));
 }));}finally{budget.close();}assert.equal(f.reads,4);
 let release,late;const gate=new Promise(resolve=>{release=resolve;});
 await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{await f.p.client.execute(query);late=gate.then(()=>f.p.client.execute(query));}));
 release();await assert.rejects(late,/SYNTHETIC_TX_CLOSED/);assert.equal(f.reads,5);
});
test('parent cancellation, timeout and runtime close fence cached and late reads',async()=>{
 for(const stop of ['cancel','timeout','close']){
  const f=fixture(),controller=new AbortController();let now=100;const budget=createExecutionBudget({budgetMs:1000,nowMs:()=>now,signal:controller.signal});
  try{if(stop==='close')await f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
   await f.p.client.execute(query);f.p.client.close();await f.p.client.execute(query);assert.equal(f.reads,2);
  }));else await assert.rejects(withExecutionBudget(budget,()=>f.p.withReadSnapshot(context,()=>f.p.transaction(async()=>{
   await f.p.client.execute(query);if(stop==='cancel')controller.abort();else now=1100;await f.p.client.execute(query);
  }))),error=>error.code===(stop==='cancel'?'SYNC_CANCELLED':'SYNC_TIMEOUT'));
  }finally{budget.close();}
  if(stop!=='close'){assert.equal(f.reads,1);assert.equal(f.commits,0);assert.equal(f.rollbacks,1);}else assert.equal(f.closed,1);
 }
 const f=fixture();let resolve;f.setDelay(()=>new Promise(r=>{resolve=r;}));const controller=new AbortController(),budget=createExecutionBudget({budgetMs:1000,signal:controller.signal});
 const pending=withExecutionBudget(budget,()=>f.p.withReadSnapshot(context,()=>f.p.transaction(()=>f.p.client.execute(query))));
 while(!resolve)await Promise.resolve();controller.abort();resolve();await assert.rejects(pending,error=>error.code==='SYNC_CANCELLED');budget.close();assert.equal(f.commits,0);assert.equal(f.rollbacks,1);
});
test('clock/leases/owner/admission/key and arbitrary SQL shapes are never snapshot reads',()=>{
 for(const sql of ['SELECT * FROM resource_locks WHERE user_id=?','SELECT * FROM phase4_executions WHERE user_id=?',
  'SELECT * FROM schema_version WHERE user_id=?','SELECT * FROM user_whoop_tokens WHERE user_id=?',
  "SELECT * FROM whoop_sleeps WHERE user_id=? AND updated_at>'now'",'SELECT random() FROM whoop_sleeps WHERE user_id=?',
  'SELECT * FROM whoop_sleeps WHERE user_id=? OR user_id=?','SELECT * FROM whoop_sleeps WHERE user_id=?; UPDATE users SET status=?',
  'SELECT * FROM whoop_sleeps WHERE user_id=? AND updated_at>CURRENT_TIMESTAMP','SELECT * FROM unknown WHERE user_id=?',
  'SELECT * FROM whoop_sleeps WHERE user_id=? -- comment']){
  assert.equal(readSnapshotKey({sql,args:['a']},context),null,sql);
 }
 assert.equal(readSnapshotKey(query,{userId:'b'}),null);assert.equal(readSnapshotKey({...query,args:{user_id:'a'}},context),null);
 for(const value of [undefined,NaN,Infinity,{},new Date()])assert.equal(readSnapshotKey({...query,args:['a',value]},context),null);
 assert.equal(readSnapshotKey({...query,args:['a','x'.repeat(READ_SNAPSHOT_LIMITS.keyBytes)]},context),null);
 assert.ok(readSnapshotKey({sql:'SELECT 1 FROM whoop_capabilities WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN (\'UNSUPPORTED\',\'UNAVAILABLE\')',args:['a','sleep',1]},context));
});
test('memo bounds and closed/cleared epochs cannot retain or return new results',()=>{
 const memo=createReadSnapshotMemo();for(let i=0;i<READ_SNAPSHOT_LIMITS.entries+1;i++)memo.put(context,String(i),result(i),memo.epoch());
 assert.equal(memo.get(context,String(READ_SNAPSHOT_LIMITS.entries)),undefined);
 const epoch=memo.epoch();memo.clear();memo.put(context,'late',result(),epoch);assert.equal(memo.get(context,'late'),undefined);
 memo.put(context,'oversized',result('x'.repeat(READ_SNAPSHOT_LIMITS.resultBytes)),memo.epoch());assert.equal(memo.get(context,'oversized'),undefined);
 memo.put(context,'binary',result(new ArrayBuffer(READ_SNAPSHOT_LIMITS.resultBytes+1)),memo.epoch());assert.equal(memo.get(context,'binary'),undefined);
 const tooMany=result();tooMany.rows=Array.from({length:READ_SNAPSHOT_LIMITS.rows+1},()=>result().rows[0]);memo.put(context,'rows',tooMany,memo.epoch());assert.equal(memo.get(context,'rows'),undefined);
 const byteBound=createReadSnapshotMemo();for(let i=0;i<32;i++)byteBound.put(context,String(i),result('x'.repeat(200000)),byteBound.epoch());
 assert.ok(byteBound.get(context,'0'));assert.equal(byteBound.get(context,'31'),undefined);byteBound.close();
 memo.close();memo.put(context,'closed',result(),memo.epoch());assert.equal(memo.get(context,'closed'),undefined);
});
