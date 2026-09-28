// Stage 6 adds one operational fact. NULL on an unresolved legacy row means
// UNKNOWN_LEGACY; NULL on NONE/caught-up means no active cycle. No backfill can
// recover an erased timestamp, so this migration deliberately writes no rows.
export const unresolvedWork = prefix => `(${prefix}scope_kind <> 'NONE' OR ${prefix}completed_generation < ${prefix}requested_generation)`;
export function buildV28() {
  const definition = `TEXT NULL CHECK(unresolved_since IS NULL OR
    (typeof(unresolved_since)='text' AND length(unresolved_since)=24
      AND strftime('%Y-%m-%dT%H:%M:%fZ',unresolved_since) IS unresolved_since))`;
  return Object.freeze({version:28,ddl:[],columns:[{table:'phase4_jobs',column:'unresolved_since',definition}],
    indexes:[`CREATE INDEX IF NOT EXISTS p4_job_unresolved_age ON phase4_jobs(execution_mode,unresolved_since,user_id)
      WHERE scope_kind <> 'NONE' OR completed_generation < requested_generation`],
    triggers:[`CREATE TRIGGER IF NOT EXISTS p4_job_cycle_immutable BEFORE UPDATE ON phase4_jobs
      WHEN (${unresolvedWork('OLD.')} AND ${unresolvedWork('NEW.')} AND NEW.unresolved_since IS NOT OLD.unresolved_since)
        OR (NOT ${unresolvedWork('OLD.')} AND ${unresolvedWork('NEW.')} AND NEW.unresolved_since IS NULL)
        OR (NOT ${unresolvedWork('NEW.')} AND NEW.unresolved_since IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'phase4_unresolved_cycle_invalid'); END`]});
}
