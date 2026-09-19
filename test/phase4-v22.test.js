import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { runMigrations, currentVersion } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { fixtureKeys } from './localDb.js';
import { V22_LEGACY_R_TABLES, V22_NEW_R_TABLES, R_COLUMNS, EXPERIMENT_FIELDS } from '../src/phase4V22Schema.js';
import { EXPERIMENT_SENTINELS, REDACTED_RECEIPT } from '../src/phase4V22Backfill.js';

const ts = '2026-09-19T00:00:00.000Z';
const options = { targetVersion: 22, privacyKeys: fixtureKeys };
async function base(t, populated = false) {
  const db = createClient({ url: ':memory:' }); t.after(() => db.close());
  await runMigrations(db, { targetVersion: 21 });
  if (!populated) return db;
  for (const id of ['a','b']) await db.execute({ sql: `INSERT INTO users(id,display_name,status,created_at,updated_at)
    VALUES (?,'Synthetic','ACTIVE',?,?)`, args: [id,ts,ts] });
  await db.execute(`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at)
    VALUES ('a','${ts}','2026-09-19','caffeine',2,'manual','${ts}','${ts}')`);
  await db.execute(`INSERT INTO pending_questions(user_id,chat_id,question,context_json,original_message,intent,answer_text,asked_at,expires_at,status)
    VALUES ('a','1001','synthetic question','{"health":5}','synthetic message','journal','synthetic answer','${ts}','2026-09-19T00:30:00.000Z','OPEN')`);
  await db.execute(`INSERT INTO telegram_operations(update_id,result_json,committed_at,delivery_state)
    VALUES (1,'{"userId":"a","reply":"synthetic reply"}','${ts}','DELIVERED'),
    (2,'{"userId":"missing","reply":"unowned synthetic reply"}','${ts}','ACTION_READY'),
    (3,'{"reply":"ambiguous synthetic reply"}','${ts}','DELIVERY_STARTED')`);
  await db.execute(`INSERT INTO telegram_processed_updates(update_id,processed_at,user_id) VALUES (2,'${ts}','a')`);
  await db.execute(`INSERT INTO health_insights(user_id,insight_type,subject,statement,status,first_detected_at)
    VALUES ('a','synthetic','synthetic','synthetic legacy statement','SUPPORTED','${ts}')`);
  await db.execute(`INSERT INTO experiments(user_id,name,hypothesis,intervention,target_metrics,protocol_json,result_json,status,created_at,updated_at)
    VALUES ('a','independently authored synthetic name','copied synthetic hypothesis','synthetic intervention','["sleep"]',
      '{"duration_days":14,"created_via":"telegram"}','{"summary":"synthetic derived result"}','DRAFT','${ts}','${ts}')`);
  await db.execute(`INSERT INTO analytics_invalidation(user_id,generation,affected_from,affected_to,created_at,updated_at)
    VALUES ('a',7,'2026-09-01','2026-09-19','${ts}','${ts}'),('b',9,'2026-09-01',NULL,'${ts}','${ts}')`);
  await db.execute(`INSERT INTO analytics_work_state(user_id,class,done_generation,range_from,range_to,range_generation,created_at,updated_at)
    VALUES ('a','LIGHT',2,'2026-09-03','2026-09-05',7,'${ts}','${ts}')`);
  await db.execute(`INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at)
    VALUES ('global','synthetic','${ts}','unowned synthetic diagnostic','${ts}')`);
  return db;
}
function directNameProof() {
  const body = { userId:'a',experimentId:1,field:'name',assertionId:'assertion-name-1',sourceUpdateKey:'authored-receipt-1',
    sourceKind:'EXPERIMENT_DIRECT_ASSERTION',complete:true,
    valueLookup:fixtureKeys.lookup(['experiment-field-v1','a',1,'name','independently authored synthetic name']) };
  return { ...body, signature: createHmac('sha256',Buffer.alloc(32,83))
    .update(JSON.stringify(['experiment-provenance-v1',body])).digest('hex') };
}

test('v22: complete R expansion, M defaults, keys and intermediate version history', async t => {
  const db = await base(t);
  await runMigrations(db,options); await assertPhase4Schema(db,22);
  for (const table of [...V22_LEGACY_R_TABLES,...V22_NEW_R_TABLES]) {
    const columns = (await db.execute(`PRAGMA table_info(${table})`)).rows.map(r=>r.name);
    for (const column of Object.keys(R_COLUMNS)) assert.ok(columns.includes(column),`${table}.${column}`);
  }
  assert.deepEqual((await db.execute('SELECT version FROM schema_version ORDER BY version')).rows.map(r=>r.version),[20,21,22]);
  await runMigrations(db,options);
  assert.equal(await currentVersion(db),22);
  const missing = await base(t);
  await assert.rejects(runMigrations(missing,{targetVersion:22}),/phase4_migration_keys_required/);
  assert.equal(await currentVersion(missing),21);
});

