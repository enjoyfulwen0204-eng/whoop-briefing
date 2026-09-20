import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { HEALTH_REDACTED } from '../src/phase4V22Backfill.js';

test('Runtime experiment writes require provenance before mutation while valid DIRECT fields create and update',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f,control=await stores.captureControl('a');
  const fields={name:'Independent synthetic name',hypothesis:'Unproven copied claim',intervention:'Independent protocol',result_json:{copied:'synthetic secret'}};
  await assert.rejects(stores.experiments.create(control,{creationKey:'unproven-create',fields}),/PROVENANCE_REQUIRED/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM experiments')).rows[0].n,0);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM experiment_field_groups')).rows[0].n,0);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_source_links')).rows[0].n,0);
  const proofs={};
  for(const field of ['name','intervention'])proofs[field]=await stores.experiments.assertDirect(control,{field,value:fields[field],sourceUpdateKey:`assert-${field}`});
  const supplied={name:fields.name,intervention:fields.intervention};
  const created=await stores.experiments.create(control,{creationKey:'create-one',fields:supplied,proofs});
  const read=await stores.experiments.read(control,created.experimentId);
  assert.equal(read.fields.length,10);assert.ok(read.fields.every(r=>r.field_revision===1));
  assert.equal(read.row.name,fields.name);assert.equal(read.row.intervention,fields.intervention);
  assert.equal(read.row.hypothesis,null);assert.equal(read.row.result_json,'{}');
  assert.equal((await db.raw.execute('SELECT hypothesis,result_json FROM experiments')).rows[0].hypothesis,null);
  assert.equal((await stores.experiments.create(control,{creationKey:'create-one',fields:supplied,proofs})).created,false);
  await assert.rejects(stores.experiments.read(control,created.experimentId,{requiredFields:['result_json']}),/REQUIRED_FIELD_REDACTED/);
  const before=await db.raw.execute({sql:'SELECT * FROM experiments WHERE id=?',args:[created.experimentId]});
  const leafCount=(await db.raw.execute('SELECT count(*) n FROM experiment_field_groups')).rows[0].n;
  await assert.rejects(stores.experiments.writeNewFields(control,{experimentId:created.experimentId,fields:{hypothesis:'No proof'},sourceKey:'missing'}),/PROVENANCE_REQUIRED/);
  assert.deepEqual((await db.raw.execute({sql:'SELECT * FROM experiments WHERE id=?',args:[created.experimentId]})).rows,before.rows);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM experiment_field_groups')).rows[0].n,leafCount);
  const hypothesis=await stores.experiments.assertDirect(control,{field:'hypothesis',value:'Direct hypothesis',sourceUpdateKey:'hypothesis'});
  assert.equal(await stores.experiments.writeNewFields(control,{experimentId:created.experimentId,fields:{hypothesis:'Direct hypothesis'},
    proofs:{hypothesis},sourceKey:'hypothesis'}),true);
  assert.equal((await stores.experiments.read(control,created.experimentId)).row.hypothesis,'Direct hypothesis');
  const other=await stores.captureControl('b');assert.equal(await stores.experiments.read(other,created.experimentId),null);
  await assert.rejects(stores.experiments.create(other,{creationKey:'x',fields:supplied,proofs}),/PROOF_MISMATCH/);
  await assert.rejects(stores.experiments.assertDirect(control,{field:'result_json',value:{x:1},sourceUpdateKey:'unproven'}),/DIRECT_ASSERTION_REQUIRED/);
});

