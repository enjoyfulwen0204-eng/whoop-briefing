/** Pure fixed metadata SQL only. This module creates no authority or client.
 * Expected bytes come exclusively from an owned coherent read in the issuer.
 * No original table payload is read while the single write batch holds a lock. */
export const META=Object.freeze({
 catalog:"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name",
 versions:'SELECT version,applied_at,note FROM schema_version ORDER BY version',
 checkpoints:'SELECT target_version,step_key,last_cursor,postcondition_state,updated_at FROM phase4_migration_checkpoints ORDER BY target_version,step_key',
 cohort:`SELECT u.id user_id,u.status,u.lifecycle_generation,t.whoop_user_id,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count FROM user_whoop_tokens t JOIN users u ON u.id=t.user_id JOIN phase4_user_state p ON p.user_id=u.id WHERE t.whoop_user_id IN (?,?,?) ORDER BY t.whoop_user_id`,
});
const columns=Object.freeze({catalog:['type','name','tbl_name','rootpage','sql'],versions:['version','applied_at','note'],checkpoints:['target_version','step_key','last_cursor','postcondition_state','updated_at'],cohort:['user_id','status','lifecycle_generation','whoop_user_id','auth_generation','source_generation','purge_generation','pending_purge_count']});
export const projectMetadata=(kind,rows)=>rows.map(r=>Object.fromEntries(columns[kind].map(k=>[k,r[k]])));
const matrix=(kind,rows)=>JSON.stringify(rows.map(r=>columns[kind].map(k=>r[k])));
export const metadataJsonSql=kind=>`(SELECT json_group_array(json_array(${columns[kind].join(',')})) FROM (${META[kind]}))`;
export function exactMetadataPredicate(snapshot,{cohort=false}={}){
 const kinds=['catalog','versions','checkpoints',...(cohort?['cohort']:[])],args=[],predicates=[];
 for(const kind of kinds){predicates.push(`${metadataJsonSql(kind)}=json(?)`);if(kind==='cohort')args.push(...snapshot.cohortWhoopIds);args.push(matrix(kind,snapshot[kind]));}
 return {sql:predicates.join(' AND '),args};
}
export const rowPredicate=(row)=>({sql:'EXISTS(SELECT 1 FROM telegram_state WHERE key=? AND value=? AND updated_at=?)',args:[row.key,row.value,row.updated_at]});
export const operatorPredicate=(prefix,rows)=>({sql:'(SELECT json_group_array(json_array(key,value,updated_at)) FROM (SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key))=json(?)',args:[prefix.length,prefix,JSON.stringify(rows.map(r=>[r.key,r.value,r.updated_at]))]});
export const constraintsPredicate="(SELECT foreign_keys FROM pragma_foreign_keys())=1 AND (SELECT ignore_check_constraints FROM pragma_ignore_check_constraints())=0";
export const serverNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const guardName='production_transition_metadata_guard';
export const createGuard={sql:`CREATE TEMP TABLE ${guardName}(ok INTEGER NOT NULL CHECK(ok=1))`,args:[]};
export const dropGuard={sql:`DROP TABLE ${guardName}`,args:[]};
export const guard=(sql,args=[])=>({sql:`INSERT INTO ${guardName}(ok) SELECT CASE WHEN (${sql}) THEN 1 ELSE NULL END`,args});
