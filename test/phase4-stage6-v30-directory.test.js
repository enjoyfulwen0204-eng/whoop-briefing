import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createFamilyDirectory } from '../src/phase4FamilyDirectory.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { fixture,NEXT } from './stage6RecurrenceFixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { createPhase4QueueStore } from '../src/phase4QueueStore.js';
import { runMigrations } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { createReanalysisQueue } from '../src/phase4ReanalysisQueue.js';
import { createReanalysisInputs } from '../src/phase4ReanalysisInputs.js';

test('v30 schema and public family registration smoke',async t=>{
  const f=await setup(t,{targetVersion:30});
  const base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const result=await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'DAILY_RECOVERY'});
  assert.ok(result.episode?.episode?.row);
  const entries=(await f.db.raw.execute('SELECT * FROM phase4_family_directory_entries')).rows;
  assert.equal(entries.length,1);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const directory=createFamilyDirectory(f.db.raw,f.keys);
  assert.equal((await directory.inventory(context,'recovery_score')).entries.length,1);
});

test('v30 directory registration failure rolls back its public episode producer',async t=>{
  const f=await setup(t,{targetVersion:30}),before=await durable(f),execute=f.db.raw.execute.bind(f.db.raw);
  let injected=false;
  f.db.raw.execute=async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&sql.startsWith('INSERT INTO phase4_family_directory_entries')) {
      injected=true;throw Error('V30_DIRECTORY_PERSISTENCE_FAILED');
    }
    return execute(statement);
  };
  try {await assert.rejects(call(f,'intelligence','analyzeMetric',
    {...request(f.initialRefs[0],f.initialRefs.slice(1)),windowFamily:'DAILY_RECOVERY'}),
  /V30_DIRECTORY_PERSISTENCE_FAILED/);}
  finally {f.db.raw.execute=execute;}
  assert.equal(injected,true);
  assert.deepEqual(await durable(f),before);
  assert.equal((await f.db.raw.execute('SELECT count(*) count FROM phase4_family_directory_entries')).rows[0].count,0);
});

test('v30 directory retains only keyed family identity across receipt redaction',async t=>{
  const f=await setup(t,{targetVersion:30}),windowFamily='PRIVATE_JOURNAL_TEXT_MUST_NOT_SURVIVE';
  assert.ok((await call(f,'intelligence','analyzeMetric',
    {...request(f.initialRefs[0],f.initialRefs.slice(1)),windowFamily})).episode?.episode?.row);
  const row=(await f.db.raw.execute({sql:"SELECT operation_key FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN' LIMIT 1"})).rows[0];
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='2026-09-25T12:00:00.000Z',
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[row.operation_key]}));
  const persisted=JSON.stringify((await f.db.raw.execute('SELECT * FROM phase4_family_directory_entries')).rows);
  assert.ok(!persisted.includes(windowFamily));
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys),
    inventory=await directory.inventory(context,'recovery_score');
  assert.equal(inventory.entries.length,1);
  assert.equal(inventory.entries[0].entry_state,'KNOWN');
});

test('v30 worker reopens a retained precise family',async t=>{
  const {f,old}=await fixture(t,{targetVersion:30});
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  for(let i=0;i<8;i++) {
    const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
    if((await worker.diagnostics()).pendingJobs===0)break;
  }
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(rows.length,2);
});

test('v30 new custom family is discovered after restart',async t=>{
  const {f,old}=await fixture(t,{targetVersion:30,windowFamily:'CUSTOM_RETAINED_FAMILY'});
  Object.assign(f,await f.restart());
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  for(let i=0;i<8;i++) {
    const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
    if((await worker.diagnostics()).pendingJobs===0)break;
  }
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(rows.length,2);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys),
    entries=(await directory.inventory(context,'recovery_score')).entries;
  assert.ok(entries.some(row=>row.family_key===old.episode_family_key));
});

test('v29 intact episode migrates to v30 and reruns',async t=>{
  const f=await setup(t,{targetVersion:29});
  const base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const result=await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'CUSTOM_RETAINED_FAMILY'});
  assert.ok(result.episode?.episode?.row);
  await f.db.migrate({targetVersion:30});
  await f.db.migrate({targetVersion:30});
  Object.assign(f,await f.restart());
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const directory=createFamilyDirectory(f.db.raw,f.keys);
  const entries=(await directory.inventory(context,'recovery_score')).entries;
  assert.equal(entries.length,1);
  assert.equal(entries[0].family_key,f.keys.lookup(['episode-family-v1','a','recovery','recovery_score',
    'phase4-intelligence-v1','recovery_score','CUSTOM_RETAINED_FAMILY']));
  assert.deepEqual(Object.keys(JSON.parse(entries[0].descriptor_json)),['identityToken']);
});

