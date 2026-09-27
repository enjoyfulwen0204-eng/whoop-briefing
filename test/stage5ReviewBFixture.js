export const T='2026-09-25T12:00:00.000Z';
export async function guards(f,table,fn) {
  const triggers=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;
  for(const trigger of triggers)await f.db.raw.execute(`DROP TRIGGER ${trigger.name}`);
  try{return await fn();}finally{for(const trigger of triggers)await f.db.raw.execute(trigger.sql);}
}
export async function durable(f) {
  const rows={};for(const table of ['evidence_runs','evidence_items','observation_episodes','phase4_episode_revisions',
    'episode_events','episode_evidence','episode_semantic_events','episode_observations','health_insights','insight_revisions',
    'phase4_evidence_result_authorities','phase4_operation_receipts','phase4_source_links'])
    rows[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
  return rows;
}
export const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['ref','created','replayed'].includes(key)).map(([key,value])=>[key,semantic(value)])):value;
export const leases=async f=>(await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'p4ctx:%'")).rows[0].n;
