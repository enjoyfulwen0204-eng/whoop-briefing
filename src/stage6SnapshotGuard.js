// The sealed preparation owns these rows. Keep the original count + every-row
// full-column IS proof, while preparing SQL in bounded chunks for eligible rows.
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const assertion=(condition,args)=>({sql:`SELECT json(CASE WHEN (${condition}) THEN 'true' ELSE 'SHORT_TRANSACTION_CONDITION_REJECTED' END) verified`,args});
// Match the existing snapshot page ceilings, including the escaped Hrana
// text-value envelope. An individual larger row retains its old binds.
const maxRows=1000,maxBytes=2*1024*1024;

export function snapshotGuards({table,columns,filter,rows}){
 const guards=[assertion(`(SELECT count(*) FROM ${quote(table)} WHERE ${filter.where})=?`,[...filter.args,rows.length])];
 if(!rows.length)return guards;
 // JSON must preserve every value used by the prior bound-parameter proof.
 // Reject values JSON cannot round-trip rather than silently comparing null.
 for(const row of rows)if(row.length!==columns.length||row.some(value=>value!==null
   &&typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value))))
  throw Object.assign(Error('PREPARATION_SNAPSHOT_TYPE'),{code:'PREPARATION_SNAPSHOT_TYPE'});
 // The pinned JSON REAL decoder can shift a decimal by one ULP. Keep every
 // row containing a non-safe-integer number on the original positional-bind
 // path; runtimePublicationClient applies exactRealStatement to those binds.
 const match=columns.map((column,index)=>`__stage6_current.${quote(column)} IS json_extract(__stage6_expected.value,'$[${index}]')`).join(' AND ');
 const packedSql=`NOT EXISTS (SELECT 1 FROM json_each(?) AS __stage6_expected WHERE NOT EXISTS (SELECT 1 FROM ${quote(table)} AS __stage6_current WHERE (${filter.where}) AND ${match}))`;
 let packed=[],bytes=Buffer.byteLength(JSON.stringify({type:'text',value:'[]'}));
 const flush=()=>{if(packed.length)guards.push(assertion(packedSql,['['+packed.join(',')+']',...filter.args]));packed=[];bytes=Buffer.byteLength(JSON.stringify({type:'text',value:'[]'}));};
 const original=row=>guards.push(assertion(`EXISTS(SELECT 1 FROM ${quote(table)} WHERE (${filter.where}) AND ${columns.map(quote).map(column=>column+' IS ?').join(' AND ')})`,[...filter.args,...row]));
 for(const row of rows){
  if(row.some(value=>typeof value==='number'&&!Number.isSafeInteger(value)
    ||typeof value==='string'&&!value.isWellFormed())){original(row);continue;}
  const payload=JSON.stringify(row),size=Buffer.byteLength(JSON.stringify(payload))-2;
  if(size+Buffer.byteLength(JSON.stringify({type:'text',value:'[]'}))>maxBytes){original(row);continue;}
  if(packed.length===maxRows||bytes+size+(packed.length?1:0)>maxBytes)flush();
  bytes+=size+(packed.length?1:0);packed.push(payload);
 }
 flush();
 return guards;
}
