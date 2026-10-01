import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '../src/schema.js';

/** A v30 database with an old version label and fabricated old DDL is not an
 * authentic historical database. Migration must reject the hybrid and leave
 * existing account authority untouched. Authentic v9/v19 fixtures are tested
 * separately. */
export async function rejectHybridRewind(db, claimedVersion) {
  assert.equal(SCHEMA_VERSION, 31);
  const before = (await db.raw.execute('SELECT id,status,lifecycle_generation FROM users ORDER BY id')).rows;
  await db.raw.execute('DROP TABLE phase4_jobs');
  await db.raw.execute('CREATE TABLE phase4_jobs (fabricated_old_shape TEXT)');
  await db.raw.execute('DELETE FROM schema_version');
  await db.raw.execute({ sql: "INSERT INTO schema_version(version,applied_at,note) VALUES (?,?,'invalid hybrid fixture')",
    args: [claimedVersion, new Date('2026-09-15T00:00:00.000Z').toISOString()] });
  await assert.rejects(db.migrate(), /phase4_schema_postcondition_failed/);
  assert.deepEqual((await db.raw.execute('SELECT id,status,lifecycle_generation FROM users ORDER BY id')).rows,before);
}
