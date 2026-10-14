// Transport optimization only, inside one original locked write transaction.
// Never memoize clocks, leases, source epochs, receipts or health data.
import {currentDurableExecution,requireSettledOperation} from './phase4ExecutionContext.js';
import {currentExecutionBudget} from './executionBudget.js';
import {currentSyncOwnership} from './syncOwnership.js';
import {cloneResult} from './processingReadSnapshot.js';
import {workStepOptions} from './phase4WorkStep.js';
const issued=new WeakMap(),last=new WeakMap(),normalize=sql=>sql.replace(/\s+/g,' ').trim();
const observations=[
 `SELECT u.id,u.status,u.lifecycle_generation,
 COALESCE(t.auth_generation,0) auth_generation,p.user_id initialized_user_id,
 p.purge_generation,p.pending_purge_count,c.user_id initialized_computation_user_id
 FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
 LEFT JOIN phase4_user_state p ON p.user_id=u.id
 LEFT JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW'
 WHERE u.id=?`,
 `SELECT p.purge_generation,p.pending_purge_count,u.status,u.lifecycle_generation,
 COALESCE(t.auth_generation,0) auth_generation FROM phase4_user_state p JOIN users u ON u.id=p.user_id
 LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE p.user_id=?`,
 `SELECT u.id,u.status,u.lifecycle_generation,u.timezone,
 COALESCE(t.auth_generation,0) auth_generation,t.whoop_user_id,p.user_id state_user_id,p.purge_generation,p.pending_purge_count
 FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
 LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,
 'SELECT status, lifecycle_generation FROM users WHERE id = ?',
 'SELECT pending_purge_count FROM phase4_user_state WHERE user_id=?',
 ...['analytics_invalidation','whoop_sync_state','phase4_jobs'].map(table=>`PRAGMA table_info(${table})`),
 'SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?',
 'SELECT 1 FROM users WHERE id=?',
];
const sourceUpdate=normalize('UPDATE phase4_user_state SET source_generation=source_generation+1,updated_at=? WHERE user_id=?');
const computationUpdate=normalize('UPDATE phase4_computation_state SET input_generation=input_generation+1, source_generation_seen=?,revision=revision+1,updated_at=? WHERE user_id=?');
const businessTables=new Set(['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts','whoop_body_measurements',
 'whoop_sync_state','analytics_invalidation','analytics_work_state','phase4_source_links','phase4_invalidations','phase4_jobs','phase4_family_work_tips','phase4_execution_work_receipts']);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
export function syncCommitSnapshotOptions(db,userId,workStep,facts){
 const ownership=currentSyncOwnership(),execution=currentDurableExecution(),budget=currentExecutionBudget();
 if(!db.privateRuntime||ownership?.db!==db||ownership.userId!==userId||ownership.budget!==budget
   ||execution?.claim?.request?.phase!=='SYNC'||execution.receipts===false||typeof workStep!=='string')return {};
 if(!Array.isArray(facts)||facts[0]!==userId||!['sleep','recovery','cycle','workout','body_measurement'].includes(facts[1])
   ||workStepOptions('whoop.window',facts).workStep!==workStep)throw Error('SYNC_COMMIT_WINDOW_IDENTITY_REQUIRED');
 requireSettledOperation();budget.assert();execution.authority.assert();
 const token=Object.freeze({});issued.set(token,{client:db.raw,userId,workStep,ownership,execution,budget});return {syncCommitSnapshot:token};
}
export function consumeSyncCommitSnapshot(token,client,workStep){
 if(token===undefined)return null;
 const binding=issued.get(token);issued.delete(token);
 if(!binding||binding.client!==client||binding.workStep!==workStep||binding.execution!==currentDurableExecution()
   ||binding.budget!==currentExecutionBudget()||binding.ownership!==currentSyncOwnership())throw Error('SYNC_COMMIT_SNAPSHOT_SCOPE_REQUIRED');
 requireSettledOperation();binding.budget.assert();binding.execution.authority.assert();return binding;
}
export function createSyncCommitSnapshot(binding){
 if(!binding)return null;
 let results=null,guard=null,reuse=false;
 const stats={hits:0,guardedWrites:0,phases:{}};
 const statements=observations.map((sql,i)=>({sql,args:sql.startsWith('PRAGMA')?[]:[i===8?'phase4_family_work_tips':binding.userId]}));
 const key=statement=>{const sql=typeof statement==='string'?statement:statement?.sql,args=typeof statement==='string'?[]:statement?.args;
  if(typeof sql!=='string'||!Array.isArray(args))return -1;
  return statements.findIndex(s=>normalize(s.sql)===normalize(sql)&&s.args.length===args.length&&s.args.every((value,i)=>Object.is(value,args[i])));
 };
 return {
  statements,
  load(values){
   const row=values[0]?.rows[0];
   // Initialization keeps its original independent path; never freeze absence.
   if(!row||row.initialized_user_id!==binding.userId||row.initialized_computation_user_id!==binding.userId||row.status!=='ACTIVE'||row.pending_purge_count!==0)return;
   results=values.map(cloneResult);reuse=true;
   // Recheck the immutable authority projection AFTER EVERY business write,
   // in the same HTTP batch. Trigger-side authority changes also reject and
   // poison the original transaction before any cached check can return.
   const projections=statements.slice(0,5).map((s,i)=>({
    sql:`(SELECT json_group_array(json_array(${values[i].columns.map(quote).join(',')})) FROM (${s.sql})) IS ?`,
    args:[...s.args,JSON.stringify(values[i].rows.map(r=>values[i].columns.map(c=>r[c])))],
   }));
   guard={sql:`SELECT json(CASE WHEN (${projections.map(p=>p.sql).join(' AND ')}) THEN 'true' ELSE 'SYNC_IMMUTABLE_AUTHORITY_CHANGED' END) verified`,args:projections.flatMap(p=>p.args)};
  },
  get(statement){const i=reuse?key(statement):-1;if(i<0||!results)return;stats.hits++;return cloneResult(results[i]);},
  getBatch(statements){if(!reuse||!results||!statements.length)return;const indices=statements.map(key);if(indices.some(i=>i<0))return;stats.hits+=indices.length;return indices.map(i=>cloneResult(results[i]));},
  guard(statements){if(!reuse||!guard)return null;
   // DDL / transaction controls are never eligible for immutable reuse.
   if(statements.some(s=>{const sql=typeof s==='string'?s:s?.sql??'',normalized=normalize(sql),args=typeof s==='string'?[]:s.args;
    if(normalized===sourceUpdate)return args?.[1]!==binding.userId;
    if(normalized===computationUpdate)return args?.[2]!==binding.userId;
    const table=/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_][a-z0-9_]*)/i.exec(sql)?.[1];
    return !businessTables.has(table);
   })){this.clear();return null;}
   stats.guardedWrites++;return guard;
  },
  clear(){reuse=false;results=null;guard=null;},
  note(phase,ms){stats.phases[phase]=ms;},
  finish(outcome){last.set(binding.client,Object.freeze({...stats,phases:Object.freeze({...stats.phases}),outcome}));this.clear();},
 };
}
export const syncCommitSnapshotStatus=db=>last.get(db.raw)??null;
