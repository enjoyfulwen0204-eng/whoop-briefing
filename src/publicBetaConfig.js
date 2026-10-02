import { createPhase4Keys } from './phase4Keys.js';
import { publicBetaPolicy } from './publicBeta.js';

/** Read only configuration. A flag never manufactures the runtime capability. */
export function publicBetaConfiguration(env = {}) {
  const runtime = env.PHASE4_BETA_SHADOW_RUNTIME ?? 'off';
  if (!['off', 'on'].includes(runtime)) throw new Error('PUBLIC_BETA_RUNTIME_CONFIG_INVALID');
  const mode = env.PHASE4_PUBLIC_BETA_MODE ?? 'off';
  const rawIds = env.PHASE4_PUBLIC_BETA_USER_IDS ?? '';
  const userIds = rawIds === '' ? [] : rawIds.split(',').map(id => id.trim());
  const policy = publicBetaPolicy({ mode, userIds });
  if (runtime === 'off' && mode !== 'off') throw new Error('PUBLIC_BETA_RUNTIME_REQUIRED');
  return Object.freeze({ runtime, policy, mode });
}

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

export const publicBetaKeys = phase4AuthorityKeys;

export function publicBetaKeysIfPresent(env = {}) {
  if (!env.PHASE4_LOOKUP_KEY && !env.PHASE4_AUDIT_KEY) return undefined;
  return publicBetaKeys(env);
}
