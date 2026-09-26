import { fail } from './phase4Core.js';
// Coverage has one predecessor per revision. Walk the connected lineage with
// visited identities, never SQL UNION ALL. The cap matches the privacy graph's
// corruption ceiling; ordinary lineage depth has no small product limit.
const LIMIT=100000;
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
  const rows=[],pending=[root],visited=new Set();
  for(let cursor=0;cursor<pending.length;cursor++) {
    const row=pending[cursor],key=row.coverage_window_id;
    if(visited.has(key)||visited.size>=LIMIT)invalid();visited.add(key);rows.push(row);cache.set(key,row);
    const children=(await client.execute({sql:`SELECT * FROM journal_coverage_windows WHERE user_id=?
      AND supersedes_coverage_window_id=? ORDER BY coverage_window_id`,args:[userId,key]})).rows;
    for(const child of children) {
      if(visited.has(child.coverage_window_id)||!Number.isSafeInteger(child.revision)||child.revision!==row.revision+1
        ||!Number.isFinite(Date.parse(child.created_at))||Date.parse(child.created_at)<Date.parse(row.created_at))invalid();
      pending.push(child);if(pending.length>LIMIT)invalid();
    }
  }
  return {rows,byId:cache};
}
