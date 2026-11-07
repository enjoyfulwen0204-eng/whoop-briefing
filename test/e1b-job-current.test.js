import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {assertSelect,exportSelectSnapshot} from '../tools/e1b/selectSnapshot.mjs';
import {localAdapter} from '../tools/e1b/localAdapter.mjs';
import {rehearseLocal} from '../tools/e1b/rehearsalChecks.mjs';
import {createSchemaTransitionRuntimeProfile} from '../src/schemaTransitionProfile.js';
import {bindConnectionLifetime,admitRuntime} from '../src/runtimeAdmission.js';
import {eraseDisabledCohort} from '../tools/e1b/maintenance.mjs';
import {runErasureMaintenance} from '../src/erasureMaintenance.js';
import {fixtureKeys} from './localDb.js';
import {assertJobStartWindow,countSubjectReceipts} from '../tools/e1b/jobChecks.mjs';
import {userErrorClearReceiptKey} from '../src/erasureCatalog.js';

test('job start guards use Taipei time even when the job waits in the queue',()=>{
 for(const clock of ['04:09','15:30','20:00'])assert.throws(()=>assertJobStartWindow(new Date('2026-11-07T'+clock+':00Z')),{code:'JOB_WINDOW_CLOSED'});
 for(const clock of ['04:10','15:29'])assert.doesNotThrow(()=>assertJobStartWindow(new Date('2026-11-07T'+clock+':00Z')));
});

test('post-erasure scan derives prior-generation receipts from the original cohort',async()=>{
 const target={id:'synthetic subject',lifecycle_generation:2};
 const other={id:'synthetic family',lifecycle_generation:1};
 const execution={execution_seq:1,execution_id:'synthetic',phase:'SYNC',trigger_source:'cloudflare',identity_digest:'a'.repeat(64),scope_key:'b'.repeat(64)};
 const receipt=user=>({execution_id:execution.execution_id,receipt_key:userErrorClearReceiptKey(fixtureKeys,execution,user.id,1)});
 let rows=[receipt(target),receipt(other)];
 const client={execute:async input=>{
  const sql=typeof input==='string'?input:input.sql;
  if(sql.includes('MAX(execution_seq)')||sql.includes('execution_seq>?'))return {rows:[execution]};
  if(sql.includes('FROM phase4_execution_work_receipts'))return {rows};
  if(sql.includes('sync_execution_id=?'))return {rows:[]};
  assert.fail('Unexpected query');
 }};
 assert.equal(await countSubjectReceipts(client,fixtureKeys,[target]),1);
 rows=[receipt(other)];
 assert.equal(await countSubjectReceipts(client,fixtureKeys,[target]),0);
 assert.equal(await countSubjectReceipts(client,fixtureKeys,[other]),1);
});

test('job SELECT boundary rejects writes, multiple statements and side effects',()=>{
 for(const sql of ['DELETE FROM users','SELECT 1; SELECT 2','SELECT load_extension(1)','PRAGMA journal_mode','SELECT 1 -- comment'])assert.throws(()=>assertSelect(sql),{code:'SNAPSHOT_SELECT_ONLY'});
 assert.equal(assertSelect('SELECT name FROM sqlite_schema'),'SELECT name FROM sqlite_schema');
});

