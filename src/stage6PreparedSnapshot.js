// Snapshot mechanics only. The caller owns the original execution, erasure
// lease and authority-bound client; this module issues no processing grant.
import {createStage6OwnedMemoryDb} from './db.js';
import {snapshotGuards} from './stage6SnapshotGuard.js';
import {assertCanonicalPreparedCatalog} from './runtimeAdmission.js';
export const quoteSnapshotName=x=>'"'+x.replaceAll('"','""')+'"';
const q=quoteSnapshotName,json=JSON.stringify;
const fail=code=>{throw Object.assign(Error(code),{code});};
export const preparedAssertion=(condition,args=[],label='LIVE_PREPARED_SNAPSHOT_CHANGED')=>({sql:`SELECT json(CASE WHEN (${condition}) THEN 'true' ELSE '${label}' END) verified`,args});
const maxRows=1000,maxBytes=2*1024*1024,maxTotal=16*1024*1024;
const schemaSQL="SELECT json_group_array(json_array(type,name,tbl_name,sql)) payload FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger','view') ORDER BY type,name)";

export async function capturePreparedSnapshot({client,filter,contextGuard,assertOpen}){
 assertOpen();
 const schema=(await client.execute("SELECT type,name,tbl_name,sql,json_array(type,name,tbl_name,sql) encoded FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger','view') ORDER BY type,name")).rows;
 assertCanonicalPreparedCatalog(schema,35);
 const tables=schema.filter(r=>r.type==='table');if(tables.length>128)fail('LIVE_PREPARED_TABLE_BOUNDS');
 const info=await client.batch(tables.map(t=>`PRAGMA table_info(${q(t.name)})`),'deferred');
 const descriptors=tables.map((t,i)=>{
  const columns=info[i].rows.map(r=>r.name).filter(c=>t.name!=='user_whoop_tokens'||['user_id','auth_generation'].includes(c));
  const pk=info[i].rows.filter(r=>r.pk).sort((a,b)=>a.pk-b.pk).map(r=>r.name);
  return {table:t.name,columns,pk,filter:filter(t.name,columns)};
 });
 const pending=descriptors.filter(d=>d.filter.where!=='0'),keys=new Map(pending.map(d=>[d,[]])),sizes=new Map(pending.map(d=>[d,[]]));let active=pending;
 while(active.length){
  const queries=active.map(d=>{
   if(!d.pk.length)fail('LIVE_PREPARED_PRIMARY_KEY_REQUIRED');
   const prior=keys.get(d).at(-1),range=prior?` AND (${d.pk.map(q).join(',')})>(${d.pk.map(()=>'?').join(',')})`:'';
   return {sql:`SELECT ${d.pk.map(q).join(',')},length(CAST(json_array(${d.columns.map(q).join(',')}) AS BLOB))+${d.columns.length*64} __bounded_bytes FROM ${q(d.table)} WHERE (${d.filter.where})${range} ORDER BY ${d.pk.map(q).join(',')} LIMIT ${maxRows}`,args:[...d.filter.args,...(prior??[])]};
  });
  const observed=(await client.batch([contextGuard,...queries,contextGuard],'deferred')).slice(1,-1),next=[];
  for(let i=0;i<active.length;i++){
   const d=active[i],rows=observed[i].rows;keys.get(d).push(...rows.map(r=>d.pk.map(k=>r[k])));sizes.get(d).push(...rows.map(r=>r.__bounded_bytes));
   if(keys.get(d).length>16000)fail('LIVE_PREPARED_KEY_BOUNDS');if(rows.length===maxRows)next.push(d);
  }
  active=next;assertOpen();
 }
 const pages=[];
 for(const d of descriptors){
  const ks=keys.get(d)??[],bs=sizes.get(d)??[];let lower;
  if(!ks.length){pages.push({d,expectedRows:0,filter:d.filter});continue;}
  for(let start=0;start<ks.length;){
   let end=start,bytes=0;while(end<ks.length&&end-start<250&&bytes+bs[end]<=maxBytes)bytes+=bs[end++];
   if(end===start)fail('LIVE_PREPARED_ROW_BOUNDS');const upper=end<ks.length?ks[end-1]:null,parts=[`(${d.filter.where})`],args=[...d.filter.args];
   if(lower){parts.push(`(${d.pk.map(q).join(',')})>(${d.pk.map(()=>'?').join(',')})`);args.push(...lower);}
   if(upper){parts.push(`(${d.pk.map(q).join(',')})<=(${d.pk.map(()=>'?').join(',')})`);args.push(...upper);}
   pages.push({d,expectedRows:end-start,filter:{where:parts.join(' AND '),args}});start=end;lower=upper;
  }
 }
 if(pages.length>128)fail('LIVE_PREPARED_PAGE_BOUNDS');
 const bytesFor=d=>`length(CAST(json_array(${d.columns.map(q).join(',')}) AS BLOB))+${d.columns.length*64}`;
 const gates=pages.map(({d,filter,expectedRows})=>preparedAssertion(`count(*)=${expectedRows} AND count(*)<=${maxRows} AND coalesce(sum(${bytesFor(d)}),0)<=${maxBytes}`,[], 'LIVE_PREPARED_PAGE_CHANGED'));
 // All envelopes, the complete schema and every payload share ONE read root.
 const statements=pages.map(({d,filter})=>({sql:`SELECT ${d.columns.map(q).join(',')} FROM ${q(d.table)} WHERE ${filter.where} ORDER BY ${(d.pk.length?d.pk:d.columns).map(q).join(',')} LIMIT ${maxRows+1}`,args:filter.args}));
 const pageGates=gates.map((g,i)=>({...g,sql:g.sql.replace(' verified',` verified FROM ${q(pages[i].d.table)} WHERE ${pages[i].filter.where}`),args:pages[i].filter.args}));
 const aggregate=descriptors.map(d=>`coalesce((SELECT sum(${bytesFor(d)}) FROM ${q(d.table)} WHERE ${d.filter.where}),0)`);
 const schemaPayload='['+schema.map(s=>s.encoded).join(',')+']',schemaGuard=preparedAssertion(`(${schemaSQL}) IS ?`,[schemaPayload]);
 const guards=[contextGuard,schemaGuard,...pageGates,preparedAssertion(`(${aggregate.join('+')})<=${maxTotal}`,descriptors.flatMap(d=>d.filter.args),'LIVE_PREPARED_TOTAL_BOUNDS')];
 const observed=(await client.batch([...guards,...statements,contextGuard],'deferred')).slice(guards.length,-1);let totalBytes=0;
 for(const d of descriptors)d.rows=[];
 for(let i=0;i<pages.length;i++){
  const {d}=pages[i],rows=observed[i].rows.map(r=>d.columns.map(c=>r[c]));
  if(rows.some(r=>r.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v)))))fail('LIVE_PREPARED_SNAPSHOT_TYPE');
  const bytes=Buffer.byteLength(json(rows));totalBytes+=bytes;if(rows.length>maxRows||bytes>maxBytes||totalBytes>maxTotal)fail('LIVE_PREPARED_PAYLOAD_BOUNDS');
  d.rows.push(...rows);
 }
 assertOpen();return {schema,schemaGuard,descriptors,totalBytes,pages:pages.length};
}

