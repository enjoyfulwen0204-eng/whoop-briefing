#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {open,readFile,mkdtemp,chmod,rm,link,unlink,lstat} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import Database from 'libsql';
import {createClient} from '@libsql/client';
import {currentVersion,runMigrations} from '../src/migrations.js';
import {assertPhase4Schema} from '../src/phase4Migrations.js';
import {productionControl,requireProductionControl,readDatabaseControl,PRODUCTION_CONTROL} from './stage8-production-control.mjs';
import {assertCleanStage8Release,stage8ProtectedDirectory,stage8ProtectedFile,stage8RecoveryKey,stage8DurableExclusiveImage,
 stage8PreservationSnapshot,verifyStage8RecoveryClient,sealStage8RecoveryImage,rehearseStage8RecoveryImage} from './stage8-migration-safety.mjs';
import {prepareStage8AtomicMigration,stage8AtomicPlanStatements,stage8AtomicPlanSteps,stage8AtomicPlanEvidence,assertStage8AtomicPlanBinding,reconcileStage8AtomicPlan} from './stage8-atomic-migration.mjs';
import {persistStage8AtomicRecovery,authenticateStage8AtomicRecovery} from './stage8-atomic-recovery.mjs';

const MAGIC=Buffer.from('KHOSSQL1'),MAX_DUMP=256*1024*1024,fail=code=>{throw Object.assign(Error(code),{code});};
const atomicRecoveryPlans=new WeakMap();
const serial=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{int64:v.toString()}:ArrayBuffer.isView(v)?{blob:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')}:v instanceof ArrayBuffer?{blob:Buffer.from(v).toString('base64')}:v);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function syncDirectory(path){const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}}
async function writeAll(fd,bytes){let at=0;while(at<bytes.length){const {bytesWritten}=await fd.write(bytes,at,bytes.length-at);if(bytesWritten<1)fail('STAGE8_BACKUP_WRITE_FAILED');at+=bytesWritten;}}

/** The only Production download is the official authenticated GET /dump.
 * Plaintext is encrypted as chunks arrive; no SQL plaintext file is written. */
async function encryptedDump(state,{backupPath,keyPath}){
 await stage8ProtectedDirectory(dirname(resolve(backupPath)));const key=await stage8RecoveryKey(keyPath);
 const temporary=resolve(backupPath)+'.partial-'+randomBytes(12).toString('hex');let fd,identity,published=false;
 const metadata={contract:'stage8-production-sql-recovery-v1',host:PRODUCTION_CONTROL.host,releaseSha:state.releaseSha,sourceSha:state.sourceSha,
  schema:state.current.schema,sourceDigest:state.current.digest,createdAt:Date.now()},iv=randomBytes(12),header=Buffer.from(JSON.stringify({metadata,iv:iv.toString('base64')})),size=Buffer.alloc(4);size.writeUInt32BE(header.length);
 const aad=Buffer.concat([MAGIC,size,header]),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
 let first=Buffer.alloc(0),last=Buffer.alloc(0),bytes=0;
 try{
  fd=await open(temporary,'wx',0o600);identity=await fd.stat();await writeAll(fd,aad);
  const response=await fetch(`https://${PRODUCTION_CONTROL.host}/dump`,{headers:{Authorization:'Bearer '+state.environment.TURSO_AUTH_TOKEN},redirect:'error',signal:AbortSignal.timeout(90_000)});
  if(response.status!==200||!response.body)fail('STAGE8_BACKUP_DOWNLOAD_FAILED');
  const reader=response.body.getReader();
  try{for(;;){const next=await reader.read();if(next.done)break;const part=Buffer.from(next.value);bytes+=part.length;if(bytes>MAX_DUMP)fail('STAGE8_BACKUP_BOUND_EXCEEDED');first=Buffer.concat([first,part]).subarray(0,1024);last=Buffer.concat([last,part]).subarray(-1024);await writeAll(fd,cipher.update(part));}}
  finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  if(bytes<100||!first.toString().includes('BEGIN TRANSACTION')||!/COMMIT;\s*$/.test(last.toString()))fail('STAGE8_BACKUP_INCOMPLETE');
  await writeAll(fd,cipher.final());await writeAll(fd,cipher.getAuthTag());await fd.sync();await fd.close();fd=null;
  await link(temporary,resolve(backupPath));published=true;await syncDirectory(dirname(resolve(backupPath)));await unlink(temporary);await syncDirectory(dirname(resolve(backupPath)));
  return {metadata,bytes,encryptedDigest:digest(await readFile(backupPath))};
 }catch(error){
  try{await fd?.close();}catch{}
  for(const path of [temporary,...(published?[resolve(backupPath)]:[])]){
   try{const current=await lstat(path);if(current.dev!==identity?.dev||current.ino!==identity?.ino)fail('STAGE8_RECOVERY_DURABILITY_UNCERTAIN');await unlink(path);await syncDirectory(dirname(path));}
   catch(cleanup){if(cleanup.code!=='ENOENT')fail('STAGE8_RECOVERY_DURABILITY_UNCERTAIN');}
  }
  throw error;
 }
}
export async function authenticateProductionDump({backupPath,keyPath,releaseSha,sourceSha,sourceDigest,now=Date.now()}){
 const file=await stage8ProtectedFile(backupPath);if(file.size>MAX_DUMP+16384)fail('STAGE8_BACKUP_BOUND_EXCEEDED');const bytes=await readFile(file.path);
 if(!bytes.subarray(0,8).equals(MAGIC)||bytes.length<44)fail('STAGE8_BACKUP_AUTHENTICATION_FAILED');
 const n=bytes.readUInt32BE(8);if(n<1||n>8192||12+n+16>=bytes.length)fail('STAGE8_BACKUP_AUTHENTICATION_FAILED');
 const aad=bytes.subarray(0,12+n),{metadata,iv}=JSON.parse(bytes.subarray(12,12+n)),m=metadata;
 if(m?.contract!=='stage8-production-sql-recovery-v1'||m.host!==PRODUCTION_CONTROL.host||m.releaseSha!==releaseSha||m.sourceSha!==sourceSha||m.sourceDigest!==sourceDigest
  ||![33,34,35].includes(m.schema)||!Number.isSafeInteger(m.createdAt)||now<m.createdAt||now-m.createdAt>3600_000)fail('STAGE8_BACKUP_BINDING_REQUIRED');
 const nonce=Buffer.from(iv??'','base64');if(nonce.length!==12)fail('STAGE8_BACKUP_AUTHENTICATION_FAILED');
 const cipher=createDecipheriv('aes-256-gcm',await stage8RecoveryKey(keyPath),nonce);cipher.setAAD(aad);cipher.setAuthTag(bytes.subarray(-16));
 // No caller receives or restores SQL until the entire GCM tag authenticates.
 const sql=Buffer.concat([cipher.update(bytes.subarray(12+n,-16)),cipher.final()]);
 return {metadata,sql,encryptedDigest:digest(bytes)};
}
async function backupAndRehearse(permit,{backupPath,keyPath,targetVersion}){
 let state=await requireProductionControl(permit);
 if(state.current.digest!==state.database.digest)fail('STAGE8_DATABASE_CHANGED_AFTER_QUIET_WINDOW');
 const original=state.current,download=await encryptedDump(state,{backupPath,keyPath});
 const decoded=await authenticateProductionDump({backupPath,keyPath,releaseSha:state.releaseSha,sourceSha:state.sourceSha,sourceDigest:original.digest});
 const directory=await mkdtemp(join(dirname(resolve(backupPath)),'restore-'));await chmod(directory,0o700);let native,client;
 try{
  const sourcePath=join(directory,'restore.sqlite');native=new Database(sourcePath);native.exec(decoded.sql.toString('utf8'));native.exec('PRAGMA wal_checkpoint(TRUNCATE)');native.close();native=null;await chmod(sourcePath,0o600);
  client=createClient({url:'file:'+sourcePath,intMode:'number'});const schema=await verifyStage8RecoveryClient(client,state.keys);
  const snapshot=await stage8PreservationSnapshot(client,state.keys),history=state.keys.lookup(['stage8-schema-history-v1',
   (await client.execute('SELECT * FROM schema_version ORDER BY version')).rows,(await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows]);
  if(schema!==original.schema||serial(snapshot)!==serial(original.snapshot)||history!==original.history)fail('STAGE8_RESTORED_SOURCE_MISMATCH');
  client.close();client=null;
  const imagePath=backupPath+'.sqlite.enc',common={sourcePath,backupPath:imagePath,keyPath,keys:state.keys,releaseSha:state.releaseSha,sourceTarget:PRODUCTION_CONTROL.host};
  const sealed=await sealStage8RecoveryImage(common),rehearsal=await rehearseStage8RecoveryImage({...common,targetVersion});
  let atomicPlan,atomicRecovery;
  if(original.schema===33&&targetVersion===35){
   // The authenticated original33 image is already sealed. Compile the exact
   // original ordered engine on this disposable restore, never on Production.
   atomicPlan=await prepareStage8AtomicMigration({sourcePath,keys:state.keys,releaseSha:state.releaseSha,sourceSha:state.sourceSha});
   // Persist the exact prepared target and signed metadata before any remote
   // DDL. A new process can reconcile a committed batch without recompiling
   // fresh timestamps or importing a serialized executable plan.
   atomicRecovery=await persistStage8AtomicRecovery(atomicPlan,{sourcePath,backupPath,keyPath,keys:state.keys,releaseSha:state.releaseSha,sourceSha:state.sourceSha,
    sourceDigest:original.digest,originalSqlEncryptedDigest:decoded.encryptedDigest,originalImageEncryptedDigest:sealed.encryptedDigest,createdAt:download.metadata.createdAt});
  }
  state=await requireProductionControl(permit);if(state.current.digest!==original.digest)fail('STAGE8_DATABASE_CHANGED_DURING_BACKUP');
  const recovery={sourceSchema:schema,sourceDigest:original.digest,createdAt:download.metadata.createdAt,sqlEncryptedDigest:decoded.encryptedDigest,
   imageEncryptedDigest:sealed.encryptedDigest,rehearsalStatus:rehearsal.status,releaseSha:state.releaseSha,targetVersion,...(atomicRecovery?{atomicRecovery}:{})};
  if(atomicPlan)atomicRecoveryPlans.set(recovery,{plan:atomicPlan,keyPath});
  return recovery;
 }finally{try{native?.close();}catch{}client?.close();decoded.sql.fill(0);await rm(directory,{recursive:true,force:true});}
}
async function controlledAtomicMigration(permit,recovery){
 const held=atomicRecoveryPlans.get(recovery);if(!held)fail('STAGE8_ATOMIC_RECOVERY_PLAN_REQUIRED');const {plan,keyPath}=held;
 if(Date.now()<recovery.createdAt||Date.now()-recovery.createdAt>3600_000)fail('STAGE8_BACKUP_BINDING_REQUIRED');
 const state=await requireProductionControl(permit);
 if(state.current.schema!==33||state.current.digest!==recovery.sourceDigest)fail('STAGE8_DATABASE_CHANGED_AFTER_BACKUP');
 assertStage8AtomicPlanBinding(plan,{keys:state.keys,releaseSha:state.releaseSha,sourceSha:state.sourceSha,sourceDigest:recovery.sourceDigest});
 const authenticated=await authenticateStage8AtomicRecovery({manifestPath:recovery.atomicRecovery.manifestPath,keyPath,keys:state.keys,releaseSha:state.releaseSha,sourceSha:state.sourceSha});
 if(authenticated.manifestDigest!==recovery.atomicRecovery.manifestDigest||JSON.stringify(authenticated.manifest.planEvidence)!==JSON.stringify(stage8AtomicPlanEvidence(plan,
  {keys:state.keys,releaseSha:state.releaseSha,sourceSha:state.sourceSha,sourceDigest:recovery.sourceDigest})))fail('STAGE8_ATOMIC_RECOVERY_BINDING_REQUIRED');
 let responseLost=false;
 // One driver-owned BEGIN IMMEDIATE/write batch. The statements, exact schema
 // guards and marker34->35 ordering come only from the original local engine.
 // No remote apply authority is exported from the local preparation helper.
 try{await state.client.batch(stage8AtomicPlanStatements(plan),'write');}catch{responseLost=true;}
 let result;const fresh=createClient({url:state.environment.TURSO_DATABASE_URL,authToken:state.environment.TURSO_AUTH_TOKEN,intMode:'number'});
 try{result=await reconcileStage8AtomicPlan(fresh,plan,{keys:state.keys});}finally{fresh.close();}
 // Provider identities, ingress closure, complete logs and every durable row
 // are independently read again after the transaction. An unexpected writer
 // can never be adopted as a new baseline, even when counts happen to match.
 const checked=await requireProductionControl(permit);
 if(result.status==='SOURCE33_OBSERVED_COMMIT_UNCERTAIN')fail('STAGE8_ATOMIC_SOURCE33_COMMIT_UNCERTAIN');
 if(result.status!=='PREPARED35_VERIFIED')fail('STAGE8_ATOMIC_OUTCOME_UNKNOWN');
 if(checked.current.digest!==result.digest)fail('STAGE8_DATABASE_CHANGED_DURING_MIGRATION');
 return {steps:stage8AtomicPlanSteps(plan),atomic:{contract:plan.contract,statementCount:plan.statementCount,mutationCount:plan.mutationCount,
  outcome:responseLost?'LOST_RESPONSE_PREPARED35_VERIFIED':'PREPARED35_VERIFIED',singleWriteTransaction:true}};
}
async function controlledStep(permit,fromVersion,targetVersion,expectedDigest){
 const state=await requireProductionControl(permit),{client,keys}=state;
 // The first baseline is the authenticated backup, then only this invocation's
 // verified migration can advance it. A fresh read never adopts external work.
 if(state.current.digest!==expectedDigest)fail('STAGE8_DATABASE_CHANGED_AFTER_BACKUP');
 if(![fromVersion,fromVersion+1].includes(targetVersion)||targetVersion>35||state.current.schema!==fromVersion)fail('STAGE8_ORDERED_SINGLE_STEP_REQUIRED');
 const before=state.current.snapshot,versions=(await client.execute('SELECT * FROM schema_version ORDER BY version')).rows,
  checkpoints=(await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows;
 const assertPreserved=async()=>{
  if(serial(before)!==serial(await stage8PreservationSnapshot(client,keys,before)))fail('STAGE8_PRESERVED_DATA_CHANGED');
  if(serial(versions)!==serial((await client.execute({sql:'SELECT * FROM schema_version WHERE version<=? ORDER BY version',args:[fromVersion]})).rows)
   ||serial(checkpoints)!==serial((await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows))fail('STAGE8_CHECKPOINT_HISTORY_CHANGED');
 };
 const result=await runMigrations(client,{allowRebuild:false,targetVersion,privacyKeys:keys});await assertPhase4Schema(client,targetVersion);await verifyStage8RecoveryClient(client,keys);
 await assertPreserved();
 const verified=await readDatabaseControl(client,keys);
 // These additive versions create no tenant rows. Extra writes to a new table
 // or newly added column must not disappear into the next step's baseline.
 if(Object.entries(verified.snapshot).some(([table,value])=>!before[table]&&value.count!==0))fail('STAGE8_UNEXPECTED_MIGRATION_DATA');
 if(fromVersion===33&&targetVersion===34){
  if(!before.user_onboarding.columns.includes('enrollment_revision')&&Number((await client.execute('SELECT count(*) n FROM user_onboarding WHERE enrollment_revision<>0')).rows[0].n))fail('STAGE8_UNEXPECTED_MIGRATION_DATA');
  if(!before.tenant_delivery_modes.columns.includes('cutover_health_date')&&Number((await client.execute('SELECT count(*) n FROM tenant_delivery_modes WHERE cutover_health_date IS NOT NULL')).rows[0].n))fail('STAGE8_UNEXPECTED_MIGRATION_DATA');
 }
 await assertPreserved();
 const checked=await requireProductionControl(permit);if(checked.current.digest!==verified.digest)fail('STAGE8_DATABASE_CHANGED_DURING_MIGRATION');
 return {nextDigest:verified.digest,result:{from:fromVersion,to:targetVersion,versionsApplied:result.versionsApplied,preservedTables:Object.keys(before).length,integrity:'ok'}};
}
function parse(argv){
 const options={};for(let i=0;i<argv.length;i++){
  const key=argv[i];if(['--observe','--apply'].includes(key)){if(options.mode)fail('STAGE8_ARGUMENT_INVALID');options.mode=key.slice(2);}
  else if(['--expected-commit','--source-commit','--inventory-file','--observation-file','--backup-file','--key-file','--from-version','--target-version','--confirm-production'].includes(key)){
   if(options[key]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))fail('STAGE8_ARGUMENT_INVALID');options[key]=argv[++i];
  }else fail('STAGE8_ARGUMENT_INVALID');
 }
 for(const key of ['mode','--expected-commit','--source-commit','--inventory-file','--observation-file'])if(!options[key])fail('STAGE8_ARGUMENT_REQUIRED');return options;
}
export async function main(argv=process.argv.slice(2),environment=process.env){
 if(Number(process.versions.node.split('.')[0])!==22)fail('STAGE8_NODE22_REQUIRED');const options=parse(argv),repository=fileURLToPath(new URL('../',import.meta.url));
 assertCleanStage8Release(options['--expected-commit'],repository);
 const inventory=JSON.parse(await readFile((await stage8ProtectedFile(options['--inventory-file'])).path,'utf8'));
 await stage8ProtectedDirectory(dirname(resolve(options['--observation-file'])));
 const control=productionControl({environment,releaseSha:options['--expected-commit'],sourceSha:options['--source-commit'],inventory});
 try{
  if(options.mode==='observe'){
   if(options['--backup-file']||options['--key-file']||options['--from-version']||options['--target-version']||options['--confirm-production'])fail('STAGE8_ARGUMENT_INVALID');
   const observation=await control.observe();await stage8DurableExclusiveImage(resolve(options['--observation-file']),Buffer.from(JSON.stringify(observation)+'\n'));
   return {status:'QUIET_WINDOW_STARTED',observedAt:observation.observedAt,schema:observation.database.schema,replicationIndexAvailable:observation.replicationIndex!==null,minimumQuietMs:PRODUCTION_CONTROL.quietMs};
  }
  if(options['--confirm-production']!=='whoop-briefing')fail('STAGE8_PRODUCTION_CONFIRMATION_REQUIRED');
  if(!options['--backup-file']||!options['--key-file']||!['33','34','35'].includes(options['--from-version'])||!['34','35'].includes(options['--target-version']))fail('STAGE8_ARGUMENT_REQUIRED');
  const from=Number(options['--from-version']),target=Number(options['--target-version']);if(target<from)fail('STAGE8_ORDERED_SINGLE_STEP_REQUIRED');
  const observation=JSON.parse(await readFile((await stage8ProtectedFile(options['--observation-file'])).path,'utf8'));
  const permit=await control.authorize(observation),state=await requireProductionControl(permit);if(state.current.schema!==from)fail('STAGE8_SOURCE_SCHEMA_CHANGED');
  const recovery=await backupAndRehearse(permit,{backupPath:options['--backup-file'],keyPath:options['--key-file'],targetVersion:target});
  assertCleanStage8Release(options['--expected-commit'],repository);const steps=[];let expectedDigest=recovery.sourceDigest,atomic;
  if(from===33&&target===35){const applied=await controlledAtomicMigration(permit,recovery);steps.push(...applied.steps);atomic=applied.atomic;}
  else{
   for(let version=from;version<target;version++){if(Date.now()-recovery.createdAt>3600_000)fail('STAGE8_BACKUP_BINDING_REQUIRED');const step=await controlledStep(permit,version,version+1,expectedDigest);steps.push(step.result);expectedDigest=step.nextDigest;}
   steps.push((await controlledStep(permit,target,target,expectedDigest)).result);
  }
  return {status:'ORDERED_PRODUCTION_MIGRATION_VERIFIED_WRITERS_PAUSED',schema:target,releaseSha:options['--expected-commit'],sourceSha:options['--source-commit'],steps,recovery,...(atomic?{atomic}:{}),trafficReopened:false};
 }finally{control.close();}
}
if(import.meta.url===`file://${process.argv[1]}`)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{
 const code=/^STAGE8_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'STAGE8_PRODUCTION_CONTROL_FAILED';console.error(JSON.stringify({code,trafficReopened:false}));process.exitCode=1;
});