test('Field correction stages only new assertion, purges old leaf permanently, preserves siblings and verifies T2 without clearing new projection',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f,control=await stores.captureControl('a');
  const fields={name:'Old synthetic name',intervention:'Independent sibling'};
  const proofs={};for(const field of Object.keys(fields))proofs[field]=await stores.experiments.assertDirect(control,{field,value:fields[field],sourceUpdateKey:`old-${field}`});
  const created=await stores.experiments.create(control,{creationKey:'create-one',fields,proofs});
  const assertion=await stores.experiments.assertDirect(control,{field:'name',value:'New synthetic name',sourceUpdateKey:'new-name'});
  const purgeId=await stores.experiments.correct(control,{experimentId:created.experimentId,field:'name',expectedRevision:1,assertion,idempotencyKey:'correction-one'});
  await assert.rejects(stores.experiments.read(control,created.experimentId),/PURGE_FENCED/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_purge_replacements')).rows[0].n,0);
  const revisions=(await db.raw.execute("SELECT * FROM experiment_field_groups WHERE field_name='name' ORDER BY field_revision")).rows;
  assert.equal(revisions[0].content_state,'REDACTED');assert.equal(revisions[0].is_current,0);assert.equal(revisions[0].content_digest_salt,null);
  assert.equal(revisions[1].content_state,'PRESENT');assert.equal(revisions[1].field_revision,2);assert.equal(revisions[1].supersedes_privacy_artifact_id,revisions[0].privacy_artifact_id);
  await stores.privacy.complete(control,purgeId);await stores.privacy.complete(control,purgeId);
  assert.equal(await stores.experiments.correct(control,{experimentId:created.experimentId,field:'name',expectedRevision:1,idempotencyKey:'correction-one'}),purgeId,
    'durable completed correction replays without requiring the transient assertion ticket');
  const read=await stores.experiments.read(control,created.experimentId);assert.equal(read.row.name,'New synthetic name');assert.equal(read.row.intervention,fields.intervention);
  assert.equal(read.fields.length,10);
  const deletion=await stores.privacy.admit(control,{targetType:'EXPERIMENT',targetId:String(created.experimentId),idempotencyKey:'delete-experiment'});
  await stores.privacy.redact(control,deletion.purge_id);await stores.privacy.complete(control,deletion.purge_id);
  const gone=await stores.experiments.read(control,created.experimentId);assert.equal(gone.row.name,HEALTH_REDACTED);assert.equal(gone.row.intervention,null);
  assert.equal(gone.redactedFields.length,10);
});

test('Journal-derived field purges transitively while independent experiment siblings survive, and new writes fan out once',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f,control=await stores.captureControl('a');
  await db.raw.execute({sql:`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at,
    logical_fact_id,revision,fact_status,privacy_artifact_id,content_state,source_linkage_state)
    VALUES ('a','2026-09-18T10:00:00.000Z','2026-09-18','caffeine',100,'synthetic',?,?,'experiment-source',1,'ACTIVE','experiment-journal','PRESENT','COMPLETE')`,
    args:[f.core.timestamp(),f.core.timestamp()]});
  const c=await stores.capture('a',{executionMode:'SHADOW'}),source=await stores.root(c,'JOURNAL_FACT','experiment-journal');
  const fields={name:'Independent protocol',result_json:{syntheticResult:100}};
  const proofs={name:await stores.experiments.assertDirect(control,{field:'name',value:fields.name,sourceUpdateKey:'direct'}),
    result_json:await stores.experiments.attestDerived(c,{field:'result_json',value:fields.result_json,sourceUpdateKey:'derived',sourceRefs:[source.ref]})};
  const created=await stores.experiments.create(control,{creationKey:'field-linked',fields:{name:fields.name},proofs:{name:proofs.name}});
  assert.equal((await stores.experiments.read(control,created.experimentId)).row.result_json,'{}');
  await stores.experiments.writeNewFields(control,{experimentId:created.experimentId,fields:{result_json:fields.result_json},
    proofs:{result_json:proofs.result_json},sourceKey:'derived-result'});
  await assert.rejects(stores.assertCurrent(c),/INPUT_FENCED/);await stores.release(c);
  assert.equal((await stores.experiments.read(control,created.experimentId)).row.result_json,'{"syntheticResult":100}');
  assert.equal((await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation,2);
  await stores.experiments.create(control,{creationKey:'field-linked',fields:{name:fields.name},proofs:{name:proofs.name}});
  assert.equal((await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation,2);
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'experiment-source',idempotencyKey:'journal-delete'});
  await stores.privacy.redact(control,purge.purge_id);await stores.privacy.complete(control,purge.purge_id);
  const retained=await stores.experiments.read(control,created.experimentId);
  assert.equal(retained.row.name,fields.name);assert.equal(retained.row.result_json,'{}');
  assert.equal(retained.fields.find(r=>r.field_name==='name').content_state,'PRESENT');
  assert.equal(retained.fields.find(r=>r.field_name==='result_json').content_state,'REDACTED');
  await assert.rejects(stores.experiments.create(control,{creationKey:'stale-proof',fields:{name:fields.name},proofs:{name:proofs.name}}),/PROOF_STALE/);
});
