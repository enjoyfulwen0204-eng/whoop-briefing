import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
// This scope can exempt only the exact five read-only admission statements.
// Importing the helper cannot exempt a privileged tenant read or mutation.
const queries=new Set([
 "SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger')",
 'SELECT version,note FROM schema_version',
 'SELECT target_version,step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version IN (21,22,23,32)',
 'PRAGMA foreign_keys','SELECT ignore_check_constraints FROM pragma_ignore_check_constraints',
].map(sql=>sql.replace(/\s+/g,' ').trim()));
export const inRuntimeMetadata=sql=>scope.getStore()===true&&typeof sql==='string'&&queries.has(sql.replace(/\s+/g,' ').trim());
export const withRuntimeMetadata=fn=>scope.run(true,fn);
