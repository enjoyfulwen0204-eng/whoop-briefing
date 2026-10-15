/** Additive opt-in LIVE allocation. The frozen v26-v34 tables stay unchanged. */
import {buildV26} from './phase4V26Schema.js';
import {buildV27} from './phase4V27Schema.js';
import {buildV29} from './phase4V29Schema.js';
import {buildV30} from './phase4V30Schema.js';
import {buildV32} from './phase4V32Schema.js';
import {LIVE_TABLES} from './stage8LiveAllocation.js';
const mode="execution_mode TEXT NOT NULL CHECK(execution_mode='LIVE')";
const immutable=table=>`CREATE TRIGGER IF NOT EXISTS ${table}_mode_immutable BEFORE UPDATE OF execution_mode ON ${table}
 WHEN NEW.execution_mode IS NOT OLD.execution_mode BEGIN SELECT RAISE(ABORT,'phase4_execution_mode_immutable'); END`;
function allocate(sql){
 // Compile only frozen, code-owned DDL. Namespace every new index/trigger too.
 for(const [old,name] of Object.entries(LIVE_TABLES).sort((a,b)=>b[0].length-a[0].length))sql=sql.replaceAll(new RegExp(`\\b${old}\\b`,'g'),name);
 sql=sql.replace(/(CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) IF NOT EXISTS )(\w+)/,(_,prefix,name)=>prefix+(name.startsWith('stage8_live_')?name:'stage8_live_'+name));
 return sql.replaceAll("execution_mode='SHADOW'","execution_mode='LIVE'").replaceAll("execution_mode IN ('OFF','SHADOW')","execution_mode='LIVE'");
}
export function buildV35(){
 const parts=[buildV26(mode,immutable),buildV27(mode,immutable),buildV29(mode,immutable),buildV30(mode,immutable)];
 // Shared health_insights triggers already exist in v27; never replace them.
 const ddl=parts.flatMap(p=>[...p.ddl,...(p.indexes??[]),...(p.triggers??[])]).filter(s=>!s.includes('p4_health_insights_')).map(allocate);
 for(let sql of buildV32().ddl){
  if(sql.includes('p4_execution_initial_authority'))continue;
  sql=sql.replace("CHECK((phase='SYNC' AND sync_execution_id IS NULL) OR (phase='STAGE6_DRAIN' AND sync_execution_id IS NOT NULL))", "CHECK(phase='STAGE6_DRAIN' AND sync_execution_id IS NULL)");
  ddl.push(allocate(sql));
 }
 ddl.push(`CREATE TRIGGER IF NOT EXISTS stage8_live_execution_initial_authority BEFORE INSERT ON stage8_live_executions
 WHEN NEW.state<>'ESTABLISHED' OR NEW.generation<>1 OR NEW.observed_outcome<>'IN_PROGRESS' OR NEW.abort_outcome IS NOT NULL
 OR NEW.phase<>'STAGE6_DRAIN' OR NEW.sync_execution_id IS NOT NULL
 OR json_extract(NEW.canonical_request_json,'$.requestId') IS NOT NEW.execution_id
 OR json_extract(NEW.canonical_request_json,'$.phase') IS NOT NEW.phase
 OR json_extract(NEW.canonical_request_json,'$.releaseSha') IS NOT NEW.release_sha
 OR json_extract(NEW.canonical_request_json,'$.executionMode') IS NOT NEW.execution_mode
 OR json_extract(NEW.canonical_request_json,'$.triggerSource') IS NOT NEW.trigger_source
 OR json_extract(NEW.canonical_request_json,'$.configProof') IS NOT NEW.config_proof
 OR json_extract(NEW.canonical_request_json,'$.contract') IS NOT 'stage8-live-producer-v1'
 OR json_type(NEW.canonical_request_json,'$.tenantScope') IS NOT 'text'
 OR length(json_extract(NEW.canonical_request_json,'$.tenantScope'))<>64
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE key NOT IN
 ('requestId','phase','releaseSha','executionMode','triggerSource','configProof','contract','tenantScope'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) GROUP BY key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json) WHERE type<>'text')
 BEGIN SELECT RAISE(ABORT,'stage8_live_execution_initial_authority'); END`);
 return Object.freeze({version:35,ddl});
}
