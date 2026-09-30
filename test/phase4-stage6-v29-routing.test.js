import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { createOperationReceipts } from '../src/phase4OperationReceipts.js';
import { createTargetAuthorityClosure } from '../src/phase4AuthorityClosure.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { OPERATION_RECEIPT_VERSION } from '../src/phase4V27Schema.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { runMigrations } from './localMigrations.js';

const ZERO='0'.repeat(64);
async function prepared(t) {
  const f=await setup(t,{targetVersion:29}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  await call(f,'intelligence','analyzeMetric',base);
  await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR'});
  const receipts=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts
    WHERE operation_kind='analyzeMetric' ORDER BY operation_key`})).rows;
  const recovery=receipts.find(row=>row.request_json.includes('DAILY_RECOVERY'));
  const rhr=receipts.find(row=>row.request_json.includes('DAILY_RHR'));
  assert.ok(recovery&&rhr);return {f,recovery,rhr};
}
const inventory=f=>f.stores.withContext('a',{executionMode:'SHADOW'},context=>
  createOperationReceipts(f.core).episodeRecurrenceInventory(context,{metricKey:'recovery_score'}));

test('v29 signed routing excludes a corrupt unrelated receipt and still requires the target',async t=>{
  const {f,recovery,rhr}=await prepared(t);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET receipt_hmac=? WHERE operation_key=?`,args:[ZERO,rhr.operation_key]}));
  assert.equal((await inventory(f)).latest.size,1);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET receipt_hmac=? WHERE operation_key=?`,args:[ZERO,recovery.operation_key]}));
  const before=await durable(f);
  await assert.rejects(inventory(f),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),before);
});

test('v29 routing persistence failure rolls back its producer and receipt atomically',async t=>{
  const f=await setup(t,{targetVersion:29}),before=await durable(f),execute=f.db.raw.execute.bind(f.db.raw);
  let injected=false;
  f.db.raw.execute=async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&sql.startsWith('INSERT INTO phase4_receipt_route_entries')) {
      injected=true;throw Error('ROUTE_PERSISTENCE_FAILED');
    }
    return execute(statement);
  };
  try {await assert.rejects(call(f,'intelligence','analyzeMetric',
    request(f.initialRefs[0],f.initialRefs.slice(1))),/ROUTE_PERSISTENCE_FAILED/);}
  finally {f.db.raw.execute=execute;}
  assert.equal(injected,true);
  assert.deepEqual(await durable(f),before);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_receipt_routes')).rows[0].n,0);
});

test('v29 target receipt naming tamper cannot make it disappear; unrelated naming tamper stays outside',async t=>{
  const {f,recovery,rhr}=await prepared(t);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET request_json=? WHERE operation_key=?`,args:[rhr.request_json,recovery.operation_key]}));
  await assert.rejects(inventory(f),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET request_json=? WHERE operation_key=?`,args:[recovery.request_json,recovery.operation_key]}));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET request_json=? WHERE operation_key=?`,args:[recovery.request_json,rhr.operation_key]}));
  assert.equal((await inventory(f)).latest.size,1);
});

test('v29 mutable family names cannot add a foreign episode or hide a routed target episode',async t=>{
  const f=await setup(t,{targetVersion:29}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const target=(await call(f,'intelligence','analyzeMetric',base)).episode.episode.row;
  const foreign=(await call(f,'intelligence','analyzeMetric',
    {...base,windowFamily:'SECONDARY_RECOVERY'})).episode.episode.row;
  assert.notEqual(target.episode_family_key,foreign.episode_family_key);
  const api=createOperationReceipts(f.core),closure=createTargetAuthorityClosure(f.core,api.authenticate);
  const read=()=>f.stores.withContext('a',{executionMode:'SHADOW'},context=>closure.inventory(context,
    {kind:'EPISODE',metricKey:'recovery_score',episodeFamilyKey:target.episode_family_key}));
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:`UPDATE observation_episodes
    SET episode_family_key=? WHERE episode_id=?`,args:['0'.repeat(64),target.episode_id]}));
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:`UPDATE observation_episodes
    SET episode_family_key=? WHERE episode_id=?`,args:[target.episode_family_key,foreign.episode_id]}));
  assert.deepEqual((await read()).observation_episodes.map(row=>row.episode_id),[target.episode_id]);
  await assert.rejects(inventory(f),/PHASE4_EPISODE_RECURRENCE_AUTHORITY_INVALID|PHASE4_OPERATION_RECEIPT_INTEGRITY/);
});

