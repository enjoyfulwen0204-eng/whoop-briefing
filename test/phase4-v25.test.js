import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, fixtureKeys } from './localDb.js';
import { runMigrations, currentVersion } from './localMigrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { PHASE4_MIGRATIONS } from '../src/phase4Schema.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { addPrivacyLink } from '../src/phase4V22Backfill.js';
import { R_COLUMNS } from '../src/phase4V22Schema.js';

const T='2026-09-25T12:00:00.000Z';
const migration=PHASE4_MIGRATIONS.find(m=>m.version===25);
async function database(t,version=24) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whoop-rc4-v25-')),url=`file:${path.join(dir,'synthetic.db')}`;
  let db=createDb({url});t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate({targetVersion:version});
  return {get db(){return db;},reopen(){db.close();db=createDb({url});return db;}};
}
const insert=(db,table,row)=>db.raw.execute({sql:`INSERT INTO ${table}(${Object.keys(row).join(',')})
  VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});
const present=id=>({user_id:'a',execution_mode:'SHADOW',content_state:'PRESENT',source_linkage_state:'COMPLETE',
  privacy_artifact_id:id,content_digest_salt:fixtureKeys.newSalt()});

test('v25 fresh install and v20→v25 expose exact complete schema, constraints and no invented rows',async t=>{
  for(const from of [0,20,24])await t.test(`v${from}→v25`,async t=>{
    const f=await database(t,from||25);await f.db.migrate({targetVersion:25});await assertPhase4Schema(f.db.raw,25);
    assert.equal(await currentVersion(f.db.raw),25);
    const fields=(await f.db.raw.execute('PRAGMA table_info(phase4_episode_revisions)')).rows;
    for(const key of Object.keys(R_COLUMNS))assert.ok(fields.some(f=>f.name===key));
    assert.deepEqual(fields.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name),['user_id','execution_mode','episode_id','revision']);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n,0);
    assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
    assert.deepEqual((await f.db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
    const schema=(await f.db.raw.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name')).rows;
    f.reopen();await f.db.migrate({targetVersion:25});assert.deepEqual((await f.db.raw.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name')).rows,schema);
  });
});

test('v25 interruption at every durable DDL/index/trigger/replacement/version boundary resumes idempotently',async t=>{
  assert.ok(migration);
  const statements=[...migration.ddl,...migration.indexes,...migration.triggers,
    ...migration.replacements.flatMap(r=>[r.ddl,`DROP ${r.kind} IF EXISTS ${r.oldName}`]),'VERSION_ROW'];
  for(const [index,target] of statements.entries())await t.test(`boundary ${index+1}`,async t=>{
    const f=await database(t),execute=f.db.raw.execute.bind(f.db.raw);let stopped=false;
    const broken={execute:async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql,result=await execute(statement);
      if(!stopped&&(sql===target||target==='VERSION_ROW'&&sql.includes('INSERT INTO schema_version')&&statement.args?.[0]===25)) {
        stopped=true;throw Error('RC4_INTERRUPTION');
      }return result;
    }};
    await assert.rejects(runMigrations(broken),/RC4_INTERRUPTION/);assert.ok(stopped);
    assert.equal(await currentVersion(f.db.raw),target==='VERSION_ROW'?25:24);
    f.reopen();await f.db.migrate({targetVersion:25});await assertPhase4Schema(f.db.raw,25);await f.db.migrate({targetVersion:25});
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM schema_version WHERE version=25')).rows[0].n,1);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n,0);
    assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  });
});

test('v24 existing episode migrates without backfill; only a legitimate post-v25 revision becomes replayable',async t=>{
  const f=await database(t),db=f.db;
  await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:new Date(T)});
  const versions={algorithm_version:'fixture',registry_version:'fixture',evidence_contract_version:'fixture',
    promotion_confound_version:'fixture',exposure_classification_version:'fixture',factor_set_version:'fixture'};
  await insert(db,'evidence_runs',{...present('legacy-run-private'),run_id:'legacy-run',deterministic_run_key:'legacy-run',
    method:'SYNTHETIC',...versions,input_generation:0,lifecycle_generation:1,auth_generation:0,state:'COMPLETED',started_at:T});
  await insert(db,'evidence_items',{...present('legacy-item-private'),evidence_item_id:'legacy-item',run_id:'legacy-run',item_key:'legacy-item',
    exposure_classification_version:'fixture',factor_set_version:'fixture',created_at:T});
  const identity={algorithmMajor:'fixture',domain:'recovery',metric:'test',subject:'test',windowFamily:'DAY',direction:'LOWER'};
  const family=fixtureKeys.lookup(['episode-family-v1','a',identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
  await insert(db,'observation_episodes',{...present('legacy-episode-private'),episode_id:'legacy-episode',episode_family_key:family,
    fingerprint:fixtureKeys.lookup(['episode-fingerprint-v1',family,'LOWER']),revision:1,state:'OPEN',domain:'recovery',subject_key:'test',direction:'LOWER',
    latest_evidence_item_id:'legacy-item',input_generation:0,lifecycle_generation:1,auth_generation:0,opened_at:T,created_at:T,updated_at:T,
    explanation_json:'{"current":"known-v24-state"}'});
  await insert(db,'episode_events',{...present('legacy-event-private'),episode_event_id:'legacy-event',episode_id:'legacy-episode',
    deterministic_event_key:'legacy-event',event_kind:'STATE_TRANSITION',to_state:'OPEN',expected_revision:0,resulting_revision:1,
    input_generation:0,actor_type:'DETERMINISTIC_ENGINE',created_at:T,evidence_references_json:'["legacy-item"]'});
  for(const [table,artifactId,sourceMode,sourceType,sourceId,relationship] of [
    ['evidence_runs','legacy-run-private','SHARED','USER','a','DEPENDS_ON'],
    ['evidence_items','legacy-item-private','SHADOW','evidence_runs','legacy-run-private','DEPENDS_ON'],
    ['observation_episodes','legacy-episode-private','SHADOW','evidence_items','legacy-item-private','INPUT_GENERATION:0'],
    ['episode_events','legacy-event-private','SHADOW','observation_episodes','legacy-episode-private','DEPENDS_ON']])
    await addPrivacyLink(db.raw,{userId:'a',mode:'SHADOW',table,artifactId,sourceMode,sourceType,sourceId,relationship,at:T});
  const old=(await db.raw.execute('SELECT * FROM observation_episodes')).rows;
  await db.migrate();assert.deepEqual((await db.raw.execute('SELECT * FROM observation_episodes')).rows,old);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n,0);
  const stores=await createPhase4Foundation({db,keys:fixtureKeys,now:()=>new Date(T)});
  await stores.initializeTenant('a','SHADOW');const c=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(stores.episodes.readRevision(c,{episodeId:'legacy-episode',revision:1}),/EPISODE_HISTORY_UNAVAILABLE/);
  const item=await stores.readArtifact(c,'evidence_items',{evidence_item_id:'legacy-item'});
  await stores.episodes.revise(c,{episodeId:'legacy-episode',expectedRevision:1,toState:'UPDATING',patch:{current_novelty:1},
    sourceRefs:[item.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T});
  const replay=await stores.episodes.readRevision(c,{episodeId:'legacy-episode',revision:2});
  assert.equal(replay.row.explanation_json,'{"current":"known-v24-state"}');assert.equal(replay.row.current_novelty,1);
  await assert.rejects(stores.episodes.readRevision(c,{episodeId:'legacy-episode',revision:1}),/EPISODE_HISTORY_UNAVAILABLE/);
  await db.migrate();assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n,1);
  assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});

test('v25 recorded-schema drift fails without repair or version advancement',async t=>{
  const f=await database(t,25);await f.db.raw.execute('DROP INDEX p4_episode_revision_time');
  await assert.rejects(f.db.migrate(),/postcondition_failed/);assert.equal(await currentVersion(f.db.raw),25);
});
