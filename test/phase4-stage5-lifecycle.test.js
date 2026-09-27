import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request,progressOneDay,recoveryRefs } from './stage5HistoryFixture.js';
import { call,read } from './stage5ClosureFixture.js';
import { setup as associationSetup,hypothesis,family,insertCoverage } from './stage5AssociationFixture.js';
import { addDays } from '../src/time.js';

const T='2026-09-25T12:00:00.000Z';
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['ref','created','replayed'].includes(key)).map(([key,value])=>[key,semantic(value)])):value;
const counts=async f=>Object.fromEntries(await Promise.all(['evidence_runs','evidence_items','observation_episodes',
  'episode_events','phase4_episode_revisions','phase4_operation_receipts'].map(async table=>[table,(await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n])));

test('A: metric reversal retains the complete original wrapper across restart and further progress',async t=>{
  const f=await setup(t),initial=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const reversed=await progressOneDay(f,'opposite',{value:95});
  assert.equal(reversed.episode.reversedEpisodeId,initial.episode.episode.row.episode_id);
  f.setNow('2026-10-20T12:00:00Z');const restarted=await f.restart();f.stores=restarted.stores;
  const c=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,c,['opposite',...f.recoveryIds.slice(0,30)]),before=await counts(f);
  const replay=await f.stores.intelligence.analyzeMetric(c,request(refs[0],refs.slice(1),'2026-09-26T12:00:00.000Z'));
  assert.deepEqual(semantic(replay),semantic(reversed));assert.deepEqual(await counts(f),before);
});

test('A/J: direct episode results, semantic retry and every terminal path have exact receipts',async t=>{
  const f=await setup(t),evidence=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
  const identity={algorithmMajor:'phase4-intelligence-v1',direction:'LOWER',domain:'recovery',metric:'recovery_score',subject:'recovery_score',windowFamily:'DIRECT'};
  const operations=[];
  async function commit(method,req) {
    f.setNow(req.semanticAt);const result=await call(f,'episodes',method,req);operations.push({method,req,result});return result;
  }
  const open={identity,data:{episode_type:'METRIC_DEVIATION',severity:1,expires_at:'2026-09-30T12:00:00Z'},
    evidenceItemId:evidence.item.row.evidence_item_id,semanticAt:T,semanticEvent:{eventKind:'OPENED',severityOrdinal:1,semanticContentHash:'direct-open'}};
  const opened=await commit('open',open),id=opened.row.episode_id;
  const event=(await f.db.raw.execute({sql:'SELECT * FROM episode_semantic_events WHERE episode_id=?',args:[id]})).rows[0];
  const retry={episodeId:id,expectedRevision:1,episodeEventId:event.episode_event_id,eventKind:'OPENED',severityOrdinal:1,semanticContentHash:'direct-open',semanticAt:T};
  const originalSemantic=await call(f,'episodes','semantic',retry);
  const base={episodeId:id,sourceRefs:[evidence.item.ref]};
  await commit('revise',{...base,expectedRevision:1,toState:'EXPLAINED',patch:{explained_status:1,
    explanation_evidence_item_id:evidence.item.row.evidence_item_id,explanation_json:{reason:'complete private explanation'}},
    reasonCode:'CURRENT_EXPLANATION',semanticAt:'2026-09-25T13:00:00Z'});
  await commit('revise',{...base,expectedRevision:2,toState:'STABILIZING',closeThresholdPassed:true,
    reasonCode:'CLOSE_THRESHOLD',semanticAt:'2026-09-25T14:00:00Z'});
  await commit('revise',{...base,expectedRevision:3,toState:'RESOLVED',closeThresholdPassed:true,
    reasonCode:'RESOLUTION_HOLD',semanticAt:'2026-09-26T14:00:00Z'});
  const expired=await commit('open',{...open,identity:{...identity,windowFamily:'EXPIRE'},semanticAt:'2026-09-26T14:00:00Z',data:{expires_at:'2026-09-26T14:00:00Z'}});
  await commit('revise',{episodeId:expired.row.episode_id,expectedRevision:1,toState:'EXPIRED',sourceRefs:[evidence.item.ref],
    reasonCode:'WINDOW_EXPIRED',semanticAt:'2026-09-26T14:00:00Z'});
  const invalidated=await commit('open',{...open,identity:{...identity,windowFamily:'INVALIDATE'},semanticAt:'2026-09-26T14:00:00Z'});
  await commit('revise',{episodeId:invalidated.row.episode_id,expectedRevision:1,toState:'INVALIDATED',sourceRefs:[evidence.item.ref],
    reasonCode:'SOURCE_INVALIDATED',semanticAt:'2026-09-26T14:00:00Z'});
  const reverseIdentity={...identity,windowFamily:'DIRECT_REVERSE'};
  const reverseBase=await commit('open',{...open,identity:reverseIdentity,semanticAt:'2026-09-26T14:00:00Z'});
  await commit('reverse',{prior:{episodeId:reverseBase.row.episode_id,expectedRevision:1,sourceRefs:[evidence.item.ref]},
    opposite:{identity:{...reverseIdentity,direction:'HIGHER'},data:{episode_type:'METRIC_DEVIATION'},evidenceItemId:evidence.item.row.evidence_item_id},
    semanticAt:'2026-09-26T14:00:00Z'});
  const restarted=await f.restart();f.stores=restarted.stores;f.context=undefined;f.setNow('2026-10-01T12:00:00Z');
  const before=await counts(f);
  for(const {method,req,result} of operations)assert.deepEqual(semantic(await call(f,'episodes',method,req)),semantic(result),method);
  assert.deepEqual(semantic(await call(f,'episodes','semantic',retry)),semantic(originalSemantic));
  assert.deepEqual(await counts(f),before);
  for(const bad of ['2020-01-01T00:00:00Z','2027-01-01T00:00:00Z'])
    await assert.rejects(call(f,'episodes','revise',{...base,expectedRevision:4,toState:'RESOLVED',reasonCode:'NEW_EVIDENCE',semanticAt:bad}),/CHRONOLOGY|TERMINAL/);
  assert.deepEqual(await counts(f),before);
});

