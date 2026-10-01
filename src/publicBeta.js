import { requireUserId } from './userContext.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { createPhase4Foundation } from './phase4Foundation.js';
import { authorizeStage6ShadowWorker, createPhase4Stage6 } from './phase4Reanalysis.js';

const runtimeCapabilities = new WeakSet();

export function publicBetaPolicy({ mode = 'off', userIds = [] } = {}) {
  if (!['off', 'allowlist', 'all'].includes(mode) || !Array.isArray(userIds)
    || userIds.some(id => typeof id !== 'string' || !id.trim())
    || (mode === 'allowlist' && userIds.length === 0)) {
    throw new Error('PUBLIC_BETA_CONFIG_INVALID');
  }
  const ids = new Set(userIds.map(id => requireUserId(id, 'publicBetaPolicy')));
  return Object.freeze({ mode, eligible: userId => {
    const id = requireUserId(userId, 'publicBetaEligibility');
    return mode === 'all' || (mode === 'allowlist' && ids.has(id));
  } });
}

/** Issued only by an explicit server composition. Neither a string flag nor
 * a serialized request can serve as this capability. */
export function authorizePublicBetaRuntime({ executionMode } = {}) {
  if (executionMode !== 'SHADOW') throw new Error('PUBLIC_BETA_SHADOW_REQUIRED');
  const capability = Object.freeze({});
  runtimeCapabilities.add(capability);
  return capability;
}

export function createPublicBetaPresentation({ stores, policy, runtimeCapability }) {
  if (!runtimeCapabilities.has(runtimeCapability)) throw new Error('PUBLIC_BETA_RUNTIME_CAPABILITY_REQUIRED');
  if (typeof stores?.withContext !== 'function' || typeof stores?.bodyEnergy?.readLatestCurrent !== 'function'
    || typeof policy?.eligible !== 'function') throw new Error('PUBLIC_BETA_PRESENTATION_AUTHORITY_REQUIRED');
  return Object.freeze({
    async bodyEnergySection({ userId, healthDate, now = new Date() }) {
      const id = requireUserId(userId, 'bodyEnergySection');
      if (!policy.eligible(id)) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(healthDate) || !(now instanceof Date)
        || !Number.isFinite(now.getTime())) return null;
      try {
        const result = await stores.withContext(id, { executionMode: 'SHADOW' }, context =>
          stores.bodyEnergy.readLatestCurrent(context, { healthDate, asOfEpochMs: now.getTime() }));
        if (!result || result.row.user_id !== id || result.row.execution_mode !== 'SHADOW'
          || result.row.health_date !== healthDate || result.calculation?.value == null) return null;
        return `⚡ 身體能量 ${result.calculation.value}/100`;
      } catch {
        // Typed authority failures, privacy fences and unavailable results all
        // omit this optional section. Never calculate or query a fallback row.
        return null;
      }
    },
  });
}

export async function createPublicBetaRuntime({ db, keys, executionMode, runtimeCapability,
  presentationPolicy = publicBetaPolicy() } = {}) {
  if (executionMode !== 'SHADOW' || !runtimeCapabilities.has(runtimeCapability))
    throw new Error('PUBLIC_BETA_RUNTIME_CAPABILITY_REQUIRED');
  if (!db?.raw || typeof db.transaction !== 'function') throw new Error('PUBLIC_BETA_DATABASE_REQUIRED');
  requirePhase4Keys(keys);
  const stage6Capability = authorizeStage6ShadowWorker({ executionMode: 'SHADOW' });
  const [worker, stores] = await Promise.all([
    createPhase4Stage6({ db, keys, executionMode: 'SHADOW', workerCapability: stage6Capability }),
    createPhase4Foundation({ db, keys }),
  ]);
  return Object.freeze({ phase4Stage6: worker,
    betaPresentation: createPublicBetaPresentation({ stores, policy: presentationPolicy, runtimeCapability }) });
}
