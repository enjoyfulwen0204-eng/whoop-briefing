/** Execution authority only. No tenant/health backfill or product activation. */
import {databaseNowMs} from './phase4ExecutionContext.js';
const hash=name=>`${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const integer=name=>`${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=0)`;
export function buildV32(){return Object.freeze({version:32,ddl:[
 `CREATE TABLE IF NOT EXISTS phase4_executions (
  execution_id TEXT NOT NULL PRIMARY KEY,
  ${hash('identity_digest')}, ${hash('scope_key')},
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
  ${integer('generation')}, ${integer('committed_at')},
  PRIMARY KEY(execution_id,receipt_key),
  FOREIGN KEY(execution_id) REFERENCES phase4_executions(execution_id)
 )`,
 `CREATE INDEX IF NOT EXISTS idx_p4_execution_progress ON phase4_executions(phase,trigger_source,created_at,updated_at)`,
 `CREATE INDEX IF NOT EXISTS idx_p4_execution_unfinalized ON phase4_executions(state,lease_until) WHERE finalized_at IS NULL`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_initial_authority BEFORE INSERT ON phase4_executions
  WHEN NEW.state<>'ESTABLISHED' OR NEW.generation<>1 OR NEW.observed_outcome<>'IN_PROGRESS' OR NEW.abort_outcome IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'p4_execution_initial_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_identity_immutable BEFORE UPDATE ON phase4_executions
  WHEN NEW.execution_id IS NOT OLD.execution_id OR NEW.identity_digest IS NOT OLD.identity_digest
   OR NEW.scope_key IS NOT OLD.scope_key OR NEW.phase IS NOT OLD.phase OR NEW.release_sha IS NOT OLD.release_sha
   OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.trigger_source IS NOT OLD.trigger_source
   OR NEW.config_proof IS NOT OLD.config_proof OR NEW.sync_execution_id IS NOT OLD.sync_execution_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT,'p4_execution_identity_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_transition BEFORE UPDATE ON phase4_executions
  WHEN NOT ((OLD.state IN ('ESTABLISHED','ABORTED') AND NEW.state IN ('ESTABLISHED','WORK_COMMITTED','ABORTED'))
   OR (OLD.state='WORK_COMMITTED' AND NEW.state IN ('WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE')))
   OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
   OR (NEW.owner IS NOT OLD.owner AND NEW.generation<>OLD.generation+1)
   OR (NEW.generation=OLD.generation+1 AND (NEW.owner IS OLD.owner OR NEW.state NOT IN ('ESTABLISHED','WORK_COMMITTED')))
   OR (OLD.result_digest IS NOT NULL AND (NEW.result_digest IS NOT OLD.result_digest OR NEW.result_json IS NOT OLD.result_json OR NEW.work_committed_at IS NOT OLD.work_committed_at))
  BEGIN SELECT RAISE(ABORT,'p4_execution_transition'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_finalize_authority BEFORE UPDATE ON phase4_executions
  WHEN NEW.state IN ('FINALIZED_SUCCESS','FINALIZED_FAILURE') AND
   (OLD.state<>'WORK_COMMITTED' OR NEW.owner IS NOT OLD.owner OR NEW.generation<>OLD.generation
    OR NEW.finalized_at IS NULL OR NEW.finalized_at>=OLD.deadline_at OR NEW.finalized_at>=OLD.lease_until
    OR OLD.deadline_at<=${databaseNowMs} OR OLD.lease_until<=${databaseNowMs})
  BEGIN SELECT RAISE(ABORT,'p4_execution_finalize_authority'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_immutable BEFORE UPDATE ON phase4_execution_work_receipts
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_owner BEFORE INSERT ON phase4_execution_work_receipts
  WHEN NOT EXISTS(SELECT 1 FROM phase4_executions e WHERE e.execution_id=NEW.execution_id
   AND e.generation=NEW.generation AND e.state='ESTABLISHED' AND e.scope_key=NEW.scope_key)
  BEGIN SELECT RAISE(ABORT,'p4_execution_receipt_owner'); END`,
 ]});}
