// Opt-in isolated controls reuse an immutable, signed, genuinely computed test
// fixture. No Stage6 WORK, source generation reset, provider or Telegram call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client/sqlite3';
import {createDb} from '../src/db.js';
import {fixtureKeys as keys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {exactRealStatement} from '../src/exactRealStatement.js';
import {stage6RuntimeBinding} from '../src/stage6RuntimeBinding.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {publishStage8Live} from '../src/stage8LivePublication.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {createPhase4ContextRegistry} from '../src/phase4Cache.js';
import {log} from '../src/logger.js';
for(const name of ['info','warn','error'])log[name]=()=>{};
const fixturePath=process.env.STAGE8_SYNTHETIC_READER_FIXTURE_PATH;
if(!fixturePath)throw Error('EXPLICIT_SIGNED_SYNTHETIC_READER_FIXTURE_REQUIRED');
const {seal,...fixture}=JSON.parse(readFileSync(fixturePath,'utf8'));
assert.equal(seal,keys.lookup([fixture.contract,fixture]));
assert.equal(fixture.tables.find(t=>t.name==='users').rows.length,1);
const q=value=>'"'+value.replaceAll('"','""')+'"';
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),'prepared-reader-control-')),url='file:'+join(dir,'db.sqlite'),transport=hranaTransport(url,{traceTransactions:true,transactionMaxMs:5000}),control=createClient({url}),db=createDb({url:'https://isolated.invalid',phase4Keys:keys,fetch:request=>transport.fetch(request)});
 t.after(async()=>{try{db.close();control.close();transport.close();}finally{await rm(dir,{recursive:true,force:true});}});
 const statements=[...fixture.schema.filter(r=>r.type==='table').map(r=>r.sql),'PRAGMA defer_foreign_keys=ON'];
 for(const table of fixture.tables)for(const row of table.rows)statements.push(exactRealStatement({sql:`INSERT INTO ${q(table.name)}(${table.columns.map(q).join(',')}) VALUES(${row.map(()=>'?').join(',')})`,args:row}));
 statements.push(...fixture.schema.filter(r=>r.type!=='table').map(r=>r.sql));await db.raw.batch(statements,'write');assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 const admission=await db.admitRuntime(),capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'}),core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,withReadSnapshot:db.withProcessingReadSnapshot,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(){}});
 const ctx=await core.capture('a',{executionMode:'LIVE',providerRequired:true});await publishStage8Live(core,ctx,capability);
 let offset=0,enabled=true;const now=()=>new Date(Date.now()+offset),reader=createStage8DerivedReader({db,keys,admission,eligible:id=>enabled&&id==='a',now}),scope={permitted:true,userId:'a',executionMode:'LIVE',purpose:'SELF_QA',asOfEpochMs:Date.now()};scope.asOfUtc=new Date(scope.asOfEpochMs).toISOString();
 const computation=(await control.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
 assert.equal(computation.last_completed_generation,computation.input_generation);
 const input={scope,kinds:['EVIDENCE'],inputGeneration:computation.input_generation},base=stage6RuntimeBinding(db).base;
 const holds=async()=>(await control.execute("SELECT name,owner,expires_at FROM resource_locks WHERE name LIKE '%:prepared-read-disposal:%'")).rows;
 const unchanged=async()=>{
  const out=[];for(const table of fixture.tables.filter(t=>/^(?:stage8_live_(?:execution|operation)|phase4_jobs|evidence_|health_insights|body_energy_results)/.test(t.name)))out.push([table.name,(await control.execute('SELECT * FROM '+q(table.name))).rows.map(row=>JSON.stringify(table.columns.map(c=>row[c]))).sort()]);return out;
 };
 const before=await unchanged();
 function beforeReceiver(attack,root=3){const original=base.transaction;let roots=0,attacked=false;base.transaction=async function(...args){roots++;if(roots===root){attacked=true;await attack();}return original.apply(this,args);};t.after(()=>{base.transaction=original;});return ()=>assert.equal(attacked,true,'FAULT_AT_FIRST_RECEIVER_ROOT_AFTER_PREPARATION');}
 return {db,control,transport,reader,input,holds,before,unchanged,beforeReceiver,expire:()=>{offset=180000;},advance:ms=>{offset=ms;},revoke:()=>{enabled=false;},base,now,admission};
}