test('v22: receipt ownership uses only verified internal result.userId, with no replay/send reset', async t => {
  const db = await base(t,true); await runMigrations(db,options);
  const rows = (await db.execute('SELECT * FROM telegram_operations ORDER BY update_id')).rows;
  assert.equal(rows[0].owner_user_id,'a'); assert.equal(rows[0].content_state,'PRESENT'); assert.equal(rows[0].delivery_state,'DELIVERED');
  assert.equal(rows[1].owner_user_id,null); assert.equal(rows[1].result_json,REDACTED_RECEIPT); assert.equal(rows[1].delivery_state,'NOT_REQUIRED');
  assert.equal(rows[2].result_json,REDACTED_RECEIPT); assert.equal(rows[2].delivery_state,'AMBIGUOUS');
  assert.ok(rows.every(r=>r.operation_state==='COMMITTED'));
  assert.equal((await db.execute('SELECT last_detail FROM system_heartbeats')).rows[0].last_detail,null);
});

test('v22: exactly ten revision-1 experiment leaves; verified independent name survives alone', async t => {
  const db = await base(t,true);
  await runMigrations(db,{...options,experimentAttestations:[directNameProof()]});
  const experiment = (await db.execute('SELECT * FROM experiments')).rows[0];
  const leaves = (await db.execute('SELECT * FROM experiment_field_groups ORDER BY field_name')).rows;
  assert.equal(leaves.length,10); assert.ok(leaves.every(l=>l.field_revision===1 && l.is_current===1));
  assert.deepEqual(leaves.reduce((out,l)=>(out[l.field_group]=(out[l.field_group]??0)+1,out),{}),
    {SCHEDULE:4,DEFINITION:3,INTERVENTION_PROTOCOL:2,DERIVED_RESULT:1});
  assert.equal(experiment.name,'independently authored synthetic name');
  for (const [field,sentinel] of Object.entries(EXPERIMENT_SENTINELS)) {
    const leaf = leaves.find(l=>l.field_name===field);
    if (field==='name') { assert.equal(leaf.provenance_state,'DIRECT'); assert.equal(leaf.content_state,'PRESENT'); }
    else { assert.equal(experiment[field],sentinel); assert.equal(leaf.provenance_state,'QUARANTINED'); assert.equal(leaf.content_state,'REDACTED'); }
  }
  assert.equal(experiment.status,'DRAFT');
  await runMigrations(db,options);
  assert.equal((await db.execute('SELECT count(*) n FROM experiment_field_groups')).rows[0].n,10);
});

test('v22: Telegram protocol shape and forged/cross-tenant attestations never prove independence', async t => {
  for (const proof of [null,{...directNameProof(),signature:'forged'}, {...directNameProof(),userId:'b'}]) {
    const db = await base(t,true);
    await runMigrations(db,{...options,experimentAttestations:proof?[proof]:[]});
    const experiment = (await db.execute('SELECT * FROM experiments')).rows[0];
    for (const [field,sentinel] of Object.entries(EXPERIMENT_SENTINELS)) assert.equal(experiment[field],sentinel);
  }
});

test('v22: attributable ranges retain conservative complete links; unproven range becomes FULL without completing work', async t => {
  const db = await base(t,true); await runMigrations(db,options);
  const [a,b] = (await db.execute('SELECT * FROM analytics_invalidation ORDER BY user_id')).rows;
  assert.equal(a.scope_kind,'HEALTH_DATE_RANGE'); assert.equal(a.affected_from,'2026-09-01'); assert.equal(a.generation,7);
  assert.equal(b.scope_kind,'FULL_TENANT_RECOMPUTE'); assert.equal(b.affected_from,null); assert.equal(b.affected_to,null);
  assert.equal(b.generation,9); assert.equal(b.health_scope_redaction_reason,'UNATTRIBUTED_LEGACY');
  const w = (await db.execute('SELECT * FROM analytics_work_state')).rows[0];
  assert.equal(w.done_generation,2); assert.equal(w.range_generation,7); assert.equal(w.scope_kind,'HEALTH_DATE_RANGE');
  await assert.rejects(db.execute("UPDATE analytics_invalidation SET affected_from='2026-09-01' WHERE user_id='b'"),/invalid_legacy_scope/);
  await assert.rejects(db.execute("UPDATE analytics_work_state SET source_linkage_state='LEGACY_UNLINKED'"),/invalid_legacy_scope/);
});