const attacks=[
  ['missing entry',async(f,entry)=>guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`DELETE FROM phase4_receipt_route_entries
    WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=? AND sequence=?`,
    args:[entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token,entry.sequence]}))],
  ['missing sequence',async(f,entry)=>guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_entries
    SET sequence=sequence+100 WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=? AND sequence=?`,
    args:[entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token,entry.sequence]}))],
  ['altered operation key',async(f,entry)=>guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_entries
    SET operation_key=? WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=? AND sequence=?`,
    args:[ZERO,entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token,entry.sequence]}))],
  ['altered subject token',async(f,entry)=>guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_entries
    SET subject_token=? WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=? AND sequence=?`,
    args:[ZERO,entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token,entry.sequence]}))],
  ['altered binding HMAC',async(f,entry)=>guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_entries
    SET binding_hmac=? WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=? AND sequence=?`,
    args:[ZERO,entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token,entry.sequence]}))],
  ['altered manifest count',async(f,entry)=>guards(f,'phase4_receipt_route_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_manifests
    SET entry_count=entry_count+1 WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=?`,
    args:[entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token]}))],
  ['altered manifest digest',async(f,entry)=>guards(f,'phase4_receipt_route_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_manifests
    SET chain_digest=? WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=?`,
    args:[ZERO,entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token]}))],
  ['altered manifest HMAC',async(f,entry)=>guards(f,'phase4_receipt_route_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_manifests
    SET manifest_hmac=? WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=?`,
    args:[ZERO,entry.user_id,entry.execution_mode,entry.subject_kind,entry.subject_token]}))],
  ['receipt with no route',async(f,{operation_key})=>guards(f,'phase4_receipt_routes',()=>f.db.raw.execute({sql:`DELETE FROM phase4_receipt_routes
    WHERE user_id='a' AND execution_mode='SHADOW' AND operation_kind='analyzeMetric' AND operation_key=?`,args:[operation_key]}))],
  ['route with no receipt',async(f,{operation_key})=>guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`DELETE FROM phase4_operation_receipts
    WHERE user_id='a' AND execution_mode='SHADOW' AND operation_kind='analyzeMetric' AND operation_key=?`,args:[operation_key]}))],
];
for(const [name,attack] of attacks)test(`v29 ${name} fails target discovery`,async t=>{
  const {f,recovery}=await prepared(t),routing=createReceiptRouting(f.db.raw,f.core.keys);
  const token=routing.token('a','SHADOW','EPISODE',['recovery_score','recovery']);
  const entry=(await f.db.raw.execute({sql:`SELECT * FROM phase4_receipt_route_entries
    WHERE user_id='a' AND execution_mode='SHADOW' AND subject_kind='EPISODE' AND subject_token=?`,args:[token]})).rows[0];
  assert.ok(entry);
  try {await attack(f,name.includes('route')?recovery:entry);}
  catch(error) {
    assert.match(String(error),/FOREIGNKEY|CONSTRAINT/);
    return; // The FK rejected the attack before discovery.
  }
  await assert.rejects(inventory(f),/PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID|PHASE4_OPERATION_RESULT_UNAVAILABLE/);
});

test('v29 route entries reject a duplicate sequence at the SQL primary key',async t=>{
  const {f}=await prepared(t),routing=createReceiptRouting(f.db.raw,f.core.keys),token=routing.token('a','SHADOW','EPISODE',['recovery_score','recovery']);
  const row=(await f.db.raw.execute({sql:`SELECT * FROM phase4_receipt_route_entries
    WHERE subject_kind='EPISODE' AND subject_token=?`,args:[token]})).rows[0];
  await assert.rejects(f.db.raw.execute({sql:`INSERT INTO phase4_receipt_route_entries
    (user_id,execution_mode,subject_kind,subject_token,sequence,operation_kind,operation_key,route_version,binding_hmac)
    VALUES (?,?,?,?,?,?,?,?,?)`,args:[row.user_id,row.execution_mode,row.subject_kind,row.subject_token,row.sequence,
      row.operation_kind,ZERO,row.route_version,row.binding_hmac]}),/UNIQUE|CONSTRAINT/);
});

test('v28 intact receipts migrate to v29, rerun, and verify without rewriting v27',async t=>{
  const f=await setup(t,{targetVersion:28}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  await call(f,'intelligence','analyzeMetric',base);
  const before=(await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows;
  await f.db.migrate({targetVersion:29});await f.db.migrate({targetVersion:29});
  await assertPhase4Schema(f.db.raw,29);
  assert.deepEqual((await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows,before);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_receipt_routes WHERE route_state='KNOWN'")).rows[0].n,before.length);
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  assert.equal((await f.db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
});

test('v28 redacted opaque receipt migrates only as LEGACY_ROUTE_UNKNOWN',async t=>{
  const f=await setup(t,{targetVersion:28}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  await call(f,'intelligence','analyzeMetric',base);
  const row=(await f.db.raw.execute('SELECT operation_key FROM phase4_operation_receipts LIMIT 1')).rows[0];
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='2026-09-25T12:00:00.000Z',
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[row.operation_key]}));
  await f.db.migrate({targetVersion:29});
  const route=(await f.db.raw.execute({sql:'SELECT * FROM phase4_receipt_routes WHERE operation_key=?',args:[row.operation_key]})).rows[0];
  assert.equal(route.route_state,'LEGACY_ROUTE_UNKNOWN');assert.equal(route.subjects_json,'[]');
  assert.equal((await f.db.raw.execute({sql:'SELECT count(*) n FROM phase4_receipt_route_entries WHERE operation_key=?',
    args:[row.operation_key]})).rows[0].n,0);
  const routing=createReceiptRouting(f.db.raw,f.core.keys);
  assert.equal((await routing.inventory({userId:'a',executionMode:'SHADOW'},'EPISODE',['recovery_score','recovery'])).unknown,1);
  Object.assign(f,await f.restart());
  await assert.rejects(inventory(f),/PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN/);
});

test('legacy unknown blocks family absence while a separately sealed direct artifact remains readable',async t=>{
  const f=await setup(t,{targetVersion:28}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const recovery=await call(f,'intelligence','analyzeMetric',base);
  await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR'});
  const rhr=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows
    .find(row=>row.request_json.includes('DAILY_RHR'));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='2026-09-25T12:00:00.000Z',
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[rhr.operation_key]}));
  await f.db.migrate({targetVersion:29});Object.assign(f,await f.restart());
  await assert.rejects(inventory(f),/PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN/);
  const api=createOperationReceipts(f.core);
  const sealed=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>api.forArtifact(context,'evidence_items',
    {evidence_item_id:recovery.item.row.evidence_item_id}));
  assert.equal(sealed.row.evidence_item_id,recovery.item.row.evidence_item_id);
});

test('v29 interrupted after route-entry insert resumes without losing its manifest',async t=>{
  const f=await setup(t,{targetVersion:28});
  await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
  const interrupted={execute:async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&sql.startsWith('INSERT INTO phase4_receipt_route_entries')) {
      injected=true;throw Error('V29_INTERRUPTION');
    }
    return result;
  }};
  await assert.rejects(runMigrations(interrupted,{targetVersion:29}),/V29_INTERRUPTION/);
  assert.equal(injected,true);
  await f.db.migrate({targetVersion:29});await f.db.migrate({targetVersion:29});
  await assertPhase4Schema(f.db.raw,29);
  const routing=createReceiptRouting(f.db.raw,f.core.keys);
  assert.ok((await routing.inventory({userId:'a',executionMode:'SHADOW'},'EPISODE',
    ['recovery_score','recovery'])).receipts.length>=1);
});

for(const [boundary,match] of [
  ['ROUTE_TABLE',sql=>sql.includes('CREATE TABLE IF NOT EXISTS phase4_receipt_routes')],
  ['MANIFEST',sql=>sql.startsWith('INSERT INTO phase4_receipt_route_manifests')],
  ['VERSION_ROW',(sql,statement)=>sql.includes('INSERT INTO schema_version')&&statement.args?.[0]===29],
])test(`v29 interrupted ${boundary} resumes idempotently`,async t=>{
  const f=await setup(t,{targetVersion:28});
  await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
  const interrupted={execute:async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&match(sql,statement)){injected=true;throw Error('V29_INTERRUPTION');}
    return result;
  }};
  await assert.rejects(runMigrations(interrupted,{targetVersion:29}),/V29_INTERRUPTION/);
  assert.equal(injected,true);
  await f.db.migrate({targetVersion:29});await f.db.migrate({targetVersion:29});
  await assertPhase4Schema(f.db.raw,29);
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});

async function clones(f,source,count) {
  const keys=f.core.keys,routing=createReceiptRouting(f.db.raw,keys),related=JSON.parse(source.related_results_json);
  for(let index=0;index<count;index++) {
    const request=JSON.parse(source.request_json);
    request.request.routingHistoryOrdinal=index;
    const row={...source,request_json:canonicalJson(request),created_at:new Date(Date.parse(source.created_at)+index+1).toISOString()};
    row.operation_key=keys.lookup(['stage5-operation-key-v1',row.request_json]);
    row.privacy_artifact_id=keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',row.user_id,row.execution_mode,
      [row.operation_kind,row.operation_key]]);
    row.receipt_hmac=keys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,
      Object.fromEntries(Object.entries(row).filter(([name])=>!['receipt_hmac','health_content_redacted_at',
        'health_content_redaction_reason','source_subject_deleted_at'].includes(name)))]));
    await routing.register(row,{request,related});
    const names=Object.keys(row);
    await f.db.raw.execute({sql:`INSERT INTO phase4_operation_receipts(${names.join(',')})
      VALUES (${names.map(()=>'?').join(',')})`,args:names.map(name=>row[name])});
  }
}

test('v29 bounds apply after family routing: 1001 unrelated receipts do not overflow recovery',async t=>{
  const {f,rhr}=await prepared(t);
  await f.db.transaction(()=>clones(f,rhr,1001));
  assert.equal((await inventory(f)).latest.size,1);
});

test('v29 explicitly rejects a target closure of more than 1000 receipts',async t=>{
  const {f,recovery}=await prepared(t);
  await f.db.transaction(()=>clones(f,recovery,1000));
  await assert.rejects(inventory(f),/PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
});

test('v29 mixed-family histories have independent scoped bounds',async t=>{
  const {f,recovery,rhr}=await prepared(t);
  await f.db.transaction(()=>clones(f,rhr,1001));
  assert.equal((await inventory(f)).latest.size,1);
  const routing=createReceiptRouting(f.db.raw,f.core.keys);
  await assert.rejects(routing.inventory({userId:'a',executionMode:'SHADOW'},'EPISODE',['rhr','autonomic']),
    /PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
  await f.db.transaction(()=>clones(f,recovery,999));
  await assert.rejects(inventory(f),/PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
});
