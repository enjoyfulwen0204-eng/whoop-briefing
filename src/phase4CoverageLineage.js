import { fail } from './phase4Core.js';
import { canonicalInstant } from './phase4Time.js';
import { CATEGORIES,healthDateFor } from './journal.js';
import { JOURNAL_VERSIONS } from './journalFoundationValidation.js';
// Coverage has one predecessor per revision. Walk the connected lineage with
// visited identities, never SQL UNION ALL. More than 1000 nodes is explicitly
// unavailable; validation never truncates a lineage to fit the bound.
const LIMIT=1000;
export function validateCoverageNode(row,userId,parent=null) {
  const invalid=()=>fail('PHASE4_COVERAGE_LINEAGE_INVALID');
  if(!row||row.user_id!==userId||typeof row.coverage_window_id!=='string'||!row.coverage_window_id
    ||!Number.isSafeInteger(row.revision)||row.revision<1||!['ACTIVE','SUPERSEDED','DELETED'].includes(row.status))invalid();
  for(const key of ['input_generation','lifecycle_generation','auth_generation','purge_generation'])
    if(!Number.isSafeInteger(row[key])||row[key]<0)invalid();
  let created,updated;
  try {created=canonicalInstant(row.created_at);updated=canonicalInstant(row.updated_at);}catch{invalid();}
  if(updated<created)invalid();
  if(parent) {
    if(row.supersedes_coverage_window_id!==parent.coverage_window_id||row.revision!==parent.revision+1
      ||created<canonicalInstant(parent.created_at))invalid();
  } else if(row.supersedes_coverage_window_id!==null||row.revision!==1)invalid();
  if(row.content_state!=='PRESENT'||row.source_linkage_state!=='COMPLETE'||row.health_content_redacted_at!==null
    ||row.status==='DELETED')fail('CONTENT_REDACTED');
  let factors,start,end;
  try {
    factors=JSON.parse(row.factor_keys_json);start=canonicalInstant(row.window_start_utc);end=canonicalInstant(row.window_end_utc);
    new Intl.DateTimeFormat('en',{timeZone:row.recorded_timezone}).format();
  } catch {invalid();}
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
    &&Number.isFinite(Date.parse(value))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  if(!Array.isArray(factors)||!factors.length||factors.some(factor=>!CATEGORIES.includes(factor)||factor==='custom')
    ||new Set(factors).size!==factors.length||row.factor_set_version!=='journal-factors-v1'||start>=end||end>created
    ||!validDate(row.health_date_start)||!validDate(row.health_date_end)||row.health_date_start>row.health_date_end
    ||row.parser_version!==JOURNAL_VERSIONS.parser||row.normalizer_version!==JOURNAL_VERSIONS.normalizer
    ||['source_event_key','confirmation_text_hash','privacy_artifact_id','content_digest_salt'].some(key=>typeof row[key]!=='string'||!row[key])
    ||row.health_date_start!==healthDateFor(new Date(start),row.recorded_timezone)
    ||row.health_date_end!==healthDateFor(new Date(Date.parse(end)-1),row.recorded_timezone)
    ||!Number.isFinite(row.answer_confidence)||row.answer_confidence<0||row.answer_confidence>1)invalid();
  if(parent) {
    let prior;try{prior=JSON.parse(parent.factor_keys_json);}catch{invalid();}
    if(!Array.isArray(prior)||factors.some(factor=>!prior.includes(factor))||row.recorded_timezone!==parent.recorded_timezone
      ||row.factor_set_version!==parent.factor_set_version)invalid();
  }
  return row;
}
export async function coverageLineage(client,userId,id) {
  const invalid=()=>fail('PHASE4_COVERAGE_LINEAGE_INVALID'),cache=new Map();
  const get=async key=>{
    if(!cache.has(key)) {
      const row=(await client.execute({sql:'SELECT * FROM journal_coverage_windows WHERE user_id=? AND coverage_window_id=?',args:[userId,key]})).rows[0];
      if(!row)invalid();cache.set(key,row);if(cache.size>LIMIT)invalid();
    }
    return cache.get(key);
  };
  let root=await get(id);const ancestors=new Set();
  while(root.supersedes_coverage_window_id!==null) {
    if(ancestors.has(root.coverage_window_id))invalid();ancestors.add(root.coverage_window_id);
    root=await get(root.supersedes_coverage_window_id);
  }
  validateCoverageNode(root,userId);
  const rows=[],pending=[root],visited=new Set();
  for(let cursor=0;cursor<pending.length;cursor++) {
    const row=pending[cursor],key=row.coverage_window_id;
    if(visited.has(key)||visited.size>=LIMIT)invalid();visited.add(key);rows.push(row);cache.set(key,row);
    const children=(await client.execute({sql:`SELECT * FROM journal_coverage_windows WHERE user_id=?
      AND supersedes_coverage_window_id=? ORDER BY coverage_window_id`,args:[userId,key]})).rows;
    // A correction replaces one assertion. Two children have no authenticated
    // winner; equal instants on a single chain are ordered by revision.
    if(children.length>1||children.length&&row.status!=='SUPERSEDED'||!children.length&&row.status==='SUPERSEDED')invalid();
    for(const child of children) {
      validateCoverageNode(child,userId,row);
      if(visited.has(child.coverage_window_id)||!Number.isSafeInteger(child.revision)||child.revision!==row.revision+1
        ||!Number.isFinite(Date.parse(child.created_at))||Date.parse(child.created_at)<Date.parse(row.created_at))invalid();
      pending.push(child);if(pending.length>LIMIT)invalid();
    }
  }
  return {rows,byId:cache};
}
