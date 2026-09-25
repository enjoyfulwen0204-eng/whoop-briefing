import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request,replayInitial,syntheticEvidence,historyCounts,progressOneDay,recoveryRefs,semanticProjection } from './stage5HistoryFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { createResultAuthority } from '../src/phase4ResultAuthority.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { evaluateJournalAssociation } from '../src/phase4Intelligence.js';

const TABLE='phase4_evidence_result_authorities',T='2026-09-25T12:00:00.000Z';
const first=f=>f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));
const authorityRows=f=>f.db.raw.execute(`SELECT * FROM ${TABLE} ORDER BY evidence_item_id,result_scope`).then(r=>r.rows);
const count=async f=>({...await historyCounts(f.db),authorities:await authorityRows(f)});
const rawInsert=(f,row,verb='INSERT')=>f.db.raw.execute({sql:`${verb} INTO ${TABLE}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});
async function guards(f,table) {
  const rows=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;
  for(const row of rows)await f.db.raw.execute(`DROP TRIGGER ${row.name}`);
  return async()=>{for(const row of rows)await f.db.raw.execute(row.sql);};
}
async function patchAuthority(f,patch) {
  await f.db.transaction(async()=>{
    await f.db.raw.execute('PRAGMA ignore_check_constraints=ON');
    await f.db.raw.execute({sql:`UPDATE ${TABLE} SET ${Object.keys(patch).map(k=>`${k}=?`).join(',')}`,args:Object.values(patch)});
    await f.db.raw.execute('PRAGMA ignore_check_constraints=OFF');
  });
}

test('RC6 original A→R1 remains immutable through legitimate R2/R3/R4 reuse and restarted exact retries',async t=>{
  const f=await setup(t),a=await first(f),origin=(await authorityRows(f))[0],id=a.episode.episode.row.episode_id;
  assert.equal(JSON.parse(origin.original_result_json).revision,1);
  for(let revision=1;revision<=3;revision++) {
    const b=await syntheticEvidence(f,f.context,`reused-${revision}`);
    await f.stores.episodes.revise(f.context,{episodeId:id,expectedRevision:revision,toState:'OPEN',
      patch:{current_confidence:.8-revision/10},sourceRefs:[a.item.ref,b.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T});
    const restarted=await f.restart(),before=await count(f);
    const replay=await replayInitial(f,'a',f.recoveryIds,restarted.stores);
    assert.deepEqual(semanticProjection(replay.episode.episode.row),semanticProjection(a.episode.episode.row));
    assert.deepEqual((await authorityRows(f))[0],origin);assert.deepEqual(await count(f),before);
  }
});

test('RC6 historical calculation context cannot be reselected by another item’s forged membership',async t=>{
  const f=await setup(t),a=await first(f),b=await progressOneDay(f),restore=await guards(f,'episode_evidence');
  await f.db.raw.execute({sql:'UPDATE episode_evidence SET episode_revision=99 WHERE evidence_item_id=?',args:[a.item.row.evidence_item_id]});
  await restore();const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  const refs=await recoveryRefs(restarted.stores,c,['next-low',...f.recoveryIds.slice(0,30)]),before=await count(f);
  const replay=await restarted.stores.intelligence.analyzeMetric(c,request(refs[0],refs.slice(1),'2026-09-26T12:00:00.000Z'));
  assert.deepEqual(replay.calculation,b.calculation);assert.deepEqual(await count(f),before);
  await assert.rejects(replayInitial(f,'a',f.recoveryIds,restarted.stores),/BINDING_INVALID/);
});

test('RC6 SQL NULL keys, REPLACE, upsert and origin/root/integrity rewrites reject without changing authority',async t=>{
  const f=await setup(t);await first(f);const row=(await authorityRows(f))[0];
  for(const field of ['user_id','execution_mode','evidence_item_id','result_scope','run_id','authority_version','privacy_artifact_id'])
    await assert.rejects(rawInsert(f,{...row,[field]:null}),/NOT NULL|CHECK|authority/);
  for(const field of ['user_id','execution_mode','evidence_item_id','run_id','result_scope','authority_version',
    'original_result_json','required_roots_json','authority_hmac','content_digest_salt','created_at','input_generation'])
    await assert.rejects(f.db.raw.execute({sql:`UPDATE ${TABLE} SET ${field}=?`,args:[typeof row[field]==='number'?99:'changed']}),/immutable|parent/);
  await assert.rejects(rawInsert(f,row,'INSERT OR REPLACE'),/authority_conflict/);
  await assert.rejects(rawInsert(f,{...row,result_scope:'INSIGHT_CURRENT'},'INSERT OR REPLACE'),/authority_conflict/);
  await assert.rejects(f.db.raw.execute(`SELECT rowid FROM ${TABLE}`),/no such column/);
  await assert.rejects(f.db.raw.execute({sql:`INSERT INTO ${TABLE} SELECT * FROM ${TABLE} WHERE 1
    ON CONFLICT(user_id,execution_mode,evidence_item_id,result_scope) DO UPDATE SET authority_hmac='changed'`,args:[]}),/authority_conflict|immutable/);
  await assert.rejects(f.db.raw.execute(`DELETE FROM ${TABLE}`),/immutable/);
  assert.deepEqual(await authorityRows(f),[row]);
});

test('RC6 independent origin/envelope/HMAC/salt/version corruptions and scoped transplants fail closed after guard bypass',async t=>{
  const f=await setup(t),a=await first(f),row=(await authorityRows(f))[0],restore=await guards(f,TABLE);
  const origin=JSON.parse(row.original_result_json),cases=[
    ...['episode_id','episode_event_id','revision'].map(k=>({original_result_json:canonicalJson({...origin,[k]:k==='revision'?2:'forged'})})),
    ...['user_id','execution_mode','evidence_item_id','result_scope','run_id','authority_version','authority_hmac','content_digest_salt','privacy_artifact_id']
      .map(k=>({[k]:k==='user_id'?'b':k==='execution_mode'?'LIVE':'forged'})),
    ...['input_generation','lifecycle_generation','auth_generation','purge_generation'].map(k=>({[k]:99})),
    {required_roots_json:canonicalJson({...JSON.parse(row.required_roots_json),roots:[]})},
  ];
  for(const patch of cases) {
    await patchAuthority(f,patch);
    const before=await authorityRows(f);
    await assert.rejects(replayInitial(f),/AUTHORITY_UNAVAILABLE|DURABLE_REPLAY_BINDING_INVALID|PARENT_STALE/);
    assert.deepEqual(await authorityRows(f),before);
    await patchAuthority(f,Object.fromEntries(Object.keys(patch).map(k=>[k,row[k]])));
  }
  // Valid bytes copied to another tenant remain scoped by the authenticated envelope.
  await rawInsert(f,{...row,user_id:'b',privacy_artifact_id:'transplanted'});
  const b=await f.stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(createResultAuthority(f.core).read(b,a.item.row.evidence_item_id,'METRIC'),/BINDING_INVALID/);
  await f.db.raw.execute(`DELETE FROM ${TABLE} WHERE user_id='b'`);await restore();
  const restarted=await f.restart();await replayInitial(f,'a',f.recoveryIds,restarted.stores);
});

test('RC6 every recorded required root is scoped/versioned; root+edges, cross-user substitute and version substitute cannot authorize',async t=>{
  for(const attack of ['delete-and-edges','cross-user','version'])await t.test(attack,async t=>{
    const f=await setup(t),a=await first(f),row=(await authorityRows(f))[0],root=f.recoveryIds.at(-1);
    assert.ok(JSON.parse(row.required_roots_json).roots.some(r=>r.type==='recovery'&&r.id===root&&r.version));
    if(attack==='version')await f.db.raw.execute({sql:"UPDATE whoop_recoveries SET updated_at='2026-09-25T11:59:00.000Z' WHERE user_id='a' AND sleep_id=?",args:[root]});
    else {
      const source=(await f.db.raw.execute({sql:"SELECT * FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[root]})).rows[0];
      await f.db.raw.execute({sql:"DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[root]});
      if(attack==='cross-user') {
        const copy={...source,user_id:'b'};await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(${Object.keys(copy).join(',')})
          VALUES (${Object.keys(copy).map(()=>'?').join(',')})`,args:Object.values(copy)});
      }
      await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id=?",args:[root]});
    }
    const restarted=await f.restart(),context=await restarted.stores.capture('a',{executionMode:'SHADOW'}),before=await count(f);
    await assert.rejects(restarted.stores.episodes.readRevision(context,{episodeId:a.episode.episode.row.episode_id,revision:1,
      evidenceItemId:a.item.row.evidence_item_id}),/SOURCE_NOT_FOUND|VERSION_MISMATCH/);
    assert.deepEqual(await count(f),before);
  });
});