test('v22: legacy Journal backfills deterministic identities and never manufactures negative coverage', async t => {
  const db = await base(t,true); await runMigrations(db,options);
  const row = (await db.execute('SELECT * FROM journal_events')).rows[0];
  assert.equal(row.logical_fact_id,'legacy-v20:a:1'); assert.equal(row.revision,1); assert.equal(row.fact_status,'ACTIVE');
  assert.equal(row.exposure_state,'EXPOSED'); assert.equal(row.normalizer_version,'legacy-v20');
  assert.equal((await db.execute('SELECT count(*) n FROM journal_coverage_windows')).rows[0].n,0);
  assert.equal((await db.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,0);
});

test('v22: mode-qualified answer identities and no SHADOW real Journal/pending projection', async t => {
  const db = await base(t); await runMigrations(db,options);
  const insert = (uid,mode,logicalFact=null) => db.execute({
    sql:`INSERT INTO structured_answer_events(user_id,execution_mode,answer_event_id,logical_answer_id,answer_revision,
      source_update_id,logical_fact_id,input_generation,lifecycle_generation,auth_generation,committed_at) VALUES (?,?,'answer','lineage',1,'receipt',?,0,1,1,?)`,
    args:[uid,mode,logicalFact,ts],
  });
  await insert('a','SHADOW'); await insert('a','LIVE'); await insert('b','SHADOW');
  await assert.rejects(insert('a','SHADOW'),/UNIQUE/);
  await assert.rejects(insert('c','SHADOW','real-fact'),/CHECK/);
  await assert.rejects(insert('c','unknown'),/CHECK/);
  await assert.rejects(db.execute("UPDATE structured_answer_events SET execution_mode='LIVE' WHERE user_id='b'"),/immutable/);
  await assert.rejects(db.execute(`INSERT INTO pending_questions(user_id,chat_id,question,asked_at,expires_at,status,context_question_id)
    VALUES ('a','1001','synthetic','${ts}','${ts}','OPEN','request')`),/requires_live/);
  await assert.rejects(db.execute(`INSERT INTO experiment_field_groups(user_id,experiment_id,field_group,field_name,source_kind,writer_kind,created_at,updated_at)
    VALUES ('a',1,'DEFINITION','result_json','LEGACY_UNPROVEN','LEGACY_BACKFILL','${ts}','${ts}')`),/CHECK/);
});

test('v22: every legacy R table has a populated, attributed backfill without row loss', async t => {
  const db = await base(t,true);
  const values = {user_id:'a',owner_user_id:'a',scope:'user:a',class:'LIGHT',key:'synthetic-capability',
    state:'RECEIVED',status:'SYNTHETIC',resource:'sleep',resource_type:'sleep',event_type:'sleep.updated',
    provider:'whoop',component:'fixture',report_type:'daily',local_date:'2026-09-19',health_date:'2026-09-19',
    result_json:'{"userId":"a","reply":null}',result:'SUCCESS',metrics_json:'{}'};
  const counts = new Map();
  for(const table of V22_LEGACY_R_TABLES) {
    if(!(await db.execute(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length) {
      const required=(await db.execute(`PRAGMA table_info(${table})`)).rows.filter(c=>c.name==='user_id' || (c.notnull && c.dflt_value===null && !(c.pk && c.type==='INTEGER')));
      const args=required.map(c=>Object.hasOwn(values,c.name)?values[c.name]:c.type==='INTEGER'?1:c.type==='REAL'?1:
        c.name.endsWith('_at')?ts:'synthetic');
      await db.execute({sql:`INSERT INTO ${table} (${required.map(c=>c.name).join(',')}) VALUES (${required.map(()=>'?').join(',')})`,args});
    }
    counts.set(table,(await db.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  }
  await runMigrations(db,options);
  for(const [table,count] of counts) {
    assert.equal((await db.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,count,table);
    assert.equal((await db.execute(`SELECT count(*) n FROM ${table} WHERE privacy_artifact_id IS NULL`)).rows[0].n,0,table);
  }
});

test('v22: every DDL, additive column, backfill, index and trigger interruption resumes', async t => {
  const ref = await base(t,true); let armed=false; const writes=[];
  const trace={execute:async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    if(sql.startsWith('CREATE TABLE IF NOT EXISTS journal_event_tombstones'))armed=true;
    const result=await ref.execute(statement);
    if(armed && /^(CREATE|ALTER|INSERT|UPDATE)/.test(sql.trim()))writes.push(sql);
    return result;
  }};
  await runMigrations(trace,options);
  assert.ok(writes.length>300);
  for(let stop=1;stop<=writes.length;stop++) {
    const db=await base(t,true);let seen=0,active=false;
    const crash={execute:async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.startsWith('CREATE TABLE IF NOT EXISTS journal_event_tombstones'))active=true;
      const result=await db.execute(statement);
      if(active && /^(CREATE|ALTER|INSERT|UPDATE)/.test(sql.trim()) && ++seen===stop)throw new Error('synthetic_interruption');
      return result;
    }};
    await assert.rejects(runMigrations(crash,options),/synthetic_interruption/);
    assert.equal(await currentVersion(db),stop===writes.length?22:21,`interruption ${stop}`);
    await runMigrations(db,options);await assertPhase4Schema(db,22);
    assert.equal((await db.execute('SELECT count(*) n FROM experiment_field_groups')).rows[0].n,10);
    assert.equal((await db.execute('SELECT result_json FROM telegram_operations WHERE update_id=2')).rows[0].result_json,REDACTED_RECEIPT);
    db.close();
  }
});
