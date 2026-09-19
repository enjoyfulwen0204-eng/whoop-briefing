/** Post-v20 DDL, re-exported by schema.js. No runtime activation or providers. */
import { buildV22 } from './phase4V22Schema.js';
export const MODE_COLUMN = `execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
  CHECK (execution_mode IN ('SHADOW','LIVE'))`;

export const modeImmutableTrigger = (table) => `CREATE TRIGGER IF NOT EXISTS ${table}_mode_immutable
  BEFORE UPDATE OF execution_mode ON ${table}
  WHEN NEW.execution_mode IS NOT OLD.execution_mode
  BEGIN SELECT RAISE(ABORT, 'phase4_execution_mode_immutable'); END`;

const counter = (name) => `${name} INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;
const timeOfDay = (name, nullable = false) => `CHECK (${nullable ? `${name} IS NULL OR ` : ''}
  (length(${name}) = 5 AND ${name} GLOB '[0-2][0-9]:[0-5][0-9]'
   AND substr(${name},1,2) <= '23'))`;

export const V21_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS phase4_user_state (
    user_id TEXT NOT NULL PRIMARY KEY,
    ${counter('source_generation')}, ${counter('purge_generation')},
    ${counter('pending_purge_count')},
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS phase4_computation_state (
    user_id TEXT NOT NULL, ${MODE_COLUMN},
    ${counter('input_generation')}, ${counter('last_completed_generation')},
    ${counter('source_generation_seen')},
    algorithm_set_version TEXT NOT NULL, ${counter('revision')},
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, execution_mode),
    CHECK (last_completed_generation <= input_generation)
  )`,
  `CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id TEXT NOT NULL PRIMARY KEY,
    notifications_paused INTEGER NOT NULL DEFAULT 0 CHECK (notifications_paused IN (0,1)),
    morning_brief_mode TEXT NOT NULL DEFAULT 'AFTER_WAKE'
      CHECK (morning_brief_mode IN ('AFTER_WAKE','FIXED_LOCAL_TIME')),
    morning_brief_local_time TEXT NULL ${timeOfDay('morning_brief_local_time', true)},
    after_wake_delay_minutes INTEGER NOT NULL DEFAULT 30
      CHECK (typeof(after_wake_delay_minutes) = 'integer' AND after_wake_delay_minutes >= 0),
    fallback_local_time TEXT NOT NULL DEFAULT '10:00' ${timeOfDay('fallback_local_time')},
    ${counter('preference_version')}, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK (morning_brief_mode <> 'FIXED_LOCAL_TIME' OR morning_brief_local_time IS NOT NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS phase4_migration_checkpoints (
    target_version INTEGER NOT NULL CHECK (target_version >= 21),
    step_key TEXT NOT NULL, last_cursor TEXT NULL,
    postcondition_state TEXT NOT NULL CHECK (postcondition_state IN ('PENDING','COMPLETE')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_version, step_key)
  )`,
  modeImmutableTrigger('phase4_computation_state'),
]);

export const PHASE4_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 21, ddl: V21_SCHEMA }),
  buildV22(MODE_COLUMN, modeImmutableTrigger),
]);
