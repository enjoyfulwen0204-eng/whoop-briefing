import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, progressOneDay, replayInitial, recoveryRefs, analyzeInserted, semanticProjection,
  syntheticEvidence, historyCounts } from './stage5HistoryFixture.js';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { V23_HEALTH_FIELDS } from '../src/phase4V23Schema.js';

const T='2026-09-25T12:00:00.000Z';
const first=f=>f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));
const context=f=>f.stores.capture('a',{executionMode:'SHADOW'});
const rawHistory=f=>f.db.raw.execute('SELECT * FROM phase4_episode_revisions ORDER BY revision').then(r=>r.rows);
const read=(f,c,id,r,extra={})=>f.stores.episodes.readRevision(c,{episodeId:id,revision:r,...extra});

async function explained(f,c,id,revision,label) {
  const item=await syntheticEvidence(f,c,label);
  await f.stores.episodes.revise(c,{episodeId:id,expectedRevision:revision,toState:'EXPLAINED',
    patch:{explained_status:1,explanation_evidence_item_id:item.row.evidence_item_id,explanation_context_id:`context-${label}`,
      explanation_json:{z:[label],a:{nested:label}},current_context_json:{source:label},current_confidence:.7},
    sourceRefs:[item.ref],reasonCode:'CURRENT_EXPLANATION',semanticAt:`2026-09-25T${12+revision}:00:00.000Z`});
  return f.stores.episodes.read(c,id);
}

test('RC4 full-field R1/R2/R3 survives overwrite, restart and R4 without current-row semantic fallback',async t=>{
  const f=await setup(t),a=await first(f),id=a.episode.episode.row.episode_id;
  const b=await explained(f,f.context,id,1,'R2-secret'),c=await explained(f,f.context,id,2,'R3-secret');
  const snapshots=await rawHistory(f),before=await historyCounts(f.db);
  const restarted=await f.restart();f.stores=restarted.stores;const fresh=await context(f);
  for(const [revision,original] of [[1,a.episode.episode],[2,b],[3,c]]) {
    const replay=await read(f,fresh,id,revision);
    assert.deepEqual(semanticProjection(replay.row),semanticProjection(original.row));
    assert.deepEqual(replay.ref,original.ref);
  }
  assert.deepEqual(await rawHistory(f),snapshots);assert.deepEqual(await historyCounts(f.db),before);
  await explained(f,fresh,id,3,'R4-secret');
  assert.deepEqual(semanticProjection((await replayInitial(f)).episode.episode.row),semanticProjection(a.episode.episode.row));
  assert.deepEqual(semanticProjection((await read(f,fresh,id,2)).row),semanticProjection(b.row));
  assert.equal((await f.stores.episodes.read(fresh,id)).row.revision,4);
});

test('RC4 valid A→R1 and B→R2 replays keep all semantic state after T+2',async t=>{
  const f=await setup(t),a=await first(f),b=await progressOneDay(f);
  await analyzeInserted(f,{id:'third',healthDate:'2026-09-27',observedAt:'2026-09-27T10:00:00.000Z',
    asOfUtc:'2026-09-27T12:00:00.000Z',baselineIds:['next-low',...f.recoveryIds.slice(0,29)]});
  const c=await context(f),refs=await recoveryRefs(f.stores,c,['next-low',...f.recoveryIds.slice(0,30)]),before=await historyCounts(f.db);
  const ra=await replayInitial(f),rb=await f.stores.intelligence.analyzeMetric(c,request(refs[0],refs.slice(1),'2026-09-26T12:00:00.000Z'));
  assert.deepEqual(semanticProjection(ra.episode.episode.row),semanticProjection(a.episode.episode.row));
  assert.deepEqual(semanticProjection(rb.episode.episode.row),semanticProjection(b.episode.episode.row));
  assert.deepEqual(await historyCounts(f.db),before);
});

