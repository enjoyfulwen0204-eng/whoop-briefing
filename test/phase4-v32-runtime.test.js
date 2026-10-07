// Genuine native methods retained BEFORE any application import.
import {Sqlite3Client,createClient} from '@libsql/client/sqlite3';
import {HttpClient} from '@libsql/client/http';
import {WsClient} from '@libsql/client/ws';
const native={file:{close:Sqlite3Client.prototype.close,reconnect:Sqlite3Client.prototype.reconnect},
 http:{close:HttpClient.prototype.close,reconnect:HttpClient.prototype.reconnect},
 ws:{close:WsClient.prototype.close,reconnect:WsClient.prototype.reconnect}};
const {default:test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
const {createDb,composeDb}=await import('../src/db.js'),{fixtureKeys}=await import('./localDb.js');
const {createOwnedDb}=await import('./stage5OwnedDb.js'),{hranaTransport}=await import('./hranaTransport.js');
assert.equal(Sqlite3Client.prototype.close,native.file.close);assert.equal(Sqlite3Client.prototype.reconnect,native.file.reconnect);
assert.equal(HttpClient.prototype.close,native.http.close);assert.equal(HttpClient.prototype.reconnect,native.http.reconnect);
assert.equal(WsClient.prototype.close,native.ws.close);assert.equal(WsClient.prototype.reconnect,native.ws.reconnect);
async function seed(t){const dir=await mkdtemp(join(tmpdir(),'p4-v32-private-')),url=`file:${join(dir,'db.sqlite')}`,db=createOwnedDb({url});
 await db.migrate({targetVersion:32});await db.close();t.after(()=>rm(dir,{recursive:true,force:true}));return url;}
for(const protocol of ['file','http'])test(`v32 ${protocol}: private lifetime cannot expose native receiver, revive close or skip a new runtime admission`,async t=>{
 const url=await seed(t),transport=protocol==='http'?hranaTransport(url):null;
 const db=createDb({url:protocol==='http'?'https://isolated.invalid':url,fetch:transport?.fetch,phase4Keys:fixtureKeys});
 t.after(()=>{db.close();transport?.close();});const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),32);assert.equal(await db.admitRuntime(),cap);
 for(const forged of [{},{...cap},JSON.parse(JSON.stringify(cap))])assert.throws(()=>db.requireRuntimeAdmission(forged));
 assert.throws(()=>native[protocol].close.call(db.raw));await assert.rejects(Promise.resolve().then(()=>native[protocol].reconnect.call(db.raw)));
 assert.throws(()=>native.ws.close.call(db.raw));await assert.rejects(Promise.resolve().then(()=>native.ws.reconnect.call(db.raw)));
 assert.equal(db.raw.transaction,undefined);assert.throws(()=>{db.raw.closed=false;},/PRIVATE_CLIENT_CONTROL/);
 db.raw.close();assert.throws(()=>db.requireRuntimeAdmission(cap));assert.throws(()=>db.raw.reconnect(),/REPLACEMENT_REQUIRED/);await assert.rejects(()=>db.admitRuntime());
 const fresh=createDb({url:protocol==='http'?'https://isolated.invalid':url,fetch:transport?.fetch,phase4Keys:fixtureKeys});t.after(()=>fresh.close());
 const next=await fresh.admitRuntime();assert.equal(fresh.requireRuntimeAdmission(next),32);assert.throws(()=>fresh.requireRuntimeAdmission(cap));
});
test('v32 phase rejects a driver with automatic unobservable WebSocket connection replacement before admission/work',async()=>{
 const {runExecutionPhase}=await import('../src/phase4Execution.js'),{configurationProof}=await import('../src/phase4ExecutionStore.js');
 const {runningReleaseSha}=await import('../src/phase4Release.js'),{randomUUID}=await import('node:crypto');
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},releaseSha=runningReleaseSha();let admissions=0;
 const request={requestId:randomUUID(),phase:'SYNC',releaseSha,triggerSource:'manual',executionMode:'OFF',
  configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 await assert.rejects(()=>runExecutionPhase({request,environment,keys:fixtureKeys,env:{},
  db:{raw:{protocol:'ws'},admitRuntime:()=>{admissions++;throw Error('UNREACHABLE');}}}),/PHASE_RUNTIME_TRANSPORT_UNSUPPORTED/);
 assert.equal(admissions,0);
});
for(const sql of ['DROP TRIGGER p4_outbox_transition',"DROP INDEX uniq_report_sent; CREATE INDEX uniq_report_sent ON report_runs(user_id,report_type,local_date) WHERE status='SENT'"])
test(`v32 caller-owned compatibility client cannot use a retained pre-import method/context to bypass fresh privileged verification: ${sql}`,async t=>{
 const url=await seed(t),base=createClient({url}),db=composeDb(base,{phase4Keys:fixtureKeys});t.after(()=>db.close());const cap=await db.admitRuntime();
 native.file.close.call(base);base.closed=false;const writer=createClient({url});for(const statement of sql.split(';').filter(Boolean))await writer.execute(statement);writer.close();
 await native.file.reconnect.call(base);
 await assert.rejects(()=>db.transaction(()=>db.raw.execute("SELECT count(*) FROM users")),/schema_postcondition/);
 await assert.rejects(()=>db.raw.execute('SELECT count(*) FROM users'),/schema_postcondition/);
 const {withRuntimeMetadata}=await import('../src/runtimeMetadataContext.js');
 await assert.rejects(()=>withRuntimeMetadata(()=>db.raw.execute('SELECT count(*) FROM users')),/schema_postcondition/);
 assert.ok(cap,'issuer context cannot grant a metadata-verification shortcut');
});
test('v32 bounded admission contention retries full canonical metadata without any DDL or assertion bypass',async t=>{
 const url=await seed(t),locker=createClient({url}),db=createDb({url,phase4Keys:fixtureKeys});t.after(()=>{locker.close();db.close();});
 await locker.execute('BEGIN EXCLUSIVE');const timer=setTimeout(()=>{void locker.execute('ROLLBACK');},100);
 try{const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),32);}finally{clearTimeout(timer);}
});
test('v32 admission expiry prevents later metadata queries and capability issuance after a delayed read',async t=>{
 const url=await seed(t),transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(()=>{db.close();transport.close();});
 const {createExecutionBudget}=await import('../src/executionBudget.js'),budget=createExecutionBudget({budgetMs:100});
 const execute=db.raw.execute;let reads=0,release;const gate=new Promise(resolve=>release=resolve);
 db.raw.execute=async query=>{reads++;if(reads===1)await gate;return execute(query);};
 let admission;
 try{await assert.rejects(()=>budget.run(()=>admission=db.admitRuntime()),error=>error.code==='SYNC_TIMEOUT');}finally{budget.close();release();}
 await assert.rejects(()=>admission,error=>error.code==='SYNC_TIMEOUT');assert.equal(reads,1,'expiry cannot initiate the remaining four metadata requests');
 const cap=await db.admitRuntime({fresh:true});assert.equal(db.requireRuntimeAdmission(cap),32);assert.equal(reads,6);
});