test('v29 redacted family migrates as typed unknown without inventing its descriptor',async t=>{
  const f=await setup(t,{targetVersion:29}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'CUSTOM_RETAINED_FAMILY'})).episode?.episode?.row);
  const row=(await f.db.raw.execute({sql:"SELECT operation_key FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN' LIMIT 1"})).rows[0];
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='2026-09-25T12:00:00.000Z',
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[row.operation_key]}));
  await f.db.migrate({targetVersion:30});Object.assign(f,await f.restart());
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys);
  const entries=(await f.db.raw.execute('SELECT * FROM phase4_family_directory_entries')).rows;
  assert.equal(entries.length,1);
  assert.equal(entries[0].entry_state,'LEGACY_FAMILY_UNKNOWN');
  assert.equal(entries[0].descriptor_json,null);
  const inventory=await directory.inventory(context,'recovery_score');
  assert.equal(inventory.unknownEntries.length,1);
  await assert.rejects(directory.allComplete(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN/);
});

for(const [boundary,match] of [
  ['entry',sql=>sql.startsWith('INSERT INTO phase4_family_directory_entries')],
  ['manifest',sql=>sql.startsWith('UPDATE phase4_family_directory_manifests SET entry_count')],
  ['tip',sql=>sql.startsWith('INSERT INTO phase4_family_work_tips')],
])test(`v30 interrupted after ${boundary} write resumes idempotently`,async t=>{
  const f=await setup(t,{targetVersion:29}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'DAILY_RECOVERY'})).episode?.episode?.row);
  const execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
  const interrupted={execute:async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&match(sql)){injected=true;throw Error('V30_INTERRUPTION');}
    return result;
  }};
  await assert.rejects(runMigrations(interrupted,{targetVersion:30,privacyKeys:f.keys}),/V30_INTERRUPTION/);
  assert.equal(injected,true);
  await f.db.migrate({targetVersion:30});await f.db.migrate({targetVersion:30});
  await assertPhase4Schema(f.db.raw,30);
  Object.assign(f,await f.restart());
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys);
  assert.equal((await directory.inventory(context,'recovery_score')).entries.length,1);
});

async function prepared(t) {
  const f=await setup(t,{targetVersion:30}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'DAILY_RECOVERY'})).episode?.episode?.row);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys);
  const entry=(await directory.inventory(context,'recovery_score')).entries[0];
  return {f,context,directory,entry};
}

for(const [table,field,value] of [
  ['phase4_family_directory_entries','family_token','0'.repeat(64)],
  ['phase4_family_directory_entries','descriptor_json','{}'],
  ['phase4_family_directory_manifests','entry_count',0],
  ['phase4_family_directory_manifests','chain_digest','0'.repeat(64)],
  ['phase4_family_directory_manifests','route_tip_json','null'],
  ['phase4_family_directory_manifests','manifest_hmac','0'.repeat(64)],
])test(`v30 directory tamper ${table}.${field} fails closed`,async t=>{
  const {f,context,directory,entry}=await prepared(t);
  try {await guards(f,table,()=>f.db.raw.execute({sql:`UPDATE ${table} SET ${field}=?
    WHERE user_id='a' AND execution_mode='SHADOW' AND source_token=?`,args:[value,entry.source_token]}));}
  catch(error) {assert.match(String(error),/FOREIGNKEY|CONSTRAINT/);return;}
  await assert.rejects(directory.inventory(context,'recovery_score'),
    /PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID/);
});

for(const [field,value] of [
  ['completed_json','{"inputGeneration":999}'],
  ['requested_json','{"inputGeneration":999}'],
  ['family_manifest_json','{"chainDigest":"bad"}'],
  ['tip_hmac','0'.repeat(64)],
])test(`v30 work-tip tamper ${field} cannot fake completion`,async t=>{
  const {f,context,directory,entry}=await prepared(t);
  await f.db.raw.execute({sql:`UPDATE phase4_family_work_tips SET ${field}=?
    WHERE user_id='a' AND execution_mode='SHADOW' AND source_token=? AND family_token=?`,
    args:[value,entry.source_token,entry.family_token]});
  await assert.rejects(directory.work(context,entry),/PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID/);
});

