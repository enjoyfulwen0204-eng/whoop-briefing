// Focused fake-executor regression. External DB SDK constructors and network throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
const APP=dirname(dirname(fileURLToPath(import.meta.url)));
const TX=pathToFileURL(join(APP,'src/processingTransaction.js')).href;
const MEMO=pathToFileURL(join(APP,'src/processingReadSnapshot.js')).href;
const NO_MEMO=TX+'?principal-readiness-memo-disabled';
const stub='data:text/javascript,'+encodeURIComponent("const no=()=>{throw Error('PURE_TEST_REAL_DB_FORBIDDEN')};export const createClient=no;export default class Database{constructor(){no()}};export class Sqlite3Client{constructor(){no()}};export class Sqlite3Transaction{constructor(){no()}};");
registerHooks({
 resolve(specifier,ctx,next){
  if(['@libsql/client','@libsql/client/sqlite3','libsql'].includes(specifier))return {url:stub,shortCircuit:true};
  return next(specifier,ctx);
 },
 load(url,ctx,next){
  if(url===NO_MEMO){
   // Comparison control disables only this opt-in in memory, retaining every callback.
   const source=readFileSync(fileURLToPath(TX),'utf8').replace(
    "state.principalReadinessMemoEnabled=privateRuntime&&base.protocol==='http'",
    'state.principalReadinessMemoEnabled=false&&privateRuntime&&base.protocol===\'http\'');
   assert.notEqual(source,readFileSync(fileURLToPath(TX),'utf8'));
   return {format:'module',source,shortCircuit:true};
  }
  return next(url,ctx);
 }
});
globalThis.fetch=()=>{throw Error('PURE_TEST_NETWORK_FORBIDDEN');};
const original=await import(NO_MEMO);
const proposed=await import(TX);
const {readSnapshotKey}=await import(MEMO);
const {withExecutionBudget,currentExecutionBudget}=await import(pathToFileURL(join(APP,'src/executionBudget.js')).href);
const {withDurableExecution}=await import(pathToFileURL(join(APP,'src/phase4ExecutionContext.js')).href);
const READY=`SELECT u.status,o.state,COALESCE(t.auth_generation,0) auth_generation,p.pending_purge_count
 FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
 LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`;
