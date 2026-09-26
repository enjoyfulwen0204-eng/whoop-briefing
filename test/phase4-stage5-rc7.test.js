import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setup,request,recoveryRefs,progressOneDay } from './stage5HistoryFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { buildPersonalBaseline } from '../src/phase4Intelligence.js';
import { canonicalJson } from '../src/phase4EntityStore.js';

const TABLE='phase4_evidence_result_authorities',T='2026-09-25T12:00:00.000Z';
const first=f=>f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));
export async function guards(f,table) {
  const rows=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;
  for(const row of rows)await f.db.raw.execute(`DROP TRIGGER ${row.name}`);
  return async()=>{for(const row of rows)await f.db.raw.execute(row.sql);};
}
// Exact durable rows, including content, rather than counts alone. Context lease
// bookkeeping is excluded because a read necessarily captures/releases a lease.
async function durable(f) {
  const result={};
  for(const table of ['evidence_runs','evidence_items','observation_episodes','episode_evidence','episode_events',
    'phase4_episode_revisions',TABLE,'health_insights','insight_revisions','phase4_source_links',
    'journal_events','journal_coverage_windows','whoop_recoveries','health_purge_targets',
    'phase4_computation_state','phase4_user_state'])
    result[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows.map(r=>canonicalJson({...r})).sort();
  return result;
}
async function purge(f,key='rc7') {
  const control=await f.stores.capturePrivacyControl('a'),p=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:key});
  await f.stores.privacy.redact(control,p.purge_id);
  await f.stores.privacy.redact(control,p.purge_id);
  return {control,p};
}
const indexes=Array.from({length:30},(_,i)=>i);

test('RC6-H-001 generic history cannot downgrade root authority through algorithm metadata',async t=>{
  const f=await setup(t),a=await first(f),root=f.recoveryIds.at(-1);
  await f.db.raw.execute({sql:"DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[root]});
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id=?",args:[root]});
  const restore=await guards(f,'evidence_runs');
  await f.db.raw.execute("UPDATE evidence_runs SET algorithm_version='unknown-rc7'");await restore();
  const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'}),before=await durable(f);
  await assert.rejects(restarted.stores.episodes.readRevision(c,{episodeId:a.episode.episode.row.episode_id,revision:1}),
    /SOURCE_NOT_FOUND|AUTHORITY_UNAVAILABLE|BINDING_INVALID|UNSUPPORTED/);
  assert.deepEqual(await durable(f),before);
});

test('RC6-H-002 real Journal purge reaches authenticated insight target after evidence edge loss',async t=>{
  const f=await associationSetup(t),a=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('edge-loss',hypothesis(f,indexes)));
  const ir=a.items[0].insight.current.revision;
  assert.ok(ir.normalized_claim);
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE artifact_type='insight_revisions' AND source_type='evidence_items'");
  await purge(f);
  const row=(await f.db.raw.execute({sql:'SELECT * FROM insight_revisions WHERE user_id=? AND insight_id=? AND revision=?',args:['a',ir.insight_id,ir.revision]})).rows[0];
  assert.equal(row.content_state,'REDACTED');assert.equal(row.normalized_claim,null);
});

test('RC6-H-003 parseable manifest with invalid HMAC cannot veto Journal purge',async t=>{
  const f=await associationSetup(t);await f.stores.intelligence.analyzeAssociationFamily(f.context,family('corrupt-manifest',hypothesis(f,indexes)));
  const root=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[f.logicalFacts[0]]})).rows[0].privacy_artifact_id;
  const restore=await guards(f,TABLE),rows=(await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows;
  for(const row of rows) {
    const m=JSON.parse(row.required_roots_json);assert.ok(m.roots.some(r=>r.id===root));m.roots=m.roots.filter(r=>r.id!==root);
    await f.db.raw.execute({sql:`UPDATE ${TABLE} SET required_roots_json=? WHERE evidence_item_id=? AND result_scope=?`,
      args:[canonicalJson(m),row.evidence_item_id,row.result_scope]});
  }
  await restore();
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE source_id=?",args:[root]});
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE artifact_type='insight_revisions' AND source_type='evidence_items'");
  await purge(f);
  for(const row of (await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows)assert.equal(row.content_state,'REDACTED');
  for(const row of (await f.db.raw.execute('SELECT * FROM insight_revisions')).rows)assert.equal(row.normalized_claim,null);
});

