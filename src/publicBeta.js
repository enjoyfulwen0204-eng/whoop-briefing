import { requireUserId } from './userContext.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { createPhase4Foundation } from './phase4Foundation.js';
import { authorizeStage6ShadowWorker, createPhase4Stage6 } from './phase4Reanalysis.js';
import { displayNameFor } from './displayName.js';
import { t } from './localization.js';

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

const approvedMetrics = new Set(['recovery_score','hrv','rhr','sleep_performance',
  'sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain']);
const factorKeys = Object.freeze({ alcohol:'alcohol',caffeine:'caffeine',stress:'stress',
  late_meal:'lateMeal',late_sleep:'lateSleep',sickness:'sickness',travel:'travel',
  exercise_note:'exercise',sauna:'sauna',supplement:'supplement',medication:'medication',
  flight:'flight',location:'location',massage:'massage',food:'food',custom:'custom' });
function localizedAssociation(locale, insight) {
  const claim = insight.claim.trim();
  const supported = /^(.*?) has been repeatedly associated in your data with (higher|lower) ([a-z_]+)\.$/.exec(claim);
  const emerging = /^(.*?) may be associated with (higher|lower) ([a-z_]+); we are still checking\.$/.exec(claim);
  const match = supported ?? emerging;
  if (!match || (supported && insight.status !== 'SUPPORTED')
    || (emerging && insight.status !== 'EMERGING')
    || !factorKeys[match[1]] || !approvedMetrics.has(match[3])) return null;
  return t(locale, supported ? 'beta.associationSupported' : 'beta.associationEmerging', {
    factor: t(locale, `factor.${factorKeys[match[1]]}`),
    direction: t(locale, `beta.direction${match[2] === 'higher' ? 'Higher' : 'Lower'}`),
    metric: t(locale, `metric.${match[3]}`),
  });
}

export function createPublicBetaPresentation({ stores, policy, db, runtimeCapability }) {
  if (!runtimeCapabilities.has(runtimeCapability)) throw new Error('PUBLIC_BETA_RUNTIME_CAPABILITY_REQUIRED');
  if (typeof stores?.withContext !== 'function' || typeof stores?.assertCurrent !== 'function'
    || typeof stores?.betaSummary?.readCurrent !== 'function'
    || typeof policy?.eligible !== 'function' || typeof db?.getUser !== 'function')
    throw new Error('PUBLIC_BETA_PRESENTATION_AUTHORITY_REQUIRED');
  const presentation = {
    eligible: userId => policy.eligible(requireUserId(userId, 'betaSummaryEligibility')),
    async withCurrentSummary({ userId, now = new Date() }, work) {
      const id = requireUserId(userId, 'betaSummary');
      if (!policy.eligible(id)) return null;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof work !== 'function') return null;
      let deliveryStarted = false;
      try {
        const locale = await db.getLocale(id);
        if (!locale) return null;
        return await stores.withContext(id, { executionMode: 'SHADOW' }, async context => {
        const items = await stores.betaSummary.readCurrent(context, { asOfUtc: now.toISOString() });
        if (!items || items.userId !== id || items.executionMode !== 'SHADOW'
          || !Array.isArray(items.episodes) || !Array.isArray(items.insights)) return null;
        const lines = [];
        for (const episode of items.episodes.slice(0, 3)) {
          if (approvedMetrics.has(episode.metricKey) && ['HIGHER','LOWER'].includes(episode.direction))
            lines.push(t(locale, `beta.episode${episode.direction === 'HIGHER' ? 'Higher' : 'Lower'}`,
              { metric: t(locale, `metric.${episode.metricKey}`) }));
        }
        for (const insight of items.insights.slice(0, 2)) {
          if (!['EMERGING', 'SUPPORTED'].includes(insight.status)
            || typeof insight.claim !== 'string' || !insight.claim.trim()
            || insight.claim.length > 300 || /body[_ ]energy/i.test(insight.claim)) continue;
          const rendered = localizedAssociation(locale, insight);
          if (rendered) lines.push(`• ${rendered}`);
        }
        if (!lines.length) return null;
        const name = await displayNameFor(db, id);
        const text = [t(locale, 'beta.title', {
          nameSuffix: name ? t(locale, 'beta.nameSuffix', { name }) : '',
        }), ...lines].join('\n');
        await stores.assertCurrent(context);
        deliveryStarted = true;
        return work(text, async () => {
          await stores.assertCurrent(context);
          // Expiry is semantic, so a generation fence alone is insufficient
          // if delivery waits across an item expiry boundary.
          const current = await stores.betaSummary.readCurrent(context,
            { asOfUtc: new Date().toISOString() });
          if (JSON.stringify(current) !== JSON.stringify(items))
            throw new Error('PHASE4_BETA_SUMMARY_EXPIRED');
          await stores.assertCurrent(context);
        });
        });
      } catch (error) {
        if (deliveryStarted) throw error;
        // A typed read or identity failure withholds the whole optional summary.
        return null;
      }
    },
    summary(request) { return this.withCurrentSummary(request, text => text); },
  };
  return Object.freeze(presentation);
}

export async function createPublicBetaRuntime({ db, keys, admission, executionMode, runtimeCapability,
  presentationPolicy = publicBetaPolicy() } = {}) {
  if (executionMode !== 'SHADOW' || !runtimeCapabilities.has(runtimeCapability))
    throw new Error('PUBLIC_BETA_RUNTIME_CAPABILITY_REQUIRED');
  if (!db?.raw || typeof db.transaction !== 'function') throw new Error('PUBLIC_BETA_DATABASE_REQUIRED');
  requirePhase4Keys(keys);
  if (!admission && typeof db.admitRuntime === 'function'
    && Number((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v) === 31)
    admission = await db.admitRuntime();
  const stage6Capability = authorizeStage6ShadowWorker({ executionMode: 'SHADOW' });
  const [worker, stores] = await Promise.all([
    createPhase4Stage6({ db, keys, admission, executionMode: 'SHADOW', workerCapability: stage6Capability }),
    createPhase4Foundation({ db, keys, admission }),
  ]);
  return Object.freeze({ phase4Stage6: worker,
    betaPresentation: createPublicBetaPresentation({ stores, policy: presentationPolicy, db, runtimeCapability }) });
}
