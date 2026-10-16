import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,copyFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {runMigrations,currentVersion} from '../src/migrations.js';
import {PHASE4_MIGRATIONS} from '../src/schema.js';
import {assertPhase4Schema} from '../src/phase4Migrations.js';
import {stage8PreservationSnapshot} from '../scripts/stage8-migration-safety.mjs';
import {readDatabaseControl} from '../scripts/stage8-production-control.mjs';
import {prepareStage8AtomicMigration,stage8AtomicPlanStatements,stage8AtomicPlanSteps,stage8AtomicPlanEvidence,assertStage8AtomicPlanBinding,reconcileStage8AtomicPlan} from '../scripts/stage8-atomic-migration.mjs';

const SHA='a'.repeat(40),SOURCE='b'.repeat(40),hash=value=>createHash('sha256').update(String(value)).digest('hex');
const catalog=async client=>(await client.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name='sqlite_sequence' ORDER BY type,name")).rows;
const pending=async client=>(await client.execute('SELECT * FROM phase4_executions WHERE finalized_at IS NULL ORDER BY execution_seq')).rows;
const receipts=async client=>(await client.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
const connect=path=>createClient({url:'file:'+path,intMode:'number'});

test('one original registered atomic batch preserves37 pending executions and1296 receipts; rollback and unknown outcomes stay explicit',async t=>{
 let network=0;t.mock.method(globalThis,'fetch',()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 const dir=await mkdtemp('/private/tmp/stage8-atomic-');await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));
 const sourcePath=join(dir,'source.sqlite'),db=createOwnedDb({url:'file:'+sourcePath});
 try{
  await db.migrate({targetVersion:33});const at=Date.now(),deadline=at+3600000;
  for(let i=0;i<37;i++){
   const id='synthetic-original-pending-'+i,identity=hash('identity-'+i),scope=hash('scope-'+i),request={requestId:id,phase:'SYNC',releaseSha:SOURCE,executionMode:'OFF',triggerSource:'manual',configProof:hash('config')};
   await db.raw.execute({sql:`INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,'ESTABLISHED',?,?)`,args:[id,identity,scope,JSON.stringify(request),'SYNC',SOURCE,'OFF','manual',request.configProof,'synthetic-owner-'+i,deadline,deadline,at,at]});
   for(let j=0;j<(i===36?36:35);j++)await db.raw.execute({sql:`INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,1,?,NULL)`,args:[id,hash('receipt-'+i+'-'+j),scope,identity,hash('step-'+i+'-'+j),at]});
  }
  await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=?',args:[at-1000,at-1000]});
  assert.equal((await pending(db.raw)).length,37);assert.equal((await receipts(db.raw)).length,1296);
 }finally{await db.close();}
 const original=connect(sourcePath);let originalControl,originalCatalog,originalPending,originalReceipts;
 try{
  const unique=new Set(),metadataUnique=new Set(),distribution={total:0,metadata:0,uncachedDataAndAuthority:0},started=performance.now();
  const traced={execute:query=>{
   const sql=typeof query==='string'?query:query.sql,key=JSON.stringify([sql,typeof query==='string'?[]:query.args??[]]);distribution.total++;unique.add(key);
   if(/\bsqlite_master\b/.test(sql)||/^PRAGMA (?:table_info|index_info|index_list|foreign_key_list)\b/i.test(sql)){distribution.metadata++;metadataUnique.add(key);}else distribution.uncachedDataAndAuthority++;
   return original.execute(query);
  }};
  originalControl=await readDatabaseControl(traced,fixtureKeys);
  t.diagnostic('source33 readDatabaseControl synthetic distribution '+JSON.stringify({...distribution,unique:unique.size,metadataUnique:metadataUnique.size,metadataRepeated:distribution.metadata-metadataUnique.size,elapsedMs:Math.round(performance.now()-started)}));
  originalCatalog=await catalog(original);originalPending=await pending(original);originalReceipts=await receipts(original);
 }finally{original.close();}
 const preparePath=join(dir,'prepare # encoded ?.sqlite');await copyFile(sourcePath,preparePath);await chmod(preparePath,0o600);
 let clientInvocations=0;const fakeClient={protocol:'file',execute(){clientInvocations++;throw Error('DATABASE_FORBIDDEN');},batch(){clientInvocations++;throw Error('DATABASE_FORBIDDEN');}};
 const preparation={sourcePath:preparePath,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE};
 await assert.rejects(prepareStage8AtomicMigration(fakeClient,{keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE}),/LOCAL_PREPARATION/);
 await assert.rejects(prepareStage8AtomicMigration({...preparation,client:fakeClient}),/LOCAL_PREPARATION/);
 for(const sourcePath of ['libsql://remote.invalid','file://'+preparePath,'prepare.sqlite',join(dir,'other')+'/../prepare.sqlite'])
  await assert.rejects(prepareStage8AtomicMigration({...preparation,sourcePath}),/LOCAL_PREPARATION/);
 const linked=join(dir,'linked.sqlite');await symlink(preparePath,linked);
 await assert.rejects(prepareStage8AtomicMigration({...preparation,sourcePath:linked}),/PROTECTED_FILE/);
 await chmod(preparePath,0o644);await assert.rejects(prepareStage8AtomicMigration(preparation),/PROTECTED_FILE/);await chmod(preparePath,0o600);
 assert.equal(clientInvocations,0);assert.equal(network,0);
 await t.test('a registered34 trigger or index already on33 is rejected before any migration mutation',async()=>{
  const v34=PHASE4_MIGRATIONS.find(m=>m.version===34),trigger=v34.triggers.find(sql=>sql.includes('p4_enrollment_revision'));
  const indexName=/^CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/.exec(v34.indexes[0])[1];
  for(const [name,sql] of [['trigger',trigger],['index',`CREATE INDEX ${indexName.toUpperCase()} ON users(id)`]]){
   const partialPath=join(dir,'partial-'+name+'.sqlite');await copyFile(sourcePath,partialPath);await chmod(partialPath,0o600);
   const partial=connect(partialPath);let before;
   try{await partial.execute(sql);before=await catalog(partial);}finally{partial.close();}
   await assert.rejects(prepareStage8AtomicMigration({...preparation,sourcePath:partialPath}),/CLEAN33_REQUIRED/);
   const checked=connect(partialPath);try{assert.equal(await currentVersion(checked),33);assert.deepEqual(await catalog(checked),before);}finally{checked.close();}
  }
 });
 const plan=await prepareStage8AtomicMigration(preparation);
 const statements=stage8AtomicPlanStatements(plan),steps=stage8AtomicPlanSteps(plan);
 assert.throws(()=>stage8AtomicPlanEvidence(plan,{keys:{lookup(){throw Error('CALLER_KEYS_FORBIDDEN');}},releaseSha:SHA,sourceSha:SOURCE,sourceDigest:originalControl.digest}),/PRIVACY_KEYS_REQUIRED/);
 assert.equal(plan.mutationCount,133);assert.ok(plan.statementCount<350);assert.deepEqual(steps.map(step=>step.to),[34,35,35]);
 assert.throws(()=>stage8AtomicPlanStatements(JSON.parse(JSON.stringify(plan))),/PLAN_REQUIRED/);
 assert.throws(()=>statements.push({sql:'DELETE FROM users'}),TypeError);
 assert.throws(()=>{statements[0].sql='DELETE FROM users';},TypeError);
 assert.throws(()=>{statements.find(statement=>statement.args.length).args[0]='changed';},TypeError);
 const wrong=createPhase4Keys({lookupKey:Buffer.alloc(32,99),auditKey:Buffer.alloc(32,83)}),wrongAudit=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,99)});
 for(const attack of [{keys:wrong},{keys:wrongAudit},{sourceSha:SHA},{releaseSha:SOURCE},{sourceDigest:'changed'}])assert.throws(()=>assertStage8AtomicPlanBinding(plan,{keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE,sourceDigest:originalControl.digest,...attack}),/BINDING/);
 const replay=async(name,operation)=>{
  const path=join(dir,name+'.sqlite');await copyFile(sourcePath,path);const client=connect(path);
  try{await operation(client);return path;}finally{client.close();}
 };
 let successfulCatalog,successfulSnapshot;
 await t.test('golden original engine and one write batch produce identical canonical definitions and all original rows',async()=>{
  const goldenPath=join(dir,'golden.sqlite');await copyFile(sourcePath,goldenPath);const golden=connect(goldenPath);
  try{for(const targetVersion of [34,35,35])await runMigrations(golden,{allowRebuild:false,targetVersion,privacyKeys:fixtureKeys});await assertPhase4Schema(golden,35);successfulCatalog=await catalog(golden);successfulSnapshot=await stage8PreservationSnapshot(golden,fixtureKeys);}finally{golden.close();}
  await replay('success',async client=>{
   let calls=0;const batch=client.batch.bind(client);client.batch=async(sql,mode)=>{calls++;assert.equal(mode,'write');return batch(sql,mode);};
   const started=performance.now();try{await client.batch(statements,'write');}finally{client.batch=batch;}
   t.diagnostic('atomic synthetic batch '+JSON.stringify({statements:plan.statementCount,registeredMutations:plan.mutationCount,approximateRequestBytes:Buffer.byteLength(JSON.stringify(statements)),elapsedMs:Math.round(performance.now()-started),actualProductionData:false}));
   assert.equal(calls,1);assert.equal(await currentVersion(client),35);await assertPhase4Schema(client,35);
   assert.deepEqual(await catalog(client),successfulCatalog);assert.deepEqual(await stage8PreservationSnapshot(client,fixtureKeys),successfulSnapshot);
   assert.deepEqual(await stage8PreservationSnapshot(client,fixtureKeys,originalControl.snapshot),originalControl.snapshot);
   assert.deepEqual(await pending(client),originalPending);assert.deepEqual(await receipts(client),originalReceipts);
   assert.equal((await reconcileStage8AtomicPlan(client,plan,{keys:fixtureKeys})).status,'PREPARED35_VERIFIED');
   const retained=(await client.execute('SELECT version,note FROM schema_version WHERE version IN (34,35) ORDER BY version')).rows;
   assert.deepEqual(retained.map(row=>[row.version,row.note]),[[34,'phase4 v34 postconditions verified'],[35,'phase4 v35 postconditions verified']]);
  });
 });
 const marker34=statements.findIndex(statement=>statement.sql.startsWith('INSERT INTO schema_version')&&statement.args[0]===34),marker35=statements.findIndex(statement=>statement.sql.startsWith('INSERT INTO schema_version')&&statement.args[0]===35);
 assert.ok(marker34>0&&marker35>marker34);
 for(const [name,index] of [['before34marker',marker34],['after34marker',marker34+1],['beforeCommit',statements.length-1]])await t.test(name+' aborts the actual driver batch without committed34/35 or partial DDL',async()=>{
  await replay(name,async client=>{
   const fault=statements.map(statement=>({sql:statement.sql,args:[...statement.args]})),guard=statements[0].sql.match(/CREATE TEMP TABLE ("[^"]+")/)[1];fault[index]={sql:`INSERT INTO temp.${guard}(ok) VALUES(0)`};
   await assert.rejects(client.batch(fault,'write'),/CHECK constraint failed/);assert.equal(await currentVersion(client),33);assert.deepEqual(await catalog(client),originalCatalog);
   assert.deepEqual(await readDatabaseControl(client,fixtureKeys),originalControl);assert.deepEqual(await pending(client),originalPending);assert.deepEqual(await receipts(client),originalReceipts);
   assert.deepEqual(await reconcileStage8AtomicPlan(client,plan,{keys:fixtureKeys}),{status:'SOURCE33_OBSERVED_COMMIT_UNCERTAIN',digest:originalControl.digest,schema:33,commitVerified:false});
  });
 });
 await t.test('lost response after committed batch reconciles the exact prepared35, using a fresh independent connection',async()=>{
  const path=await replay('lost-after-commit',async client=>{
   const lost=async()=>{await client.batch(statements,'write');throw Error('SYNTHETIC_LOST_RESPONSE');};await assert.rejects(lost(),/LOST_RESPONSE/);
  });
  const fresh=connect(path);try{assert.equal((await reconcileStage8AtomicPlan(fresh,plan,{keys:fixtureKeys})).status,'PREPARED35_VERIFIED');assert.deepEqual(await pending(fresh),originalPending);assert.deepEqual(await receipts(fresh),originalReceipts);}finally{fresh.close();}
 });
 await t.test('lost response before known execution observes33 without claiming rollback or permitting blind retry',async()=>{
  await replay('lost-before-execution',async client=>{
   const unknown=async()=>{throw Error('SYNTHETIC_LOST_RESPONSE');};await assert.rejects(unknown(),/LOST_RESPONSE/);
   const result=await reconcileStage8AtomicPlan(client,plan,{keys:fixtureKeys});assert.equal(result.status,'SOURCE33_OBSERVED_COMMIT_UNCERTAIN');assert.equal(result.commitVerified,false);
  });
 });
 await t.test('schema drift between the outside preflight and transaction fails the first server guard before registered DDL',async()=>{
  await replay('schema-drift',async client=>{
   await client.execute('CREATE INDEX synthetic_unexpected_writer ON phase4_executions(updated_at)');
   await assert.rejects(client.batch(statements,'write'),/CHECK constraint failed/);assert.equal(await currentVersion(client),33);
   assert.equal((await client.execute("SELECT count(*) n FROM sqlite_master WHERE name='morning_brief_plans'")).rows[0].n,0);
   assert.equal((await reconcileStage8AtomicPlan(client,plan,{keys:fixtureKeys})).status,'UNKNOWN_KEEP_MAINTENANCE');
  });
 });
 await t.test('an unexpected same-count row change is caught by full postcommit preservation and keeps maintenance closed',async()=>{
  await replay('same-count-data-drift',async client=>{
   await client.execute('UPDATE phase4_executions SET updated_at=updated_at+1 WHERE execution_seq=1');await client.batch(statements,'write');
   assert.equal(await currentVersion(client),35);assert.equal((await pending(client)).length,37);assert.equal((await receipts(client)).length,1296);
   assert.equal((await reconcileStage8AtomicPlan(client,plan,{keys:fixtureKeys})).status,'UNKNOWN_KEEP_MAINTENANCE');
  });
 });
 assert.equal(network,0);
});