test('RC6-M-001 degraded authenticated null result replays exact calculation after restart',async t=>{
  const f=await setup(t);await first(f);
  // New observation, same semantic deviation, one unknown baseline version.
  const row=(await f.db.raw.execute("SELECT * FROM whoop_recoveries WHERE sleep_id='sleep-30' AND user_id='a'")).rows[0];
  const copy={...row,sleep_id:'degraded-baseline',updated_at:null};
  await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(${Object.keys(copy).join(',')}) VALUES (${Object.keys(copy).map(()=>'?').join(',')})`,args:Object.values(copy)});
  const ids=[...f.recoveryIds.slice(1,30),'degraded-baseline'];
  const original=await progressOneDay(f,'degraded-current',{value:15,baselineIds:ids});
  assert.equal(original.episode,null);assert.equal(original.calculation.classification,'INSUFFICIENT_QUALITY');
  f.setNow('2026-10-01T12:00:00.000Z');const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  const refs=await recoveryRefs(restarted.stores,c,['degraded-current',...ids]),before=await durable(f);
  const replay=await restarted.stores.intelligence.analyzeMetric(c,request(refs[0],refs.slice(1),'2026-09-26T12:00:00.000Z'));
  assert.deepEqual(replay.calculation,original.calculation);assert.equal(replay.episode,null);assert.deepEqual(await durable(f),before);
});

test('RC6-M-002 historical insight calculation time belongs to original revision',async t=>{
  const f=await associationSetup(t);
  await f.stores.intelligence.analyzeAssociationFamily(f.context,family('time-old',hypothesis(f,indexes.map(i=>i+30))));
  const a=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('time-new',hypothesis(f,indexes)));
  assert.equal(a.items[0].insight.current.row.last_recalculated_at,T);
  f.setNow('2026-09-26T12:00:00.000Z');const c=await f.stores.capture('a',{executionMode:'SHADOW'});
  const later={...f,outcomeRefs:await recoveryRefs(f.stores,c,f.input.sources.recovery.map(r=>r.sleep_id)),factRefs:[],coverageRef:(await f.stores.root(c,'JOURNAL_COVERAGE','coverage-caffeine')).ref};
  for(const row of (await f.db.raw.execute("SELECT privacy_artifact_id FROM journal_events WHERE user_id='a' ORDER BY health_date")).rows)later.factRefs.push((await f.stores.root(c,'JOURNAL_FACT',row.privacy_artifact_id)).ref);
  const req=family('time-later',hypothesis(later,indexes),'2026-09-26T12:00:00.000Z');
  const original=await f.stores.intelligence.analyzeAssociationFamily(c,req);
  assert.equal(original.items[0].insight.current.row.last_recalculated_at,T);
  const before=await durable(f),replay=await f.stores.intelligence.analyzeAssociationFamily(c,req);
  assert.equal(replay.items[0].insight.current.row.last_recalculated_at,T);assert.deepEqual(await durable(f),before);
  f.setNow('2026-09-27T12:00:00.000Z');const restarted=await f.restart(),c3=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  const day3={...f,outcomeRefs:await recoveryRefs(restarted.stores,c3,f.input.sources.recovery.map(r=>r.sleep_id)),factRefs:[],
    coverageRef:(await restarted.stores.root(c3,'JOURNAL_COVERAGE','coverage-caffeine')).ref};
  for(const row of (await f.db.raw.execute("SELECT privacy_artifact_id FROM journal_events WHERE user_id='a' ORDER BY health_date")).rows)
    day3.factRefs.push((await restarted.stores.root(c3,'JOURNAL_FACT',row.privacy_artifact_id)).ref);
  const before3=await durable(f),replay3=await restarted.stores.intelligence.analyzeAssociationFamily(c3,
    family('time-later',hypothesis(day3,indexes),'2026-09-26T12:00:00.000Z'));
  assert.equal(replay3.items[0].insight.current.row.last_recalculated_at,T);assert.deepEqual(await durable(f),before3);
});

test('RC6-M-003 equivalent source version instants preserve baseline selection',()=>{
  const observation=(id,updated,value)=>({sourceId:id,sourceType:'recovery',sourceVersion:canonicalJson([updated,T,null,'SCORED']),
    healthDate:'2026-09-24',observedAt:'2026-09-24T12:00:00.000Z',ingestedAt:T,value});
  const run=updated=>buildPersonalBaseline({metricKey:'recovery_score',targetHealthDate:'2026-09-25',asOfUtc:T,
    observations:[observation('a',updated,10),observation('b','2026-09-24T12:00:00.000Z',90)]});
  const original=run('2026-09-24T12:00:00.000Z');
  for(const value of ['2026-09-24T05:00:00.000-07:00','2026-09-24T19:00:00.000+07:00'])assert.deepEqual(run(value),original);
});

test('RC6-M-004 coverage self-cycle returns explicit integrity error promptly',()=>{
  const result=spawnSync(process.execPath,['test/rc7CoverageProbe.js','1'],{encoding:'utf8',timeout:20000,killSignal:'SIGKILL'});
  assert.equal(result.error?.code,undefined,`Expected PHASE4_COVERAGE_LINEAGE_INVALID; child ${result.error?.code}`);
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PHASE4_COVERAGE_LINEAGE_INVALID/);
});

test('RC7 generic history validates known, unknown and malformed registration versions without writes',async t=>{
  const f=await setup(t),a=await first(f),restore=await guards(f,'evidence_runs');
  for(const version of ['phase4-intelligence-v1','unknown','{malformed']) {
    await f.db.raw.execute({sql:'UPDATE evidence_runs SET algorithm_version=?,method=?',args:[version,'UNKNOWN_METHOD']});
    const before=await durable(f);
    const result=await f.stores.episodes.readRevision(f.context,{episodeId:a.episode.episode.row.episode_id,revision:1});
    assert.equal(result.row.revision,1);assert.deepEqual(await durable(f),before);
  }
  await restore();
  const restoreAuthority=await guards(f,TABLE);await f.db.raw.execute(`DELETE FROM ${TABLE}`);await restoreAuthority();
  const before=await durable(f);
  await assert.rejects(f.stores.episodes.readRevision(f.context,{episodeId:a.episode.episode.row.episode_id,revision:1}),/AUTHORITY_UNAVAILABLE/);
  assert.deepEqual(await durable(f),before);
});

test('RC7 no-change and warming null projections survive later episode state and a different clock',async t=>{
  for(const kind of ['no-change','warming'])await t.test(kind,async t=>{
    const f=await setup(t);
    if(kind==='no-change')await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=50 WHERE user_id='a' AND sleep_id='sleep-00'");
    const ids=kind==='warming'?[f.recoveryIds[0]]:f.recoveryIds,refs=await recoveryRefs(f.stores,f.context,ids);
    const original=await f.stores.intelligence.analyzeMetric(f.context,request(refs[0],refs.slice(1)));
    assert.equal(original.episode,null);
    assert.equal(original.quality.status,kind==='warming'?'WARMING_UP':'AVAILABLE');
    await progressOneDay(f);
    f.setNow('2026-10-02T00:00:00.000Z');const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'});
    const again=await recoveryRefs(restarted.stores,c,ids),before=await durable(f);
    const replay=await restarted.stores.intelligence.analyzeMetric(c,request(again[0],again.slice(1)));
    assert.deepEqual(replay.calculation,original.calculation);assert.deepEqual(replay.quality,original.quality);
    assert.equal(replay.episode,null);assert.deepEqual(await durable(f),before);
  });
});

test('RC7 legacy signed null is unavailable; corrupt projection cannot authenticate or mutate on read',async t=>{
  const f=await setup(t),req=request(f.initialRefs[0],[]),original=await f.stores.intelligence.analyzeMetric(f.context,req);
  assert.equal(original.episode,null);
  const row=(await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows[0];
  const patch=async value=>{const restore=await guards(f,TABLE);await f.db.raw.execute({sql:`UPDATE ${TABLE} SET original_result_json=?,authority_hmac=?`,args:[value.original_result_json,value.authority_hmac]});await restore();};
  const corrupt={...row,original_result_json:canonicalJson({...JSON.parse(row.original_result_json),calculation:{classification:'FORGED',targetEpisodeState:null}})};
  await patch(corrupt);let before=await durable(f);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context,req),/BINDING_INVALID/);assert.deepEqual(await durable(f),before);
  const legacy={...row,original_result_json:'null'};
  const fields=Object.fromEntries(Object.entries(legacy).filter(([k])=>!['authority_hmac','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at'].includes(k)));
  legacy.authority_hmac=f.keys.digest(legacy.content_digest_salt,canonicalJson(['evidence-result-authority-v1',fields]));
  await patch(legacy);before=await durable(f);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context,req),/AUTHORITY_UNAVAILABLE/);assert.deepEqual(await durable(f),before);
});

test('RC7 source timestamp representation and permutation preserve manifest, identity, provenance and replay',async t=>{
  const f=await setup(t),duplicates=[];
  for(const row of (await f.db.raw.execute("SELECT * FROM whoop_recoveries WHERE user_id='a' AND sleep_id<>'sleep-00' ORDER BY sleep_id")).rows) {
    const copy={...row,sleep_id:`zz-${row.sleep_id}`,recovery_score:90};duplicates.push(copy.sleep_id);
    await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(${Object.keys(copy).join(',')}) VALUES (${Object.keys(copy).map(()=>'?').join(',')})`,args:Object.values(copy)});
  }
  f.recoveryIds.push(...duplicates);f.initialRefs=await recoveryRefs(f.stores,f.context,f.recoveryIds);
  const a=await first(f);assert.equal(a.baseline.median,50);assert.equal(a.calculation.classification,'NEW_CHANGE');
  const iso=(value,offset)=>new Date(Date.parse(value)+offset*3600000).toISOString().replace('Z',`${offset<0?'-':'+'}07:00`);
  for(const offset of [-7,7]) {
    for(const row of (await f.db.raw.execute("SELECT * FROM whoop_recoveries WHERE user_id='a' AND sleep_id NOT LIKE 'zz-%'")).rows)
      await f.db.raw.execute({sql:'UPDATE whoop_recoveries SET updated_at=?,synced_at=? WHERE user_id=? AND sleep_id=?',
        args:[iso(row.updated_at,offset),iso(row.synced_at,offset),'a',row.sleep_id]});
    const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(restarted.stores,c,f.recoveryIds);
    const before=await durable(f),b=await restarted.stores.intelligence.analyzeMetric(c,request(refs[0],refs.slice(1).reverse()));
    for(const key of ['baseline','quality','calculation'])assert.deepEqual(b[key],a[key]);
    for(const key of ['run_id','deterministic_run_key','input_manifest_json','input_manifest_hash'])assert.equal(b.run.row[key],a.run.row[key]);
    assert.equal(b.item.row.evidence_item_id,a.item.row.evidence_item_id);assert.equal(b.item.row.provenance_json,a.item.row.provenance_json);
    assert.deepEqual(await durable(f),before);
  }
});

