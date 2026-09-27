import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnedDb } from './stage5OwnedDb.js';
import { fixtureKeys } from './localDb.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { legacyFixture,loadLegacyFixture } from './stage5LegacyFixture.js';
import { stage5PrivacyIndex } from '../src/phase4Stage5Privacy.js';
import { buildPhase4Core } from '../src/phase4Core.js';
import { guards,T } from './stage5ReviewBFixture.js';

for(const version of ['pre25','v25'])test(`H001: real ${version} standalone Journal explanation is purged without naming links or fabricated authority`,async t=>{
  const fixture=legacyFixture(t,{version,standaloneExplanation:true}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage5-review-b-privacy-'));
  const db=createOwnedDb({url:`file:${path.join(dir,'fixture.db')}`});t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate();await loadLegacyFixture(db,fixture);
  const stores=await createPhase4Foundation({db,keys:fixtureKeys,now:()=>new Date(T)});
  const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
    afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,authorizeMode(){},now:()=>new Date(T)});
  const saved={};for(const table of ['observation_episodes','episode_events','phase4_episode_revisions'])saved[table]=(await db.raw.execute(`SELECT * FROM ${table}`)).rows;
  assert.match(saved.observation_episodes[0].explanation_json,/REVIEW_B_LEGACY_STANDALONE_SECRET/);
  assert.equal(saved.phase4_episode_revisions.length,version==='pre25'?0:2);
  for(const table of ['phase4_operation_receipts','phase4_evidence_result_authorities'])assert.equal((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
  await db.raw.execute('DELETE FROM phase4_source_links');
  const fact=(await db.raw.execute('SELECT * FROM journal_events')).rows[0],control=await stores.capturePrivacyControl('a');
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:fact.logical_fact_id,idempotencyKey:`review-b-${version}`});
  await stores.privacy.redact(control,purge.purge_id);
  for(const table of Object.keys(saved)) {
    assert.equal((await db.raw.execute(`SELECT count(*) n FROM ${table} WHERE content_state='PRESENT'`)).rows[0].n,0,table);
    assert.ok(!(await db.raw.execute(`SELECT * FROM ${table}`)).rows.some(row=>JSON.stringify(row).includes('REVIEW_B_LEGACY_STANDALONE_SECRET')));
  }
  await assert.rejects(db.transaction(async()=>{
    assert.equal((await stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');throw Error('ROLLBACK_COMPLETE_PROBE');
  }),/ROLLBACK_COMPLETE_PROBE/);
  // Independently simulate an omitted legacy family while the ledger lies.
  // Restore only captured historical bytes, never modern authority or HMACs.
  for(const [table,rows] of Object.entries(saved))await guards({db},table,async()=>{
    for(const row of rows) {
      const fields=Object.keys(row);await db.raw.execute({sql:`UPDATE ${table} SET ${fields.map(key=>`${key}=?`).join(',')} WHERE privacy_artifact_id=?`,
        args:[...fields.map(key=>row[key]),row.privacy_artifact_id]});
    }
  });
  await db.raw.execute("DELETE FROM health_purge_targets WHERE artifact_type IN ('observation_episodes','episode_events','phase4_episode_revisions')");
  await assert.rejects(stage5PrivacyIndex(core,'a',{verifyRemaining:true}),/PURGE_CLOSURE_UNPROVEN|PURGE_SENSITIVE_REMAINS/);
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/PURGE_CLOSURE_UNPROVEN|PURGE_SENSITIVE_REMAINS|UNCLASSIFIED_PLAINTEXT_REMAINS/);
  assert.notEqual((await stores.privacy.status(control,purge.purge_id)).state,'COMPLETE');
  await assert.rejects(stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
  for(const table of ['phase4_operation_receipts','phase4_evidence_result_authorities'])assert.equal((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
});
