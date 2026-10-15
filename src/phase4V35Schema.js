/** Additive opt-in LIVE allocation. The frozen v26-v34 tables stay unchanged. */
import {buildV26} from './phase4V26Schema.js';
import {buildV27} from './phase4V27Schema.js';
import {buildV29} from './phase4V29Schema.js';
import {buildV30} from './phase4V30Schema.js';
import {buildV32} from './phase4V32Schema.js';
import {LIVE_TABLES} from './stage8LiveAllocation.js';
const mode="execution_mode TEXT NOT NULL CHECK(execution_mode='LIVE')";
const immutable=table=>`CREATE TRIGGER IF NOT EXISTS ${table}_mode_immutable BEFORE UPDATE OF execution_mode ON ${table}
 WHEN NEW.execution_mode IS NOT OLD.execution_mode BEGIN SELECT RAISE(ABORT,'phase4_execution_mode_immutable'); END`;
function allocate(sql){
 // Compile only frozen, code-owned DDL. Namespace every new index/trigger too.
 for(const [old,name] of Object.entries(LIVE_TABLES).sort((a,b)=>b[0].length-a[0].length))sql=sql.replaceAll(new RegExp(`\\b${old}\\b`,'g'),name);
 sql=sql.replace(/(CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) IF NOT EXISTS )(\w+)/,(_,prefix,name)=>prefix+(name.startsWith('stage8_live_')?name:'stage8_live_'+name));
 return sql.replaceAll("execution_mode='SHADOW'","execution_mode='LIVE'").replaceAll("execution_mode IN ('OFF','SHADOW')","execution_mode='LIVE'");
}
export function buildV35(){
 const parts=[buildV26(mode,immutable),buildV27(mode,immutable),buildV29(mode,immutable),buildV30(mode,immutable)];
 // Shared health_insights triggers already exist in v27; never replace them.
 const ddl=parts.flatMap(p=>[...p.ddl,...(p.indexes??[]),...(p.triggers??[])]).filter(s=>!s.includes('p4_health_insights_')).map(allocate);
 for(let sql of buildV32().ddl){
  if(sql.includes('p4_execution_initial_authority'))continue;
  sql=sql.replace("CHECK((phase='SYNC' AND sync_execution_id IS NULL) OR (phase='STAGE6_DRAIN' AND sync_execution_id IS NOT NULL))", "CHECK(phase='STAGE6_DRAIN' AND sync_execution_id IS NULL)");
  ddl.push(allocate(sql));
 }
 ddl.push(`CREATE TRIGGER IF NOT EXISTS stage8_live_execution_initial_authority BEFORE INSERT ON stage8_live_executions
 WHEN NEW.state<>'ESTABLISHED' OR NEW.generation<>1 OR NEW.observed_outcome<>'IN_PROGRESS' OR NEW.abort_outcome IS NOT NULL
 OR NEW.phase<>'STAGE6_DRAIN' OR NEW.sync_execution_id IS NOT NULL
 OR json_extract(NEW.canonical_request_json,'$.requestId') IS NOT NEW.execution_id
 OR json_extract(NEW.canonical_request_json,'$.phase') IS NOT NEW.phase
 OR json_extract(NEW.canonical_request_json,'$.releaseSha') IS NOT NEW.release_sha
 OR json_extract(NEW.canonical_request_json,'$.executionMode') IS NOT NEW.execution_mode
 OR json_extract(NEW.canonical_request_json,'$.triggerSource') IS NOT NEW.trigger_source
 OR json_extract(NEW.canonical_request_json,'$.configProof') IS NOT NEW.config_proof
 OR json_extract(NEW.canonical_request_json,'$.contract') IS NOT 'stage8-live-producer-v1'
 OR json_type(NEW.canonical_request_json,'$.tenantScope') IS NOT 'text'
 OR length(json_extract(NEW.canonical_request_json,'$.tenantScope'))<>64
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE key NOT IN
 ('requestId','phase','releaseSha','executionMode','triggerSource','configProof','contract','tenantScope'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) GROUP BY key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE type<>'text')
 BEGIN SELECT RAISE(ABORT,'stage8_live_execution_initial_authority'); END`);
 ddl.push(
 `CREATE TABLE IF NOT EXISTS stage8_live_job_completions (
  user_id TEXT NOT NULL, execution_mode TEXT NOT NULL CHECK(execution_mode='LIVE'),
  input_generation INTEGER NOT NULL CHECK(typeof(input_generation)='integer' AND input_generation>=1 AND input_generation<=9007199254740991 AND input_generation>0),
  job_kind TEXT NOT NULL CHECK(job_kind IN ('RECOMPUTE_DERIVED','REPAIR_CURRENTNESS')),
  scope_revision INTEGER NOT NULL CHECK(typeof(scope_revision)='integer' AND scope_revision>=0 AND scope_revision<=9007199254740991 AND scope_revision>=0),
  scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
  execution_id TEXT NOT NULL, producing_generation INTEGER NOT NULL CHECK(typeof(producing_generation)='integer' AND producing_generation>=1 AND producing_generation<=9007199254740991 AND producing_generation>0),
  receipt_key TEXT NOT NULL CHECK(length(receipt_key)=64 AND receipt_key NOT GLOB '*[^0-9a-f]*'), cursor_hash TEXT NOT NULL CHECK(length(cursor_hash)=64 AND cursor_hash NOT GLOB '*[^0-9a-f]*'),
  original_deadline_at INTEGER NOT NULL CHECK(typeof(original_deadline_at)='integer' AND original_deadline_at>=1 AND original_deadline_at<=9007199254740991 AND original_deadline_at>0),
  completed_at INTEGER NOT NULL CHECK(typeof(completed_at)='integer' AND completed_at>=1 AND completed_at<=9007199254740991 AND completed_at>0 AND completed_at<original_deadline_at),
  completion_hmac TEXT NOT NULL CHECK(length(completion_hmac)=64 AND completion_hmac NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(user_id,execution_mode,input_generation,job_kind,scope_revision),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(execution_id) REFERENCES stage8_live_executions(execution_id),
  FOREIGN KEY(receipt_key) REFERENCES stage8_live_execution_work_receipts(receipt_key) DEFERRABLE INITIALLY DEFERRED
 ) WITHOUT ROWID`,
 `CREATE TRIGGER IF NOT EXISTS stage8_live_completion_immutable_update BEFORE UPDATE ON stage8_live_job_completions
  BEGIN SELECT RAISE(ABORT,'stage8_live_completion_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS stage8_live_completion_immutable_delete BEFORE DELETE ON stage8_live_job_completions
  BEGIN SELECT RAISE(ABORT,'stage8_live_completion_immutable'); END`,
 `CREATE TABLE IF NOT EXISTS stage8_live_publications (
  user_id TEXT NOT NULL, execution_mode TEXT NOT NULL CHECK(execution_mode='LIVE'),
  input_generation INTEGER NOT NULL CHECK(typeof(input_generation)='integer' AND input_generation>=1 AND input_generation<=9007199254740991 AND input_generation>0),
  scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
  producer_hash TEXT NOT NULL CHECK(length(producer_hash)=64 AND producer_hash NOT GLOB '*[^0-9a-f]*'), artifact_hash TEXT NOT NULL CHECK(length(artifact_hash)=64 AND artifact_hash NOT GLOB '*[^0-9a-f]*'),
  proofs_json TEXT NOT NULL CHECK(json_valid(proofs_json) AND json_type(proofs_json)='array' AND json_array_length(proofs_json)=2 AND length(proofs_json)<=16384),
  issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at>=1 AND issued_at<=9007199254740991 AND issued_at>0), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>=1 AND expires_at<=9007199254740991 AND expires_at>issued_at AND expires_at-issued_at<=900000),
  publication_hmac TEXT NOT NULL CHECK(length(publication_hmac)=64 AND publication_hmac NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(user_id,execution_mode,input_generation), FOREIGN KEY(user_id) REFERENCES users(id)
 ) WITHOUT ROWID`,
 `CREATE TRIGGER IF NOT EXISTS stage8_live_publication_immutable_update BEFORE UPDATE ON stage8_live_publications
  BEGIN SELECT RAISE(ABORT,'stage8_live_publication_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS stage8_live_publication_immutable_delete BEFORE DELETE ON stage8_live_publications
  BEGIN SELECT RAISE(ABORT,'stage8_live_publication_immutable'); END`,
 );
 for(const [table,identity] of [
  ['stage8_live_job_completions',['user_id','execution_mode','input_generation','job_kind','scope_revision']],
  ['stage8_live_publications',['user_id','execution_mode','input_generation']],
 ])ddl.push(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
  WHEN EXISTS(SELECT 1 FROM ${table} p WHERE ${identity.map(k=>`p.${k}=NEW.${k}`).join(' AND ')})
  BEGIN SELECT RAISE(ABORT,'stage8_live_certificate_immutable'); END`);
 ddl.push(`CREATE TRIGGER IF NOT EXISTS stage8_live_publication_proof_shape BEFORE INSERT ON stage8_live_publications
  WHEN ${['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'].map((kind,index)=>`
   json_type(NEW.proofs_json,'$[${index}]') IS NOT 'object'
   OR json_extract(NEW.proofs_json,'$[${index}].jobKind') IS NOT '${kind}'
   OR (SELECT count(*) FROM json_each(json_extract(NEW.proofs_json,'$[${index}]')))<>3
   OR EXISTS(SELECT 1 FROM json_each(json_extract(NEW.proofs_json,'$[${index}]')) WHERE key NOT IN ('jobKind','receiptKey','completionHmac'))
   OR ${['receiptKey','completionHmac'].map(key=>`(json_type(NEW.proofs_json,'$[${index}].${key}') IS NOT 'text'
    OR length(json_extract(NEW.proofs_json,'$[${index}].${key}'))<>64
    OR json_extract(NEW.proofs_json,'$[${index}].${key}') GLOB '*[^0-9a-f]*')`).join(' OR ')}
  `).join(' OR ')}
  BEGIN SELECT RAISE(ABORT,'stage8_live_publication_proof_shape'); END`);
 return Object.freeze({version:35,ddl});
}
