/** Fixed source33 recovery. Only the existing signed BASE row changes.
 * This does not create D, authorize migration, renew a window, adopt a new q,
 * or prove that an earlier native request was never submitted/cancelled. */
import {createClient} from '@libsql/client';
import {snapshotRevocationOptions} from './ownedProductionEpochOptions.js';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {runningReleaseSha} from './phase4Release.js';
import {assertSchemaTransitionProfile} from './schemaTransitionProfile.js';
import {PROFILE_REVISION_PREFIX} from './profileRevision.js';
import {authenticateProductionEpochQualification,createProductionEpochBootstrap,PRODUCTION_EPOCH_TARGET as P} from './productionEpochBootstrap.js';
import {PRODUCTION_SUPERVISOR_BOOT_KEY} from './productionEpochManifest.js';
import {assertCleanStage8Release} from '../scripts/stage8-migration-safety.mjs';
import {META,projectMetadata,exactMetadataPredicate,rowPredicate,operatorPredicate,constraintsPredicate,serverNow,createGuard,dropGuard,guard} from './productionEpochShortBatchMetadata.js';

const BOOT='production-supervisor-monotonic-boot-v1',PREFIX=PROFILE_REVISION_PREFIX+'operator:';
const proofs=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,fields)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const hex=(v,n=64)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const equal=(a,b)=>hex(a)&&hex(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const sign=(keys,body)=>keys.digest(keys.lookup([BOOT]),[BOOT,body]);
const lease=()=>({startedAt:Date.now(),deadlineAt:Date.now()+15000});
function budget(policy){const now=Date.now();if(now<policy.startedAt||now>=policy.deadlineAt)fail('UNINITIALIZED_ABORT_READ_OR_WINDOW_DEADLINE');return now;}
function makeBoot(keys,body){const signature=sign(keys,body),digest=keys.lookup([BOOT,body,signature]);return {key:PRODUCTION_SUPERVISOR_BOOT_KEY,value:JSON.stringify({body,signature,digest}),updated_at:new Date(body.issuedAtMs).toISOString(),digest};}
function authenticBoot(row,keys){
 if(!exact(row,['key','value','updated_at'])||row.key!==PRODUCTION_SUPERVISOR_BOOT_KEY||typeof row.value!=='string'||Buffer.byteLength(row.value)>2048)fail('UNINITIALIZED_ABORT_AUTHENTIC_BOOT_REQUIRED');
 let value;try{value=JSON.parse(row.value);}catch{fail('UNINITIALIZED_ABORT_AUTHENTIC_BOOT_REQUIRED');}
 if(!exact(value,['body','signature','digest'])||!exact(value.body,['contract','generation','nonce','issuedAtMs','releaseSha'])||value.body.contract!==BOOT||!Number.isSafeInteger(value.body.generation)||value.body.generation<1||value.body.generation>=Number.MAX_SAFE_INTEGER||!hex(value.body.nonce)||!hex(value.body.releaseSha,40)||!Number.isSafeInteger(value.body.issuedAtMs)||value.body.issuedAtMs<=0||!equal(value.signature,sign(keys,value.body)))fail('UNINITIALIZED_ABORT_AUTHENTIC_BOOT_REQUIRED');
 const expected=makeBoot(keys,value.body);if(!same({...row,digest:value.digest},expected)||!equal(expected.digest,value.digest))fail('UNINITIALIZED_ABORT_AUTHENTIC_BOOT_REQUIRED');return {row:expected,body:value.body};
}
function context(input,{captured=false}={}){
 const options=snapshotRevocationOptions(input,captured);
 if(!exact(options,['environment','operatorQualification',...(captured?['processBoot']:[])]))fail('UNINITIALIZED_ABORT_FIXED_CONSTRUCTION_REQUIRED');
 const environment=Object.freeze({...options.environment});if(Object.hasOwn(environment,'RENDER_API_KEY'))fail('UNINITIALIZED_ABORT_OPERATOR_LOGIN_MUST_STAY_LOCAL');
 const keys=phase4AuthorityKeys(environment),{s,window,qualificationTransport}=authenticateProductionEpochQualification({keys,operatorQualification:options.operatorQualification});
 const qualification=JSON.parse(qualificationTransport.value).qualification;
 // The canonical constructor verifies exact static config/actual checkout and,
 // for the active writer, the ORIGINAL opaque captured process boot identity.
 const verifier=createProductionEpochBootstrap({environment,operatorQualification:qualification,...(captured?{processBoot:options.processBoot}:{})});verifier.close();
 assertSchemaTransitionProfile(environment);const releaseSha=runningReleaseSha(environment);if(releaseSha!==window.source33RuntimeSha||releaseSha!==window.targetRuntimeSha)fail('UNINITIALIZED_ABORT_ORIGINAL_SOURCE_RUNTIME_REQUIRED');
 assertCleanStage8Release(releaseSha,fileURLToPath(new URL('../',import.meta.url)));
 return {environment,keys,s,window,releaseSha,qualification,catalogDigest:qualification.body.sourceCatalogDigest,originalBoot:authenticBoot({key:s.bootRow.key,value:s.bootRow.value,updated_at:s.bootRow.updated_at},keys)};
}
function native(c,policy){
 const {environment}=c;if(environment.TURSO_DATABASE_URL!==P.databaseUrl||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('UNINITIALIZED_ABORT_FIXED_DATABASE_REQUIRED');
 return createClient({url:P.databaseUrl,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number',fetch:(input,init)=>{
  const now=budget(policy),url=new URL(typeof input==='string'?input:input.url);if(url.origin!=='https://'+new URL(P.databaseUrl).hostname)fail('UNINITIALIZED_ABORT_FIXED_DATABASE_REQUIRED');
  return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(Math.min(15000,policy.deadlineAt-now))])});
 }});
}
async function readBase(tx,c,policy){
 const read=async statement=>{budget(policy);const result=await tx.execute(statement);budget(policy);return result.rows;};
 const operator=await read({sql:'SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key',args:[PREFIX.length,PREFIX]});
 if(operator.length)fail('UNINITIALIZED_ABORT_TRANSITION_ALREADY_PRESENT');
 const versions=projectMetadata('versions',await read(META.versions));
 if(Math.max(0,...versions.map(r=>r.version))!==33||versions.some(r=>!Number.isSafeInteger(r.version)))fail('UNINITIALIZED_ABORT_CANONICAL33_REQUIRED');
 for(let v=21;v<=33;v++)if(versions.filter(r=>r.version===v&&r.note===`phase4 v${v} postconditions verified`).length!==1)fail('UNINITIALIZED_ABORT_CANONICAL33_REQUIRED');
 const catalog=projectMetadata('catalog',await read(META.catalog));if(c.keys.lookup(['production-transition-r3-actual-catalog-v1',catalog.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql}))])!==c.catalogDigest)fail('UNINITIALIZED_ABORT_EXACT_ORIGINAL_CATALOG_REQUIRED');
 const checkpoints=projectMetadata('checkpoints',await read(META.checkpoints));
 for(const [v,k]of [[21,'tenant_metadata'],[22,'privacy_backfill'],[22,'lookup_key_check'],[22,'audit_key_check'],[23,'legacy_insights'],[32,'execution_authority']]){const r=checkpoints.find(r=>r.target_version===v&&r.step_key===k);if(r?.postcondition_state!=='COMPLETE'||k==='lookup_key_check'&&!c.keys.verifyLookupCheckpoint(r.last_cursor)||k==='audit_key_check'&&!c.keys.verifyAuditCheckpoint(r.last_cursor)||k==='execution_authority'&&r.last_cursor!=='phase4-execution-v2')fail('UNINITIALIZED_ABORT_KEY_CONTINUITY_REQUIRED');}
 if((await read('PRAGMA foreign_keys'))[0]?.foreign_keys!==1||(await read('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()'))[0]?.ignore_check_constraints!==0)fail('UNINITIALIZED_ABORT_CONSTRAINTS_REQUIRED');
 const rows=await read({sql:'SELECT key,value,updated_at FROM telegram_state WHERE key=?',args:[PRODUCTION_SUPERVISOR_BOOT_KEY]});if(rows.length!==1)fail('UNINITIALIZED_ABORT_AUTHENTIC_BOOT_REQUIRED');
 const current=authenticBoot({key:rows[0].key,value:rows[0].value,updated_at:rows[0].updated_at},c.keys);if(current.body.generation<c.originalBoot.body.generation||current.body.generation===c.originalBoot.body.generation&&!same(current.row,c.originalBoot.row))fail('UNINITIALIZED_ABORT_BOOT_MONOTONICITY_REQUIRED');return {...current,metadata:{catalog,versions,checkpoints}};
}
function issue(c,current){
 if(current.body.generation<=c.originalBoot.body.generation)fail('UNINITIALIZED_ABORT_ORIGINAL_INITIALIZATION_NOT_REVOKED');
 const reference=Object.freeze({contract:'production-original-initialization-revocation-observation-v1',productionAuthority:'NONE'});
 proofs.set(reference,{keys:c.keys,qualificationDigest:c.keys.lookup(['uninitialized-abort-original-qualification-v1',c.qualification.body]),windowId:c.window.originalWindowId,originalGeneration:c.originalBoot.body.generation,currentGeneration:current.body.generation,currentBootDigest:current.row.digest,releaseSha:c.releaseSha,observedAtMs:Date.now()});return reference;
}
export function requireProductionInitializationRevocation(reference,keys){
 requirePhase4Keys(keys);const p=proofs.get(reference);if(!p||p.keys.lookupCheckpoint()!==keys.lookupCheckpoint()||p.keys.auditCheckpoint()!==keys.auditCheckpoint()||Date.now()<p.observedAtMs||Date.now()-p.observedAtMs>30000)fail('UNINITIALIZED_ABORT_FRESH_OWNED_PROOF_REQUIRED');
 return Object.freeze({productionAuthority:'NONE',phase:'PREFENCE33_ORIGINAL_INITIALIZATION_REVOKED',schema:33,originalWindowId:p.windowId,source33RuntimeSha:p.releaseSha,originalBootGeneration:p.originalGeneration,currentBootGeneration:p.currentGeneration,currentBootDigest:p.currentBootDigest,originalQualificationDigest:p.qualificationDigest,operatorRows:0,originalInitializationRevoked:true,originalMigrationNeverIssued:false,remoteSqlCancelled:false,newMaintenanceAllowed:false});
}
/** Protected operator/cold recovery observation. No write, scope, window or
 * process boot is issued. A higher authenticated generation plus zero controls
 * proves the ORIGINAL late A guard can no longer match its original boot. */