export async function openPreparedMemory(snapshot,keys,checkpoint){
 return createStage6OwnedMemoryDb(async seed=>{
  await seed.execute('PRAGMA foreign_keys=OFF');for(const s of snapshot.schema.filter(r=>r.type==='table'))await seed.execute(s.sql);
  for(const d of snapshot.descriptors)for(const row of d.rows){
   const pause=checkpoint();if(pause)await pause;
   const extra=d.table==='user_whoop_tokens'?['access_token','refresh_token','access_token_expires_at','updated_at']:[],columns=[...d.columns,...extra];
   await seed.execute({sql:`INSERT INTO ${q(d.table)}(${columns.map(q).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,args:[...row,...extra.map(()=> 'LIVE_PREPARATION_REDACTED')]});
  }
  for(const s of snapshot.schema.filter(r=>r.type==='index'||r.type==='trigger'))await seed.execute(s.sql);await seed.execute('PRAGMA foreign_keys=ON');
 },keys);
}
export async function capturePreparedPostImages(db,snapshot){
 const post=[];
 for(const d of snapshot.descriptors){
  const rows=(await db.raw.execute({sql:`SELECT ${d.columns.map(q).join(',')} FROM ${q(d.table)} WHERE ${d.filter.where} ORDER BY ${(d.pk.length?d.pk:d.columns).map(q).join(',')} LIMIT 16001`,args:d.filter.args})).rows.map(r=>d.columns.map(c=>r[c]));
  if(rows.length>16000)fail('LIVE_PREPARED_POSTIMAGE_BOUNDS');post.push({...d,rows});
 }
 if(Buffer.byteLength(json(post.map(d=>[d.table,d.rows])))>maxTotal)fail('LIVE_PREPARED_POSTIMAGE_BOUNDS');return post;
}
export const preparedImageGuards=descriptors=>descriptors.flatMap(snapshotGuards);
export function erasePreparedSnapshot(snapshot){for(const d of snapshot?.descriptors??[])d.rows.length=0;}