test('RC4 snapshot integrity, structure, event and graph corruption all fail closed without repair',async t=>{
  const f=await setup(t),a=await first(f);await progressOneDay(f);
  const c=await context(f),id=a.episode.episode.row.episode_id,stored=(await rawHistory(f))[0];
  const triggers=(await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='phase4_episode_revisions'")).rows;
  for(const trigger of triggers)await f.db.raw.execute(`DROP TRIGGER ${trigger.name}`);
  const cases=[
    ['hash',{snapshot_hash:'0'.repeat(64)}],['version',{snapshot_version:'unknown'}],['malformed JSON',{snapshot_json:'{'}],
    ['noncanonical JSON',{snapshot_json:JSON.stringify(JSON.parse(stored.snapshot_json),null,2),
      snapshot_hash:f.keys.digest(stored.content_digest_salt,JSON.stringify(JSON.parse(stored.snapshot_json),null,2))}],
    ['event identity',{episode_event_id:'forged-event'}],['semantic time',{semantic_at:'2026-09-25T11:00:00.000Z'}],
    ...['revision','episode_id','user_id','execution_mode','input_generation','lifecycle_generation','auth_generation','purge_generation']
      .map(field=>[field,mutatePayload(stored,p=>{p.episode[field]=typeof p.episode[field]==='number'?99:'forged';},f)]),
    ['unknown field',mutatePayload(stored,p=>{p.episode.unknown='x';},f)],
    ['missing field',mutatePayload(stored,p=>{delete p.episode.explanation_json;},f)],
    ['invalid field type',mutatePayload(stored,p=>{p.episode.severity={bad:1};},f)],
    ['event evidence authorization',mutatePayload(stored,p=>{p.event.evidence_references_json='[]';},f)],
  ];
  for(const [label,patch] of cases) {
    const fields=Object.keys(patch);
    await f.db.transaction(async()=>{
      await f.db.raw.execute('PRAGMA ignore_check_constraints=ON');
      await f.db.raw.execute({sql:`UPDATE phase4_episode_revisions SET ${fields.map(k=>`${k}=?`).join(',')} WHERE revision=1`,args:Object.values(patch)});
      await f.db.raw.execute('PRAGMA ignore_check_constraints=OFF');
    });
    await assert.rejects(read(f,c,id,1),/PHASE4_DURABLE_REPLAY_BINDING_INVALID/,label);
    await assert.rejects(f.stores.readArtifact(c,'phase4_episode_revisions',{episode_id:id,revision:1}),
      /PHASE4_DURABLE_REPLAY_BINDING_INVALID/,`${label}: generic artifact reads must also validate`);
    const after=(await rawHistory(f))[0];for(const [k,v] of Object.entries(patch))assert.equal(after[k],v,'reader must not repair');
    await f.db.raw.execute({sql:`UPDATE phase4_episode_revisions SET ${fields.map(k=>`${k}=?`).join(',')} WHERE revision=1`,args:fields.map(k=>stored[k])});
  }
  await f.db.raw.execute('PRAGMA ignore_check_constraints=OFF');for(const trigger of triggers)await f.db.raw.execute(trigger.sql);
  await f.db.raw.execute({sql:`DELETE FROM phase4_source_links WHERE artifact_type='episode_events'
    AND artifact_id=? AND source_type='evidence_items'`,args:[JSON.parse(stored.snapshot_json).event.privacy_artifact_id]});
  await assert.rejects(read(f,c,id,1,{evidenceItemId:a.item.row.evidence_item_id}),/DURABLE_REPLAY_BINDING_INVALID/);
});
function mutatePayload(stored,mutation,f) {
  const payload=JSON.parse(stored.snapshot_json);mutation(payload);const snapshot_json=canonicalJson(payload);
  return {snapshot_json,snapshot_hash:f.keys.digest(stored.content_digest_salt,snapshot_json)};
}

test('RC4 immutable SQL envelopes, snapshot content and committed episode semantics reject mutation',async t=>{
  const f=await setup(t);await first(f);
  for(const [field,value] of [['revision',9],['user_id','b'],['execution_mode','LIVE'],['episode_id','forged'],
    ['episode_event_id','forged'],['snapshot_json','{}'],['snapshot_hash','0'.repeat(64)],['snapshot_version','unknown']])
    await assert.rejects(f.db.raw.execute({sql:`UPDATE phase4_episode_revisions SET ${field}=?`,args:[value]}),/immutable|append_only|invalid_revision_parent/);
  await assert.rejects(f.db.raw.execute('UPDATE observation_episodes SET explained_status=1'),/revision_immutable/);
  await assert.rejects(f.db.raw.execute("UPDATE observation_episodes SET direction='HIGHER',revision=revision+1"),/identity_immutable/);
  const row=(await rawHistory(f))[0];
  const cols=Object.keys(row);await assert.rejects(f.db.raw.execute({sql:`INSERT INTO phase4_episode_revisions(${cols.join(',')})
    VALUES (${cols.map(()=>'?').join(',')})`,args:cols.map(k=>row[k])}),/UNIQUE/);
});

test('RC4 failures after event, materialization, snapshot and links roll back all revision components',async t=>{
  const f=await setup(t),a=await first(f),id=a.episode.episode.row.episode_id,execute=f.db.raw.execute.bind(f.db.raw);
  const item=await syntheticEvidence(f,f.context,'atomic');
  const change={episodeId:id,expectedRevision:1,toState:'UPDATING',patch:{latest_evidence_item_id:item.row.evidence_item_id},
    sourceRefs:[item.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T};
  for(const fragment of ['INSERT INTO episode_events(','UPDATE observation_episodes SET',
    'INSERT INTO phase4_episode_revisions(','INSERT INTO phase4_source_links']) {
    const before=await historyCounts(f.db),rows=await rawHistory(f);let injected=false;
    f.db.raw.execute=async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(!injected&&sql.includes(fragment)){injected=true;throw Error('RC4_INJECTED_FAILURE');}return result;
    };
    await assert.rejects(f.stores.episodes.revise(f.context,change),/RC4_INJECTED_FAILURE/);f.db.raw.execute=execute;
    assert.equal(injected,true,fragment);assert.deepEqual(await historyCounts(f.db),before);assert.deepEqual(await rawHistory(f),rows);
    assert.equal((await f.stores.episodes.read(f.context,id)).row.revision,1);
  }
  await f.stores.episodes.revise(f.context,change);assert.equal((await rawHistory(f)).length,2);
});

test('RC4 concurrent CAS has one winner and duplicate revision operation is read-only',async t=>{
  const f=await setup(t),a=await first(f),id=a.episode.episode.row.episode_id,item=await syntheticEvidence(f,f.context,'race');
  const change={episodeId:id,expectedRevision:1,toState:'OPEN',patch:{current_novelty:0},sourceRefs:[item.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T};
  const results=await Promise.allSettled([f.stores.episodes.revise(f.context,change),
    f.stores.episodes.revise(f.context,{...change,patch:{current_confidence:.4}})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/CAS_LOST/);
  const before=await historyCounts(f.db),rows=await rawHistory(f);
  assert.equal(before.events,2);assert.equal(before.snapshots,2);
  const duplicate=await f.stores.episodes.revise(f.context,change);assert.equal(duplicate.created,false);
  for(const semanticAt of [undefined,null,'','bad','2026-02-30T00:00:00.000Z',123])
    await assert.rejects(f.stores.episodes.revise(f.context,{...change,semanticAt}),/SEMANTIC_TIME_REQUIRED|SEMANTIC_TIME_INVALID/);
  assert.deepEqual(await historyCounts(f.db),before);assert.deepEqual(await rawHistory(f),rows);
});

test('RC4 semantic-time validation precedes open/no-op/refresh/reverse/semantic shortcuts',async t=>{
  const f=await setup(t),a=await first(f),id=a.episode.episode.row.episode_id;
  for(const semanticAt of [undefined,'bad']) {
    const suffix={semanticAt};
    await assert.rejects(f.stores.episodes.open(f.context,suffix),/SEMANTIC_TIME/);
    await assert.rejects(f.stores.episodes.reverse(f.context,{prior:{},opposite:{},...suffix}),/SEMANTIC_TIME/);
    await assert.rejects(f.stores.episodes.refresh(f.context,{episodeId:id,expectedRevision:1,...suffix}),/SEMANTIC_TIME/);
    await assert.rejects(f.stores.episodes.semantic(f.context,{episodeId:id,expectedRevision:1,...suffix}),/SEMANTIC_TIME/);
    await assert.rejects(f.stores.episodes.revise(f.context,{episodeId:id,expectedRevision:1,toState:'OPEN',patch:{},
      sourceRefs:[a.item.ref],reasonCode:'NEW_EVIDENCE',...suffix}),/SEMANTIC_TIME/);
  }
  const before=await historyCounts(f.db);
  await f.stores.episodes.revise(f.context,{episodeId:id,expectedRevision:1,toState:'OPEN',patch:{},sourceRefs:[a.item.ref],
    reasonCode:'NEW_EVIDENCE',semanticAt:T});assert.deepEqual(await historyCounts(f.db),before);
});

test('RC4 generation refresh snapshots complete new state and fences old generation without rewriting history',async t=>{
  const f=await setup(t),a=await first(f),old=(await rawHistory(f))[0],id=a.episode.episode.row.episode_id;
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const c=await context(f),item=await syntheticEvidence(f,c,'fresh-generation');
  const fields=V23_HEALTH_FIELDS.observation_episodes.filter(k=>k!=='max_semantic_severity_ordinal');
  const projection=Object.fromEntries(fields.map(k=>[k,a.episode.episode.row[k]]));projection.explanation_json={new:'generation'};
  const fresh=await f.stores.episodes.refresh(c,{episodeId:id,expectedRevision:1,
    identity:{algorithmMajor:'phase4-intelligence-v1',direction:'LOWER',domain:'recovery',metric:'recovery_score',subject:'recovery_score',windowFamily:'DAILY_RECOVERY'},
    projection,evidenceItemId:item.row.evidence_item_id,semanticAt:T});
  assert.equal(fresh.row.revision,2);assert.equal(fresh.row.input_generation,c.inputGeneration);
  assert.deepEqual(semanticProjection((await read(f,c,id,2)).row),semanticProjection(fresh.row));
  assert.deepEqual((await rawHistory(f))[0],old);
  await assert.rejects(read(f,f.context,id,1),/INPUT_FENCED/);
  await assert.rejects(read(f,c,id,1),/PARENT_STALE/);
});

test('RC4 snapshot readers isolate users/modes and current lifecycle/auth/purge/input authority',async t=>{
  const f=await setup(t),a=await first(f),id=a.episode.episode.row.episode_id;
  const b=await f.stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(read(f,b,id,1),/HISTORY_UNAVAILABLE/);
  await f.stores.initializeTenant('a','LIVE');const live=await f.stores.capture('a',{executionMode:'LIVE'});
  await assert.rejects(read(f,live,id,1),/HISTORY_UNAVAILABLE/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_episode_revisions WHERE execution_mode='LIVE'")).rows[0].n,0);
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});
  await assert.rejects(read(f,f.context,id,1),/LIFECYCLE_FENCED/);
  await assert.rejects(read(f,await context(f),id,1),/PARENT_STALE/);
});

test('RC4 Journal purge redacts R1/R2 payloads and hashes, fences replay, and cannot rehydrate',async t=>{
  const f=await syntheticPhase4Fixture(t,{now:()=>new Date(T)}),c=await context(f),uid='a';
  await f.db.raw.execute({sql:`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at,
    logical_fact_id,revision,fact_status,privacy_artifact_id,content_state,source_linkage_state)
    VALUES (?,?,'2026-09-25','caffeine',100,'synthetic',?,?,'rc4-fact',1,'ACTIVE','rc4-fact-private','PRESENT','COMPLETE')`,args:[uid,T,T,T]});
  const source=await f.stores.root(c,'JOURNAL_FACT','rc4-fact-private'),item=await syntheticEvidence(f,c,'journal-health',[source.ref]);
  const a=await f.stores.episodes.open(c,{identity:{algorithmMajor:'fixture',direction:'LOWER',domain:'recovery',metric:'test',subject:'test',windowFamily:'DAY'},
    data:{episode_type:'SYNTHETIC',explained_status:1,explanation_evidence_item_id:item.row.evidence_item_id,
      explanation_json:{secret:'R1-JOURNAL-HEALTH'},current_context_json:{dose:100}},evidenceItemId:item.row.evidence_item_id,semanticAt:T});
  await explained(f,c,a.row.episode_id,1,'R2-overwrites');
  assert.deepEqual(semanticProjection((await read(f,c,a.row.episode_id,1)).row),semanticProjection(a.row));
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:'rc4-fact',idempotencyKey:'rc4-delete'});
  await assert.rejects(read(f,c,a.row.episode_id,1),/PURGE_FENCED/);
  await f.stores.privacy.redact(control,purge.purge_id);await f.stores.release(c);
  await f.stores.privacy.complete(control,purge.purge_id);
  const fresh=await context(f);
  for(const revision of [1,2])await assert.rejects(read(f,fresh,a.row.episode_id,revision),/CONTENT_REDACTED/);
  const rows=await rawHistory(f);assert.equal(rows.length,2);
  for(const row of rows)for(const field of ['snapshot_json','snapshot_hash','semantic_at','content_digest_salt'])assert.equal(row[field],null);
  assert.equal((await f.db.raw.execute('SELECT revision FROM observation_episodes')).rows[0].revision,2,'purge is not a semantic revision');
  await assert.rejects(f.db.raw.execute("UPDATE phase4_episode_revisions SET content_state='PRESENT'"),/content_redacted|invalid_revision_parent/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_episode_revisions WHERE execution_mode='LIVE'")).rows[0].n,0);
});

test('RC4 deleted health root invalidates historical snapshot through the existing provenance graph',async t=>{
  const f=await setup(t),a=await first(f);await progressOneDay(f);const c=await context(f),id=a.episode.episode.row.episode_id;
  await read(f,c,id,1);
  await f.db.deleteWhoopResource({userId:'a',resourceType:'recovery',resourceId:f.recoveryIds[0],now:f.core.now()});
  await assert.rejects(read(f,await context(f),id,1),/SOURCE_NOT_FOUND|SOURCE_DELETED|PARENT_STALE/);
});

test('RC4 every lifecycle revision path has exactly one full snapshot including reverse, expiry and invalidation',async t=>{
  const f=await syntheticPhase4Fixture(t,{now:()=>new Date(T)}),c=await context(f),item=await syntheticEvidence(f,c,'paths');
  const identity={algorithmMajor:'fixture',direction:'LOWER',domain:'recovery',metric:'test',subject:'test',windowFamily:'DAY'};
  const a=await f.stores.episodes.open(c,{identity,data:{severity:1,expires_at:'2026-09-26T12:00:00.000Z'},
    evidenceItemId:item.row.evidence_item_id,semanticAt:T,semanticEvent:{eventKind:'OPENED',severityOrdinal:1,semanticContentHash:'open'}});
  const id=a.row.episode_id;
  await f.stores.episodes.revise(c,{episodeId:id,expectedRevision:1,toState:'EXPLAINED',patch:{explained_status:1,
    explanation_evidence_item_id:item.row.evidence_item_id,explanation_json:{known:true}},sourceRefs:[item.ref],
    reasonCode:'CURRENT_EXPLANATION',semanticAt:T,semanticEvent:{eventKind:'EXPLAINED',severityOrdinal:1,semanticContentHash:'explain'}});
  const reversed=await f.stores.episodes.reverse(c,{prior:{episodeId:id,expectedRevision:2,sourceRefs:[item.ref]},
    opposite:{identity:{...identity,direction:'HIGHER'},data:{severity:1,expires_at:T},evidenceItemId:item.row.evidence_item_id},semanticAt:T});
  await f.stores.episodes.revise(c,{episodeId:reversed.row.episode_id,expectedRevision:1,toState:'EXPIRED',
    sourceRefs:[item.ref],reasonCode:'WINDOW_EXPIRED',semanticAt:T});
  const invalidated=await f.stores.episodes.open(c,{identity:{...identity,windowFamily:'INVALID'},data:{severity:1},evidenceItemId:item.row.evidence_item_id,semanticAt:T});
  await f.stores.episodes.revise(c,{episodeId:invalidated.row.episode_id,expectedRevision:1,toState:'INVALIDATED',
    sourceRefs:[item.ref],reasonCode:'SOURCE_INVALIDATED',semanticAt:T});
  const rows=(await f.db.raw.execute(`SELECT e.episode_id,e.resulting_revision,e.to_state,h.snapshot_json
    FROM episode_events e LEFT JOIN phase4_episode_revisions h ON h.user_id=e.user_id AND h.execution_mode=e.execution_mode
      AND h.episode_event_id=e.episode_event_id ORDER BY e.episode_id,e.resulting_revision`)).rows;
  assert.equal(rows.length,7);assert.equal((await rawHistory(f)).length,7);
  for(const row of rows) {
    const snapshot=JSON.parse(row.snapshot_json);assert.equal(snapshot.episode.revision,row.resulting_revision);
    assert.equal(snapshot.episode.state,row.to_state);assert.equal(snapshot.episode.episode_id,row.episode_id);
  }
  assert.equal((await read(f,c,id,1)).row.state,'OPEN');assert.equal((await read(f,c,id,2)).row.state,'EXPLAINED');
  assert.equal((await read(f,c,id,3)).row.state,'RESOLVED');
  await assert.rejects(read(f,c,invalidated.row.episode_id,2),/PARENT_STALE/);
});

test('RC4 sealed semantic events replay without mutation and cannot alter a committed snapshot',async t=>{
  const f=await setup(t),a=await first(f),row=a.episode.episode.row;
  const event=(await f.db.raw.execute('SELECT * FROM episode_semantic_events')).rows[0];
  const payload={episodeId:row.episode_id,expectedRevision:1,episodeEventId:event.episode_event_id,eventKind:event.event_kind,
    severityOrdinal:event.severity_ordinal,claimKey:event.claim_key,semanticContentHash:event.semantic_content_hash,semanticAt:T};
  const before=await historyCounts(f.db),snapshots=await rawHistory(f);
  await f.stores.episodes.semantic(f.context,payload);
  await assert.rejects(f.stores.episodes.semantic(f.context,{...payload,semanticAt:undefined}),/SEMANTIC_TIME_REQUIRED/);
  await assert.rejects(f.stores.episodes.semantic(f.context,{...payload,severityOrdinal:99}),/IDENTITY_CONTENT_CONFLICT/);
  assert.deepEqual(await historyCounts(f.db),before);assert.deepEqual(await rawHistory(f),snapshots);
});
