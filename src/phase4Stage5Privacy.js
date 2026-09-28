import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { createOperationReceipts } from './phase4OperationReceipts.js';
import { createResultAuthority } from './phase4ResultAuthority.js';
import { RESULT_AUTHORITY_TABLE } from './phase4V26Schema.js';
import { OPERATION_RECEIPT_TABLE } from './phase4V27Schema.js';
import { physicallyScrubbed } from './phase4Redaction.js';
import { createBodyEnergyStore } from './bodyEnergyStore.js';

const invalid=()=>fail('PHASE4_PURGE_AUTHORITY_INVALID');
const identity=node=>canonicalJson([node.mode,node.type,node.id]);
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const EPISODE_TABLES=['observation_episodes','phase4_episode_revisions','episode_events','episode_evidence','episode_observations','episode_semantic_events'];

/** Independent of naming links and purge targets. Immutable receipts and v25
 * snapshots authenticate roots; original keyed manifests cover pre-v26 runs.
 * Corruption aborts closure instead of removing an edge from consideration. */
export async function stage5PrivacyIndex(core,userId,{verifyRemaining=false}={}) {
  const {client,keys}=core,edges=[],nodes=new Map(),authority=createResultAuthority(core),receipts=createOperationReceipts(core);
  const tables=[OPERATION_RECEIPT_TABLE,RESULT_AUTHORITY_TABLE,'body_energy_results','body_energy_checkpoints','evidence_runs','evidence_items',...EPISODE_TABLES,'health_insights','insight_revisions'];
  for(const table of tables) {
    const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? LIMIT 10001`,args:[userId]})).rows;
    if(rows.length>10000)fail('PHASE4_PURGE_SCOPE_BOUNDS_UNAVAILABLE');
    for(const row of rows) {
      if(!row.privacy_artifact_id)fail('PHASE4_PURGE_CLOSURE_UNPROVEN');
      nodes.set(identity({mode:row.execution_mode,type:table,id:row.privacy_artifact_id}),
      {mode:row.execution_mode,type:table,id:row.privacy_artifact_id,row});
    }
  }
  const edge=(target,source)=>edges.push({artifact_execution_mode:target.mode,artifact_type:target.type,artifact_id:target.id,
    source_execution_mode:source.mode,source_type:source.type,source_id:source.id});
  const values=type=>[...nodes.values()].filter(node=>node.type===type);
  const legacy=node=>edge(node,{mode:'SHARED',type:'TENANT_LEGACY',id:userId});
  // Marker-only, disconnected, or otherwise unreadable payload cannot prove
  // its own dependencies. Conservatively include it in the tenant purge;
  // completion must reject it even when links and target records are lost.
  for(const node of nodes.values())if(!readableRow(node.row)&&!physicallyScrubbed(node.type,node.row)) {
    if(verifyRemaining)fail('PHASE4_PURGE_SENSITIVE_REMAINS');
    legacy(node);
  }
  function evidence(mode,id) {
    const node=values('evidence_items').find(node=>node.mode===mode&&(node.row.evidence_item_id===id||node.id===id));
    if(!node)invalid();return node;
  }
  function source(mode,type,id) {
    if(type==='evidence_items')return evidence(mode,id);
    if(['sleep','recovery','cycle','workout','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(type))return {type,id,mode:'SHARED'};
    const node=nodes.get(identity({mode,type,id}));if(!node)invalid();return node;
  }
  for(const node of values('body_energy_results'))if(readableRow(node.row))
    for(const root of createBodyEnergyStore(core).privacyDependencies(userId,node.row))edge(node,root);
  for(const node of values('body_energy_checkpoints'))if(readableRow(node.row)) {
    const row=node.row,key=keys.lookup(['body-energy-checkpoint-v1',userId,node.mode,'PERIODIC_15M',
      row.checkpoint_bucket_start,row.algorithm_version,row.input_generation]);
    if(key!==row.checkpoint_lookup_key||row.checkpoint_as_of_epoch_ms!==row.checkpoint_bucket_start+900000)invalid();
    const parents=values('body_energy_results').filter(parent=>parent.mode===node.mode
      &&parent.row.input_generation===row.input_generation&&parent.row.as_of_epoch_ms===row.checkpoint_as_of_epoch_ms
      &&parent.row.algorithm_version===row.algorithm_version);
    if(!parents.length||!parents.some(parent=>parent.row.result_id===row.result_id))invalid();
    for(const parent of parents)edge(node,parent);
  }
  for(const node of values(RESULT_AUTHORITY_TABLE))if(readableRow(node.row)) {
    const closure=await authority.privacyDependencies(userId,node.row);
    for(const root of closure.roots)edge(node,root);
    for(const target of closure.targets) {
      const found=nodes.get(identity(target));if(!found)invalid();
      if(identity(found)!==identity(node))edge(found,node);
    }
  }
  for(const node of values(OPERATION_RECEIPT_TABLE))if(readableRow(node.row)) {
    const decoded=receipts.authenticate({userId,executionMode:node.mode},node.row);
    for(const root of decoded.required_roots_json.roots)edge(node,root);
    for(const target of decoded.related_results_json) {
      if(target.projection_role==='DEPENDENCY')continue;
      const found=nodes.get(identity(target));if(!found)invalid();edge(found,node);
    }
  }
  for(const node of values('evidence_runs'))if(readableRow(node.row)&&node.row.state==='COMPLETED') {
    // Operational scaffolds without a registered manifest remain graph-owned.
    // If orphaned, the completion oracle below refuses to certify them.
    if(node.row.input_manifest_json===null)continue;
    for(const root of await authority.descriptorsForRun({userId,executionMode:node.mode},node.row))edge(node,root);
    for(const item of values('evidence_items').filter(item=>item.mode===node.mode&&item.row.run_id===node.row.run_id))edge(item,node);
  }
  for(const node of values('phase4_episode_revisions'))if(readableRow(node.row)) {
    const row=node.row,value=parse(row.snapshot_json);
    if(row.snapshot_version!=='episode-revision-v1'||canonicalJson(value)!==row.snapshot_json
      ||keys.digest(row.content_digest_salt,row.snapshot_json)!==row.snapshot_hash
      ||value.episode.user_id!==userId||value.episode.execution_mode!==node.mode
      ||value.episode.episode_id!==row.episode_id||value.episode.revision!==row.revision)invalid();
    const refs=parse(value.event.evidence_references_json);if(!Array.isArray(refs)||!refs.length)invalid();
    for(const ref of refs) {
      if(!Array.isArray(ref)||ref.length!==2)invalid();edge(node,source(node.mode,...ref));
    }
    for(const target of values('observation_episodes').filter(target=>target.mode===node.mode&&target.row.episode_id===row.episode_id))edge(target,node);
  }
  // Pre-v25 standalone explanations have no snapshot or modern authority.
  // Their event references remain independent of the naming graph. They may
  // widen a purge, but cannot prove absence of other historical dependencies.
  for(const node of values('episode_events'))if(readableRow(node.row)) {
    const refs=parse(node.row.evidence_references_json);
    if(!Array.isArray(refs)||!refs.length)invalid();
    for(const ref of refs) {
      if(typeof ref==='string') {edge(node,evidence(node.mode,ref));continue;}
      if(!Array.isArray(ref)||ref.length!==2)invalid();edge(node,source(node.mode,...ref));
    }
    const parent=values('observation_episodes').find(parent=>parent.mode===node.mode&&parent.row.episode_id===node.row.episode_id);
    if(!parent)invalid();edge(parent,node);
  }
  for(const parent of values('observation_episodes')) {
    for(const type of EPISODE_TABLES.filter(type=>type!=='observation_episodes'))
      for(const child of values(type).filter(child=>child.mode===parent.mode&&child.row.episode_id===parent.row.episode_id))edge(child,parent);
    if(readableRow(parent.row))for(const id of [parent.row.latest_evidence_item_id,parent.row.explanation_evidence_item_id].filter(Boolean))
      edge(parent,evidence(parent.mode,id));
    if(readableRow(parent.row)) {
      const revisions=values('phase4_episode_revisions').filter(node=>node.mode===parent.mode
        &&node.row.episode_id===parent.row.episode_id&&readableRow(node.row));
      // A gap includes real pre-v25 history, even after a v25 revision was
      // subsequently appended. Conservatively erase the whole legacy family.
      if(revisions.length!==parent.row.revision
        ||Array.from({length:revisions.length},(_,i)=>i+1).some(revision=>!revisions.some(node=>node.row.revision===revision)))legacy(parent);
    }
  }
  for(const revision of values('insight_revisions'))if(readableRow(revision.row)) {
    for(const field of ['supporting_evidence_ids_json','contradicting_evidence_ids_json']) {
      const ids=parse(revision.row[field]);if(!Array.isArray(ids))invalid();
      for(const id of ids)edge(revision,evidence(revision.mode,id));
    }
    const parent=values('health_insights').find(parent=>parent.mode===revision.mode&&parent.row.id===revision.row.insight_id);
    if(!parent)invalid();edge(parent,revision);
  }
  for(const parent of values('health_insights')) {
    for(const child of values('insight_revisions')
      .filter(child=>child.mode===parent.mode&&child.row.insight_id===parent.row.id))edge(child,parent);
    // Old insight/revision state has no authenticated complete projection.
    // A retained unsigned claim/support list cannot certify what it excludes.
    const authenticated=edges.some(link=>link.artifact_execution_mode===parent.mode&&link.artifact_type===parent.type
      &&link.artifact_id===parent.id&&[OPERATION_RECEIPT_TABLE,RESULT_AUTHORITY_TABLE].includes(link.source_type));
    if(readableRow(parent.row)&&!authenticated)legacy(parent);
  }

  if(verifyRemaining) {
    // Reinspect every present sensitive node, including ones never recorded as
    // purge targets. A present descendant of a missing/redacted root is proof
    // that closure was incomplete. No target-ledger membership is consulted.
    const sources=new Map();
    for(const link of edges) {
      const target=nodes.get(identity({mode:link.artifact_execution_mode,type:link.artifact_type,id:link.artifact_id}));
      if(!target||!readableRow(target.row))continue;
      const source={mode:link.source_execution_mode,type:link.source_type,id:link.source_id};
      sources.set(identity(source),source);
    }
    for(const source of sources.values()) {
      if(source.mode!=='SHARED') {
        if(!readableRow(nodes.get(identity(source))?.row))fail('PHASE4_PURGE_SENSITIVE_REMAINS');
      } else if(['JOURNAL_FACT','JOURNAL_COVERAGE'].includes(source.type)) {
        const [table,key]=source.type==='JOURNAL_FACT'?['journal_events','privacy_artifact_id']:['journal_coverage_windows','coverage_window_id'];
        const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND ${key}=?`,args:[userId,source.id]})).rows[0];
        if(!readableRow(row))fail('PHASE4_PURGE_SENSITIVE_REMAINS');
      } else if(['sleep','recovery','cycle','workout'].includes(source.type)) {
        const [table,key]={sleep:['whoop_sleeps','id'],recovery:['whoop_recoveries','sleep_id'],
          cycle:['whoop_cycles','id'],workout:['whoop_workouts','id']}[source.type];
        const exists=(await client.execute({sql:`SELECT 1 FROM ${table} WHERE user_id=? AND ${key}=?`,args:[userId,source.id]})).rows.length;
        const deleted=(await client.execute({sql:"SELECT 1 FROM whoop_resource_tombstones WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'",
          args:[userId,source.type,String(source.id)]})).rows.length;
        if(!exists||deleted)fail('PHASE4_PURGE_SENSITIVE_REMAINS');
      } else if(source.type==='TENANT_LEGACY')fail('PHASE4_PURGE_CLOSURE_UNPROVEN');
      else if(source.type==='USER'&&source.id!==userId)invalid();
    }
    // A parent/child cycle is not proof of closure. Every remaining node must
    // reach a checked root through retained dependency content.
    const rooted=new Set();
    let changed=true;
    while(changed) {
      changed=false;
      for(const link of edges) {
        const target=identity({mode:link.artifact_execution_mode,type:link.artifact_type,id:link.artifact_id});
        const source=identity({mode:link.source_execution_mode,type:link.source_type,id:link.source_id});
        if(!rooted.has(target)&&(link.source_execution_mode==='SHARED'||rooted.has(source))) {rooted.add(target);changed=true;}
      }
    }
    for(const node of nodes.values())if(readableRow(node.row)&&node.mode==='SHADOW'&&!rooted.has(identity(node)))
      fail('PHASE4_PURGE_CLOSURE_UNPROVEN');
  }
  return edges;
}
