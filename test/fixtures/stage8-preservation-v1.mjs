// Frozen original 128-row, serial-table algorithm from the reviewed v1 operator
// (5c1a797cfb119fe8b4cd334eea5b9b7bfb34603a). Independent parity oracle only.
const fail=code=>{throw Object.assign(Error(code),{code});};
const identifier=name=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))fail('STAGE8_UNSAFE_SCHEMA_IDENTIFIER');return '"'+name+'"';};
const serial=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{int64:v.toString()}:v instanceof ArrayBuffer?{blob:Buffer.from(v).toString('base64')}:ArrayBuffer.isView(v)?{blob:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')}:v);
export async function originalStage8PreservationSnapshot(client,keys,definition=null){
 const result={};
 const tables=definition?Object.keys(definition):(await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') AND name NOT IN ('schema_version','phase4_migration_checkpoints') ORDER BY name")).rows.map(row=>row.name);
 for(const table of tables){
  const info=(await client.execute(`PRAGMA table_info(${identifier(table)})`)).rows;
  const columns=definition?.[table]?.columns??info.map(row=>row.name);
  if(columns.some(column=>!info.some(row=>row.name===column)))fail('STAGE8_PRESERVED_COLUMN_MISSING');
  const primary=info.filter(row=>Number(row.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(row=>identifier(row.name));
  const order=primary.length?primary.join(','):'rowid';let offset=0,hash=keys.lookup(['stage8-preservation-table-v1',table,columns]);
  for(;;){
   const rows=(await client.execute({sql:`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)} ORDER BY ${order} LIMIT 128 OFFSET ?`,args:[offset]})).rows;
   for(const row of rows)hash=keys.lookup(['stage8-preservation-row-v1',hash,serial(columns.map(column=>row[column]))]);
   offset+=rows.length;if(rows.length<128)break;
  }
  result[table]={columns,count:offset,hash};
 }
 return result;
}
