import {randomBytes} from 'node:crypto';
import Database from 'libsql';
import {Sqlite3Client} from '@libsql/client/sqlite3';
import {ResultSetImpl} from '@libsql/core/util';
import {runMigrations} from '../src/migrations.js';
import {createPhase4Keys} from '../src/phase4Keys.js';

const queryPlans=new WeakMap(),CHUNK=64,MAX_METADATA_BYTES=8*1024*1024;
const fail=code=>{throw Object.assign(Error(code),{code});};
const serial=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?{int64:item.toString()}:item);
const catalogSql='SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY type,name';
const versionSql='SELECT MAX(version) AS v FROM schema_version';
const compact=sql=>sql.trim().replace(/\s+/g,' ');
const identifier='(?:"[a-zA-Z_][a-zA-Z0-9_]*"|\'[a-zA-Z_][a-zA-Z0-9_]*\'|[a-zA-Z_][a-zA-Z0-9_]*)';
const pragma=new RegExp('^PRAGMA (table_info|index_info|index_list|foreign_key_list)\\(\\s*'+identifier+'\\s*\\)$','i');
const inventory=new Set([
 "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
 "SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') AND name NOT IN ('schema_version','phase4_migration_checkpoints') ORDER BY name",
]);

/** A deliberately small read-only grammar. A query mentioning sqlite_master
 * is not sufficient: joins, expressions, comments, extra statements, arbitrary
 * predicates and all data/key/checkpoint/integrity/lease reads stay uncached. */
function metadataStatement(query,args){
 const sql=typeof query==='string'?query:query?.sql,values=typeof query==='string'?args??[]:query?.args??[];
 if(typeof sql!=='string'||!Array.isArray(values)||values.some(value=>typeof value!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)))return null;
 const normalized=compact(sql),p=pragma.exec(normalized);
 let columns;
 if(p)columns={table_info:['cid','name','type','notnull','dflt_value','pk'],index_info:['seqno','cid','name'],index_list:['seq','name','unique','origin','partial'],foreign_key_list:['id','seq','table','from','to','on_update','on_delete','match']}[p[1].toLowerCase()];
 else if(inventory.has(normalized))columns=['name'];
 else if(/^SELECT 1 FROM sqlite_master WHERE (?:type\s*=\s*'table' AND )?name\s*=\s*(?:\?|'[a-zA-Z_][a-zA-Z0-9_]*')(?: LIMIT 1)?$/i.test(normalized))columns=['1'];
 else if(/^SELECT type,\s*sql FROM sqlite_master WHERE name\s*=\s*\?$/i.test(normalized))columns=['type','sql'];
 else if(/^SELECT sql FROM sqlite_master WHERE (?:type\s*=\s*'table' AND )?name\s*=\s*(?:\?|'[a-zA-Z_][a-zA-Z0-9_]*')$/i.test(normalized))columns=['sql'];
 if(!columns||(normalized.match(/\?/g)?.length??0)!==values.length)return null;
 return {sql,args:[...values],columns,key:serial([sql,values])};
}
function cloneResult(result){
 const columns=[...result.columns],rows=result.rows.map(original=>{
  const row={};Object.defineProperty(row,'length',{value:columns.length});
  columns.forEach((column,index)=>{const value=original[column];Object.defineProperty(row,index,{value});if(!Object.hasOwn(row,column))Object.defineProperty(row,column,{value,enumerable:true,writable:true,configurable:true});});return row;
 });
 return new ResultSetImpl(columns,[...result.columnTypes],rows,result.rowsAffected,result.lastInsertRowid);
}
function validateResult(result,statement){
 if(!result||!Array.isArray(result.rows)||!Array.isArray(result.columns)||!Array.isArray(result.columnTypes)
  ||serial(result.columns)!==serial(statement.columns)||result.rows.length>4096||Number(result.rowsAffected)!==0
  ||result.rows.some(row=>statement.columns.some(column=>!Object.hasOwn(row,column)||row[column]!==null&&!['string','number','bigint'].includes(typeof row[column]))))fail('STAGE8_METADATA_BATCH_RESULT_INVALID');
 return cloneResult(result);
}
function localPlan(read){
 let pending=queryPlans.get(read);if(pending)return pending;
 pending=(async()=>{
  // Synthetic schema discovery only. Neither original application keys nor
  // credentials are used, and no synthetic result survives this function.
  const native=new Database(':memory:'),local=new Sqlite3Client(':memory:',{},native,'number'),keys=createPhase4Keys({lookupKey:randomBytes(32),auditKey:randomBytes(32)}),byVersion=new Map();
  try{
   for(const version of [33,34,35]){
    await runMigrations(local,{allowRebuild:false,targetVersion:version,privacyKeys:keys});
    const queries=new Map(),traced={protocol:'file',execute:query=>{const statement=metadataStatement(query);if(statement)queries.set(statement.key,Object.freeze({sql:statement.sql,args:Object.freeze(statement.args),columns:Object.freeze(statement.columns),key:statement.key}));return local.execute(query);}};
    await read(traced,keys);byVersion.set(version,Object.freeze([...queries.values()]));
   }
   return byVersion;
  }finally{local.close();}
 })();
 queryPlans.set(read,pending);pending.catch(()=>queryPlans.delete(read));return pending;
}
async function fence(client){
 const catalog=(await client.execute(catalogSql)).rows.map(row=>[row.type,row.name,row.tbl_name,row.rootpage,row.sql]),version=(await client.execute(versionSql)).rows[0]?.v;
 if(![33,34,35].includes(Number(version))||catalog.length>4096)fail('STAGE8_METADATA_SCHEMA_REQUIRED');
 const identity=serial([catalog,version]);if(Buffer.byteLength(identity)>MAX_METADATA_BYTES)fail('STAGE8_METADATA_BOUNDS');return {identity,version:Number(version)};
}

