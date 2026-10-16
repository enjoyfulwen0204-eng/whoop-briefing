import {createHash,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {requirePhase4Keys} from '../src/phase4Keys.js';
import {stage8ProtectedFile,stage8RecoveryKey,stage8DurableExclusiveImage,sealStage8RecoveryImage,STAGE8_PRODUCTION_HOST} from './stage8-migration-safety.mjs';
import {readDatabaseControl} from './stage8-production-control.mjs';
import {stage8AtomicPlanEvidence} from './stage8-atomic-migration.mjs';

const MAGIC=Buffer.from('KHOSREC1'),MAX_IMAGE=128*1024*1024,MAX_SQL=256*1024*1024,MAX_MANIFEST=128*1024,MAX_AGE=3600_000;
const fail=code=>{throw Object.assign(Error(code),{code});},hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const signature=(keys,value)=>keys.digest(keys.lookup(['stage8-atomic-precommit-audit-domain-v1']),JSON.stringify(value));
const continuity=keys=>JSON.stringify([keys.lookup(['stage8-atomic-plan-key-continuity-v1']),
 keys.digest(keys.lookup(['stage8-atomic-plan-audit-domain-v1']),'stage8-atomic-plan-key-continuity-v1')]);
const catalogSql=`SELECT json_group_array(json_array(type,name,tbl_name,sql)) value FROM
 (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name='sqlite_sequence' ORDER BY type,name)`;
const catalogDigest=async(client,keys)=>keys.lookup(['stage8-atomic-recovery-catalog-v1',String((await client.execute(catalogSql)).rows[0]?.value)]);
async function protectedBytes(path,maximum){const file=await stage8ProtectedFile(path);if(file.size>maximum)fail('STAGE8_ATOMIC_RECOVERY_BOUNDS');return readFile(file.path);}
function optionsOnly(options,required,optional=[]){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype)fail('STAGE8_ATOMIC_RECOVERY_OPTIONS_REQUIRED');
 const names=Reflect.ownKeys(options);
 if(names.some(name=>typeof name!=='string'||![...required,...optional].includes(name))||required.some(name=>!Object.hasOwn(options,name))
  ||Object.values(Object.getOwnPropertyDescriptors(options)).some(value=>!Object.hasOwn(value,'value')))fail('STAGE8_ATOMIC_RECOVERY_OPTIONS_REQUIRED');
}
function validateBinding(value,{keys,releaseSha,sourceSha,now}){
 requirePhase4Keys(keys);
 if(!sha(releaseSha)||!sha(sourceSha)||!Number.isSafeInteger(now)||value?.contract!=='stage8-atomic-precommit-v1'||value.host!==STAGE8_PRODUCTION_HOST
  ||value.planEvidence?.contract!=='stage8-atomic-reconciliation-evidence-v1'||value.planEvidence.releaseSha!==releaseSha||value.planEvidence.sourceSha!==sourceSha
  ||value.planEvidence.from!==33||value.planEvidence.to!==35||value.planEvidence.keyContinuity!==continuity(keys)
  ||!Number.isSafeInteger(value.createdAt)||now<value.createdAt||now-value.createdAt>MAX_AGE
  ||!Number.isSafeInteger(value.prepared35?.sealedAt)||value.prepared35.sealedAt<value.createdAt||now<value.prepared35.sealedAt
  ||['sourceDigest','targetDigest','sourceHistoryDigest','targetHistoryDigest','sourceCatalogDigest','targetCatalogDigest','targetPreservation','statementPacketSha256'].some(name=>!hex(value.planEvidence[name]))
  ||!Array.isArray(value.planEvidence.originalVersionMarkers)||!Array.isArray(value.planEvidence.preparedMarkers)
  ||JSON.stringify(value.planEvidence.preparedMarkers.map(marker=>marker.version))!=='[34,35]'
  ||value.planEvidence.preparedMarkers.some(marker=>marker.note!==`phase4 v${marker.version} postconditions verified`||!Number.isFinite(Date.parse(marker.appliedAt))))fail('STAGE8_ATOMIC_RECOVERY_BINDING_REQUIRED');
}
async function retainedCiphertext(path,expected,maximum){
 if(!hex(expected)||hash(await protectedBytes(path,maximum))!==expected)fail('STAGE8_ATOMIC_RECOVERY_CIPHERTEXT_CHANGED');
}
async function authenticatePrepared35(value,keyPath){
 const sealed=await protectedBytes(value.prepared35.path,MAX_IMAGE+16384);
 if(hash(sealed)!==value.prepared35.encryptedDigest||!sealed.subarray(0,8).equals(MAGIC)||sealed.length<44)fail('STAGE8_ATOMIC_RECOVERY_IMAGE_AUTHENTICATION_FAILED');
 const length=sealed.readUInt32BE(8);if(length<1||length>8192||12+length+16>=sealed.length)fail('STAGE8_ATOMIC_RECOVERY_IMAGE_AUTHENTICATION_FAILED');
 const header=sealed.subarray(12,12+length),chunks=[];let image;
 try{
  const {metadata,iv}=JSON.parse(header),nonce=Buffer.from(iv??'','base64');
  if(nonce.length!==12||metadata?.contract!=='stage8-protected-recovery-v1'||metadata.schema!==35||metadata.releaseSha!==value.planEvidence.releaseSha
   ||metadata.sourceTarget!==value.host||metadata.createdAt!==value.prepared35.sealedAt||metadata.imageDigest!==value.prepared35.imageDigest
   ||metadata.preservation!==value.planEvidence.targetPreservation)fail('STAGE8_ATOMIC_RECOVERY_IMAGE_AUTHENTICATION_FAILED');
  const decipher=createDecipheriv('aes-256-gcm',await stage8RecoveryKey(keyPath),nonce);decipher.setAAD(header);decipher.setAuthTag(sealed.subarray(-16));
  // Plaintext is never returned or restored. The complete tag authenticates
  // before the full image digest is accepted, then the buffer is erased.
  chunks.push(decipher.update(sealed.subarray(12+length,-16)));chunks.push(decipher.final());image=Buffer.concat(chunks);
  if(!image.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||hash(image)!==metadata.imageDigest)fail('STAGE8_ATOMIC_RECOVERY_IMAGE_AUTHENTICATION_FAILED');
 }catch{fail('STAGE8_ATOMIC_RECOVERY_IMAGE_AUTHENTICATION_FAILED');}finally{for(const chunk of chunks)chunk.fill(0);image?.fill(0);}
}

