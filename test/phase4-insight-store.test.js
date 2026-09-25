import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';

async function fixture(t) {
  const f=await syntheticPhase4Fixture(t),c=await f.stores.capture('a',{executionMode:'SHADOW'});
  const source=await f.stores.root(c,'USER','a');
  const run=await f.stores.evidence.start(c,{deterministic_run_key:'synthetic-run',method:'SYNTHETIC',algorithm_version:'fixture',
    registry_version:'fixture',evidence_contract_version:'fixture-v1',promotion_confound_version:'unknown-promotion-confound-v1',
    exposure_classification_version:'fixture',factor_set_version:'fixture',started_at:f.core.timestamp()},[source.ref]);
  await f.stores.evidence.complete(c,run.row.run_id,{eligible_observation_days:1,unknown_eligible_days:0,unknown_fraction:0});
  const item=await f.stores.evidence.addItem(c,{run_id:run.row.run_id,item_key:'candidate',exposure_classification_version:'fixture',factor_set_version:'fixture'});
  const candidate={identity:{subject:'Synthetic',outcome:'Synthetic',direction:'DOWN',exposureCategory:'synthetic',algorithmFamily:'synthetic',evidenceContractMajor:'1'},
    claim:'Synthetic candidate; still checking.',creationKey:'synthetic-create',evidenceContractVersion:'fixture-v1',
    supportingEvidenceIds:[item.row.evidence_item_id],expiresAt:'2026-10-01T00:00:00.000Z'};
  return {...f,c,candidate};
}