const normalized=sql=>sql.replace(/\s+/g,' ').trim();
const UID='synthetic-principal';
const readyRow=()=>({status:'ACTIVE',state:'READY',auth_generation:1,pending_purge_count:0});
const failure=code=>Object.assign(Error(code),{code});
function result(rows=[]){return {columns:['status','state','auth_generation','pending_purge_count'],columnTypes:['TEXT','TEXT','INTEGER','INTEGER'],rows,rowsAffected:0,lastInsertRowid:undefined};}
function budget(){
 const abort=new AbortController();let expired=false,assertions=0;
 return {abort,signal:abort.signal,deadlineAt:Date.now()+15000,remainingMs:()=>expired?0:15000,
  assert(){assertions++;if(expired||abort.signal.aborted)throw failure('SYNC_TIMEOUT');},expire(){expired=true;},assertions:()=>assertions};
}
function harness(module=proposed,{protocol='http',privateRuntime=true,mode='LIVE'}={}){
 const h={trace:[],transactions:[],principal:readyRow(),phase:'PRE',callbacks:0,localChecks:0,config:{enabled:true,eligible:true,sameRelease:true},budget:budget()};
 h.context=Object.freeze({userId:UID,executionMode:mode});
 h.execution={receipts:false,pending:new Set(),claim:{request:{phase:'STAGE6_DRAIN',executionMode:mode}},authority:{assert(){currentExecutionBudget()?.assert();}}};
 const sqlOf=q=>typeof q==='string'?q:q.sql;
 async function execute(q,tx=null){
  const sql=sqlOf(q),event={sql,phase:h.phase,tx:tx?.id??null,epoch:module.processingReadObservationEpoch(h.api?.client)};h.trace.push(event);
  if(normalized(sql)===normalized(READY)){
   if(h.failNextRead){h.failNextRead=false;throw failure('SYNTHETIC_READ_FAILURE');}
   assert.equal(typeof q,'object');assert.deepEqual(q.args,[UID]);return result([{...(tx?.principal??h.principal)}]);
  }
  if(sql==='SELECT 1'){if(tx)tx.beginAcknowledged=true;return result([{n:1}]);}
  if(sql==='SELECT 7')return result([{n:7}]);
  if(sql==='UPDATE synthetic_business SET n=?'){
   assert.ok(tx?.beginAcknowledged,'only acknowledged fake write root');h.onMutation?.(tx,event);return {...result(),rowsAffected:1};
  }
  throw Error('PURE_TEST_UNEXPECTED_SQL');
 }
 const base={protocol,closed:false,execute:q=>execute(q),batch:qs=>Promise.all(qs.map(q=>execute(q))),
  async transaction(writeMode){
   assert.equal(writeMode,'write');
   const tx={id:h.transactions.length+1,principal:{...h.principal},closed:false,beginAcknowledged:protocol!=='http',commitCalls:0,rollbackCalls:0,
    execute:q=>execute(q,tx),async batch(qs){const out=[];for(const q of qs)out.push(await execute(q,tx));return out;},
    async commit(){
     tx.commitCalls++;h.trace.push({commitAttempt:tx.commitCalls,tx:tx.id,readyFetches:h.readyFetches(tx.id)});
     if(h.busyLeft>0){h.busyLeft--;h.onBusy?.(tx);throw failure('SQLITE_BUSY');}
     h.principal={...tx.principal};tx.closed=true;
    },async rollback(){tx.rollbackCalls++;tx.closed=true;},close(){tx.closed=true;}};
   h.transactions.push(tx);return tx;
  },close(){base.closed=true;}};
 h.api=module.processingTransactions(base,{privateRuntime});
 h.query=()=>h.api.client.execute({sql:READY,args:[UID]});
 h.readyFetches=id=>h.trace.filter(e=>typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)&&(id===undefined||e.tx===id)).length;
 h.guard=module.readOnlyProcessingCheck(async()=>{
  h.callbacks++;h.localChecks++;
  if(!h.config.enabled||!h.config.eligible||!h.config.sameRelease)throw failure('SYNTHETIC_LOCAL_CONFIGURATION_FENCED');
  const row=(await h.query()).rows[0];
  if(!row||row.status!=='ACTIVE'||row.state!=='READY'||row.auth_generation<1||row.pending_purge_count!==0)throw failure('STAGE8_LIVE_PRINCIPAL_FENCED');
 });
 h.scope=(work,{context=h.context,clock=h.budget,execution=h.execution}={})=>withExecutionBudget(clock,()=>withDurableExecution(execution,()=>h.api.withReadSnapshot(context,work)));
 h.run=(work,{after=false,...scope}={})=>h.scope(()=>h.api.withFence(h.guard,()=>h.api.transaction(work,after?{after:h.guard}:{})),scope);
 return h;
}

test('exact readiness shape requires explicit opted-in tenant-bound key; all other SQL stays excluded',()=>{
 const q={sql:READY,args:[UID]},context={userId:UID};
 assert.equal(readSnapshotKey(q,context),null);assert.ok(readSnapshotKey(q,context,{allowPrincipalReadiness:true}));
 for(const value of [{...q,args:['other']},{...q,args:[UID,1]},{...q,sql:READY+' OR 1=1'},{...q,sql:READY.replace('o.state','o.*')}])assert.equal(readSnapshotKey(value,context,{allowPrincipalReadiness:true}),null);
 assert.equal(readSnapshotKey({sql:'SELECT schema_version FROM pragma_schema_version',args:[UID]},context,{allowPrincipalReadiness:true}),null);
});

test('disabling only readiness memo keeps the same fence callbacks and predicates with more transports',async t=>{
 const runs=[];
 for(const module of [original,proposed]){
  const h=harness(module);await h.run(async()=>{h.phase='BODY';for(let n=0;n<8;n++)await h.api.client.execute('SELECT 7');h.phase='TERMINAL';},{after:true});runs.push(h);
 }
 const [a,b]=runs;assert.equal(b.callbacks,a.callbacks);assert.equal(b.localChecks,a.localChecks);assert.ok(b.readyFetches()<a.readyFetches());
 assert.equal(b.trace.filter(e=>e.phase==='BODY'&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)).length,0);
 assert.ok(b.trace.some(e=>e.phase==='TERMINAL'&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)));
 assert.equal(b.transactions[0].commitCalls,1);assert.equal(b.transactions[0].rollbackCalls,0);
 t.diagnostic(JSON.stringify({kind:'PURE_FIXED_FENCE_QUERY_MODEL_NOT_NATIVE_TIMING',sameCallbacks:b.callbacks,originalReadyFetches:a.readyFetches(),proposedReadyFetches:b.readyFetches()}));
});