/** The opaque in-process plan can publish reconciliation evidence, never a
 * serialized executable plan. Both encrypted source backups remain exclusive. */
export async function persistStage8AtomicRecovery(plan,options){
 optionsOnly(options,['sourcePath','backupPath','keyPath','keys','releaseSha','sourceSha','sourceDigest','originalSqlEncryptedDigest','originalImageEncryptedDigest','createdAt']);
 const {sourcePath,backupPath,keyPath,keys,releaseSha,sourceSha,sourceDigest,originalSqlEncryptedDigest,originalImageEncryptedDigest,createdAt}=options;
 const planEvidence=stage8AtomicPlanEvidence(plan,{keys,releaseSha,sourceSha,sourceDigest}),file=await stage8ProtectedFile(sourcePath);
 const local=createClient({url:pathToFileURL(file.path).href,intMode:'number'});
 try{if((await readDatabaseControl(local,keys)).digest!==planEvidence.targetDigest||await catalogDigest(local,keys)!==planEvidence.targetCatalogDigest)fail('STAGE8_ATOMIC_PREPARED35_CHANGED');}finally{local.close();}
 const preparedPath=resolve(backupPath)+'.prepared35.sqlite.enc',sealed=await sealStage8RecoveryImage({sourcePath:file.path,backupPath:preparedPath,keyPath,keys,releaseSha,sourceTarget:STAGE8_PRODUCTION_HOST});
 if(sealed.metadata.schema!==35||sealed.metadata.preservation!==planEvidence.targetPreservation)fail('STAGE8_ATOMIC_PREPARED35_CHANGED');
 const value={contract:'stage8-atomic-precommit-v1',host:STAGE8_PRODUCTION_HOST,createdAt,planEvidence,
  original33:{sqlPath:resolve(backupPath),sqlEncryptedDigest:originalSqlEncryptedDigest,imagePath:resolve(backupPath)+'.sqlite.enc',imageEncryptedDigest:originalImageEncryptedDigest},
  prepared35:{path:preparedPath,encryptedDigest:sealed.encryptedDigest,imageDigest:sealed.metadata.imageDigest,sealedAt:sealed.metadata.createdAt}};
 validateBinding(value,{keys,releaseSha,sourceSha,now:Date.now()});
 await retainedCiphertext(value.original33.sqlPath,originalSqlEncryptedDigest,MAX_SQL+16384);
 await retainedCiphertext(value.original33.imagePath,originalImageEncryptedDigest,MAX_IMAGE+16384);
 const manifestPath=resolve(backupPath)+'.atomic-precommit.json',bytes=Buffer.from(JSON.stringify({...value,signature:signature(keys,value)})+'\n');
 await stage8DurableExclusiveImage(manifestPath,bytes);
 return Object.freeze({manifestPath,manifestDigest:hash(bytes),prepared35Path:preparedPath,prepared35EncryptedDigest:sealed.encryptedDigest});
}

