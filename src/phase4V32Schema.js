/** Execution authority only. No tenant/health backfill or product activation. */
import {databaseNowMs} from './phase4ExecutionContext.js';
const hash=name=>`${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const integer=name=>`${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=0)`;
export function buildV32(){return Object.freeze({version:32,ddl:[
 `CREATE TABLE IF NOT EXISTS phase4_executions (
  execution_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(execution_seq>0 AND execution_seq<=9007199254740991),
  execution_id TEXT NOT NULL UNIQUE,
  ${hash('identity_digest')}, ${hash('scope_key')},
  canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
  phase TEXT NOT NULL CHECK(phase IN ('SYNC','STAGE6_DRAIN')),
  release_sha TEXT NOT NULL CHECK(length(release_sha)=40 AND release_sha NOT GLOB '*[^0-9a-f]*'),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('OFF','SHADOW')),
  trigger_source TEXT NOT NULL CHECK(trigger_source IN ('manual','github','cloudflare','event')),
  ${hash('config_proof')}, sync_execution_id TEXT NULL,
  owner TEXT NOT NULL, ${integer('generation')}, ${integer('lease_until')}, ${integer('deadline_at')},
  state TEXT NOT NULL CHECK(state IN ('ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED')),
  abort_outcome TEXT NULL CHECK(abort_outcome IS NULL OR abort_outcome IN ('CANCELLED','TIMEOUT','FAILED')),
  observed_outcome TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK(observed_outcome IN ('IN_PROGRESS','COMMIT_INDETERMINATE')),
  result_json TEXT NULL CHECK(result_json IS NULL OR json_valid(result_json)),
  result_digest TEXT NULL CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
  ${integer('created_at')}, ${integer('updated_at')}, work_committed_at INTEGER NULL, finalized_at INTEGER NULL,
  CHECK(generation>0 AND deadline_at<=lease_until),
  CHECK((state IN ('ESTABLISHED','ABORTED') AND result_json IS NULL AND result_digest IS NULL AND work_committed_at IS NULL AND finalized_at IS NULL)
   OR (state='WORK_COMMITTED' AND result_json IS NOT NULL AND result_digest IS NOT NULL AND work_committed_at IS NOT NULL AND finalized_at IS NULL)
   OR (state IN ('FINALIZED_SUCCESS','FINALIZED_FAILURE') AND result_json IS NOT NULL AND result_digest IS NOT NULL AND work_committed_at IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK((phase='SYNC' AND sync_execution_id IS NULL) OR (phase='STAGE6_DRAIN' AND sync_execution_id IS NOT NULL)),
  FOREIGN KEY(sync_execution_id) REFERENCES phase4_executions(execution_id)
 )`,
 `CREATE TABLE IF NOT EXISTS phase4_execution_work_receipts (
  execution_id TEXT NOT NULL, ${hash('receipt_key')}, ${hash('scope_key')},
  ${hash('request_digest')}, ${hash('step_key')},
  ${integer('generation')}, ${integer('committed_at')},
  result_json TEXT NULL CHECK(result_json IS NULL OR (json_valid(result_json) AND
   (json_type(result_json) IN ('true','false','integer','real') OR
    (json_type(result_json)='text' AND length(json_extract(result_json,'$'))=64 AND json_extract(result_json,'$') NOT GLOB '*[^0-9a-f]*')))),
  PRIMARY KEY(receipt_key), UNIQUE(execution_id,step_key),
  FOREIGN KEY(execution_id) REFERENCES phase4_executions(execution_id)
 )`,
 `CREATE TABLE IF NOT EXISTS phase4_execution_producers (
  user_id TEXT NOT NULL, execution_mode TEXT NOT NULL CHECK(execution_mode='SHADOW'),
  ${integer('input_generation')}, producing_execution_id TEXT NOT NULL,
  ${integer('producing_generation')}, ${integer('execution_seq')},
  ${hash('tenant_proof')},
  PRIMARY KEY(user_id,execution_mode,input_generation,producing_execution_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(producing_execution_id) REFERENCES phase4_executions(execution_id)
 )`,
 `CREATE INDEX IF NOT EXISTS idx_p4_execution_progress ON phase4_executions(phase,trigger_source,execution_seq)`,
 `CREATE INDEX IF NOT EXISTS idx_p4_execution_unfinalized ON phase4_executions(state,lease_until) WHERE finalized_at IS NULL`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_initial_authority BEFORE INSERT ON phase4_executions
  WHEN NEW.state<>'ESTABLISHED' OR NEW.generation<>1 OR NEW.observed_outcome<>'IN_PROGRESS' OR NEW.abort_outcome IS NOT NULL
   OR json_extract(NEW.canonical_request_json,'$.requestId') IS NOT NEW.execution_id
   OR json_extract(NEW.canonical_request_json,'$.phase') IS NOT NEW.phase
   OR json_extract(NEW.canonical_request_json,'$.releaseSha') IS NOT NEW.release_sha
   OR json_extract(NEW.canonical_request_json,'$.executionMode') IS NOT NEW.execution_mode
   OR json_extract(NEW.canonical_request_json,'$.triggerSource') IS NOT NEW.trigger_source
   OR json_extract(NEW.canonical_request_json,'$.configProof') IS NOT NEW.config_proof
   OR json_extract(NEW.canonical_request_json,'$.syncRequestId') IS NOT NEW.sync_execution_id
   OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE key NOT IN
    ('requestId','phase','releaseSha','executionMode','triggerSource','configProof','syncRequestId','handoff','legacyBodyDigest'))
   OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) GROUP BY key HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE type<>'text')
   OR (NEW.phase='SYNC' AND json_extract(NEW.canonical_request_json,'$.handoff') IS NOT NULL)
   OR (NEW.phase='STAGE6_DRAIN' AND (json_extract(NEW.canonical_request_json,'$.handoff') IS NULL
    OR length(json_extract(NEW.canonical_request_json,'$.handoff'))<>64
    OR json_extract(NEW.canonical_request_json,'$.handoff') GLOB '*[^0-9a-f]*'))
   OR (json_extract(NEW.canonical_request_json,'$.legacyBodyDigest') IS NOT NULL AND
    (length(json_extract(NEW.canonical_request_json,'$.legacyBodyDigest'))<>64
     OR json_extract(NEW.canonical_request_json,'$.legacyBodyDigest') GLOB '*[^0-9a-f]*'))
  BEGIN SELECT RAISE(ABORT,'p4_execution_initial_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_no_replace BEFORE INSERT ON phase4_executions
  WHEN EXISTS(SELECT 1 FROM phase4_executions WHERE execution_id=NEW.execution_id OR execution_seq=NEW.execution_seq)
  BEGIN SELECT RAISE(ABORT,'p4_execution_no_replace'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_no_delete BEFORE DELETE ON phase4_executions
  BEGIN SELECT RAISE(ABORT,'p4_execution_no_delete'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_sequence_monotonic BEFORE INSERT ON phase4_executions
  WHEN NEW.execution_seq<>-1 AND NEW.execution_seq<=COALESCE((SELECT MAX(execution_seq) FROM phase4_executions),0)
  BEGIN SELECT RAISE(ABORT,'p4_execution_sequence_monotonic'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_identity_immutable BEFORE UPDATE ON phase4_executions
  WHEN NEW.execution_seq IS NOT OLD.execution_seq OR NEW.execution_id IS NOT OLD.execution_id OR NEW.identity_digest IS NOT OLD.identity_digest
   OR NEW.canonical_request_json IS NOT OLD.canonical_request_json
   OR NEW.scope_key IS NOT OLD.scope_key OR NEW.phase IS NOT OLD.phase OR NEW.release_sha IS NOT OLD.release_sha
   OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.trigger_source IS NOT OLD.trigger_source
   OR NEW.config_proof IS NOT OLD.config_proof OR NEW.sync_execution_id IS NOT OLD.sync_execution_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT,'p4_execution_identity_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_transition BEFORE UPDATE ON phase4_executions
  WHEN NOT ((OLD.state='ESTABLISHED' AND NEW.state IN ('ESTABLISHED','WORK_COMMITTED','ABORTED'))
   OR (OLD.state='WORK_COMMITTED' AND NEW.state IN ('WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE')))
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
   OR (NEW.owner IS NOT OLD.owner AND NEW.generation<>OLD.generation+1)
   OR (NEW.generation=OLD.generation+1 AND (NEW.owner IS OLD.owner OR NEW.state NOT IN ('ESTABLISHED','WORK_COMMITTED')))
   OR (NEW.generation=OLD.generation+1 AND OLD.state='ESTABLISHED' AND OLD.lease_until>${databaseNowMs})
   OR ((NEW.lease_until>OLD.lease_until OR NEW.deadline_at>OLD.deadline_at) AND NEW.generation<>OLD.generation+1)
   OR (NEW.state='ABORTED' AND EXISTS(SELECT 1 FROM phase4_execution_work_receipts WHERE execution_id=OLD.execution_id))
   OR (OLD.state='ESTABLISHED' AND NEW.state='WORK_COMMITTED' AND
    (OLD.lease_until<=${databaseNowMs} OR OLD.deadline_at<=${databaseNowMs}
     OR NEW.owner IS NOT OLD.owner OR NEW.generation<>OLD.generation
     OR NEW.lease_until<>OLD.lease_until OR NEW.deadline_at<>OLD.deadline_at))
   OR (OLD.result_digest IS NOT NULL AND (NEW.result_digest IS NOT OLD.result_digest OR NEW.result_json IS NOT OLD.result_json OR NEW.work_committed_at IS NOT OLD.work_committed_at))
  BEGIN SELECT RAISE(ABORT,'p4_execution_transition'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_result_authority BEFORE UPDATE ON phase4_executions
  WHEN NEW.result_json IS NOT NULL AND
   (json_extract(NEW.result_json,'$.identity') IS NOT NEW.identity_digest
    OR json_extract(NEW.result_json,'$.releaseSha') IS NOT NEW.release_sha
    OR json_extract(NEW.result_json,'$.phase') IS NOT NEW.phase
    OR json_extract(NEW.result_json,'$.source') IS NOT NEW.trigger_source
    OR json_extract(NEW.result_json,'$.executionMode') IS NOT NEW.execution_mode
    OR json_extract(NEW.result_json,'$.configProof') IS NOT NEW.config_proof)
  BEGIN SELECT RAISE(ABORT,'p4_execution_result_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_finalize_authority BEFORE UPDATE ON phase4_executions
  WHEN NEW.state IN ('FINALIZED_SUCCESS','FINALIZED_FAILURE') AND
   (OLD.state<>'WORK_COMMITTED' OR NEW.owner IS NOT OLD.owner OR NEW.generation<>OLD.generation
    OR NEW.finalized_at IS NULL OR NEW.finalized_at>=OLD.deadline_at OR NEW.finalized_at>=OLD.lease_until
    OR OLD.deadline_at<=${databaseNowMs} OR OLD.lease_until<=${databaseNowMs})
  BEGIN SELECT RAISE(ABORT,'p4_execution_finalize_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_immutable BEFORE UPDATE ON phase4_execution_work_receipts
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_no_delete BEFORE DELETE ON phase4_execution_work_receipts
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_no_delete'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_no_replace BEFORE INSERT ON phase4_execution_work_receipts
  WHEN EXISTS(SELECT 1 FROM phase4_execution_work_receipts WHERE receipt_key=NEW.receipt_key OR (execution_id=NEW.execution_id AND step_key=NEW.step_key))
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_no_replace'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_owner BEFORE INSERT ON phase4_execution_work_receipts
  WHEN NOT EXISTS(SELECT 1 FROM phase4_executions e WHERE e.execution_id=NEW.execution_id
   AND e.generation=NEW.generation AND e.state='ESTABLISHED' AND e.scope_key=NEW.scope_key
   AND e.identity_digest=NEW.request_digest AND e.deadline_at>${databaseNowMs} AND e.lease_until>${databaseNowMs})
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_owner'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_producer_insert BEFORE INSERT ON phase4_execution_producers
  WHEN NOT EXISTS(SELECT 1 FROM phase4_executions e WHERE e.execution_id=NEW.producing_execution_id
   AND e.phase='STAGE6_DRAIN' AND e.state='ESTABLISHED' AND e.execution_mode=NEW.execution_mode
   AND e.generation=NEW.producing_generation AND e.execution_seq=NEW.execution_seq
   AND e.lease_until>${databaseNowMs} AND e.deadline_at>${databaseNowMs})
  BEGIN SELECT RAISE(ABORT,'p4_execution_producer_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_producer_no_regression BEFORE INSERT ON phase4_execution_producers
  WHEN EXISTS(SELECT 1 FROM phase4_execution_producers WHERE user_id=NEW.user_id AND execution_mode=NEW.execution_mode
   AND input_generation=NEW.input_generation AND execution_seq>NEW.execution_seq)
  BEGIN SELECT RAISE(ABORT,'p4_execution_producer_no_regression'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_producer_update BEFORE UPDATE ON phase4_execution_producers
  WHEN NEW.user_id IS NOT OLD.user_id OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.input_generation<>OLD.input_generation
   OR NEW.execution_seq<OLD.execution_seq
   OR NOT EXISTS(SELECT 1 FROM phase4_executions e WHERE e.execution_id=NEW.producing_execution_id
    AND e.phase='STAGE6_DRAIN' AND e.state='ESTABLISHED' AND e.execution_mode=NEW.execution_mode
    AND e.generation=NEW.producing_generation AND e.execution_seq=NEW.execution_seq
    AND e.lease_until>${databaseNowMs} AND e.deadline_at>${databaseNowMs})
  BEGIN SELECT RAISE(ABORT,'p4_execution_producer_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_producer_no_delete BEFORE DELETE ON phase4_execution_producers
  WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
  BEGIN SELECT RAISE(ABORT,'p4_execution_producer_no_delete'); END`,
 ]});}