test('every own mutation and batch clears before and after, including trigger-side principal revocation',async()=>{
 for(const batch of [false,true]){
  const h=harness();let before,during,after;
  h.onMutation=(tx,event)=>{during=event.epoch;tx.principal.pending_purge_count=1;};
  await assert.rejects(h.run(async()=>{
   h.phase='BODY';await h.api.client.execute('SELECT 7');before=proposed.processingReadObservationEpoch(h.api.client);
   if(batch)await h.api.client.batch([{sql:'UPDATE synthetic_business SET n=?',args:[1]},{sql:'SELECT 7',args:[]}]);
   else await h.api.client.execute({sql:'UPDATE synthetic_business SET n=?',args:[1]});
   after=proposed.processingReadObservationEpoch(h.api.client);await h.api.client.execute('SELECT 7');
  }),{code:'STAGE8_LIVE_PRINCIPAL_FENCED'});
  assert.ok(during>before);assert.ok(after>during);assert.equal(h.transactions[0].commitCalls,0);assert.equal(h.transactions[0].rollbackCalls,1);
 }
});

test('terminal freshness rejects injected changed principal after warm callback snapshot',async()=>{
 const h=harness();await assert.rejects(h.run(async()=>{
  h.phase='BODY';await h.api.client.execute('SELECT 7');
  // Adversarial fake native-state change: not a claim that another SQLite writer can commit through BEGIN IMMEDIATE.
  h.transactions[0].principal.state='BLOCKED';h.phase='TERMINAL';
 },{after:true}),{code:'STAGE8_LIVE_PRINCIPAL_FENCED'});
 assert.ok(h.trace.some(e=>e.phase==='TERMINAL'&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)));
 assert.equal(h.transactions[0].commitCalls,0);assert.equal(h.transactions[0].rollbackCalls,1);
});

test('COMMIT retry freshness repeats the DB predicate and refuses changed principal before retry',async()=>{
 const h=harness();h.busyLeft=1;h.onBusy=tx=>{tx.principal.auth_generation=0;h.phase='AFTER_BUSY';};
 await assert.rejects(h.run(async()=>{h.phase='BODY';await h.api.client.execute('SELECT 7');h.phase='COMMIT';}),{code:'STAGE8_LIVE_PRINCIPAL_FENCED'});
 assert.equal(h.transactions[0].commitCalls,1);assert.equal(h.transactions[0].rollbackCalls,1);
 assert.ok(h.trace.some(e=>e.phase==='AFTER_BUSY'&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)));
 const valid=harness();valid.busyLeft=1;await valid.run(async()=>{await valid.api.client.execute('SELECT 7');});
 const attempts=valid.trace.filter(e=>e.commitAttempt);assert.equal(attempts.length,2);assert.ok(attempts[1].readyFetches>attempts[0].readyFetches);
});

test('local eligibility configuration and budget revocation remain live despite warm readiness data',async()=>{
 for(const flag of ['enabled','eligible','sameRelease']){
  const h=harness();await assert.rejects(h.run(async()=>{await h.api.client.execute('SELECT 7');h.config[flag]=false;await h.api.client.execute('SELECT 7');}),{code:'SYNTHETIC_LOCAL_CONFIGURATION_FENCED'});
  assert.equal(h.transactions[0].commitCalls,0);assert.equal(h.transactions[0].rollbackCalls,1);assert.equal(h.callbacks,h.localChecks);
 }
 for(const cancel of [false,true]){
  const h=harness();await assert.rejects(h.run(async()=>{await h.api.client.execute('SELECT 7');if(cancel)h.budget.abort.abort();else h.budget.expire();await h.api.client.execute('SELECT 7');}),{code:'SYNC_TIMEOUT'});
  assert.equal(h.transactions[0].commitCalls,0);assert.equal(h.transactions[0].rollbackCalls,1);
 }
});