test('A/C: Body retained audit requires its full receipt and every physical root',async t=>{
  const f=await setup(t),req={asOfEpochMs:Date.parse(T),targetHealthDate:'2026-09-25'};
  const original=await call(f,'bodyEnergy','compute',req);
  const checkpoint=await call(f,'bodyEnergy','checkpoint',{bucketStart:Date.parse(T)-900000});
  const audit=()=>f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.audit(c,original.row.result_id));
  assert.equal((await audit()).row.result_id,original.row.result_id);
  assert.deepEqual(semantic(await call(f,'bodyEnergy','compute',req)),semantic(original));
  assert.equal((await read(f,'body_energy_checkpoints',{checkpoint_id:checkpoint.row.checkpoint_id})).row.result_id,original.row.result_id);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  assert.deepEqual((await audit()).calculation,original.calculation,'retained historical authority does not issue a current capability');
  await f.db.raw.execute("DELETE FROM whoop_sleeps WHERE user_id='a' AND id='sleep-00'");
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE source_type='sleep' AND source_id='sleep-00'");
  await assert.rejects(audit(),/SOURCE_NOT_FOUND/);
});

test('A/J: independent reconfirmation, weakened recovery and direct lifecycle retries retain full insight projections',async t=>{
  const f=await associationSetup(t,{days:90}),operations=[];
  // Transaction timestamps are prepared before any authority exists. Each
  // 30-day input was available at the end of its own historical window.
  await f.db.raw.execute('UPDATE whoop_recoveries SET synced_at=updated_at');
  await f.db.raw.execute('UPDATE journal_events SET created_at=event_at,updated_at=event_at');
  const allFactRefs=f.factRefs;
  async function window(name,start) {
    const indexes=Array.from({length:30},(_,i)=>start+i),h=hypothesis(f,indexes);
    const last=f.input.sources.recovery[start].health_date,first=f.input.sources.recovery[start+29].health_date;
    const id=await insertCoverage(f,{startDate:addDays(first,-1),endDate:addDays(last,-1),id:`lifecycle-${name}`});
    await f.db.raw.execute({sql:'UPDATE journal_coverage_windows SET created_at=window_end_utc,updated_at=window_end_utc WHERE coverage_window_id=?',args:[id]});
    const c=await f.stores.capture('a',{executionMode:'SHADOW'}),coverage=(await f.stores.root(c,'JOURNAL_COVERAGE',id)).ref;
    await f.stores.release(c);
    return family(name,{...h,journalFactSources:allFactRefs,coverageSources:[coverage]},`${last}T12:00:00Z`);
  }
  const oldest=await window('oldest',60),middle=await window('middle',30),newest=await window('newest',0);
  async function commit(group,method,req) {
    const result=await call(f,group,method,req);operations.push({group,method,req,result});return result;
  }
  const first=await commit('intelligence','analyzeAssociationFamily',oldest);
  const second=await commit('intelligence','analyzeAssociationFamily',middle),supported=second.items[0].insight.current;
  assert.equal(first.items[0].insight.current.row.status,'EMERGING');assert.equal(supported.row.status,'SUPPORTED');
  const repeated=await commit('intelligence','analyzeAssociationFamily',{...middle,multipleTestingFamily:'same-window-resample'});
  assert.equal(repeated.items[0].insight.current.row.current_revision,supported.row.current_revision);
  const sameWindow={insightId:supported.row.id,expectedRevision:supported.row.current_revision,status:'SUPPORTED',
    claim:supported.row.statement,supportingEvidenceIds:JSON.parse(supported.revision.supporting_evidence_ids_json),reason:'REPLICATED_SUPPORT',semanticAt:middle.asOfUtc};
  await assert.rejects(call(f,'insights','transition',sameWindow),/INDEPENDENT_REPLICATION_REQUIRED/);
  const reconfirmed=await commit('intelligence','analyzeAssociationFamily',newest),current=reconfirmed.items[0].insight.current;
  assert.equal(current.row.status,'SUPPORTED');assert.equal(current.row.current_revision,supported.row.current_revision+1);
  assert.equal(current.row.last_confirmed_at,T);
  const support=JSON.parse(current.revision.supporting_evidence_ids_json),item=reconfirmed.items[0].item.row.evidence_item_id;
  const direct=await commit('insights','create',{identity:{subject:'direct-caffeine',outcome:'recovery_score',direction:'LOWER',
    exposureCategory:'caffeine',algorithmFamily:'JOURNAL_ASSOCIATION',evidenceContractMajor:'phase4-evidence-v1'},
    claim:'A separate direct lifecycle assertion',evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[item],
    expiresAt:'2026-10-01T12:00:00Z',creationKey:'full-direct-create',semanticAt:T});
  await commit('insights','transition',{insightId:direct.row.id,expectedRevision:1,status:'EMERGING',claim:direct.row.statement,
    supportingEvidenceIds:[item],reason:'REPEATED_EVIDENCE',semanticAt:T});
  const weakened=await commit('insights','transition',{insightId:current.row.id,expectedRevision:current.row.current_revision,status:'WEAKENED',
    claim:current.row.statement,supportingEvidenceIds:support,contradictingEvidenceIds:[item],reason:'CONTRADICTORY_EVIDENCE',semanticAt:T});
  assert.equal(weakened.row.status,'WEAKENED');
  const recovered=await commit('intelligence','analyzeAssociationFamily',{...newest,multipleTestingFamily:'recovery-window'});
  assert.equal(recovered.items[0].insight.current.row.id,current.row.id);assert.equal(recovered.items[0].insight.current.row.status,'EMERGING');
  const recoveredCurrent=recovered.items[0].insight.current;
  for(const bad of ['2020-01-01T00:00:00Z','2027-01-01T00:00:00Z'])
    await assert.rejects(call(f,'insights','transition',{...sameWindow,expectedRevision:recoveredCurrent.row.current_revision,status:'RETIRED',
      disposition:'REFUTED',reason:'REFUTED',semanticAt:bad}),/CHRONOLOGY/);
  await commit('insights','transition',{insightId:current.row.id,expectedRevision:recoveredCurrent.row.current_revision,status:'RETIRED',
    disposition:'REFUTED',claim:current.row.statement,supportingEvidenceIds:support,contradictingEvidenceIds:[item],reason:'REFUTED',semanticAt:T});
  const incarnation=await commit('intelligence','analyzeAssociationFamily',{...newest,multipleTestingFamily:'post-refutation'});
  assert.notEqual(incarnation.items[0].insight.current.row.id,current.row.id);
  assert.equal(incarnation.items[0].insight.current.row.supersedes_id,current.row.id);
  const next=incarnation.items[0].insight.current;
  const expiry=new Date(Date.parse(next.row.expires_at)+1).toISOString();f.setNow(expiry);
  await commit('intelligence','expireInsight',{insightId:next.row.id,asOfUtc:expiry});
  const restarted=await f.restart();f.stores=restarted.stores;f.context=undefined;f.setNow('2027-03-01T12:00:00Z');
  const before=await counts(f);
  for(const op of operations)assert.deepEqual(semantic(await call(f,op.group,op.method,op.req)),semantic(op.result),op.method);
  assert.deepEqual(await counts(f),before);
});
