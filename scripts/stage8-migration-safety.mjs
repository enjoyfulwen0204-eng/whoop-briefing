import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,open,unlink,lstat,realpath,mkdtemp,chmod,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createClient} from '@libsql/client';
import {currentVersion,runMigrations} from '../src/migrations.js';
import {assertPhase4Schema,verifyPhase4Schema} from '../src/phase4Migrations.js';
import {requirePhase4Keys} from '../src/phase4Keys.js';

export const STAGE8_PRODUCTION_HOST='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
const MAGIC=Buffer.from('KHOSREC1'),MAX_BYTES=128*1024*1024;
const fail=code=>{throw Object.assign(Error(code),{code});};
const identifier=name=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))fail('STAGE8_UNSAFE_SCHEMA_IDENTIFIER');return '"'+name+'"';};
const serial=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{int64:v.toString()}:v instanceof ArrayBuffer?{blob:Buffer.from(v).toString('base64')}:ArrayBuffer.isView(v)?{blob:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')}:v);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitEnvironment=()=>{const env={...process.env,LC_ALL:'C'};for(const name of Object.keys(env))if(name.startsWith('GIT_'))delete env[name];return env;};

export function assertCleanStage8Release(expectedSha,repository){
 if(!/^[a-f0-9]{40}$/.test(expectedSha??''))fail('STAGE8_EXACT_RELEASE_REQUIRED');
 const opts={cwd:repository,env:gitEnvironment(),encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']};
 if(execFileSync('git',['rev-parse','HEAD'],opts).trim()!==expectedSha||execFileSync('git',['status','--porcelain','--untracked-files=all'],opts).trim())fail('STAGE8_CLEAN_RELEASE_REQUIRED');
 return expectedSha;
}
// Shared filesystem primitives retain the reviewed ownership, outside-Git,
// exclusive-create and crash-durability checks; no remote migration is granted.
export {protectedDirectory as stage8ProtectedDirectory,protectedFile as stage8ProtectedFile,
 imageKey as stage8RecoveryKey,durableExclusiveImage as stage8DurableExclusiveImage};
async function protectedDirectory(path){
 const full=resolve(path),actual=await realpath(full),st=await lstat(full);
 if(actual!==full||!st.isDirectory()||(st.mode&0o077)!==0||st.uid!==process.getuid())fail('STAGE8_PROTECTED_DIRECTORY_REQUIRED');
 try{if(execFileSync('git',['-C',actual,'rev-parse','--is-inside-work-tree'],{encoding:'utf8',env:gitEnvironment(),timeout:2000,stdio:['ignore','pipe','pipe']}).trim()==='true')fail('STAGE8_RECOVERY_OUTSIDE_GIT_REQUIRED');}catch(error){if(error.code==='STAGE8_RECOVERY_OUTSIDE_GIT_REQUIRED')throw error;if(!String(error.stderr).includes('not a git repository'))fail('STAGE8_REPOSITORY_BOUNDARY_UNPROVEN');}
 return actual;
}
async function protectedFile(path){
 const full=resolve(path);await protectedDirectory(dirname(full));
 const st=await lstat(full);
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid()||await realpath(full)!==full)fail('STAGE8_PROTECTED_FILE_REQUIRED');
 return {path:full,size:st.size};
}
async function imageKey(path){const file=await protectedFile(path),key=await readFile(file.path);if(key.length!==32)fail('STAGE8_RECOVERY_KEY_REQUIRED');return key;}
async function syncDirectory(path){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
/** A success receipt follows both file and directory fsync. Failed publication
 * removes only this invocation's new inode; an existing backup is never touched. */
async function durableExclusiveImage(path,bytes){
 let file,identity;
 try{
  file=await open(path,'wx',0o600);identity=await file.stat();
  await file.writeFile(bytes);await file.sync();await file.close();file=null;
  await syncDirectory(dirname(path));
 }catch(error){
  try{await file?.close();}catch{}
  if(identity){
   try{
    const current=await lstat(path);
    if(current.dev!==identity.dev||current.ino!==identity.ino)fail('STAGE8_RECOVERY_DURABILITY_UNCERTAIN');
    await unlink(path);await syncDirectory(dirname(path));
   }catch(cleanupError){
    if(cleanupError.code!=='ENOENT')fail('STAGE8_RECOVERY_DURABILITY_UNCERTAIN');
   }
  }
  throw error;
 }
}
async function healthy(client){
 if(String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check)!=='ok'||(await client.execute('PRAGMA foreign_key_check')).rows.length)fail('STAGE8_DATABASE_UNHEALTHY');
}
async function continuity(client,keys){
 requirePhase4Keys(keys);
 const rows=(await client.execute("SELECT step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key")).rows;
 if(rows.length!==2||rows.some(row=>row.postcondition_state!=='COMPLETE'||!(row.step_key==='lookup_key_check'?keys.verifyLookupCheckpoint(row.last_cursor):keys.verifyAuditCheckpoint(row.last_cursor))))fail('STAGE8_KEY_CONTINUITY_REQUIRED');
}
export async function verifyStage8RecoveryClient(client,keys){
 const version=await currentVersion(client);if(![33,34,35].includes(version))fail('STAGE8_RECOVERY_SCHEMA_REQUIRED');
 await continuity(client,keys);await healthy(client);await verifyPhase4Schema(client,version,{resuming:true});return version;
}

/** Keyed row digests never expose health values or credentials. Preserve every
 * existing column and row, including pending jobs/receipts and preferences. */
export async function stage8PreservationSnapshot(client,keys,definition=null){
 const tables=definition?Object.keys(definition):(await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') AND name NOT IN ('schema_version','phase4_migration_checkpoints') ORDER BY name")).rows.map(row=>row.name);
 const results=new Array(tables.length);let next=0,failure;
 const capture=async table=>{
  const info=(await client.execute(`PRAGMA table_info(${identifier(table)})`)).rows;
  const columns=definition?.[table]?.columns??info.map(row=>row.name);
  if(columns.some(column=>!info.some(row=>row.name===column)))fail('STAGE8_PRESERVED_COLUMN_MISSING');
  const primary=info.filter(row=>Number(row.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(row=>identifier(row.name));
  const order=primary.length?primary.join(','):'rowid';let offset=0,hash=keys.lookup(['stage8-preservation-table-v1',table,columns]);
  for(;;){
   const rows=(await client.execute({sql:`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)} ORDER BY ${order} LIMIT 1024 OFFSET ?`,args:[offset]})).rows;
   for(const row of rows)hash=keys.lookup(['stage8-preservation-row-v1',hash,serial(columns.map(column=>row[column]))]);
   offset+=rows.length;if(rows.length<1024)break;
  }
  return {columns,count:offset,hash};
 };
 // Four table readers, each retaining only its current <=1024-row page.
 // Every table's original PK/rowid order and per-row HMAC chain are unchanged.
 // Assemble by original table index so transport completion order cannot alter
 // the all-tables digest. Settle every reader before propagating an error.
 const worker=async()=>{while(!failure&&next<tables.length){const index=next++;try{results[index]=await capture(tables[index]);}catch(error){failure??=error;}}};
 await Promise.all(Array.from({length:Math.min(4,tables.length)},worker));if(failure)throw failure;
 return Object.fromEntries(tables.map((table,index)=>[table,results[index]]));
}

/** Local disposable recovery copies only. This deliberately does not grant
 * remote migration authority or substitute DB counts for provider quiescence. */
export async function applyStage8LocalMigrationStep(client,{keys,fromVersion,targetVersion}){
 if(client.protocol!=='file')fail('STAGE8_REMOTE_QUIESCENCE_AUTHORITY_UNAVAILABLE');
 if(![33,34,35].includes(fromVersion)||![fromVersion,fromVersion+1].includes(targetVersion)||targetVersion>35)fail('STAGE8_ORDERED_SINGLE_STEP_REQUIRED');
 if(await currentVersion(client)!==fromVersion)fail('STAGE8_SOURCE_SCHEMA_CHANGED');
 await continuity(client,keys);
 await verifyPhase4Schema(client,fromVersion,{resuming:targetVersion>fromVersion});await healthy(client);
 const before=await stage8PreservationSnapshot(client,keys);
 const checkpoints=(await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows;
 const versions=(await client.execute('SELECT * FROM schema_version ORDER BY version')).rows;
 const result=await runMigrations(client,{allowRebuild:false,targetVersion,privacyKeys:keys});
 await assertPhase4Schema(client,targetVersion);await healthy(client);
 const after=await stage8PreservationSnapshot(client,keys,before);
 if(serial(before)!==serial(after))fail('STAGE8_PRESERVED_DATA_CHANGED');
 const retainedVersions=(await client.execute({sql:'SELECT * FROM schema_version WHERE version<=? ORDER BY version',args:[fromVersion]})).rows;
 if(serial(versions)!==serial(retainedVersions)||serial(checkpoints)!==serial((await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows))fail('STAGE8_CHECKPOINT_HISTORY_CHANGED');
 return {from:fromVersion,to:targetVersion,versionsApplied:result.versionsApplied,preservedTables:Object.keys(before).length,preservationDigest:keys.lookup(['stage8-preservation-all-v1',before]),integrity:'ok'};
}

/** Seal an already stopped/checkpointed local SQLite export. The source host
 * label is operator-supplied, not provider proof. Production must separately
 * match its fresh quiesced source to this protected image. No provider token,
 * export command, WAL deletion/checkpoint or production DB mutation occurs. */
export async function sealStage8RecoveryImage({sourcePath,backupPath,keyPath,keys,releaseSha,sourceTarget,now=Date.now()}){
 if(!/^[a-f0-9]{40}$/.test(releaseSha??'')||![STAGE8_PRODUCTION_HOST,'SYNTHETIC_LOCAL'].includes(sourceTarget))fail('STAGE8_RECOVERY_BINDING_REQUIRED');
 const source=await protectedFile(sourcePath);await protectedDirectory(dirname(resolve(backupPath)));
 if(source.size>MAX_BYTES)fail('STAGE8_RECOVERY_IMAGE_TOO_LARGE');
 for(const suffix of ['-wal','-journal']){try{if((await lstat(source.path+suffix)).size)fail('STAGE8_RECOVERY_SOURCE_NOT_CLOSED');}catch(error){if(error.code!=='ENOENT')throw error;}}
 // Frozen migration contracts use safe-integer number metadata. Keep their
 // established driver mode; unsupported int64 values fail instead of coercing.
 const client=createClient({url:'file:'+source.path,intMode:'number'});let schema,snapshot;
 try{schema=await currentVersion(client);if(![33,34,35].includes(schema))fail('STAGE8_RECOVERY_SCHEMA_REQUIRED');await healthy(client);await continuity(client,keys);await verifyPhase4Schema(client,schema,{resuming:true});snapshot=await stage8PreservationSnapshot(client,keys);}finally{client.close();}
 const image=await readFile(source.path);if(!image.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))fail('STAGE8_SQLITE_IMAGE_REQUIRED');
 const metadata={contract:'stage8-protected-recovery-v1',sourceTarget,schema,releaseSha,createdAt:now,preservation:keys.lookup(['stage8-preservation-all-v1',snapshot]),imageDigest:digest(image)};
 const iv=randomBytes(12),header=Buffer.from(JSON.stringify({metadata,iv:iv.toString('base64')})),size=Buffer.alloc(4);size.writeUInt32BE(header.length);
 const cipher=createCipheriv('aes-256-gcm',await imageKey(keyPath),iv);cipher.setAAD(header);
 const sealed=Buffer.concat([MAGIC,size,header,cipher.update(image),cipher.final(),cipher.getAuthTag()]);
 await durableExclusiveImage(resolve(backupPath),sealed);
 return {metadata,encryptedDigest:digest(sealed),encryptedBytes:sealed.length};
}

/** Restore only to an owned disposable 0700 directory, prove the original keyed
 * source image, then rehearse ordered steps without altering the sealed backup. */
export async function rehearseStage8RecoveryImage({backupPath,keyPath,keys,releaseSha,sourceTarget,targetVersion,now=Date.now()}){
 const file=await protectedFile(backupPath);if(file.size>MAX_BYTES+16384)fail('STAGE8_RECOVERY_IMAGE_TOO_LARGE');
 const sealed=await readFile(file.path);if(!sealed.subarray(0,8).equals(MAGIC)||sealed.length<44)fail('STAGE8_RECOVERY_ENVELOPE_INVALID');
 const n=sealed.readUInt32BE(8);if(n<1||n>8192||12+n+16>=sealed.length)fail('STAGE8_RECOVERY_ENVELOPE_INVALID');
 const header=sealed.subarray(12,12+n),parsed=JSON.parse(header),m=parsed.metadata;
 if(m?.contract!=='stage8-protected-recovery-v1'||m.releaseSha!==releaseSha||m.sourceTarget!==sourceTarget||![STAGE8_PRODUCTION_HOST,'SYNTHETIC_LOCAL'].includes(sourceTarget)||![33,34,35].includes(m.schema)||!Number.isSafeInteger(m.createdAt)||now<m.createdAt||now-m.createdAt>3600000||![34,35].includes(targetVersion)||m.schema>targetVersion)fail('STAGE8_RECOVERY_BINDING_REQUIRED');
 const decipher=createDecipheriv('aes-256-gcm',await imageKey(keyPath),Buffer.from(parsed.iv,'base64'));decipher.setAAD(header);decipher.setAuthTag(sealed.subarray(-16));
 const image=Buffer.concat([decipher.update(sealed.subarray(12+n,-16)),decipher.final()]);if(digest(image)!==m.imageDigest)fail('STAGE8_RECOVERY_IMAGE_CHANGED');
 const directory=await mkdtemp(join(tmpdir(),'khos-recovery-'));await chmod(directory,0o700);let client;
 try{
  const restored=join(directory,'rehearsal.sqlite');await writeFile(restored,image,{mode:0o600,flag:'wx'});
  client=createClient({url:'file:'+restored,intMode:'number'});
  if(await currentVersion(client)!==m.schema)fail('STAGE8_RECOVERY_SCHEMA_REQUIRED');
  await healthy(client);await continuity(client,keys);
  if(keys.lookup(['stage8-preservation-all-v1',await stage8PreservationSnapshot(client,keys)])!==m.preservation)fail('STAGE8_RECOVERY_IMAGE_CHANGED');
  const steps=[];for(let version=m.schema;version<targetVersion;version++)steps.push(await applyStage8LocalMigrationStep(client,{keys,fromVersion:version,targetVersion:version+1}));
  steps.push(await applyStage8LocalMigrationStep(client,{keys,fromVersion:targetVersion,targetVersion}));
  if(digest(await readFile(file.path))!==digest(sealed))fail('STAGE8_ENCRYPTED_BACKUP_CHANGED');
  return {status:'LOCAL_RECOVERY_REHEARSAL_PASS',schema:targetVersion,releaseSha,steps,encryptedDigest:digest(sealed),remoteApply:'BLOCKED_NO_QUIESCENCE_AUTHORITY'};
 }finally{client?.close();await rm(directory,{recursive:true,force:true});}
}
