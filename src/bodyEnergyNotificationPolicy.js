import {ANTI_SPAM_POLICY} from './proactivePolicy.js';
import {PHASE4_METRICS} from './phase4IntelligenceRegistry.js';
import {BODY_ENERGY_RELEASE_CRITERIA} from './bodyEnergyReleaseCriteria.js';
/** Explicit narrow Body Energy product policy. Existing thresholds are reused;
 * these are engineering/product contracts, never clinical population norms. */
export const BODY_ENERGY_NOTIFICATION_POLICY=Object.freeze({
  version:'body-energy-drop-policy-v1',signalCode:'BODY_ENERGY_FRESH_LOAD_DROP',
  absoluteFloor:PHASE4_METRICS.body_energy.absoluteFloor,relativeFloor:PHASE4_METRICS.body_energy.relativeFloor,
  denominatorFloor:PHASE4_METRICS.body_energy.denominatorFloor,
  freshnessMaximumMs:BODY_ENERGY_RELEASE_CRITERIA.freshMaximumMs,
  topicCooldownMs:ANTI_SPAM_POLICY.TOPIC_COOLDOWN_HOURS*3600_000,
  rollingDailyCap:ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP,
  reportType:'body_energy_drop',defaultOptIn:false,
  trigger:'EXISTING_FINALIZED_STAGE6_DRAIN_ONLY',
});