test('RC7 real source-version changes and opaque versions are not over-normalized',async()=>{
  const {canonicalSourceVersion}=await import('../src/phase4SourceVersion.js');
  const tuple=value=>canonicalJson([value,T,null,'SCORED']);
  assert.notEqual(canonicalSourceVersion(tuple(T)),canonicalSourceVersion(tuple('2026-09-25T12:00:00.001Z')));
  assert.notEqual(canonicalSourceVersion(tuple(T)),canonicalSourceVersion(canonicalJson([T,T,null,'PENDING'])));
  for(const value of ['opaque-v1','2026-09-25T05:00:00-07:00','["bad",null,null,"SCORED"]'])assert.equal(canonicalSourceVersion(value),value);
});

test('RC7 coverage two-node and three-node cycles reject explicitly after restart',()=>{
  for(const size of [2,3]) {
    const result=spawnSync(process.execPath,['test/rc7CoverageProbe.js',String(size)],{encoding:'utf8',timeout:20000,killSignal:'SIGKILL'});
    assert.equal(result.error?.code,undefined);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PHASE4_COVERAGE_LINEAGE_INVALID/);
  }
});

test('RC7 long coverage lineage, shared predecessor and missing predecessor have deterministic semantics',async t=>{
  const f=await associationSetup(t,{days:2,createFacts:false});
  const original=(await f.db.raw.execute("SELECT * FROM journal_coverage_windows WHERE user_id='a'")).rows[0],rows=[];
  await f.db.transaction(async()=>{
    for(let i=1;i<=150;i++) {
      const row={...original,coverage_window_id:`chain-${i}`,supersedes_coverage_window_id:i===1?original.coverage_window_id:`chain-${i-1}`,
        source_event_key:`chain-source-${i}`,privacy_artifact_id:`chain-artifact-${i}`,revision:i+1,created_at:new Date(Date.parse(T)+i).toISOString()};
      await f.db.raw.execute({sql:`INSERT INTO journal_coverage_windows(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});rows.push(row);
    }
    const branch={...rows[0],coverage_window_id:'branch',source_event_key:'branch-source',privacy_artifact_id:'branch-artifact'};
    await f.db.raw.execute({sql:`INSERT INTO journal_coverage_windows(${Object.keys(branch).join(',')}) VALUES (${Object.keys(branch).map(()=>'?').join(',')})`,args:Object.values(branch)});
  });
  f.setNow('2026-09-26T00:00:00.000Z');const {core,stores}=await f.restart(),c=await stores.capture('a',{executionMode:'SHADOW'});
  const source=(await stores.root(c,'JOURNAL_COVERAGE','chain-150')).ref;
  const historical=await core.journalSourcesAsOf(c,[source],new Date(Date.parse(T)+75).toISOString());
  assert.equal(historical[0].id,'chain-75');
  const branch=await core.validateHistoricalJournal(c,{type:'JOURNAL_COVERAGE',id:'branch',historicalAsOf:'2026-09-26T00:00:00.000Z',row:null});
  assert.equal(branch.coverage_window_id,'branch');
  await f.db.raw.execute("UPDATE journal_coverage_windows SET supersedes_coverage_window_id='missing' WHERE coverage_window_id='branch'");
  await assert.rejects(core.validateHistoricalJournal(c,{type:'JOURNAL_COVERAGE',id:'branch',historicalAsOf:'2026-09-26T00:00:00.000Z',row:null}),/COVERAGE_LINEAGE_INVALID/);
});

test('RC7 authenticated METRIC result participates in Journal purge after root and episode edge loss',async t=>{
  for(const attack of ['edge-loss','corrupt-transitive-authority'])await t.test(attack,async t=>{
  const f=await setup(t),control=await f.stores.captureControl('a'),sourceText='caffeine at 2026-09-25T10:00:00.000Z';
  const fact=await f.stores.journal.create(control,{sourceEventKey:'metric-journal',sourceText,candidate:{category:'caffeine',
    eventAt:'2026-09-25T10:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
  assert.equal(fact.status,'ACCEPT');f.logicalFacts=[fact.logicalFactId];
  f.context=await f.stores.capture('a',{executionMode:'SHADOW'});f.initialRefs=await recoveryRefs(f.stores,f.context,f.recoveryIds);
  const a=await first(f),root=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[fact.logicalFactId]})).rows[0].privacy_artifact_id;
  const j=(await f.stores.root(f.context,'JOURNAL_FACT',root)).ref;
  await f.stores.episodes.revise(f.context,{episodeId:a.episode.episode.row.episode_id,expectedRevision:1,toState:'EXPLAINED',
    patch:{explained_status:1,explanation_evidence_item_id:a.item.row.evidence_item_id,explanation_context_id:'rc7-journal-context',explanation_json:{journal:'sensitive'}},sourceRefs:[j,a.item.ref],reasonCode:'CURRENT_EXPLANATION',semanticAt:T});
  const b=await progressOneDay(f),authority=(await f.db.raw.execute({sql:`SELECT * FROM ${TABLE} WHERE evidence_item_id=?`,args:[b.item.row.evidence_item_id]})).rows[0];
  assert.ok(JSON.parse(authority.required_roots_json).roots.some(r=>r.id===root));
  if(attack==='corrupt-transitive-authority') {
    const restore=await guards(f,TABLE),manifest=JSON.parse(authority.required_roots_json);
    manifest.roots=manifest.roots.filter(r=>r.id!==root);
    await f.db.raw.execute({sql:`UPDATE ${TABLE} SET required_roots_json=? WHERE evidence_item_id=?`,args:[canonicalJson(manifest),b.item.row.evidence_item_id]});
    await restore();
  }
  await f.db.raw.execute({sql:'DELETE FROM phase4_source_links WHERE source_id=?',args:[root]});
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE artifact_type LIKE 'episode_%' AND source_type='evidence_items'");
  await purge(f,'metric-target');
  for(const row of (await f.db.raw.execute('SELECT * FROM phase4_episode_revisions')).rows)assert.equal(row.snapshot_json,null);
  assert.equal((await f.db.raw.execute({sql:`SELECT content_state FROM ${TABLE} WHERE evidence_item_id=?`,args:[b.item.row.evidence_item_id]})).rows[0].content_state,'REDACTED');
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');assert.equal((await f.db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
  });
});

test('RC7 both insight result scopes and transitive association targets purge without mutable revision edges',async t=>{
  const f=await associationSetup(t),oldFacts=[],newFacts=[];
  for(const fact of (await f.db.raw.execute("SELECT * FROM journal_events WHERE user_id='a' ORDER BY health_date")).rows) {
    const ref=(await f.stores.root(f.context,'JOURNAL_FACT',fact.privacy_artifact_id)).ref;
    (fact.health_date<f.input.sources.recovery[30].health_date?oldFacts:newFacts).push(ref);
  }
  const old=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('scope-old',
    {...hypothesis(f,indexes.map(i=>i+30)),journalFactSources:oldFacts}));
  const newer=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('scope-new',
    {...hypothesis(f,indexes),journalFactSources:newFacts}));
  // Purge an older fact absent from B's direct input manifest: J reaches B only
  // through its inherited A/insight support, then reaches both result targets.
  f.logicalFacts=[f.logicalFacts[15]];
  const transitiveRoot=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[f.logicalFacts[0]]})).rows[0].privacy_artifact_id;
  assert.ok(!JSON.parse(newer.runs[0].row.input_manifest_json).hypotheses[0].journal_authority.some(r=>r.id===transitiveRoot));
  const opposite=[];
  for(const index of indexes) {
    const source=f.input.sources.recovery[index],id=`rc7-opposite-${index}`;
    await f.db.raw.execute({sql:"INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a',?,?,'SCORED',?,50,60,0,?,?)",args:[id,source.health_date,index%2?40:60,source.updated_at,source.synced_at]});
    opposite.push((await f.stores.root(f.context,'recovery',id)).ref);
  }
  const a=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('scope-opposite',{...hypothesis(f,indexes),outcomeSources:opposite,journalFactSources:newFacts}));
  assert.ok(a.items[0].insight.current);assert.ok(a.items[0].insight.contradiction);
  const rows=(await f.db.raw.execute({sql:`SELECT * FROM ${TABLE} WHERE evidence_item_id=?`,args:[a.items[0].item.row.evidence_item_id]})).rows;
  assert.deepEqual(rows.map(r=>r.result_scope).sort(),['INSIGHT_CONTRADICTION','INSIGHT_CURRENT']);
  assert.ok(rows.some(r=>JSON.parse(r.required_roots_json).roots.some(root=>root.id===old.items[0].item.row.privacy_artifact_id)));
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE artifact_type='insight_revisions' AND source_type='evidence_items'");
  const root=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[f.logicalFacts[0]]})).rows[0].privacy_artifact_id;
  await f.db.raw.execute({sql:'DELETE FROM phase4_source_links WHERE source_id=?',args:[root]});
  await purge(f,'all-scopes');
  for(const row of (await f.db.raw.execute('SELECT * FROM insight_revisions')).rows)assert.equal(row.normalized_claim,null);
  for(const row of (await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows)assert.equal(row.content_state,'REDACTED');
});

test('RC7 corrupt-authority privacy is scoped, atomic, monotonic and unreadable after completion',async t=>{
  const {syntheticEvidence}=await import('./stage5HistoryFixture.js');
  const {createResultAuthority}=await import('../src/phase4ResultAuthority.js');
  const f=await associationSetup(t),result=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('atomic',hypothesis(f,indexes)));
  const b=await f.stores.capture('b',{executionMode:'SHADOW'});await syntheticEvidence(f,b,'unrelated-user');
  await f.stores.initializeTenant('a','LIVE');const live=await f.stores.capture('a',{executionMode:'LIVE'});await syntheticEvidence(f,live,'unrelated-mode');
  const unrelated=async()=> (await f.db.raw.execute("SELECT * FROM evidence_items WHERE user_id='b' OR execution_mode='LIVE'")).rows;
  const unrelatedBefore=await unrelated(),restore=await guards(f,TABLE);
  await f.db.raw.execute(`UPDATE ${TABLE} SET authority_hmac='${'0'.repeat(64)}'`);await restore();
  let before=await durable(f);
  await assert.rejects(createResultAuthority(f.core).read(f.context,result.items[0].item.row.evidence_item_id,'INSIGHT_CURRENT'),/BINDING_INVALID/);
  assert.deepEqual(await durable(f),before);
  const control=await f.stores.capturePrivacyControl('a'),p=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'atomic-corrupt'});
  const execute=f.db.raw.execute.bind(f.db.raw);let injected=false;before=await durable(f);
  f.db.raw.execute=async statement=>{const value=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&sql.startsWith('UPDATE insight_revisions SET')){injected=true;throw Error('RC7_REDACTION_INJECTED');}return value;};
  try {await assert.rejects(f.stores.privacy.redact(control,p.purge_id),/RC7_REDACTION_INJECTED/);}finally{f.db.raw.execute=execute;}
  assert.equal(injected,true);assert.deepEqual(await durable(f),before);assert.equal((await f.stores.privacy.status(control,p.purge_id)).state,'ADMITTED');
  await f.stores.privacy.redact(control,p.purge_id);await f.stores.privacy.redact(control,p.purge_id);
  await f.stores.release(f.context);await f.stores.release(live);await f.stores.privacy.complete(control,p.purge_id);
  assert.deepEqual(await unrelated(),unrelatedBefore);
  const c=await f.stores.capture('a',{executionMode:'SHADOW'}),restarted=await f.restart(),fresh=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  before=await durable(f);
  await assert.rejects(createResultAuthority(restarted.core).read(fresh,result.items[0].item.row.evidence_item_id,'INSIGHT_CURRENT'),/CONTENT_REDACTED/);
  assert.deepEqual(await durable(f),before);
  await assert.rejects(f.db.raw.execute(`UPDATE ${TABLE} SET content_state='PRESENT'`),/content_redacted|parent/);
  await assert.rejects(f.stores.insights.read(c,result.items[0].insight.current.row.id,{history:true}),/CONTENT_REDACTED/);
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');assert.equal((await f.db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
});

test('RC7 unauthenticated fallback aborts purge atomically and never reports completion',async t=>{
  const f=await associationSetup(t);await f.stores.intelligence.analyzeAssociationFamily(f.context,family('invalid-fallback',hypothesis(f,indexes)));
  const restore=await guards(f,TABLE),restoreRun=await guards(f,'evidence_runs');
  await f.db.raw.execute(`UPDATE ${TABLE} SET authority_hmac='${'0'.repeat(64)}'`);
  await f.db.raw.execute("UPDATE evidence_runs SET input_manifest_hash='invalid'");await restore();await restoreRun();
  const control=await f.stores.capturePrivacyControl('a'),p=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'invalid-fallback'}),before=await durable(f);
  await assert.rejects(f.stores.privacy.redact(control,p.purge_id),/PHASE4_PURGE_AUTHORITY_INVALID/);
  assert.deepEqual(await durable(f),before);assert.equal((await f.stores.privacy.status(control,p.purge_id)).state,'ADMITTED');
  await assert.rejects(f.stores.privacy.complete(control,p.purge_id),/PURGE_CONTENT_PENDING/);
  await assert.rejects(f.stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
});

test('RC7 generic metric history also requires supplemental evidence authority regardless of registration',async t=>{
  const {syntheticEvidence}=await import('./stage5HistoryFixture.js');
  const f=await setup(t),a=await first(f),b=await syntheticEvidence(f,f.context,'unauthorized-supplement');
  await f.stores.episodes.revise(f.context,{episodeId:a.episode.episode.row.episode_id,expectedRevision:1,toState:'OPEN',
    patch:{current_confidence:.8},sourceRefs:[a.item.ref,b.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T});
  for(const version of ['phase4-intelligence-v1','unknown']) {
    const restore=await guards(f,'evidence_runs');
    await f.db.raw.execute({sql:'UPDATE evidence_runs SET algorithm_version=? WHERE run_id=?',args:[version,b.row.run_id]});await restore();
    const before=await durable(f);
    await assert.rejects(f.stores.episodes.readRevision(f.context,{episodeId:a.episode.episode.row.episode_id,revision:2}),/AUTHORITY_UNAVAILABLE/);
    assert.deepEqual(await durable(f),before);
  }
});