test('job export uses one streaming snapshot, preserves exact v33 schema, counts and values',async t=>{
 const f=await syntheticStage7V33Fixture(t),directory=await mkdtemp(join(tmpdir(),'e1b-synthetic-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let cursorCalls=0,closed=0;
 const openClient=()=>({getVersion:async()=>3,close(){closed++;},openStream:()=>({
  close(){closed++;},query:sql=>f.db.raw.execute(assertSelect(sql)),
  async _openCursor({steps}){
   cursorCalls++;assert.equal(steps.length,1);const sql=assertSelect(steps[0].stmt.sql);
   const rows=(await f.db.raw.execute(sql)).rows;let index=0;
   return {async next(){if(index<rows.length){const r=rows[index++];return {type:'row',row:[r.kind,r.table_name,r.payload]};}
    if(index++===rows.length)return {type:'step_end',affectedRowCount:0};},close(){closed++;}};
  }
 })});
 const path=join(directory,'synthetic.sqlite'),result=await exportSelectSnapshot({url:'libsql://synthetic.invalid',token:'synthetic-only',path,openClient});
 assert.equal(cursorCalls,1);assert.equal(closed,3);assert.ok(result.rows>0);
 const copy=new DatabaseSync(path);t.after(()=>copy.close());
 const schema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name";
 assert.deepEqual(copy.prepare(schema).all().map(r=>({...r})),(await f.db.raw.execute(schema)).rows.map(r=>({...r})));
 for(const {name} of copy.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()){
  assert.equal(copy.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n,(await f.db.raw.execute(`SELECT COUNT(*) n FROM "${name}"`)).rows[0].n,name);
 }
 assert.equal(copy.prepare('SELECT MAX(version) v FROM schema_version').get().v,33);
});

test('job local adapter rolls back trigger changes and rows together',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'e1b-local-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const db=localAdapter(join(directory,'synthetic.sqlite'));t.after(()=>db.raw.close());
 await db.raw.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)');await db.raw.execute('INSERT INTO t VALUES(1)');
 const ddl="CREATE TRIGGER no_delete BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT,'blocked'); END";await db.raw.execute(ddl);
 await assert.rejects(db.raw.batch(['DROP TRIGGER no_delete','DELETE FROM t','SELECT * FROM missing',ddl]));
 assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM t')).rows[0].n,1);
 assert.equal((await db.raw.execute("SELECT sql FROM sqlite_schema WHERE name='no_delete'")).rows[0].sql,ddl);
});