test('RC6 graph contract: auxiliary root index loss is tolerated; required snapshot/event binding loss rejects',async t=>{
  const f=await setup(t),a=await first(f),root=f.recoveryIds.at(-1);
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id=?",args:[root]});
  await replayInitial(f);
  const row=(await authorityRows(f))[0],origin=JSON.parse(row.original_result_json);
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE artifact_type='phase4_episode_revisions' AND source_type='episode_events'",args:[]});
  await assert.rejects(f.stores.episodes.readRevision(f.context,{episodeId:origin.episode_id,revision:origin.revision,
    evidenceItemId:a.item.row.evidence_item_id}),/BINDING_INVALID/);
});

test('RC6 authority without snapshot and snapshot without authority both fail with no fallback',async t=>{
  for(const missing of ['snapshot','authority'])await t.test(missing,async t=>{
    const f=await setup(t);await first(f);
    if(missing==='snapshot')await f.db.raw.execute('DELETE FROM phase4_episode_revisions');
    else {const restore=await guards(f,TABLE);await f.db.raw.execute(`DELETE FROM ${TABLE}`);await restore();}
    const restarted=await f.restart(),before=await count(f);
    await assert.rejects(replayInitial(f,'a',f.recoveryIds,restarted.stores),missing==='snapshot'?/EPISODE_HISTORY_UNAVAILABLE/:/EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE/);
    assert.deepEqual(await count(f),before);
  });
});

