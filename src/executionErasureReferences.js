import {assertErasureTables} from './erasureCatalog.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
export const erasureIdentifier=name=>{if(!/^[a-z][a-z0-9_]*$/.test(name))fail('ERASURE_SCHEMA_UNCLASSIFIED');return '"'+name+'"';};
/** Exact string references also cover JSON and KV payloads. No row values
 * leave the database. These same predicates are rechecked in the write batch,
 * so a reference created after planning cannot become a dangling authority.
 * We deliberately retain false positives instead of guessing at ownership. */
export async function executionReferencePredicates(client,{execution,receiptKeys=[],subjectId=null,subjectKeys=[],includeExecution=subjectId===null}){
 const tables=(await client.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")).rows.map(r=>r.name);
 assertErasureTables(tables);const result=[];
 for(const table of tables){
  if(table==='sqlite_sequence')continue;
  const columns=(await client.execute('PRAGMA table_info('+erasureIdentifier(table)+')')).rows;
  const text=columns.filter(c=>/TEXT/i.test(c.type));if(!text.length)continue;
  const args=[],filters=[];
  if(table==='phase4_executions'){filters.push('execution_id<>?');args.push(execution.execution_id);}
  if(table==='phase4_execution_work_receipts'){filters.push('execution_id<>?');args.push(execution.execution_id);}
  if(subjectId&&columns.some(c=>c.name==='user_id')&&table!=='telegram_processed_updates'){
   filters.push('(user_id IS NULL OR user_id<>?)');args.push(subjectId);
  }
  if(subjectId&&table==='users'){filters.push('id<>?');args.push(subjectId);}
  if(table==='telegram_state'&&subjectKeys.length){filters.push('key NOT IN ('+subjectKeys.map(()=>'?').join(',')+')');args.push(...subjectKeys);}
  // A personal receipt does not require deleting its parent. Only explicit
  // receipt references matter in that mode; whole retirement checks both.
  const needles=[...(includeExecution?[execution.execution_id]:[]),...receiptKeys];
  if(!needles.length)continue;
  const contains=text.flatMap(c=>needles.map(value=>{args.push(value);return 'instr('+erasureIdentifier(c.name)+',?)>0';}));
  const where=[...filters,'('+contains.join(' OR ')+')'].join(' AND ');
  result.push({table,sql:'SELECT 1 FROM '+erasureIdentifier(table)+' WHERE '+where+' LIMIT 1',args});
 }
 return result;
}
export const noReferenceAssertion=predicate=>({sql:"SELECT CASE WHEN NOT EXISTS("+predicate.sql+") THEN 1 ELSE json('ERASURE_RETAINED_REFERENCE') END",args:predicate.args});
