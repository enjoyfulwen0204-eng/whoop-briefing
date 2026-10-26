import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {metricProducerPageSql} from '../src/phase4MetricProofSql.js';
import {metricProducerDataKey} from '../src/processingMetricProducerData.js';
import {currentExecutionReceiptTransactionMarker,withExecutionReceiptTransaction} from '../src/phase4ExecutionContext.js';
const sql=metricProducerPageSql(true),context={userId:'a',executionMode:'LIVE',providerRequired:true,inputGeneration:1};
const query={sql,args:['a','LIVE',1,'']};
const template=createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex');
const physical=f=>f.transport.counts.byTemplate[template]?.count??0;
async function setup(t){
 const f=await fixture(t,35,{traceTransactions:true});
 await f.db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys});await stores.initializeTenant('a','SHADOW');
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});await f.db.setLocale('a','en');
 f.producer=await createStage8LiveProducer({db:f.db,keys:fixtureKeys,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 return f;
}
test('only the exact bounded LIVE producer DATA page is admitted without evaluating accessors or proxies',()=>{
 const key=metricProducerDataKey(query,context);assert.ok(key);
 for(const other of [
  {...query,sql:metricProducerPageSql(false)}, {...query,sql:sql+' '}, {...query,sql:'SELECT * FROM stage8_live_executions WHERE lease_until>unixepoch()'},
  {...query,sql:'WITH expected AS (VALUES (?,?)) SELECT * FROM stage8_live_execution_work_receipts'},
  {...query,args:['b','LIVE',1,'']},{...query,args:['a','SHADOW',1,'']},{...query,args:['a','LIVE',2,'']},
  {...query,args:['a','LIVE',1,'x'.repeat(4097)]},{...query,args:['a','LIVE',1,'',1]}, {...query,extra:true},
  new Proxy(query,{get(){throw Error('PROXY_GET');}}),
  {get sql(){throw Error('SQL_GETTER');},args:query.args},
  {sql,args:['a','LIVE',1,{}]},
 ])assert.equal(metricProducerDataKey(other,context),null);
 const getterArgs=['a','LIVE',1,''];Object.defineProperty(getterArgs,'3',{get(){throw Error('ARG_GETTER');}});
 assert.equal(metricProducerDataKey({sql,args:getterArgs},context),null);
 for(const changed of [{...context,userId:'b'},{...context,providerRequired:false},{...context,executionMode:'SHADOW'},
  {...context,inputGeneration:NaN},new Proxy(context,{get(){throw Error('CONTEXT_GETTER');}})])assert.equal(metricProducerDataKey(query,changed),null);
 assert.notEqual(key,metricProducerDataKey({...query,args:['a','LIVE',1,'later']},context));
});
test('actual owned HTTP root isolates marker, cursor and mutation epochs and never shares mutable producer rows',async t=>{
 const f=await setup(t),original=f.db.raw.execute;let observed=false,mutationObserved=false,producerStatement;
 f.db.raw.execute=async stmt=>{
  if(!mutationObserved&&producerStatement&&stmt?.sql?.startsWith('UPDATE evidence_runs')){
   const prior=await original(producerStatement),n=physical(f);
   const result=await original(stmt);
   assert.deepEqual((await original(producerStatement)).rows,prior.rows);
   assert.equal(physical(f),n+1,'an original actual business DML clears producer DATA');
   mutationObserved=true;return result;
  }
  const result=await original(stmt);
  if(stmt?.sql===sql)producerStatement=stmt;
  if(!observed&&stmt?.sql===sql&&currentExecutionReceiptTransactionMarker()&&result.rows.length){
   observed=true;const n=physical(f),snapshot=JSON.stringify(result.rows);result.rows[0].tenant_proof='CALLER_MUTATION';
   const again=await original(stmt);assert.equal(physical(f),n,'same marker uses row DATA');assert.equal(JSON.stringify(again.rows),snapshot);
   await withExecutionReceiptTransaction(async()=>{
    await original(stmt);assert.equal(physical(f),n+1,'nested original marker has its own namespace');
    await original(stmt);assert.equal(physical(f),n+1);
   });
   await original(stmt);assert.equal(physical(f),n+1,'restored outer marker keeps only its own data');
   await original({...stmt,args:[...stmt.args.slice(0,3),'different-cursor']});assert.equal(physical(f),n+2);
   return again;
  }
  return result;
 };
 try{for(let i=0;i<3;i++){const value=await f.producer.run({userId:'a',requestId:'actual-producer-data-boundaries-'+i});assert.equal(value.result.jobsFailed,0);}}finally{f.db.raw.execute=original;}
 assert.equal(observed,true);assert.equal(mutationObserved,true);assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});
for(const fault of ['PRODUCER_HMAC','REVOKED_OWNER'])test('actual cached DATA still runs original fresh validation: '+fault,async t=>{
 const f=await setup(t);await f.producer.run({userId:'a',requestId:'actual-producer-data-prefix-'+fault});
 const before=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows;
 const original=f.db.raw.execute,seen=new Map(),polluted=new Set();let injected=0,effects=0,hits=0;
 f.db.raw.execute=async stmt=>{
  const text=typeof stmt==='string'?stmt:stmt.sql,marker=currentExecutionReceiptTransactionMarker();
  if(polluted.has(marker)&&/^(INSERT INTO|UPDATE) (evidence_|stage8_live_execution_work_receipts|stage8_live_operation_receipts|stage8_live_publications)/.test(text))effects++;
  const n=physical(f),result=await original(stmt);
  if(text===sql&&marker){
   const ordinal=(seen.get(marker)??0)+1;seen.set(marker,ordinal);
   if(ordinal===2&&physical(f)===n&&result.rows.length){
    hits++;injected++;polluted.add(marker);
    if(fault==='PRODUCER_HMAC')return {...result,rows:result.rows.map(r=>({...r,tenant_proof:'BAD_PRODUCER_HMAC'}))};
   }
  }
  if(fault==='REVOKED_OWNER'&&polluted.has(marker)&&/^SELECT \* FROM stage8_live_executions WHERE execution_id=\? AND owner=\? AND generation=\?/.test(text))return {...result,rows:[]};
  return result;
 };
 let value,error;try{value=await f.producer.run({userId:'a',requestId:'actual-producer-data-fault-'+fault});}catch(e){error=e;}finally{f.db.raw.execute=original;}
 assert.ok(hits>0,'must exercise an actual physical producer-page cache hit');assert.ok(injected>0);assert.equal(effects,0,'no effect in a root containing rejected producer or fresh owner');
 if(error)assert.match(String(error.code??error.message),/METRIC_UNIT_RECEIPT_REQUIRED|OWNER_FENCED|STAGE8_LIVE/);
 else{assert.ok(value.result.jobsFailed>0);assert.equal(value.result.jobsCompleted,0);assert.notEqual(value.publication.status,'CURRENT');}
 const after=new Set((await original('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const row of before)assert.ok(after.has(JSON.stringify(row)),'existing genuine receipts remain byte-identical');
 assert.equal((await original('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});