test('job local phase blocks all network and child process escape paths',()=>{
 const module=new URL('../tools/e1b/networkFence.mjs',import.meta.url).href;
 const script=`import {denyRehearsalNetwork} from ${JSON.stringify(module)};
 import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import child from 'node:child_process';
 denyRehearsalNetwork();
 const calls=[()=>fetch('https://example.invalid'),()=>new WebSocket('wss://example.invalid'),()=>http.get('http://example.invalid'),()=>https.get('https://example.invalid'),()=>net.connect(1),()=>tls.connect(1),()=>child.execSync('true')];
 for(const f of calls){let blocked=false;try{f();}catch(e){blocked=e.code==='REHEARSAL_NETWORK_DENIED';}if(!blocked)process.exit(1);}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,NODE_ENV:'test'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');
});

test('complete job rehearsal preserves three synthetic users while erasing five disabled subjects',async t=>{
 const at=new Date('2026-11-07T04:15:00Z'),f=await syntheticStage7V33Fixture(t,{now:()=>at});
 await f.db.createUser({id:'c',displayName:'Synthetic family',timezone:'Asia/Taipei',status:'ACTIVE'},{now:at});await f.core.initializeTenant('c','SHADOW');
 for(let i=0;i<5;i++){
  const id='synthetic-erasure-target-'+i;
  await f.db.createUser({id,displayName:'Unique erasure subject '+i,timezone:'Asia/Taipei',status:'ACTIVE'},{now:at});
  await f.db.transitionUserLifecycle({userId:id,targetStatus:'DISABLED',expectedCurrentStatus:'ACTIVE',now:at});
 }
 const directory=await mkdtemp(join(tmpdir(),'e1b-full-synthetic-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'copy.sqlite'),openClient=()=>({getVersion:async()=>3,close(){},openStream:()=>({close(){},query:sql=>f.db.raw.execute(assertSelect(sql)),async _openCursor({steps}){
  const rows=(await f.db.raw.execute(assertSelect(steps[0].stmt.sql))).rows;let n=0;return {close(){},async next(){if(n<rows.length){const r=rows[n++];return {type:'row',row:[r.kind,r.table_name,r.payload]};}if(n++===rows.length)return {type:'step_end',affectedRowCount:0};}};
 }})});
 await exportSelectSnapshot({url:'libsql://synthetic.invalid',token:'synthetic',path,openClient});
 const db=localAdapter(path);t.after(()=>db.raw.close());
 const environment={PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION',FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b,c',OWNER_USER_IDS:'a'};
 const profile=createSchemaTransitionRuntimeProfile({environment,keys:f.keys});bindConnectionLifetime(db.raw,db.raw,db.transaction,{runtimeProfile:profile,keys:f.keys});
 const admit=()=>admitRuntime(db.raw,f.keys);await admit();
 const logs=[];assert.deepEqual(await rehearseLocal({db,keys:f.keys,environment,at,admit,emit:x=>logs.push(x)}),{pass:true});
 assert.equal(logs.at(-1).remaining,0);assert.equal(logs.at(-1).users_preserved,3);assert.equal(logs.at(-1).output_digest_kinds,6);
 assert.doesNotMatch(JSON.stringify(logs),/synthetic-erasure-target|Unique erasure subject/);
});

test('maintenance requires exactly five disabled non-family non-Owner accounts before any mutation',async t=>{
 const at=new Date('2026-11-07T04:15:00Z'),f=await syntheticStage7V33Fixture(t,{now:()=>at});
 const environment={OWNER_USER_IDS:'b',FAMILY_GROUP_USER_IDS:'b,c,d'};
 const call=()=>eraseDisabledCohort({db:f.db,keys:f.keys,environment,expected:5,now:()=>at});
 let writes=0;const execute=f.db.raw.execute;
 f.db.raw.execute=async input=>{const sql=typeof input==='string'?input:input.sql;if(/^\s*(?:UPDATE|DELETE|INSERT|DROP|CREATE)\b/i.test(sql))writes++;return execute(input);};
 await assert.rejects(call(),{code:'MAINTENANCE_EXPECTED_COUNT_MISMATCH'});assert.equal(writes,0);
 f.db.raw.execute=execute;
 for(let i=0;i<5;i++){
  const id='maintenance-subject-'+i;await f.db.createUser({id,displayName:'Unique maintenance name '+i,timezone:'Asia/Taipei',status:'ACTIVE'},{now:at});
  await f.db.transitionUserLifecycle({userId:id,targetStatus:'DISABLED',expectedCurrentStatus:'ACTIVE',now:at});
 }
 const peer=(await f.db.raw.execute("SELECT * FROM users WHERE id IN ('a','b') ORDER BY id")).rows;
 const result=await call();assert.equal(result.pass,true);assert.equal(result.subjects,5);assert.equal(result.remaining,0);assert.ok(result.deleted.USER>=5);
 assert.deepEqual(result.deleted.SHARED_OPERATIONAL,0);assert.equal(result.deleted.SYSTEM,0);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM users WHERE id IN ('a','b') ORDER BY id")).rows,peer);
 assert.doesNotMatch(JSON.stringify(result),/maintenance-subject|Unique maintenance name/);
 await assert.rejects(call(),{code:'MAINTENANCE_EXPECTED_COUNT_MISMATCH'});
});

test('night maintenance with insufficient remainder defers without querying or writing',async()=>{
 let queries=0;const logs=[];
 const db=new Proxy({},{get(){queries++;throw Error('UNEXPECTED_DATABASE_ACCESS');}});
 const result=await runErasureMaintenance({db,budget:{remainingMs:()=>14000},emit:s=>logs.push(JSON.parse(s))});
 assert.equal(queries,0);assert.equal(result.retries.deferred,1);assert.equal(result.retention.status,'DEFERRED_BUDGET');
 assert.deepEqual(Object.keys(logs[0]).sort(),['completed','deferred','duration_ms','event','overdue','pending']);
});

test('copy rehearsal refuses a non-grandfathered v1 consent before erasure',async()=>{
 const users=[...['a','b','c'].map(id=>({id,status:'ACTIVE'})),...Array.from({length:5},(_,n)=>({id:'subject-'+n,status:'DISABLED'}))];
 const key='beta:v1:'+fixtureKeys.lookup(['beta-state-key-v1','member','subject-0']);
 const body={consent:{version:'2026-11-06-v1',at:'2026-11-06T00:00:00Z'}},signature=fixtureKeys.lookup(['beta-state-v1','member','subject-0',body]);
 let queries=0;const db={raw:{execute:async sql=>{assert.equal(sql,'SELECT * FROM users LIMIT 101');queries++;return {rows:users};}},getState:async k=>k===key?JSON.stringify({body,signature}):null};
 await assert.rejects(rehearseLocal({db,keys:fixtureKeys,environment:{FAMILY_GROUP_USER_IDS:'a,b,c',OWNER_USER_IDS:'a'},at:new Date(),emit(){},admit(){}}),{code:'REHEARSAL_NEW_USER_V1_CONSENT_PRESENT'});
 assert.equal(queries,1);
});
