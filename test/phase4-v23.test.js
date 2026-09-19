import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { runMigrations, currentVersion } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { V23_TABLES, V23_HEALTH_FIELDS } from '../src/phase4V23Schema.js';
import { R_COLUMNS } from '../src/phase4V22Schema.js';
import { fixtureKeys } from './localDb.js';

const ts='2026-09-19T00:00:00.000Z', epoch=Date.parse(ts);
const opts={targetVersion:23,privacyKeys:fixtureKeys};
async function base(t,version=23) {
  const db=createClient({url:':memory:'});t.after(()=>db.close());
  await runMigrations(db,{...opts,targetVersion:22});
  for (const id of ['a','b']) await db.execute({sql:`INSERT INTO users(id,display_name,status,created_at,updated_at)
    VALUES (?,'Synthetic','ACTIVE',?,?)`,args:[id,ts,ts]});
  if(version===23) await runMigrations(db,opts);
  return db;
}
const insert=(db,table,row)=>db.execute({sql:`INSERT INTO ${table} (${Object.keys(row).join(',')})
  VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});
const present=id=>({content_state:'PRESENT',source_linkage_state:'COMPLETE',privacy_artifact_id:id});
const body=(id,extra={})=>({user_id:'a',execution_mode:'SHADOW',result_id:id,result_lookup_key:`lookup-${id}`,
  as_of_epoch_ms:epoch,as_of_utc:ts,health_date:'2026-09-19',value:70,quality_state:'AVAILABLE',
  algorithm_version:'body-energy-v1.2.0',constants_version:'constants-v3',baseline_version:'robust-baseline-v1',metric_registry_version:'fixture-v1',
  input_generation:0,lifecycle_generation:1,auth_generation:1,input_manifest_json:'{"synthetic":true}',input_manifest_hash:'opaque-hash',
  created_at:ts,...present(`privacy-${id}`),...extra});
const episode=(id,extra={})=>({user_id:'a',execution_mode:'SHADOW',episode_id:id,fingerprint:'opaque-direction',episode_family_key:'opaque-family',
  revision:1,state:'OPEN',input_generation:0,lifecycle_generation:1,auth_generation:1,opened_at:ts,updated_at:ts,created_at:ts,
  ...present(`privacy-${id}`),...extra});

test('v23: all ten new R/M tables, explicitly non-null PK components, exact schema and frozen legacy insight classification',async t=>{
  const db=await base(t,22);
  await db.execute(`INSERT INTO health_insights(user_id,insight_type,subject,statement,status,first_detected_at)
    VALUES ('a','synthetic','synthetic','synthetic historical statement','SUPPORTED','${ts}')`);
  await runMigrations(db,opts);await assertPhase4Schema(db,23);
  assert.deepEqual((await db.execute('SELECT version FROM schema_version ORDER BY version')).rows.map(r=>r.version),[20,21,22,23]);
  for(const table of V23_TABLES) {
    const info=(await db.execute(`PRAGMA table_info(${table})`)).rows;
    for(const column of Object.keys(R_COLUMNS))assert.ok(info.some(c=>c.name===column),`${table}.${column}`);
    assert.ok(info.filter(c=>c.pk).every(c=>c.notnull===1),table);
    assert.equal(info.find(c=>c.name==='execution_mode').dflt_value,"'SHADOW'");
  }
  const old=(await db.execute('SELECT * FROM health_insights')).rows[0];
  assert.equal(old.legacy_classification,'LEGACY_UNVERIFIED');assert.equal(old.statement,'synthetic historical statement');
  for(const field of ['insight_key','current_revision','evidence_contract_version','lifecycle_disposition','input_generation'])assert.equal(old[field],null);
  await runMigrations(db,opts);await assertPhase4Schema(db,23);
  assert.equal((await db.execute("SELECT count(*) n FROM sqlite_master WHERE name='p4_health_insights_privacy_id'")).rows[0].n,0);
});

test('v23: exact identity, separate instants in one bucket, new generations and mode/tenant isolation',async t=>{
  const db=await base(t);
  await insert(db,'body_energy_results',body('r1'));
  await assert.rejects(insert(db,'body_energy_results',body('r2')),/UNIQUE/);
  await insert(db,'body_energy_results',body('r2',{as_of_epoch_ms:epoch+840000,as_of_utc:new Date(epoch+840000).toISOString()}));
  await insert(db,'body_energy_results',body('r3',{input_generation:1}));
  await insert(db,'body_energy_results',body('r1',{execution_mode:'LIVE'}));
  await insert(db,'body_energy_results',body('r1',{user_id:'b'}));
  await assert.rejects(insert(db,'body_energy_results',body('bad',{as_of_epoch_ms:epoch+.5})),/CHECK|exact_as_of/);
  await assert.rejects(insert(db,'body_energy_results',body('bad',{as_of_utc:'2026-09-19T00:00:01.000Z'})),/exact_as_of/);
  await assert.rejects(insert(db,'body_energy_results',body('bad',{input_manifest_json:null})),/CHECK/);
  await assert.rejects(db.execute("UPDATE body_energy_results SET value=10 WHERE user_id='a'"),/append_only/);
  await assert.rejects(db.execute("UPDATE body_energy_results SET input_manifest_json='{}' WHERE user_id='a'"),/append_only/);
  await assert.rejects(db.execute("UPDATE body_energy_results SET input_generation=9 WHERE user_id='a'"),/envelope_immutable/);
  await assert.rejects(db.execute("UPDATE body_energy_results SET execution_mode='LIVE' WHERE user_id='b'"),/immutable/);
  assert.equal((await db.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,5);
});

test('v23: checkpoint uniqueness is separate; parent exact instant/version/generation/tenant/mode is required',async t=>{
  const db=await base(t);await insert(db,'body_energy_results',body('r1'));
  const cp={user_id:'a',execution_mode:'SHADOW',checkpoint_id:'cp',checkpoint_kind:'PERIODIC_15M',checkpoint_lookup_key:'opaque-cp',
    checkpoint_bucket_start:epoch-900000,checkpoint_as_of_epoch_ms:epoch,result_id:'r1',algorithm_version:'body-energy-v1.2.0',
    input_generation:0,created_at:ts,...present('privacy-cp')};
  await insert(db,'body_energy_checkpoints',cp);
  await assert.rejects(insert(db,'body_energy_checkpoints',{...cp,checkpoint_id:'cp2',checkpoint_lookup_key:'other'}),/UNIQUE/);
  for(const patch of [{execution_mode:'LIVE'},{user_id:'b'},{input_generation:1},{algorithm_version:'wrong'},
    {checkpoint_as_of_epoch_ms:epoch+1},{checkpoint_bucket_start:epoch-900001}]) {
    await assert.rejects(insert(db,'body_energy_checkpoints',{...cp,checkpoint_id:'bad',...patch}),/parent|CHECK|UNIQUE/);
  }
});

test('v23: confidence uses the ADR INSUFFICIENT label and storage does not narrow the JS Date domain',async t=>{
  const db=await base(t);
  for (const [index,label] of ['HIGH','MEDIUM','LOW','INSUFFICIENT'].entries())
    await insert(db,'body_energy_results',body(label,{input_generation:index,confidence_label:label}));
  await assert.rejects(insert(db,'body_energy_results',body('bad',{input_generation:5,confidence_label:'UNAVAILABLE'})),/CHECK/);
  const far=8640000000000000;
  // SQLite's strftime cannot represent extended ISO years. The store's exact
  // Date/ISO validator is authoritative outside SQLite's supported year range.
  await insert(db,'body_energy_results',body('extended',{as_of_epoch_ms:far,as_of_utc:new Date(far).toISOString(),health_date:'+275760-09-13'}));
});

test('v23: redaction nulls content without removing lookup barrier or allowing rehydration',async t=>{
  const db=await base(t);await insert(db,'body_energy_results',body('r1'));
  const redacted=`content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='${ts}',
    health_content_redaction_reason='SOURCE_DELETED',purge_generation=1,content_digest_salt=NULL`;
  await assert.rejects(db.execute(`UPDATE body_energy_results SET ${redacted}`),/redacted_plaintext/);
  await db.execute(`UPDATE body_energy_results SET ${V23_HEALTH_FIELDS.body_energy_results.map(f=>`${f}=NULL`).join(',')},${redacted}`);
  await assert.rejects(insert(db,'body_energy_results',body('replacement',{result_lookup_key:'lookup-r1'})),/UNIQUE/);
  await assert.rejects(db.execute("UPDATE body_energy_results SET content_state='LEGACY_UNLINKED'"),/content_redacted/);
  assert.equal((await db.execute('SELECT result_lookup_key FROM body_energy_results')).rows[0].result_lookup_key,'lookup-r1');
});

test('v23: episode active family and fingerprint uniqueness; same-state event revisions are typed',async t=>{
  const db=await base(t);await insert(db,'observation_episodes',episode('e1'));
  await assert.rejects(insert(db,'observation_episodes',episode('e2',{fingerprint:'opposite'})),/UNIQUE/);
  await assert.rejects(insert(db,'observation_episodes',episode('e2',{episode_family_key:'other'})),/UNIQUE/);
  await insert(db,'observation_episodes',episode('e1',{execution_mode:'LIVE'}));
  await insert(db,'observation_episodes',episode('e1',{user_id:'b'}));
  await assert.rejects(db.execute("UPDATE observation_episodes SET revision=9 WHERE user_id='a'"),/invalid_episode_revision/);
  assert.equal((await db.execute("UPDATE observation_episodes SET revision=revision+1 WHERE user_id='a' AND execution_mode='SHADOW' AND revision=99")).rowsAffected,0);
  await db.execute("UPDATE observation_episodes SET state='RESOLVED',revision=revision+1 WHERE user_id='a' AND execution_mode='SHADOW'");
  await assert.rejects(db.execute("UPDATE observation_episodes SET state='OPEN',revision=revision+1 WHERE user_id='a' AND execution_mode='SHADOW'"),/invalid_episode_revision/);
  await insert(db,'observation_episodes',episode('e2',{reopens_episode_id:'e1'}));
  const event={user_id:'a',execution_mode:'SHADOW',episode_event_id:'event',deterministic_event_key:'opaque-event',episode_id:'e2',
    event_kind:'SAME_STATE_REVISION',from_state:'OPEN',to_state:'OPEN',expected_revision:1,resulting_revision:2,input_generation:0,
    actor_type:'FOUNDATION_TEST',created_at:ts,...present('privacy-event')};
  await insert(db,'episode_events',event);
  await assert.rejects(insert(db,'episode_events',{...event,episode_event_id:'event2'}),/UNIQUE/);
  for(const patch of [{resulting_revision:3},{to_state:'EXPLAINED'},{from_state:'RESOLVED',to_state:'RESOLVED'},{event_kind:'STATE_TRANSITION'}])
    await assert.rejects(insert(db,'episode_events',{...event,episode_event_id:'bad',deterministic_event_key:'bad',...patch}),/CHECK/);
});

test('v23: same-mode parents reject orphan/mixed tenant/mixed mode evidence and episode membership',async t=>{
  const db=await base(t);await insert(db,'observation_episodes',episode('e1'));
  const obs={user_id:'a',execution_mode:'SHADOW',episode_id:'e1',observation_key:'opaque-observation',input_generation:0,added_at:ts,...present('privacy-obs')};
  await insert(db,'episode_observations',obs);
  for(const patch of [{user_id:'b'},{execution_mode:'LIVE'},{episode_id:'missing'}])
    await assert.rejects(insert(db,'episode_observations',{...obs,...patch}),/same_mode_parent/);
  await assert.rejects(insert(db,'evidence_items',{user_id:'a',execution_mode:'SHADOW',evidence_item_id:'i',run_id:'missing',item_key:'i',
    exposure_classification_version:'fixture-v1',factor_set_version:'fixture-v1',created_at:ts,...present('privacy-i')}),/same_mode_parent/);
});

test('v23: every migration statement, including index replacements, resumes without early version advancement',async t=>{
  const fixture=async()=>{const db=await base(t,22);await db.execute(`INSERT INTO health_insights
    (user_id,insight_type,subject,statement,status,first_detected_at) VALUES ('a','synthetic','synthetic','synthetic old statement','SUPPORTED','${ts}')`);return db;};
  const ref=await fixture();const writes=[];let armed=false;
  const trace={execute:async s=>{const sql=typeof s==='string'?s:s.sql;if(sql.startsWith('CREATE TABLE IF NOT EXISTS body_energy_results'))armed=true;
    const result=await ref.execute(s);if(armed && /^(CREATE|ALTER|INSERT|UPDATE|DROP)/.test(sql.trim()))writes.push(sql);return result;}};
  await runMigrations(trace,opts);assert.ok(writes.length>100);
  for(let stop=1;stop<=writes.length;stop++) {
    const db=await fixture();let seen=0,active=false;
    const crash={execute:async s=>{const sql=typeof s==='string'?s:s.sql;if(sql.startsWith('CREATE TABLE IF NOT EXISTS body_energy_results'))active=true;
      const result=await db.execute(s);if(active && /^(CREATE|ALTER|INSERT|UPDATE|DROP)/.test(sql.trim()) && ++seen===stop)throw new Error('synthetic_interruption');return result;}};
    await assert.rejects(runMigrations(crash,opts),/synthetic_interruption/);
    assert.equal(await currentVersion(db),stop===writes.length?23:22,`interruption ${stop}`);
    await runMigrations(db,opts);await assertPhase4Schema(db,23);
    assert.equal((await db.execute('SELECT legacy_classification FROM health_insights')).rows[0].legacy_classification,'LEGACY_UNVERIFIED');
    assert.equal((await db.execute("SELECT postcondition_state FROM phase4_migration_checkpoints WHERE target_version=23")).rows[0].postcondition_state,'COMPLETE');
    db.close();
  }
});

test('v23: applied drift fails closed rather than silently forward-fixing a recorded version',async t=>{
  const db=await base(t);await db.execute('DROP INDEX p4_episode_active_fingerprint');
  await assert.rejects(runMigrations(db,opts),/schema_postcondition_failed/);
  assert.equal(await currentVersion(db),23);
  assert.equal((await db.execute("SELECT count(*) n FROM sqlite_master WHERE name='p4_episode_active_fingerprint'")).rows[0].n,0);
});