test('Insight parent stub, first revision and current pointer commit atomically; legacy and foreign parents cannot become current',async t=>{
  const f=await fixture(t),{stores,c,candidate,db}=f;
  const one=await stores.insights.create(c,candidate);
  assert.equal(one.row.status,'HYPOTHESIS');assert.equal(one.row.current_revision,1);
  assert.equal(one.revision.revision,1);assert.equal(one.row.legacy_classification,'PHASE4');
  assert.equal((await stores.insights.create(c,candidate)).created,false);
  const other=await stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(stores.insights.read(other,one.row.id),/PARENT_NOT_FOUND/);
  await assert.rejects(stores.insights.create(other,candidate),/PARENT_NOT_FOUND/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n,1);
  await assert.rejects(stores.insights.create(c,{...candidate,creationKey:'other'}),/UNIQUE/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM insight_revisions')).rows[0].n,1);
});

test('Insight transitions require legal edges and durable replication; dismissal is atomic terminal disposition and CAS has one winner',async t=>{
  const {stores,c,candidate,db}=await fixture(t),one=await stores.insights.create(c,candidate);
  const change={insightId:one.row.id,expectedRevision:1,claim:candidate.claim,supportingEvidenceIds:candidate.supportingEvidenceIds};
  await assert.rejects(stores.insights.transition(c,{...change,status:'SUPPORTED',reason:'REPLICATED_SUPPORT'}),/ILLEGAL_INSIGHT_TRANSITION/);
  await assert.rejects(stores.insights.transition(c,{...change,status:'EMERGING',reason:'REPEATED_EVIDENCE'}),/REPEATED_EVIDENCE_REQUIRED/);
  const outcomes=await Promise.allSettled([
    stores.insights.transition(c,{...change,status:'RETIRED',disposition:'USER_DISMISSED',reason:'USER_DISMISSED'}),
    stores.insights.transition(c,{...change,status:'RETIRED',disposition:'REJECTED',reason:'REJECTED'}),
  ]);
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
  assert.match(outcomes.find(v=>v.status==='rejected').reason.message,/CAS_LOST/);
  await assert.rejects(stores.insights.read(c,one.row.id),/NOT_CURRENT/);
  const historical=await stores.insights.read(c,one.row.id,{history:true});
  assert.equal(historical.row.status,'RETIRED');assert.equal(historical.row.lifecycle_disposition,'USER_DISMISSED');
  assert.equal(historical.revision.lifecycle_disposition,'USER_DISMISSED');
  await assert.rejects(stores.insights.transition(c,{...change,expectedRevision:2,status:'EMERGING',reason:'REPEATED_EVIDENCE'}),/ILLEGAL_INSIGHT_TRANSITION/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM insight_revisions')).rows[0].n,2);
});

test('A logical insight refresh uses new-generation evidence without promoting the old revision or dropping purge lineage',async t=>{
  const f=await fixture(t),{stores,c,candidate,db}=f,old=await stores.insights.create(c,candidate);
  await stores.queue.sourceChanged(await stores.captureControl('a'));
  const fresh=await stores.capture('a',{executionMode:'SHADOW'}),source=await stores.root(fresh,'USER','a');
  await assert.rejects(stores.insights.read(fresh,old.row.id),/PARENT_STALE/);
  const run=await stores.evidence.start(fresh,{deterministic_run_key:'new-input-run',method:'SYNTHETIC',algorithm_version:'fixture',
    registry_version:'fixture',evidence_contract_version:'fixture-v1',promotion_confound_version:'unknown-promotion-confound-v1',
    exposure_classification_version:'fixture',factor_set_version:'fixture',started_at:f.core.timestamp()},[source.ref]);
  await stores.evidence.complete(fresh,run.row.run_id,{});
  const item=await stores.evidence.addItem(fresh,{run_id:run.row.run_id,item_key:'new',exposure_classification_version:'fixture',factor_set_version:'fixture'});
  const change={insightId:old.row.id,expectedRevision:1,status:'HYPOTHESIS',claim:'Fresh synthetic candidate.',
    supportingEvidenceIds:[item.row.evidence_item_id],reason:'CANDIDATE_EVIDENCE',refresh:true};
  const updated=await stores.insights.transition(fresh,change);
  assert.equal(updated.row.id,old.row.id);assert.equal(updated.row.current_revision,2);assert.equal(updated.row.input_generation,1);
  const history=(await db.raw.execute('SELECT revision,input_generation FROM insight_revisions ORDER BY revision')).rows;
  assert.deepEqual(history.map(r=>[r.revision,r.input_generation]),[[1,0],[2,1]]);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='health_insights' AND unlinked_at IS NULL")).rows[0].n,2);
  await assert.rejects(stores.insights.transition(fresh,change),/REFRESH_INVALID|CAS_LOST/);
});

test('Insight promotion fails closed on missing or low durable confidence and accepts a compatible persisted score',async t=>{
  const f=await syntheticPhase4Fixture(t,{now:()=>new Date('2026-09-25T12:00:00.000Z')}),c=await f.stores.capture('a',{executionMode:'SHADOW'}),
    source=await f.stores.root(c,'USER','a'),semanticAt='2026-09-25T12:00:00.000Z';
  const components=value=>({dataQuality:value,sampleSufficiency:value,replication:value,effectStability:value,
    recency:value,multiplicityControl:value,softConfoundFraction:0});
  async function candidate(name,confidence) {
    let run=await f.stores.evidence.start(c,{deterministic_run_key:`confidence-${name}`,subject_key:name,method:'JOURNAL_ASSOCIATION',
      window_start_utc:'2026-09-01T00:00:00.000Z',window_end_utc:'2026-09-20T00:00:00.000Z',as_of_utc:semanticAt,timezone:'Asia/Taipei',
      algorithm_version:'fixture',registry_version:'fixture',evidence_contract_version:'fixture-v1',
      promotion_confound_version:'unknown-promotion-confound-v1',exposure_classification_version:'fixture',factor_set_version:'fixture',
      multiple_testing_family:`family-${name}`,started_at:semanticAt},[source.ref]);
    run=await f.stores.evidence.complete(c,run.row.run_id,{eligible_observation_days:30,unknown_eligible_days:0,unknown_fraction:0});
    const provenance={replication_windows:[{start:'2026-09-01T00:00:00.000Z',end:'2026-09-08T00:00:00.000Z',direction:'LOWER'},
      {start:'2026-09-08T00:00:00.000Z',end:'2026-09-20T00:00:00.000Z',direction:'LOWER'}],minimum_effect_size:5};
    if(confidence!==undefined)provenance.confidence=confidence;
    const item=await f.stores.evidence.addItem(c,{run_id:run.row.run_id,item_key:`item-${name}`,claim_key:name,direction:'LOWER',unit:'score',
      effect:-10,adjusted_significance:.05,exposed_count:15,confirmed_unexposed_count:15,unknown_count:0,effective_sample_count:30,
      exposure_classification_version:'fixture',factor_set_version:'fixture',quality:'AVAILABLE',recency_weight:1,causal_status:'ASSOCIATION_ONLY',
      provenance_json:provenance,confound_json:{hard_flags:[],outcome_missing_fraction_exposed:0,outcome_missing_fraction_unexposed:0}},[source.ref]);
    const insight=await f.stores.insights.create(c,{identity:{subject:name,outcome:'recovery',direction:'lower',exposureCategory:name,
      algorithmFamily:'journal-association',evidenceContractMajor:'1'},claim:`${name} candidate`,creationKey:`create-${name}`,
      evidenceContractVersion:'fixture-v1',supportingEvidenceIds:[item.row.evidence_item_id],expiresAt:'2026-12-01T00:00:00.000Z',semanticAt});
    return {item,insight};
  }
  const missing=await candidate('missing',undefined),low=await candidate('low',{version:'evidence-confidence-v1',score:.4,label:'LOW',
      components:components(.4),hardConfound:false,uncertaintyAvailable:true}),
    inconsistent=await candidate('inconsistent',{version:'evidence-confidence-v1',score:.8,label:'HIGH',components:components(.4),
      hardConfound:false,uncertaintyAvailable:true}),
    valid=await candidate('valid',{version:'evidence-confidence-v1',score:.8,label:'HIGH',components:components(.8),
      hardConfound:false,uncertaintyAvailable:true});
  const promote=value=>f.stores.insights.transition(c,{insightId:value.insight.row.id,expectedRevision:1,status:'EMERGING',
    claim:value.insight.row.statement,supportingEvidenceIds:[value.item.row.evidence_item_id],reason:'REPEATED_EVIDENCE',semanticAt});
  await assert.rejects(promote(missing),/REPEATED_EVIDENCE_REQUIRED/);await assert.rejects(promote(low),/REPEATED_EVIDENCE_REQUIRED/);
  await assert.rejects(promote(inconsistent),/REPEATED_EVIDENCE_REQUIRED/);
  assert.equal((await promote(valid)).row.status,'EMERGING');
});
