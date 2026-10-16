import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv as parse} from 'node:util';
const output='/private/tmp/phase4-blockers-20261016/production-operation-metadata.json';
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
 out.activeExecutions=await sql("SELECT phase,trigger_source,release_sha,execution_mode,state,generation,lease_until,deadline_at,created_at,updated_at FROM phase4_executions WHERE lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) ORDER BY execution_seq DESC LIMIT 20");
 out.unfinalizedGroups=await sql("SELECT phase,trigger_source,release_sha,execution_mode,state,count(*) AS count,MIN(created_at) AS earliest_created_at,MAX(updated_at) AS latest_updated_at FROM phase4_executions WHERE finalized_at IS NULL GROUP BY phase,trigger_source,release_sha,execution_mode,state");
 out.activeLockMetadata=await sql("SELECT count(*) AS count,MIN(acquired_at) AS earliest_acquired_at,MAX(expires_at) AS latest_expires_at FROM resource_locks WHERE expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')");
 out.databaseStatus='READBACK_COMPLETE';
}catch(error){out.databaseStatus='BLOCKED';out.databaseErrorCode=/^[A-Z_0-9]+$/.test(error.message)?error.message:'DETAILS_SUPPRESSED';}
try{
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo',{signal:AbortSignal.timeout(20000)});const v=await r.json();
 if(!r.ok||!v.ok)throw Error('WEBHOOK_READ_REJECTED');
 out.telegram={ok:true,url:v.result.url,pendingUpdateCount:v.result.pending_update_count,maxConnections:v.result.max_connections,allowedUpdates:v.result.allowed_updates,lastErrorDate:v.result.last_error_date??null};
}catch{out.telegram={status:'BLOCKED',detailsSuppressed:true};}
out.completedAtUTC=new Date().toISOString();await writeFile(output,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
