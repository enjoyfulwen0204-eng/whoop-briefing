import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations, currentVersion } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { V24_TABLES, V24_HEALTH_FIELDS, MESSAGE_FAMILIES, OUTBOX_STATES } from '../src/phase4V24Schema.js';
import { R_COLUMNS } from '../src/phase4V22Schema.js';
import { fixtureKeys } from './localDb.js';

const ts='2026-09-19T00:00:00.000Z', deadline='2026-09-19T00:30:00.000Z';
const opts={targetVersion:24,privacyKeys:fixtureKeys};
async function base(t,version=24,url=':memory:') {
  const db=createClient({url});t.after(()=>db.close());
  await runMigrations(db,{...opts,targetVersion:23});
  for(const id of ['a','b'])await db.execute({sql:`INSERT INTO users(id,display_name,status,created_at,updated_at)
    VALUES (?,'Synthetic','ACTIVE',?,?)`,args:[id,ts,ts]});
  if(version===24)await runMigrations(db,opts);
  return db;
}
const insert=(db,table,row)=>db.execute({sql:`INSERT INTO ${table} (${Object.keys(row).join(',')})
  VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});
const present=id=>({content_state:'PRESENT',source_linkage_state:'COMPLETE',privacy_artifact_id:id});
const reservation=(id,extra={})=>({user_id:'a',execution_mode:'SHADOW',reservation_id:id,message_family:'CONTEXT_QUESTION',
  question_request_id:id,semantic_key:JSON.stringify(['a','CONTEXT_QUESTION',id]),state:'RESERVED',origin:'PHASE4',created_at:ts,...extra});
const message=(id,extra={})=>({user_id:'a',execution_mode:'SHADOW',message_id:id,idempotency_key:JSON.stringify(['a','CONTEXT_QUESTION',id]),
  message_class:'CONTEXT_QUESTION',reservation_id:id,question_request_id:id,input_generation:0,lifecycle_generation:1,auth_generation:1,
  expires_at:deadline,created_at:ts,updated_at:ts,payload_text:'synthetic question',...present(`privacy-${id}`),...extra});
const slot=(extra={})=>({user_id:'a',execution_mode:'SHADOW',updated_at:ts,...extra});

test('v24: complete disabled schema, M/R inventory, exact defaults and independent version history',async t=>{
  const db=await base(t);await assertPhase4Schema(db,24);
  assert.deepEqual((await db.execute('SELECT version FROM schema_version ORDER BY version')).rows.map(r=>r.version),[20,21,22,23,24]);
  for(const table of V24_TABLES) {
    const info=(await db.execute(`PRAGMA table_info(${table})`)).rows;
    assert.ok(info.filter(c=>c.pk).every(c=>c.notnull===1),table);
    assert.equal(info.find(c=>c.name==='execution_mode').dflt_value,"'SHADOW'");
    for(const field of Object.keys(R_COLUMNS))assert.equal(info.some(c=>c.name===field),Object.hasOwn(V24_HEALTH_FIELDS,table),`${table}.${field}`);
    assert.equal((await db.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
  }
  await runMigrations(db,opts);await assertPhase4Schema(db,24);
  assert.equal((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});

test('v24: all four canonical semantic namespaces; permanent consumed/closed reservations',async t=>{
  const db=await base(t);
  const targets=[{local_health_date:'2026-09-19'},{episode_semantic_event_id:'event'},{question_request_id:'question'},
    {answer_event_id:'answer',followup_kind:'INTERPRETATION_UPDATE'}];
  for(const [i,family] of MESSAGE_FAMILIES.entries()) {
    const target=targets[i],key=JSON.stringify(['a',family,...Object.values(target)]);
    const row={user_id:'a',execution_mode:'SHADOW',reservation_id:family,message_family:family,semantic_key:key,
      state:'RESERVED',origin:'PHASE4',created_at:ts,...target};
    await insert(db,'outbound_semantic_reservations',row);
    await assert.rejects(insert(db,'outbound_semantic_reservations',{...row,reservation_id:'different'}),/UNIQUE/);
    await insert(db,'outbound_semantic_reservations',{...row,execution_mode:'LIVE'});
    await assert.rejects(insert(db,'outbound_semantic_reservations',{...row,reservation_id:'bad',semantic_key:JSON.stringify(['a',family,'new-decision-id'])}),/CHECK/);
  }
  await db.execute(`UPDATE outbound_semantic_reservations SET state='CONSUMED',consumed_outcome='AMBIGUOUS',consumed_at='${ts}'
    WHERE execution_mode='SHADOW'`);
  await assert.rejects(db.execute("UPDATE outbound_semantic_reservations SET state='RESERVED' WHERE execution_mode='SHADOW'"),/permanent/);
  await assert.rejects(db.execute('DELETE FROM outbound_semantic_reservations'),/permanent/);
  await db.execute(`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='INVALIDATED',closed_at='${ts}'
    WHERE execution_mode='LIVE'`);
  await assert.rejects(db.execute("UPDATE outbound_semantic_reservations SET state='RESERVED' WHERE execution_mode='LIVE'"),/permanent/);
  await assert.rejects(insert(db,'outbound_messages',message('CONTEXT_QUESTION',{
    question_request_id:'question',idempotency_key:JSON.stringify(['a','CONTEXT_QUESTION','question'])})),/reservation_parent/);
});

test('v24: legacy barriers retain typed origin without inventing a Phase 4 question request',async t=>{
  const db=await base(t);
  await insert(db,'outbound_semantic_reservations',{user_id:'a',execution_mode:'LIVE',reservation_id:'legacy-barrier',
    message_family:'CONTEXT_QUESTION',semantic_key:'opaque-versioned-legacy-mapping',origin:'LEGACY_BARRIER',
    legacy_table:'pending_questions',legacy_row_id:'opaque-legacy-id',state:'CONSUMED',consumed_outcome:'AMBIGUOUS',consumed_at:ts,created_at:ts});
  assert.equal((await db.execute('SELECT question_request_id FROM outbound_semantic_reservations')).rows[0].question_request_id,null);
  assert.equal((await db.execute('SELECT count(*) n FROM context_questions')).rows[0].n,0);
});

test('v24: exact decision action space, default LEGACY delivery mode and typed slot requirements',async t=>{
  const db=await base(t);
  const decision={user_id:'a',decision_id:'d',deterministic_decision_key:'opaque-d',action:'NO_NOTIFICATION',input_generation:0,
    lifecycle_generation:1,auth_generation:1,policy_version:'fixture-v1',metric_registry_version:'fixture-v1',evidence_version:'fixture-v1',
    template_version:'fixture-v1',expires_at:deadline,created_at:ts,...present('privacy-d')};
  await insert(db,'phase4_proactive_decisions',decision);
  await assert.rejects(insert(db,'phase4_proactive_decisions',{...decision,decision_id:'bad',action:'LOG_ONLY'}),/CHECK/);
  await insert(db,'tenant_delivery_modes',{user_id:'a',message_family:'CONTEXT_QUESTION',lifecycle_generation:1,auth_generation:1,
    reason_code:'INITIAL',changed_at:ts});
  assert.equal((await db.execute('SELECT mode FROM tenant_delivery_modes')).rows[0].mode,'LEGACY');
  await assert.rejects(insert(db,'phase4_question_interaction_slots',slot({state:'RESERVED',question_request_id:'q',reserved_at:ts})),/CHECK/);
  await assert.rejects(insert(db,'phase4_question_interaction_slots',slot({execution_mode:'LIVE',state:'RESERVED',question_request_id:'q',
    lifecycle_generation:1,auth_generation:1,reserved_at:ts})),/CHECK/);
  await assert.rejects(insert(db,'phase4_question_interaction_slots',slot({state:'FREE',question_request_id:'q'})),/CHECK/);
});

test('v24: outbox identity, same-mode reservation parents, frozen payload and terminal ambiguity',async t=>{
  const db=await base(t);await insert(db,'outbound_semantic_reservations',reservation('q'));await insert(db,'outbound_messages',message('q'));
  await assert.rejects(insert(db,'outbound_messages',message('q',{message_id:'other'})),/UNIQUE/);
  await assert.rejects(insert(db,'outbound_messages',message('q',{execution_mode:'LIVE',destination_binding_id:'fake'})),/reservation_parent/);
  await assert.rejects(insert(db,'outbound_messages',message('q',{user_id:'b'})),/reservation_parent/);
  await assert.rejects(db.execute("UPDATE outbound_messages SET payload_text='changed',revision=revision+1"),/append_only/);
  await assert.rejects(db.execute("UPDATE outbound_messages SET idempotency_key='new',revision=revision+1"),/immutable|reservation_parent/);
  for(const state of ['ELIGIBLE','CLAIMED','DELIVERY_STARTED','AMBIGUOUS'])
    await db.execute({sql:`UPDATE outbound_messages SET state=?,revision=revision+1,lease_owner='worker',lease_expires_at=?`,args:[state,deadline]});
  await assert.rejects(db.execute("UPDATE outbound_messages SET state='ELIGIBLE',revision=revision+1"),/outbox_transition/);
  await db.execute(`UPDATE outbound_messages SET payload_text=NULL,content_state='REDACTED',source_linkage_state='DISCONNECTED',
    health_content_redacted_at='${ts}',health_content_redaction_reason='SOURCE_DELETED',purge_generation=1,revision=revision+1`);
  assert.equal((await db.execute('SELECT state FROM outbound_messages')).rows[0].state,'AMBIGUOUS');
  await assert.rejects(db.execute("UPDATE outbound_messages SET content_state='PRESENT',revision=revision+1"),/content_redacted/);
  assert.equal(OUTBOX_STATES.length,10);
});

test('v24: one slot per tenant/mode, revision CAS and no replacement during ambiguous answer window',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phase4-slot-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const url=`file:${path.join(dir,'synthetic.db')}`,db=await base(t,24,url),other=createClient({url});t.after(()=>other.close());
  await insert(db,'phase4_question_interaction_slots',slot());
  await insert(db,'phase4_question_interaction_slots',slot({execution_mode:'LIVE'}));
  await insert(db,'phase4_question_interaction_slots',slot({user_id:'b'}));
  const claim=(client,id)=>client.execute({sql:`UPDATE phase4_question_interaction_slots
    SET state='RESERVED',question_request_id=?,reserved_at=?,lifecycle_generation=1,auth_generation=1,revision=revision+1
    WHERE user_id='a' AND execution_mode='SHADOW' AND revision=0 AND state='FREE'`,args:[id,ts]});
  const winners=await Promise.all([claim(db,'q1'),claim(other,'q2')]);assert.equal(winners.reduce((n,r)=>n+r.rowsAffected,0),1);
  assert.equal((await db.execute("SELECT state FROM phase4_question_interaction_slots WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].state,'FREE');
  await assert.rejects(db.execute("UPDATE phase4_question_interaction_slots SET question_request_id='replacement',revision=revision+1 WHERE execution_mode='SHADOW' AND user_id='a'"),/occupied_slot_immutable/);
  await db.execute(`UPDATE phase4_question_interaction_slots SET state='DELIVERY_STARTED',delivery_started_at='${ts}',answer_deadline='${deadline}',revision=revision+1
    WHERE user_id='a' AND execution_mode='SHADOW'`);
  await assert.rejects(db.execute(`UPDATE phase4_question_interaction_slots SET state='EXPIRED',expired_at='${deadline}',revision=revision+1
    WHERE user_id='a' AND execution_mode='SHADOW'`),/slot_transition/);
  await db.execute(`UPDATE phase4_question_interaction_slots SET state='AMBIGUOUS_WAIT',ambiguous_at='${ts}',revision=revision+1
    WHERE user_id='a' AND execution_mode='SHADOW'`);
  await assert.rejects(db.execute(`UPDATE phase4_question_interaction_slots SET answer_deadline='2026-09-20T00:00:00.000Z',revision=revision+1
    WHERE user_id='a' AND execution_mode='SHADOW'`),/deadline_immutable/);
  await assert.rejects(db.execute("UPDATE phase4_question_interaction_slots SET revision=100 WHERE user_id='a' AND execution_mode='SHADOW'"),/invalid_revision/);
});

test('v24: attempt default/SHADOW rejects, LIVE requires same-mode message and no provider plaintext columns',async t=>{
  const db=await base(t);
  const attempt={user_id:'a',attempt_id:'try',message_id:'q',attempt_number:1,state:'DELIVERY_STARTED',request_hash:'opaque',delivery_started_at:ts};
  await insert(db,'outbound_semantic_reservations',reservation('q'));await insert(db,'outbound_messages',message('q'));
  await assert.rejects(insert(db,'outbound_delivery_attempts',attempt),/CHECK/);
  await assert.rejects(insert(db,'outbound_delivery_attempts',{...attempt,execution_mode:'LIVE'}),/attempt_parent/);
  await insert(db,'outbound_semantic_reservations',reservation('q',{execution_mode:'LIVE'}));
  await insert(db,'outbound_messages',message('q',{execution_mode:'LIVE',destination_binding_id:'synthetic-binding'}));
  await insert(db,'outbound_delivery_attempts',{...attempt,execution_mode:'LIVE'});
  const columns=(await db.execute('PRAGMA table_info(outbound_delivery_attempts)')).rows.map(r=>r.name);
  assert.ok(!columns.some(n=>/response.*(text|body)|payload|request_text/.test(n)));
  await assert.rejects(db.execute("UPDATE outbound_delivery_attempts SET error_code='provider body with health data'"),/CHECK/);
});

test('v24: FULL scope has null ranges, preserves work, and uses finite reasons and mode-qualified lease identity',async t=>{
  const db=await base(t);
  const row={user_id:'a',execution_mode:'SHADOW',job_kind:'RECOMPUTE_DERIVED',requested_generation:7,completed_generation:4,
    updated_at:ts,...present('privacy-job')};
  await insert(db,'phase4_jobs',row);await insert(db,'phase4_jobs',{...row,execution_mode:'LIVE'});
  await assert.rejects(db.execute("UPDATE phase4_jobs SET affected_from='2026-09-01'"),/CHECK/);
  await assert.rejects(db.execute("UPDATE phase4_jobs SET completed_generation=8"),/CHECK/);
  await assert.rejects(db.execute("UPDATE phase4_jobs SET completed_generation=7,state='COMPLETED'"),/CHECK/);
  await assert.rejects(db.execute("UPDATE phase4_jobs SET completed_generation=3"),/generation_regression/);
  await assert.rejects(db.execute("UPDATE phase4_jobs SET reason_codes_json='[\"copied health narrative\"]'"),/scope_reason/);
  await assert.rejects(insert(db,'phase4_jobs',{...row,job_kind:'LIGHT'}),/CHECK/);
  await db.execute(`UPDATE phase4_jobs SET state='RUNNING',lease_owner='worker',lease_expires_at='${deadline}',claimed_generation=7,
    claimed_lifecycle_generation=1,claimed_auth_generation=1,claimed_scope_revision=0,claimed_purge_generation=0
    WHERE user_id='a' AND execution_mode='SHADOW' AND job_kind='RECOMPUTE_DERIVED' AND requested_generation=7 AND scope_revision=0`);
  assert.equal((await db.execute("SELECT state FROM phase4_jobs WHERE execution_mode='LIVE'")).rows[0].state,'PENDING');
  const job=(await db.execute("SELECT * FROM phase4_jobs WHERE execution_mode='SHADOW'")).rows[0];
  assert.equal(job.scope_kind,'FULL_TENANT_RECOMPUTE');assert.equal(job.completed_generation,4);
});

test('v24: every DDL/index/trigger interruption is restartable and no version shortcut is recorded',async t=>{
  const ref=await base(t,23);const writes=[];let armed=false;
  const trace={execute:async s=>{const sql=typeof s==='string'?s:s.sql;if(sql.startsWith('CREATE TABLE IF NOT EXISTS phase4_invalidations'))armed=true;
    const result=await ref.execute(s);if(armed && /^(CREATE|INSERT)/.test(sql.trim()))writes.push(sql);return result;}};
  await runMigrations(trace,opts);assert.ok(writes.length>50);
  for(let stop=1;stop<=writes.length;stop++) {
    const db=await base(t,23);let seen=0,active=false;
    const crash={execute:async s=>{const sql=typeof s==='string'?s:s.sql;if(sql.startsWith('CREATE TABLE IF NOT EXISTS phase4_invalidations'))active=true;
      const result=await db.execute(s);if(active && /^(CREATE|INSERT)/.test(sql.trim()) && ++seen===stop)throw new Error('synthetic_interruption');return result;}};
    await assert.rejects(runMigrations(crash,opts),/synthetic_interruption/);assert.equal(await currentVersion(db),stop===writes.length?24:23);
    await runMigrations(db,opts);await assertPhase4Schema(db,24);
    assert.equal((await db.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,0);db.close();
  }
});