/** One readDatabaseControl invocation only. Every cached result comes from
 * this authenticated client's actual read-batch response. No driver target,
 * protocol, permit, expected schema result or provider proof is replaced. */
export async function withStage8MetadataReadCache(client,keys,read){
 if(typeof client.batch!=='function')return read(client,keys);
 const before=await fence(client),plan=(await localPlan(read)).get(before.version);if(!plan)fail('STAGE8_METADATA_SCHEMA_REQUIRED');
 const cache=new Map();let retainedBytes=0;
 for(let start=0;start<plan.length;start+=CHUNK){
  const chunk=plan.slice(start,start+CHUNK);let results;
  try{results=await client.batch(chunk.map(statement=>({sql:statement.sql,args:[...statement.args]})),'read');}catch{fail('STAGE8_METADATA_BATCH_FAILED');}
  if(!Array.isArray(results)||results.length!==chunk.length)fail('STAGE8_METADATA_BATCH_RESULT_INVALID');
  for(let index=0;index<chunk.length;index++){
   const observed=validateResult(results[index],chunk[index]);retainedBytes+=Buffer.byteLength(serial(observed));if(retainedBytes>MAX_METADATA_BYTES)fail('STAGE8_METADATA_BOUNDS');cache.set(chunk[index].key,observed);
  }
 }
 const observed={protocol:client.protocol,execute:async(query,args)=>{
  const statement=metadataStatement(query,args);
  if(!statement)return client.execute(query,args);
  if(cache.has(statement.key))return cloneResult(cache.get(statement.key));
  // Unseen branches must observe the real database too. Copy arguments before
  // awaiting transport; a caller cannot mutate a key or a cached prior result.
  const result=validateResult(await client.execute({sql:statement.sql,args:[...statement.args]}),statement);
  retainedBytes+=Buffer.byteLength(serial(result));if(retainedBytes>MAX_METADATA_BYTES)fail('STAGE8_METADATA_BOUNDS');cache.set(statement.key,result);return cloneResult(result);
 }};
 try{return await read(observed,keys);}
 finally{const after=await fence(client);if(after.identity!==before.identity)fail('STAGE8_METADATA_SCHEMA_CHANGED_DURING_READ');}
}
