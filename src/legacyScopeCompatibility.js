import { requirePhase4Keys } from './phase4Keys.js';
import { addPrivacyLink } from './phase4V22Backfill.js';

/** Minimal v22 dual-write compatibility. No worker, purge admission or scheduling.
 * The broader read/currentness/lease adapter is installed with Foundation stores. */
export function legacyScopeCompatibility(client, keys) {
  async function available() {
    return (await client.execute('PRAGMA table_info(analytics_invalidation)')).rows.some(r => r.name === 'scope_kind');
  }
  async function range(userId, table, from, to, now, cls = null) {
    if (!await available()) return { suffix: '', values: [], columns: '', placeholders: '', full: false };
    const prior = (await client.execute({ sql: `SELECT * FROM ${table} WHERE user_id=?${cls ? ' AND class=?' : ''}`,
      args: cls ? [userId,cls] : [userId] })).rows[0];
    const full = prior?.scope_kind === 'FULL_TENANT_RECOMPUTE';
    const valid = !full && typeof from === 'string' && typeof to === 'string' && from <= to;
    const kind = valid ? 'HEALTH_DATE_RANGE' : 'FULL_TENANT_RECOMPUTE';
    const crypto = requirePhase4Keys(keys);
    const id = prior?.privacy_artifact_id ?? crypto.lookup(['privacy-artifact-v1', table, userId, 'SHARED',
      cls ? [userId,cls] : [userId]]);
    if (!(await client.execute({sql:'SELECT 1 FROM users WHERE id=?',args:[userId]})).rows.length) throw new Error('phase4_scope_tenant_missing');
    if (prior?.content_state !== 'REDACTED') await addPrivacyLink(client,{userId,table,artifactId:id,sourceType:'TENANT_LEGACY',sourceId:userId,at:now});
    const fields = ['scope_kind','privacy_artifact_id','content_state','source_linkage_state'];
    const values = [kind,id,prior?.content_state === 'REDACTED' ? 'REDACTED' : 'PRESENT',
      prior?.content_state === 'REDACTED' ? 'DISCONNECTED' : 'COMPLETE'];
    return { suffix: ', '+fields.map(f=>`${f}=?`).join(','), values, columns: ', '+fields.join(','),
      placeholders: ', '+fields.map(()=>'?').join(','), full: kind === 'FULL_TENANT_RECOMPUTE' };
  }
  return { available, range };
}