export async function observeProductionInitializationRevocation(options={}){
 const c=context(options),policy=lease(),client=native(c,policy);let tx;try{tx=await client.transaction('read');const current=await readBase(tx,c,policy);await tx.commit();budget(policy);return issue(c,current);}catch(error){try{await tx?.rollback();}catch{}throw error;}finally{tx?.close();client.close();}
}
/** Sole active source33 abort writer. The canonical ORIGINAL process-boot
 * capability is mandatory. One fixed write batch serializes against late A;
 * its exact boot guard is checked before A's first DDL. No new q is adopted. */
export async function revokeProductionUninitializedAttempt(options={}){
 const c=context(options,{captured:true});
 // Idempotent reconciliation can finish normal recovery after expiry only if
 // revocation ALREADY committed. A still-original boot needs the active window.
 try{return await observeProductionInitializationRevocation({environment:c.environment,operatorQualification:c.qualification});}catch(error){if(error?.code!=='UNINITIALIZED_ABORT_ORIGINAL_INITIALIZATION_NOT_REVOKED')throw error;}
 const now=Date.now();if(now<c.window.originalWindowStartMs||now>=c.window.originalWindowEndMs)fail('UNINITIALIZED_ABORT_ORIGINAL_WINDOW_INACTIVE');const policy={startedAt:now,deadlineAt:c.window.originalWindowEndMs},client=native(c,policy);let tx;
 try{tx=await client.transaction('read');const current=await readBase(tx,c,policy);await tx.commit();tx.close();tx=null;budget(policy);
  if(current.body.generation===c.originalBoot.body.generation){const next=makeBoot(c.keys,{contract:BOOT,generation:current.body.generation+1,nonce:randomBytes(32).toString('hex'),issuedAtMs:Date.now(),releaseSha:c.releaseSha});authenticBoot({key:next.key,value:next.value,updated_at:next.updated_at},c.keys);
   const metadata=exactMetadataPredicate(current.metadata),before=rowPredicate(current.row),after=rowPredicate(next),operators=operatorPredicate(PREFIX,[]),window=`${serverNow}>=? AND ${serverNow}<?`,where=[metadata.sql,before.sql,operators.sql,constraintsPredicate,window].join(' AND '),args=[...metadata.args,...before.args,...operators.args,c.window.originalWindowStartMs,c.window.originalWindowEndMs];
   const packet=[createGuard,guard(where,args),{sql:'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?',args:[next.value,next.updated_at,next.key,current.row.value,current.row.updated_at]},guard('changes()=1'),guard([metadata.sql,after.sql,operators.sql,constraintsPredicate,window].join(' AND '),[...metadata.args,...after.args,...operators.args,c.window.originalWindowStartMs,c.window.originalWindowEndMs]),dropGuard];
   budget(policy);await client.batch(packet,'write');budget(policy);}
 }catch(error){try{await tx?.rollback();}catch{}throw error;}finally{tx?.close();client.close();}
 return observeProductionInitializationRevocation({environment:c.environment,operatorQualification:c.qualification});
}