test('v30 invalidation requests every registered family without completing either',async t=>{
  const {f,context,directory}=await prepared(t),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  const entries=(await directory.inventory(context,'recovery_score')).entries;
  assert.equal(entries.length,2);
  await f.db.transaction(()=>createPhase4QueueStore(f.core).markFull('a','SHADOW',
    context.inputGeneration,context.purgeGeneration,'SOURCE_CHANGED'));
  const current=await f.stores.capture('a',{executionMode:'SHADOW'});
  for(const entry of entries)assert.equal((await directory.work(current,entry)).due,true);
});

test('v30 missing directory entry and signed-manifest rollback both fail closed',async t=>{
  const {f,context,directory,entry}=await prepared(t),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const old=(await f.db.raw.execute({sql:`SELECT * FROM phase4_family_directory_manifests
    WHERE user_id='a' AND source_token=?`,args:[entry.source_token]})).rows[0];
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  await guards(f,'phase4_family_directory_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_family_directory_manifests
    SET entry_count=?,chain_digest=?,route_tip_json=?,manifest_hmac=? WHERE user_id='a' AND source_token=?`,
    args:[old.entry_count,old.chain_digest,old.route_tip_json,old.manifest_hmac,entry.source_token]}));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID/);
  const current=(await f.db.raw.execute({sql:`SELECT * FROM phase4_family_directory_entries
    WHERE user_id='a' AND source_token=? ORDER BY sequence DESC LIMIT 1`,args:[entry.source_token]})).rows[0];
  await guards(f,'phase4_family_work_tips',()=>f.db.raw.execute({sql:`DELETE FROM phase4_family_work_tips
    WHERE user_id='a' AND source_token=? AND family_token=?`,args:[entry.source_token,current.family_token]}));
  await guards(f,'phase4_family_directory_entries',()=>f.db.raw.execute({sql:`DELETE FROM phase4_family_directory_entries
    WHERE user_id='a' AND source_token=? AND sequence=?`,args:[entry.source_token,current.sequence]}));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID/);
});

test('v30 discovery and work-tip check never read broad receipt-route rows',async t=>{
  const {f,context}=await prepared(t);
  const guarded={execute(input) {
    const sql=typeof input==='string'?input:input.sql;
    assert.doesNotMatch(sql,/\bFROM\s+phase4_receipt_routes\b/i);
    assert.doesNotMatch(sql,/\bFROM\s+phase4_operation_receipts\b/i);
    return f.db.raw.execute(input);
  }};
  const directory=createFamilyDirectory(guarded,f.keys);
  const found=await directory.inventory(context,'recovery_score');
  assert.equal(found.entries.length,1);
  assert.equal(typeof (await directory.work(context,found.entries[0])).due,'boolean');
});

test('v30 missing directory manifest never becomes an empty complete directory',async t=>{
  const {f,context,directory,entry}=await prepared(t);
  await guards(f,'phase4_family_directory_manifests',()=>f.db.raw.execute({sql:`DELETE FROM phase4_family_directory_manifests
    WHERE user_id='a' AND source_token=?`,args:[entry.source_token]}));
  await assert.rejects(directory.inventory(context,'recovery_score'),
    /PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID/);
});

test('v30 detects paired old directory and v29 metric-manifest rollback',async t=>{
  const {f,context,directory,entry}=await prepared(t),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const token=createReceiptRouting(f.db.raw,f.keys).token('a','SHADOW','EPISODE',
    ['recovery_score','recovery']);
  const oldRoute=(await f.db.raw.execute({sql:`SELECT * FROM phase4_receipt_route_manifests
    WHERE user_id='a' AND subject_kind='EPISODE' AND subject_token=?`,args:[token]})).rows[0];
  const oldDirectory=(await f.db.raw.execute({sql:`SELECT * FROM phase4_family_directory_manifests
    WHERE user_id='a' AND source_token=?`,args:[entry.source_token]})).rows[0];
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,
    windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  const added=(await f.db.raw.execute({sql:`SELECT * FROM phase4_family_directory_entries
    WHERE user_id='a' AND source_token=? ORDER BY sequence DESC LIMIT 1`,args:[entry.source_token]})).rows[0];
  await guards(f,'phase4_family_work_tips',()=>f.db.raw.execute({sql:`DELETE FROM phase4_family_work_tips
    WHERE user_id='a' AND source_token=? AND family_token=?`,args:[entry.source_token,added.family_token]}));
  await guards(f,'phase4_family_directory_entries',()=>f.db.raw.execute({sql:`DELETE FROM phase4_family_directory_entries
    WHERE user_id='a' AND source_token=? AND sequence=?`,args:[entry.source_token,added.sequence]}));
  await guards(f,'phase4_family_directory_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_family_directory_manifests
    SET entry_count=?,chain_digest=?,route_tip_json=?,manifest_hmac=? WHERE user_id='a' AND source_token=?`,
    args:[oldDirectory.entry_count,oldDirectory.chain_digest,oldDirectory.route_tip_json,
      oldDirectory.manifest_hmac,entry.source_token]}));
  await guards(f,'phase4_receipt_route_manifests',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_route_manifests
    SET entry_count=?,chain_digest=?,manifest_hmac=? WHERE user_id='a' AND subject_kind='EPISODE' AND subject_token=?`,
    args:[oldRoute.entry_count,oldRoute.chain_digest,oldRoute.manifest_hmac,token]}));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID/);
});

test('v30 external family registration reopens the source pass atomically',async t=>{
  const {f}=await prepared(t),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const before=(await f.db.raw.execute({sql:`SELECT scope_revision FROM phase4_jobs
    WHERE user_id='a' AND execution_mode='SHADOW' AND job_kind='RECOMPUTE_DERIVED'`})).rows[0];
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,
    windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  const after=(await f.db.raw.execute({sql:`SELECT scope_revision,scope_kind,full_scan_cursor
    FROM phase4_jobs WHERE user_id='a' AND execution_mode='SHADOW' AND job_kind='RECOMPUTE_DERIVED'`})).rows[0];
  assert.ok(after.scope_revision>before.scope_revision);
  assert.equal(after.scope_kind,'FULL_TENANT_RECOMPUTE');
  assert.equal(after.full_scan_cursor,null);
});

test('v30 completed tip cannot hide a missing precise v29 route entry',async t=>{
  const {f,context,directory,entry}=await prepared(t);
  await directory.complete(context,entry);
  assert.equal((await directory.work(context,entry)).due,false);
  const route=(await f.db.raw.execute({sql:`SELECT * FROM phase4_receipt_route_entries
    WHERE user_id='a' AND subject_kind='EPISODE_FAMILY' AND subject_token=? LIMIT 1`,
    args:[entry.family_token]})).rows[0];
  await guards(f,'phase4_receipt_route_entries',()=>f.db.raw.execute({sql:`DELETE FROM phase4_receipt_route_entries
    WHERE user_id='a' AND subject_kind='EPISODE_FAMILY' AND subject_token=? AND sequence=?`,
    args:[entry.family_token,route.sequence]}));
  await assert.rejects(directory.work(context,entry),/PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID/);
});

test('v30 source completion rejects a family registered after directory enumeration',async t=>{
  const {f,context,directory,entry}=await prepared(t);
  await f.db.transaction(()=>createPhase4QueueStore(f.core).markFull('a','SHADOW',
    context.inputGeneration,context.purgeGeneration,'SOURCE_CHANGED'));
  await directory.complete(context,entry);
  const queue=createReanalysisQueue(f.core),inputs=createReanalysisInputs(f.core,f.stores);
  const lease=await queue.claim(context,'RECOMPUTE_DERIVED');assert.ok(lease);
  const page=await inputs.enumerate(context,null,100);assert.ok(page.length);
  await queue.owned(context,lease,()=>queue.checkpoint(context,lease,page.at(-1).cursor));
  const proof=await queue.end(context,lease,(cursor,limit)=>inputs.enumerate(context,cursor,limit));
  const before=(await directory.inventory(context,'recovery_score')).manifest;
  const base=request(f.initialRefs[0],f.initialRefs.slice(1));
  assert.ok((await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  const after=(await directory.inventory(context,'recovery_score')).manifest;
  assert.equal(after.entry_count,before.entry_count+1);
  await assert.rejects(queue.complete(context,lease,proof),/PHASE4_LEASE_CAS_LOST/);
  await queue.abandon(lease);
});

test('v30 invalidation after a completed family tip makes it due again',async t=>{
  const {f,context,directory,entry}=await prepared(t);
  await f.db.transaction(()=>createPhase4QueueStore(f.core).markFull('a','SHADOW',
    context.inputGeneration,context.purgeGeneration,'SOURCE_CHANGED'));
  await directory.complete(context,entry);
  assert.equal((await directory.work(context,entry)).due,false);
  await f.db.transaction(()=>createPhase4QueueStore(f.core).markFull('a','SHADOW',
    context.inputGeneration,context.purgeGeneration,'SOURCE_CHANGED'));
  const fresh=await f.stores.capture('a',{executionMode:'SHADOW'});
  assert.equal((await directory.work(fresh,entry)).due,true);
});