/** Authenticate retained evidence locally. A receipt cannot be turned into a
 * WeakMap plan, a Production permit or any write operation. */
export async function authenticateStage8AtomicRecovery(options){
 optionsOnly(options,['manifestPath','keyPath','keys','releaseSha','sourceSha'],['now']);
 const {manifestPath,keyPath,keys,releaseSha,sourceSha,now=Date.now()}=options;requirePhase4Keys(keys);
 const bytes=await protectedBytes(manifestPath,MAX_MANIFEST);let parsed;
 try{parsed=JSON.parse(bytes);}catch{fail('STAGE8_ATOMIC_RECOVERY_MANIFEST_AUTHENTICATION_FAILED');}
 const {signature:supplied,...value}=parsed??{},expected=signature(keys,value);
 if(!hex(supplied)||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(expected,'hex')))fail('STAGE8_ATOMIC_RECOVERY_MANIFEST_AUTHENTICATION_FAILED');
 validateBinding(value,{keys,releaseSha,sourceSha,now});
 await retainedCiphertext(value.original33?.sqlPath,value.original33?.sqlEncryptedDigest,MAX_SQL+16384);
 await retainedCiphertext(value.original33?.imagePath,value.original33?.imageEncryptedDigest,MAX_IMAGE+16384);
 await authenticatePrepared35(value,keyPath);
 return {manifest:value,manifestDigest:hash(bytes)};
}

/** Supported new-process recovery is read-only. It owns a fresh authenticated
 * Production read client; callers cannot provide a client, SQL or grant.
 * Providers must still be requalified separately before any reopening. */
export async function verifyStage8AtomicRecovery(options){
 optionsOnly(options,['manifestPath','keyPath','keys','releaseSha','sourceSha','environment'],['now']);
 const {environment,...localOptions}=options,{manifest,manifestDigest}=await authenticateStage8AtomicRecovery(localOptions),{keys}=options;
 if(!environment||![`libsql://${STAGE8_PRODUCTION_HOST}`,`libsql://${STAGE8_PRODUCTION_HOST}/`].includes(environment.TURSO_DATABASE_URL)
  ||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('STAGE8_ATOMIC_RECOVERY_PRODUCTION_READ_REQUIRED');
 const client=createClient({url:`libsql://${STAGE8_PRODUCTION_HOST}`,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number'});
 const common={manifestDigest,readOnly:true,trafficReopened:false,remoteApply:'UNAVAILABLE_READ_ONLY_EVIDENCE'};
 try{
  const observed=await readDatabaseControl(client,keys),catalog=await catalogDigest(client,keys),evidence=manifest.planEvidence;
  if(observed.schema===35&&observed.digest===evidence.targetDigest&&catalog===evidence.targetCatalogDigest)return {...common,status:'PREPARED35_VERIFIED',digest:observed.digest,schema:35,commitVerified:true};
  if(observed.schema===33&&observed.digest===evidence.sourceDigest&&catalog===evidence.sourceCatalogDigest)return {...common,status:'SOURCE33_OBSERVED_COMMIT_UNCERTAIN',digest:observed.digest,schema:33,commitVerified:false};
 }catch{}finally{client.close();}
 return {...common,status:'UNKNOWN_KEEP_MAINTENANCE',commitVerified:false};
}
