import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv as parse} from 'node:util';
const output='/private/tmp/phase4-blockers-20261016/db-webhook-readback.json';
const env=parse(await readFile('/Users/kelvin/Desktop/whoop-briefing/.env','utf8'));
const host='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
const out={startedAtUTC:new Date().toISOString(),credentialSource:'existing project .env; values never emitted',credentialChanges:0,tokenMetadataInspected:false,durableWrites:0,queries:[]};
async function sql(query){
 if(!/^SELECT\b/.test(query))throw Error('READ_ONLY_SQL_REQUIRED');out.queries.push(query);
 const r=await fetch('https://'+host+'/v2/pipeline',{method:'POST',headers:{Authorization:'Bearer '+env.TURSO_AUTH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:query,want_rows:true}},{type:'close'}]}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('DATABASE_HTTP_'+r.status);
 const value=(await r.json()).results[0];if(value.type!=='ok')throw Error('DATABASE_QUERY_REJECTED');
 const result=value.response.result;return result.rows.map(row=>Object.fromEntries(result.cols.map((c,i)=>[c.name,row[i].value??null])));
}
try{
 if(new URL(env.TURSO_DATABASE_URL.replace('libsql://','https://')).hostname!==host)throw Error('DATABASE_IDENTITY_MISMATCH');
 out.schema=await sql('SELECT MAX(version) AS version FROM schema_version');
 const schema=await sql("SELECT name,sql FROM sqlite_schema WHERE type='table' AND (sql LIKE '%lease_until%' OR sql LIKE '%lease_expires_at%' OR name='resource_locks') ORDER BY name");
 const inventory=[];
 for(const row of schema){
  if(!/^[a-z_][a-z0-9_]*$/.test(row.name))throw Error('TABLE_IDENTITY_INVALID');
  const column=/\blease_until\b/.test(row.sql)?'lease_until':/\blease_expires_at\b/.test(row.sql)?'lease_expires_at':'expires_at';
  const predicate=column==='lease_until'?"lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)":`${column}>strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  inventory.push({table:row.name,column,...(await sql(`SELECT count(*) AS active_leases FROM ${row.name} WHERE ${predicate}`))[0]});
 }
 out.writerLeaseInventory=inventory;
 out.executionSettlement=await sql("SELECT state,count(*) AS count FROM phase4_executions WHERE finalized_at IS NULL GROUP BY state");
 out.databaseStatus='READBACK_COMPLETE';
}catch(error){out.databaseStatus='BLOCKED';out.databaseErrorCode=/^[A-Z_0-9]+$/.test(error.message)?error.message:'DETAILS_SUPPRESSED';}
try{
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo',{signal:AbortSignal.timeout(20000)});const v=await r.json();
 if(!r.ok||!v.ok)throw Error('WEBHOOK_READ_REJECTED');
 out.telegram={ok:true,url:v.result.url,pendingUpdateCount:v.result.pending_update_count,maxConnections:v.result.max_connections,allowedUpdates:v.result.allowed_updates,lastErrorDate:v.result.last_error_date??null};
}catch{out.telegram={status:'BLOCKED',detailsSuppressed:true};}
out.completedAtUTC=new Date().toISOString();await writeFile(output,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