test('prepared Evidence and all four reply kinds retain canonical proofs in one readonly receiver',async t=>{
 const f=await setup(t),scopes=await createScopedHealthContext({db:f.db,keys,admission:f.admission,derivedReader:f.reader,now:f.now}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'});
 for(const kind of ['EVIDENCE','BODY_ENERGY','EPISODES','INSIGHTS']){const value=await scopes.derived(scope,kind);assert.equal(value.status,'CURRENT');if(kind==='EVIDENCE')assert.equal(value.items.length,8);}
 const reply=await scopes.sealReply(scope,{text:'SYNTHETIC_CANONICAL_REPLY'});
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),true);
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10002',reply}),false);
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply:{...reply,text:'FORGED_PROJECTION'}}),false);
 assert.equal((await f.holds()).length,0);assert.deepEqual(await f.unchanged(),f.before);
 console.log('PREPARED_READ_CONTROL '+JSON.stringify({kind:'FOUR_KIND_REPLY',diagnostics:f.reader.preparedStatus(),nativeWork:0,production:false}));
});

for(const [attack,sql] of [
 ['SOURCE_GENERATION',"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'"],
 ['AUTH_REVISION',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'"],
 ['PURGE',"UPDATE phase4_user_state SET pending_purge_count=pending_purge_count+1 WHERE user_id='a'"],
 ['CANONICAL_SOURCE',"UPDATE whoop_sleeps SET score_state='PENDING_SCORE' WHERE user_id='a'"],
])test('prepared receiver rejects '+attack+' committed after local preparation',async t=>{
 const f=await setup(t),attacked=f.beforeReceiver(()=>f.control.execute(sql));let returned=false;
 await assert.rejects(f.reader.withPreparedSnapshot(f.input,values=>{returned=true;return values;}));
 attacked();assert.equal(returned,false);assert.equal(f.reader.preparedStatus(),null);assert.deepEqual(await f.unchanged(),f.before);
});

test('prepared receiver keeps the permanent hold and returns no result on lost COMMIT ACK',async t=>{
 const f=await setup(t),attacked=f.beforeReceiver(()=>{f.transport.arm({matchSql:/json_each\(\?\) AS __stage6_expected/,loseAcknowledgement:true});});
 await assert.rejects(f.reader.withPreparedSnapshot(f.input),error=>error.code==='COMMIT_INDETERMINATE');attacked();
 const holds=await f.holds();assert.equal(holds.length,1);assert.equal(holds[0].expires_at,'9999-12-31T23:59:59.999Z');assert.equal(f.reader.preparedStatus(),null);assert.deepEqual(await f.unchanged(),f.before);
 const registry=createPhase4ContextRegistry({client:f.control,keys,timestamp:()=> '9999-12-31T23:59:59.999Z'});assert.equal(await registry.pending('a',1),1);assert.deepEqual(await f.holds(),holds);
});

test('prepared receiver cannot renew the original SELF_QA expiry',async t=>{
 const f=await setup(t),attacked=f.beforeReceiver(f.expire);
 await assert.rejects(f.reader.withPreparedSnapshot(f.input),/SCOPE_REQUIRED|SYNC_TIMEOUT|CANCELLED/);attacked();assert.equal(f.reader.preparedStatus(),null);assert.deepEqual(await f.unchanged(),f.before);
});

test('server finish callback is under strict read-only DML enforcement',async t=>{
 const f=await setup(t);let entered=false;
 await assert.rejects(f.reader.withPreparedSnapshot(f.input,async()=>{entered=true;await f.db.raw.execute("UPDATE users SET display_name='forbidden' WHERE id='a'");return true;}),/READ_ONLY|READONLY|PREPARATION/i);
 assert.equal(entered,true);assert.equal((await f.control.execute("SELECT display_name FROM users WHERE id='a'")).rows[0].display_name,'Synthetic');assert.equal(f.reader.preparedStatus(),null);assert.deepEqual(await f.unchanged(),f.before);
});


for(const action of ['POLICY','SCOPE_EXPIRY'])test('projection stays private when '+action+' changes during acknowledged hold cleanup',async t=>{
 const f=await setup(t),execute=f.base.execute;let attacked=false;
 f.base.execute=async function(statement,...args){const result=await execute.call(this,statement,...args);if(typeof statement==='object'&&statement.sql.startsWith('DELETE FROM resource_locks')&&String(statement.args[0]).includes(':prepared-read-disposal:')){attacked=true;if(action==='POLICY')f.revoke();else f.expire();}return result;};
 t.after(()=>{f.base.execute=execute;});
 await assert.rejects(f.reader.withPreparedSnapshot(f.input),/SCOPE_REQUIRED|SYNC_TIMEOUT|CANCELLED/);assert.equal(attacked,true);assert.equal(f.reader.preparedStatus(),null);assert.equal((await f.holds()).length,0);
});

for(const ack of ['LOST','LATE'])test('uncertain registration '+ack+' ACK retains its signed permanent hold before any source capture',async t=>{
 const f=await setup(t),prior=f.transport.counts.byFamily.CANONICAL??0,attacked=f.beforeReceiver(()=>{f.transport.arm({matchSql:/resource_locks/i,...(ack==='LOST'?{loseAcknowledgement:true}:{after:()=>new Promise(resolve=>setTimeout(resolve,5300))})});},2);
 await assert.rejects(f.reader.withPreparedSnapshot(f.input),/COMMIT|SYNC_TIMEOUT|SYNC_CANCELLED|ABORT/i);attacked();
 if(ack==='LATE')await new Promise(resolve=>setTimeout(resolve,400));
 assert.equal((await f.holds()).length,1);assert.equal(f.transport.counts.byFamily.CANONICAL??0,prior);assert.equal(f.reader.preparedStatus(),null);assert.deepEqual(await f.unchanged(),f.before);
});

test('reply cannot outlive its original expiry during successful prepared-hold cleanup',async t=>{
 const f=await setup(t);let acceptedBeforeCleanup;
 const derivedReader=Object.assign(f.reader.bind(null),{withPreparedSnapshot:(input,finish)=>f.reader.withPreparedSnapshot(input,async (values,proof)=>{acceptedBeforeCleanup=await finish(values,proof);return acceptedBeforeCleanup;})}),
  scopes=await createScopedHealthContext({db:f.db,keys,admission:f.admission,derivedReader,now:f.now}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'});
 assert.equal((await scopes.derived(scope,'EVIDENCE')).status,'CURRENT');const reply=await scopes.sealReply(scope,{text:'ORIGINAL_EXPIRING_REPLY'});
 // Start ten seconds before the UNCHANGED original guard expires. Cleanup
 // crosses only that expiry; the new internal scope is still <120s old.
 f.advance(reply.stage8ReplyGuard.expiresAt-Date.now()-10000);const execute=f.base.execute;let attacked=false;
 f.base.execute=async function(statement,...args){const result=await execute.call(this,statement,...args);if(typeof statement==='object'&&statement.sql.startsWith('DELETE FROM resource_locks')&&String(statement.args[0]).includes(':prepared-read-disposal:')){attacked=true;f.advance(reply.stage8ReplyGuard.expiresAt-Date.now()+1);}return result;};t.after(()=>{f.base.execute=execute;});
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),false);assert.equal(acceptedBeforeCleanup,true);assert.equal(attacked,true);assert.equal((await f.holds()).length,0);
});


