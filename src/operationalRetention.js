import {requirePhase4Keys} from './phase4Keys.js';
import {assertErasureTables} from './erasureCatalog.js';
import {scanErasureExecutions,ownersForExecution} from './erasureExecutionScan.js';
import {classifyExecutionRetirement} from './executionRetirement.js';
import {executionReferencePredicates,noReferenceAssertion,erasureIdentifier} from './executionErasureReferences.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
/** Bounded cleanup, using only an injected already-admitted connection. A
 * protected user's execution is never partially retired by this operation.
 * Each safe unit is one atomic DROP/DELETE/exact-CREATE batch, not a migration.
 * No transport, provider, secret loading or application startup is imported. */
export function createOperationalRetention({db,keys,now=()=>new Date(),emit=console.log}){
 requirePhase4Keys(keys);
 async function run({budget,maxExecutions=100}={}){
  if(!budget||typeof budget.remainingMs!=='function'||typeof budget.assert!=='function')fail('RETENTION_BUDGET_REQUIRED');
  if(!Number.isInteger(maxExecutions)||maxExecutions<1||maxExecutions>100)fail('RETENTION_BATCH_BOUND_INVALID');
  const started=Date.now(),summary={retired:0,receipts:0,protected:0,deferred:0,blocked:0};
  const finish=()=>{emit(JSON.stringify({event:'operational_retention',...summary,duration_ms:Date.now()-started}));return summary;};
  if(budget.remainingMs()<10000){summary.deferred=1;return finish();}
  const users=(await db.raw.execute('SELECT id,lifecycle_generation FROM users LIMIT 101')).rows;
  if(users.length>100)fail('RETENTION_USER_BOUND');
  const cursorKey='e1b:retention:cursor',saved=(await db.raw.execute({sql:'SELECT value FROM telegram_state WHERE key=?',args:[cursorKey]})).rows[0];
  let position=0,scanned=0;
  if(saved){let value;try{value=JSON.parse(saved.value);}catch{fail('RETENTION_CURSOR_INVALID');}
   if(value.version!=='e1b-retention-v1'||!Number.isSafeInteger(value.sequence)||value.sequence<0)fail('RETENTION_CURSOR_INVALID');position=value.sequence;
  }
  for await(const {execution:e,receipts:owned,latestSequence,children} of scanErasureExecutions(db.raw,{afterSequence:position})){
   if(budget.remainingMs()<10000||scanned>=250||summary.retired>=maxExecutions){summary.deferred++;break;}
   position=e.execution_seq;scanned++;
   budget.assert();
   for(const r of owned)if(r.result_json!==null){let value;try{value=JSON.parse(r.result_json);}catch{fail('RETENTION_RESULT_UNCLASSIFIED');}
    if(!(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))fail('RETENTION_RESULT_UNCLASSIFIED');
   }
   const owners=ownersForExecution(keys,users,e,owned),decision=classifyExecutionRetirement(e,{now:now().getTime(),latestSequence,
    readPathsClosed:true,retainedReferences:children?['CHILD_EXECUTION']:[],existingUserReceiptCount:owners.size});
   if(decision.reasons.includes('EXISTING_USER_RECEIPT'))summary.protected++;
   if(!decision.retirable)continue;
   const id=e.execution_id;
   const predicates=await executionReferencePredicates(db.raw,{execution:e,receiptKeys:owned.map(r=>r.receipt_key)});
   let retained=false;for(const p of predicates){budget.assert();if((await db.raw.execute(p)).rows.length){retained=true;break;}}
   if(retained){summary.blocked++;continue;}
   const schema=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name")).rows;
   assertErasureTables(schema.filter(r=>r.type==='table').map(r=>r.name));
   const guards=schema.filter(r=>r.type==='trigger'&&['phase4_executions','phase4_execution_work_receipts','phase4_execution_producers'].includes(r.tbl_name)&&/BEFORE\s+DELETE/i.test(r.sql));
   const statements=[{sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM phase4_executions e WHERE execution_id=? AND state=? AND generation=? AND lease_until=? AND deadline_at=?
    AND execution_seq < (SELECT MAX(execution_seq) FROM phase4_executions WHERE phase=e.phase AND trigger_source=e.trigger_source))
    AND (SELECT COUNT(*) FROM phase4_execution_work_receipts WHERE execution_id=?)=?
    THEN 1 ELSE json('RETENTION_SNAPSHOT_CHANGED') END`,args:[id,e.state,e.generation,e.lease_until,e.deadline_at,id,owned.length]},
    ...predicates.map(noReferenceAssertion),...guards.map(g=>({sql:'DROP TRIGGER '+erasureIdentifier(g.name),args:[]})),
    {sql:'DELETE FROM phase4_execution_producers WHERE producing_execution_id=?',args:[id]},
    {sql:'DELETE FROM phase4_execution_work_receipts WHERE execution_id=?',args:[id]},
    {sql:'DELETE FROM phase4_executions WHERE execution_id=?',args:[id]},...guards.map(g=>({sql:g.sql,args:[]}))];
   budget.assert();await db.raw.batch(statements,'write');
   const after=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name")).rows;
   if(JSON.stringify(after)!==JSON.stringify(schema))fail('ERASURE_SCHEMA_CHANGED');
   if((await db.raw.execute('PRAGMA foreign_key_check')).rows.length)fail('ERASURE_FOREIGN_KEY_FAILED');
   summary.retired++;summary.receipts+=owned.length;
  }
  budget.assert();
  if(summary.deferred)await db.raw.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',args:[cursorKey,JSON.stringify({version:'e1b-retention-v1',sequence:position}),now().toISOString()]});
  else await db.raw.execute({sql:'DELETE FROM telegram_state WHERE key=?',args:[cursorKey]});
  return finish();
 }
 return Object.freeze({run});
}
