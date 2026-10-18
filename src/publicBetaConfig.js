import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
export {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
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


export const publicBetaKeys = phase4AuthorityKeys;

export function publicBetaKeysIfPresent(env = {}) {
  if (!env.PHASE4_LOOKUP_KEY && !env.PHASE4_AUDIT_KEY) return undefined;
  return publicBetaKeys(env);
}
