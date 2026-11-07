import {DatabaseSync} from 'node:sqlite';
import {openJsonCursorClient} from './jsonCursor.mjs';
import {ERASURE_TABLES,assertErasureTables} from '../../src/erasureCatalog.js';
import {fail} from './rehearsalDiagnostics.mjs';
export const identifier=s=>{if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(s))fail('SNAPSHOT_IDENTIFIER_INVALID');return '"'+s+'"';};
// This allowlist is for our generated statements, not a general SQL firewall.
// No comments, semicolons, functions with side effects, or caller SQL enters it.
export function assertSelect(sql){
 if(typeof sql!=='string'||!/^SELECT\s/.test(sql)||/;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE|load_extension)\b/i.test(sql))fail('SNAPSHOT_SELECT_ONLY');
 return sql;
}
export function snapshotSql(tables,columns){
 assertErasureTables(tables.map(t=>t.name));
 const sql=["SELECT 'schema' kind,'' table_name,json_array(type,name,tbl_name,sql) payload FROM sqlite_schema WHERE type IN ('table','index','trigger')"];
 for(const {name} of tables){
  const cols=columns.get(name);if(!cols?.length)fail('SNAPSHOT_COLUMNS_MISSING');
  sql.push(`SELECT 'count','${name}',json_array(COUNT(*)) FROM ${identifier(name)}`);
  const values=cols.map(c=>{const id=identifier(c.name);return `json_array(typeof(${id}),CASE typeof(${id}) WHEN 'integer' THEN CAST(${id} AS TEXT) WHEN 'blob' THEN hex(${id}) ELSE ${id} END)`;});
  sql.push(`SELECT 'row','${name}',json_array(${values.join(',')}) FROM ${identifier(name)}`);
 }
 return assertSelect(sql.join(' UNION ALL '));
}
const decode=([type,value])=>type==='integer'?BigInt(value):type==='blob'?Buffer.from(value,'hex'):value;

/** One compound SELECT gives counts, schema and every row one read snapshot.
 * Hrana v3 cursor streams one row at a time; execute/query is used only for
 * bounded schema metadata. Nothing here imports application startup. */
export async function exportSelectSnapshot({url,token,path,fetchImpl=globalThis.fetch,onProgress=()=>{},onReadStart=()=>{},openClient=openJsonCursorClient}){
 const endpoint=new URL(url.replace(/^libsql:/,'https:'));if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)fail('SNAPSHOT_URL_INVALID');
 let closed=false;
 const guardedFetch=async request=>{
  const destination=new URL(request.url);
  if(closed||destination.origin!==endpoint.origin||destination.username||destination.password)fail('SNAPSHOT_NETWORK_DENIED');
  return fetchImpl(request,{redirect:'error',signal:AbortSignal.timeout(300000)});
 };
 const remote=await openClient(endpoint,token,guardedFetch),stream=remote.openStream();let cursor,local;
 try{
  if(await remote.getVersion()!==3)fail('SNAPSHOT_CURSOR_UNAVAILABLE');
  onReadStart();
  const metadata=async sql=>(await stream.query(assertSelect(sql))).rows;
  const tables=await metadata("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 101");
  assertErasureTables(tables.map(t=>t.name));const columns=new Map();
  for(const t of tables)columns.set(t.name,await metadata(`SELECT name,type,pk FROM pragma_table_info('${t.name}') ORDER BY cid LIMIT 128`));
  const sql=snapshotSql(tables,columns);
  // The tool-local pinned Hrana client exposes the incremental cursor here.
  // Public query()/batch().query() collect all rows, so must not be used.
  cursor=await stream._openCursor({steps:[{stmt:{sql,args:[],namedArgs:[],wantRows:true}}]});
  local=new DatabaseSync(path);local.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; BEGIN');
  for(const t of tables)if(t.name!=='sqlite_sequence')local.exec(t.sql);
  const inserts=new Map(tables.map(t=>[t.name,local.prepare(`INSERT INTO ${identifier(t.name)} (${columns.get(t.name).map(c=>identifier(c.name)).join(',')}) VALUES (${columns.get(t.name).map(()=>'?').join(',')})`)]));
  const schema=[],counts=new Map(),actual=new Map(),sequences=[];let rows=0,finished=false;
  for(;;){const entry=await cursor.next();if(!entry)break;
   if(entry.type==='error'||entry.type==='step_error')fail('SNAPSHOT_REMOTE_SELECT_FAILED');
   if(entry.type==='step_end'){if(entry.affectedRowCount!==0)fail('SNAPSHOT_UNEXPECTED_WRITE');finished=true;}
   if(entry.type!=='row')continue;
   const [kind,table,payload]=entry.row,value=JSON.parse(payload);
   if(kind==='schema')schema.push({type:value[0],name:value[1],tbl_name:value[2],sql:value[3]});
   else if(kind==='count')counts.set(table,value[0]);
   else if(kind==='row'){
    if(!ERASURE_TABLES[table])fail('SNAPSHOT_UNKNOWN_TABLE');
    if(table==='sqlite_sequence')sequences.push(value.map(decode));else inserts.get(table).run(...value.map(decode));
    actual.set(table,(actual.get(table)??0)+1);rows++;
    if(rows%1000===0){if(process.memoryUsage().rss>768*1024*1024)fail('SNAPSHOT_MEMORY_BOUND');onProgress(rows);}
   }else fail('SNAPSHOT_ROW_INVALID');
  }
  if(!finished)fail('SNAPSHOT_INCOMPLETE');
  for(const t of tables)if(counts.get(t.name)!==(actual.get(t.name)??0))fail('SNAPSHOT_COUNT_MISMATCH');
  local.exec('DELETE FROM sqlite_sequence');for(const row of sequences)inserts.get('sqlite_sequence').run(...row);
  for(const s of schema)if(s.type!=='table'&&s.sql)local.exec(s.sql);
  local.exec('COMMIT; PRAGMA foreign_keys=ON');
  const saved=local.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all();
  const canonical=xs=>JSON.stringify([...xs].sort((a,b)=>(a.type+'\0'+a.name).localeCompare(b.type+'\0'+b.name)));
  if(canonical(schema)!==canonical(saved))fail('SNAPSHOT_SCHEMA_CHANGED');
  if(local.prepare('SELECT MAX(version) v FROM schema_version').get().v!==33)fail('SNAPSHOT_V33_REQUIRED');
  if(local.prepare('PRAGMA integrity_check').all().some(r=>Object.values(r)[0]!=='ok')||local.prepare('PRAGMA foreign_key_check').all().length)fail('SNAPSHOT_INTEGRITY_FAILED');
  return {tables:tables.length,rows};
 }finally{cursor?.close();stream.close();remote.close();closed=true;local?.close();token=null;}
}