test('RC6 evidence/run/membership/event/materialization/snapshot/authority/link failures roll back the full first result',async t=>{
  const f=await setup(t),execute=f.db.raw.execute.bind(f.db.raw);
  for(const fragment of ['INSERT INTO evidence_items(','UPDATE evidence_runs SET','INSERT INTO episode_evidence(',
    'INSERT INTO episode_events(','INSERT INTO observation_episodes(','INSERT INTO phase4_episode_revisions(',
    `INSERT INTO ${TABLE}(`,'INSERT INTO phase4_source_links']) {
    const before=await count(f);let injected=false;
    f.db.raw.execute=async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(!injected&&sql.includes(fragment)){injected=true;throw Error('RC6_FAILURE');}return result;
    };
    try {await assert.rejects(first(f),/RC6_FAILURE/);}finally{f.db.raw.execute=execute;}
    assert.ok(injected,fragment);assert.deepEqual(await count(f),before);
  }
  const results=await Promise.all([first(f),first(f)]);
  assert.equal(results[0].item.row.evidence_item_id,results[1].item.row.evidence_item_id);
  assert.equal((await authorityRows(f)).length,1);assert.equal((await historyCounts(f.db)).snapshots,1);
});

test('RC6 family-wide multiplicity roots include other hypotheses; deleting those roots and edges rejects the focused result',async t=>{
  const f=await associationSetup(t,{days:10}),left=hypothesis(f,[0,1,2,3,4]),right={...hypothesis(f,[5,6,7,8,9]),factor:'exercise'};
  const result=await f.stores.intelligence.analyzeAssociationFamily(f.context,{...family('family-roots',left),hypotheses:[left,right]});
  const focused=result.items[0].item.row.evidence_item_id,root=f.input.sources.recovery[9].sleep_id;
  const rows=(await authorityRows(f)).filter(r=>r.evidence_item_id===focused);assert.equal(rows.length,2);
  assert.ok(JSON.parse(rows[0].required_roots_json).roots.some(r=>r.type==='recovery'&&r.id===root));
  await createResultAuthority(f.core).read(f.context,focused,'INSIGHT_CURRENT');
  await f.db.raw.execute({sql:"DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[root]});
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id=?",args:[root]});
  const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(createResultAuthority(restarted.core).read(c,focused,'INSIGHT_CURRENT'),/SOURCE_NOT_FOUND/);
});

test('RC6 association prior support is a transitive required dependency and Journal purge redacts all authorities without resurrection',async t=>{
  const f=await associationSetup(t),older=hypothesis(f,Array.from({length:30},(_,i)=>i+30)),newer=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const a=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('old',older));
  const b=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('new',newer));
  const target=b.items[0].item.row.evidence_item_id,stored=(await authorityRows(f)).find(r=>r.evidence_item_id===target&&r.result_scope==='INSIGHT_CURRENT');
  assert.ok(JSON.parse(stored.required_roots_json).roots.some(r=>r.type==='evidence_items'&&r.id===a.items[0].item.row.privacy_artifact_id));
  const deletedFact=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=?',
    args:['a',f.logicalFacts[0]]})).rows[0];
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE user_id='a' AND source_type='JOURNAL_FACT' AND source_id=?",
    args:[deletedFact.privacy_artifact_id]});
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'rc6-purge'});
  await f.stores.privacy.redact(control,purge.purge_id);await f.stores.privacy.redact(control,purge.purge_id);
  await f.stores.release(f.context);await f.stores.privacy.complete(control,purge.purge_id);
  for(const row of await authorityRows(f)) {
    assert.equal(row.content_state,'REDACTED');
    for(const field of ['required_roots_json','original_result_json','authority_hmac','content_digest_salt','input_manifest_hash','item_hash'])assert.equal(row[field],null);
  }
  await assert.rejects(f.db.raw.execute(`UPDATE ${TABLE} SET content_state='PRESENT'`),/content_redacted|parent/);
  const c=await f.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(createResultAuthority(f.core).read(c,target,'INSIGHT_CURRENT'),/CONTENT_REDACTED/);
  assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${TABLE} WHERE execution_mode='LIVE'`)).rows[0].n,0);
});

test('RC6 normalized insight expiry agrees before/exact/after for Z, both offsets and fractionless times',async t=>{
  const f=await setup(t),item=await syntheticEvidence(f,f.context,'time-matrix'),expiry='2026-09-26T12:00:00.000Z';
  const insight=await f.stores.insights.create(f.context,{identity:{subject:'test',outcome:'test',direction:'up',
    exposureCategory:'test',algorithmFamily:'test',evidenceContractMajor:'1'},claim:'Synthetic',creationKey:'matrix',
    evidenceContractVersion:'fixture',supportingEvidenceIds:[item.row.evidence_item_id],expiresAt:'2026-09-26T05:00:00-07:00',semanticAt:T});
  assert.equal(insight.row.expires_at,expiry);
  for(const delta of [-1,0,1])for(const offset of [-7,0,7]) {
    const instant=Date.parse(expiry)+delta,wall=new Date(instant+offset*3600000).toISOString();
    const asOfUtc=offset?wall.replace('Z',`${offset<0?'-':'+'}07:00`):wall;
    if(delta<0)await f.stores.insights.read(f.context,insight.row.id,{asOfUtc});
    else await assert.rejects(f.stores.insights.read(f.context,insight.row.id,{asOfUtc}),/NOT_CURRENT/);
    if(delta===0)await assert.rejects(f.stores.insights.read(f.context,insight.row.id,{asOfUtc:asOfUtc.replace('.000','')}),/NOT_CURRENT/);
  }
});

test('RC6 Body Energy inputs retain complete transitive root authority after root and graph deletion',async t=>{
  const f=await setup(t),body=await f.stores.bodyEnergy.compute(f.context,{asOfEpochMs:Date.parse(T)});
  const source=await f.stores.bodyEnergy.read(f.context,body.row.result_id);
  const result=await f.stores.intelligence.analyzeMetric(f.context,{metricKey:'body_energy',currentSource:source.ref,
    baselineSources:[],asOfUtc:T,windowFamily:'BODY_DAY'});
  const row=(await authorityRows(f))[0],roots=JSON.parse(row.required_roots_json).roots;
  assert.ok(roots.some(r=>r.type==='body_energy_results'));assert.ok(roots.some(r=>r.type==='sleep'&&r.id==='sleep-00'));
  await f.db.raw.execute("DELETE FROM whoop_sleeps WHERE user_id='a' AND id='sleep-00'");
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE user_id='a' AND source_type='sleep' AND source_id='sleep-00'");
  const restarted=await f.restart(),c=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(createResultAuthority(restarted.core).read(c,result.item.row.evidence_item_id,'METRIC'),/SOURCE_NOT_FOUND/);
});

test('RC6 authority honors current lifecycle/auth/input/purge fences and rejects cross-mode transplantation',async t=>{
  for(const fence of ['lifecycle','auth','input','purge'])await t.test(fence,async t=>{
    const f=await setup(t),a=await first(f),id=a.item.row.evidence_item_id;
    await createResultAuthority(f.core).read(await f.stores.capture('a',{executionMode:'SHADOW'}),id,'METRIC');
    const sql={lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",
      auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
      input:"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a'",
      purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'"}[fence];
    await f.db.raw.execute(sql);
    await assert.rejects(createResultAuthority(f.core).read(f.context,id,'METRIC'),/FENCED/);
  });
  const f=await setup(t),a=await first(f);await f.stores.initializeTenant('a','LIVE');
  const live=await f.stores.capture('a',{executionMode:'LIVE'}),restore=await guards(f,TABLE);
  await patchAuthority(f,{execution_mode:'LIVE'});
  await assert.rejects(createResultAuthority(f.core).read(live,a.item.row.evidence_item_id,'METRIC'),/BINDING_INVALID/);
  await patchAuthority(f,{execution_mode:'SHADOW'});await restore();
});

test('RC6 association replication intervals compare instants and canonicalize equivalent offsets',()=>{
  const days=Array.from({length:40},(_,i)=>({healthDate:new Date(Date.UTC(2026,7,i+1)).toISOString().slice(0,10),
    exposureState:i%2?'EXPOSED':'CONFIRMED_UNEXPOSED',outcome:i%2?40:50,quality:'AVAILABLE'}));
  const common={factor:'caffeine',outcomeMetric:'recovery_score',days,asOfUtc:T};
  const a=[{start:'2026-08-01T00:00:00.000Z',end:'2026-08-11T00:00:00.000Z',direction:'LOWER'},
    {start:'2026-08-11T00:00:00.000Z',end:'2026-08-21T00:00:00.000Z',direction:'LOWER'}];
  const b=[{...a[0],end:'2026-08-10T17:00:00-07:00'},{...a[1],start:'2026-08-11T07:00:00+07:00'}];
  assert.deepEqual(evaluateJournalAssociation({...common,replicationWindows:a}),evaluateJournalAssociation({...common,replicationWindows:b}));
});
