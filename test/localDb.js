/** Synthetic local fixtures only. These keys are never application defaults. */
import { createDb as createApplicationDb } from '../src/db.js';
import { createPhase4Keys } from '../src/phase4Keys.js';
export * from '../src/db.js';
export const fixtureKeys = createPhase4Keys({ lookupKey: Buffer.alloc(32, 71), auditKey: Buffer.alloc(32, 83) });
export function createDb(options) {
  if (options.url !== ':memory:' && !options.url?.startsWith('file:')) throw new Error('synthetic_local_database_only');
  return createApplicationDb({ phase4Keys: fixtureKeys, ...options });
}