for(const [name,sql] of [
 ['AUTH',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'"],
 ['PURGE',"UPDATE phase4_user_state SET pending_purge_count=pending_purge_count+1 WHERE user_id='a'"],
 ['SOURCE',"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'"],
 ['ACTOR',"DELETE FROM user_telegram WHERE user_id='a'"],
])test('reply final metadata rejects '+name+' changed after acknowledged health receiver during hold cleanup',async t=>{
 const f=await setup(t);let acceptedBeforeCleanup;
 const derivedReader=Object.assign(f.reader.bind(null),{withPreparedSnapshot:(input,finish)=>f.reader.withPreparedSnapshot(input,async (values,proof)=>{acceptedBeforeCleanup=await finish(values,proof);return acceptedBeforeCleanup;})}),scopes=await createScopedHealthContext({db:f.db,keys,admission:f.admission,derivedReader,now:f.now}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'});
 assert.equal((await scopes.derived(scope,'EVIDENCE')).status,'CURRENT');const reply=await scopes.sealReply(scope,{text:'SYNTHETIC_ORIGINAL_REPLY'}),execute=f.base.execute;let attacked=false;
 f.base.execute=async function(statement,...args){const result=await execute.call(this,statement,...args);if(typeof statement==='object'&&statement.sql.startsWith('DELETE FROM resource_locks')&&String(statement.args[0]).includes(':prepared-read-disposal:')){await f.control.execute(sql);attacked=true;}return result;};t.after(()=>{f.base.execute=execute;});
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),false);assert.equal(acceptedBeforeCleanup,true);assert.equal(attacked,true);assert.equal((await f.holds()).length,0);
});


test('publication metadata is immutable and a foreign invocation witness cannot authorize a reply',async t=>{
 const f=await setup(t);await assert.rejects(f.control.execute("DELETE FROM stage8_live_publications WHERE user_id='a'"),/publication_immutable/);
 let reached=false;
 const derivedReader=Object.assign(f.reader.bind(null),{withPreparedSnapshot:(input,finish)=>f.reader.withPreparedSnapshot(input,async (values,proof)=>{reached=true;return finish(values,{...proof,publicationWitness:{...proof.publicationWitness,digest:'0'.repeat(64)}});})}),scopes=await createScopedHealthContext({db:f.db,keys,admission:f.admission,derivedReader,now:f.now}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'});
 assert.equal((await scopes.derived(scope,'EVIDENCE')).status,'CURRENT');const reply=await scopes.sealReply(scope,{text:'SYNTHETIC_ORIGINAL_REPLY'});
 assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),false);assert.equal(reached,true);assert.equal((await f.holds()).length,0);
});
