import {createPhase4Keys} from './phase4Keys.js';

/** Durable Phase 4 authority is required independently of Beta activation. */
export function phase4AuthorityKeys(env = {}) {
  const decode = name => {
    const value = env[name];
    if (typeof value !== 'string' || !/^[a-f\d]{64,}$/i.test(value) || value.length % 2)
      throw new Error('PHASE4_PRIVACY_KEYS_REQUIRED');
    return Buffer.from(value, 'hex');
  };
  return createPhase4Keys({ lookupKey: decode('PHASE4_LOOKUP_KEY'), auditKey: decode('PHASE4_AUDIT_KEY') });
}