test('context budget execution and transaction boundaries cannot consume another snapshot',async()=>{
 const h=harness();await h.scope(()=>h.api.transaction(async()=>{
  await h.query();await h.query();assert.equal(h.readyFetches(1),1);
  const otherContext=Object.freeze({userId:UID,executionMode:'LIVE'});await h.api.withReadSnapshot(otherContext,async()=>{await h.query();await h.query();});assert.equal(h.readyFetches(1),2);
  await withExecutionBudget(budget(),async()=>{await h.query();await h.query();});assert.equal(h.readyFetches(1),4);
  await withDurableExecution({...h.execution,pending:new Set()},async()=>{await h.query();await h.query();});assert.equal(h.readyFetches(1),6);
 }));
 await h.scope(()=>h.api.transaction(async()=>{await h.query();await h.query();}));assert.equal(h.readyFetches(2),1);
 await h.scope(async()=>{await h.query();await h.query();});assert.equal(h.trace.filter(e=>e.tx===null&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY)).length,2);
});

test('errors and rollback discard state; result clones cannot mutate the retained principal row',async()=>{
 const h=harness();h.failNextRead=true;await assert.rejects(h.scope(()=>h.api.transaction(()=>h.query())),{code:'SYNTHETIC_READ_FAILURE'});assert.equal(h.transactions[0].rollbackCalls,1);
 await h.scope(()=>h.api.transaction(async()=>{const a=await h.query();a.rows[0].state='BLOCKED';const b=await h.query();assert.equal(b.rows[0].state,'READY');}));assert.equal(h.readyFetches(2),1);
 await assert.rejects(h.scope(()=>h.api.transaction(async()=>{await h.query();throw failure('SYNTHETIC_CALLBACK_FAILURE');})),{code:'SYNTHETIC_CALLBACK_FAILURE'});
 await h.scope(()=>h.api.transaction(()=>h.query()));assert.equal(h.readyFetches(4),1);
});

test('no readiness memo outside owned HTTP LIVE roots or before original BEGIN acknowledgement',async()=>{
 for(const options of [{protocol:'file'},{privateRuntime:false},{mode:'SHADOW'}]){
  const h=harness(proposed,options);await h.scope(()=>h.api.transaction(async()=>{await h.query();await h.query();}));assert.equal(h.readyFetches(1),2);
 }
 const h=harness();await h.scope(()=>h.api.transaction(()=>h.query()));const first=h.trace.findIndex(e=>e.sql==='SELECT 1'),ready=h.trace.findIndex(e=>e.tx===1&&typeof e.sql==='string'&&normalized(e.sql)===normalized(READY));assert.ok(first>=0&&ready>first);assert.equal(h.transactions[0].beginAcknowledged,true);
});

test('producer predicates and explicit terminal barriers remain present',()=>{
 const tx=readFileSync(fileURLToPath(TX),'utf8'),producer=readFileSync(join(APP,'src/stage8LiveProducer.js'),'utf8');
 assert.equal(tx.split('if(state.principalReadinessMemoEnabled)readMemo.close();').length-1,3);
 assert.ok(tx.indexOf('state.replaying=true;if(state.principalReadinessMemoEnabled)readMemo.close();')<tx.indexOf('const result=replay?'));
 assert.ok(tx.indexOf('if(state.principalReadinessMemoEnabled)readMemo.close();')<tx.indexOf('await runChecks([...state.checks'));
 assert.match(producer,/async function ready\(id\)\{\s*liveProducerConfiguration\(capability,db.raw,keys,id\);/);
 const actualReady=/const row=\(await db\.raw\.execute\(\{sql:`([\s\S]*?)`,args:\[id\]\}\)\)\.rows\[0\]/.exec(producer)?.[1];assert.ok(actualReady);assert.equal(normalized(READY),normalized(actualReady));
 assert.ok(producer.includes("if(!row||row.status!=='ACTIVE'||row.state!=='READY'||row.auth_generation<1||row.pending_purge_count!==0)"));
});
