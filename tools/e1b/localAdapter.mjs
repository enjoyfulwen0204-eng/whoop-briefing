import {DatabaseSync} from 'node:sqlite';
const fail=code=>{throw Object.assign(Error(code),{code});};
/** Job-local only. There is no URL/token option. Limited execute results keep
 * an accidentally unbounded diagnostic from materializing a full data table. */
export function localAdapter(path){
 const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');let depth=0;
 const execute=async input=>{
  const {sql,args=[]}=typeof input==='string'?{sql:input}:input,statement=db.prepare(sql),columns=statement.columns();
  if(columns.length){const rows=[];for(const row of statement.iterate(...args)){rows.push({...row});if(rows.length>8192)fail('REHEARSAL_QUERY_BOUND');}return {rows,rowsAffected:0};}
  const result=statement.run(...args);return {rows:[],rowsAffected:Number(result.changes),lastInsertRowid:result.lastInsertRowid};
 };
 const transaction=async run=>{const savepoint='rehearsal_'+depth++,root=depth===1;
  db.exec(root?'BEGIN IMMEDIATE':'SAVEPOINT '+savepoint);
  try{const result=await run();db.exec(root?'COMMIT':'RELEASE '+savepoint);return result;}
  catch(e){db.exec(root?'ROLLBACK':'ROLLBACK TO '+savepoint+'; RELEASE '+savepoint);throw e;}
  finally{depth--;}
 };
 const client={protocol:'file',execute,batch:(statements)=>transaction(async()=>{const results=[];for(const s of statements)results.push(await execute(s));return results;}),close:()=>db.close()};
 return {raw:client,transaction,iterate:(sql,args=[])=>db.prepare(sql).iterate(...args),
  getState:async key=>(await execute({sql:'SELECT value FROM telegram_state WHERE key=?',args:[key]})).rows[0]?.value??null,
  setState:async(key,value)=>execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',args:[key,value,new Date().toISOString()]})};
}
