import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { log, describeError } from './logger.js';

// GitHub's worst observed gap was 273 minutes. Twelve hours is >2.6x that evidence and
// deliberately treats the best-effort backup as degraded without paging the product user.
export const SCHEDULER_POLICY = Object.freeze({
  cloudflare: Object.freeze({
    role: 'primary', component: HEARTBEAT_COMPONENT.CLOUDFLARE,
    healthyAgeMs: 30 * 60_000, degradedAgeMs: 30 * 60_000,
    alertableAgeMs: 30 * 60_000, notify: true,
  }),
  github: Object.freeze({
    role: 'backup', component: HEARTBEAT_COMPONENT.GITHUB,
    healthyAgeMs: 6 * 60 * 60_000, degradedAgeMs: 6 * 60 * 60_000,
    alertableAgeMs: 12 * 60 * 60_000, notify: false,
  }),
});

export function providerState(heartbeat, provider, now = new Date()) {
  const policy = SCHEDULER_POLICY[provider];
  if (!heartbeat?.lastOkAt) return { provider, state: 'uninitialized', ageMs: null };
  const ageMs = now.getTime() - Date.parse(heartbeat.lastOkAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { provider, state: 'unknown', ageMs: null };
  if (ageMs <= policy.healthyAgeMs) return { provider, state: 'healthy', ageMs };
  if (ageMs <= policy.alertableAgeMs) return { provider, state: 'delayed', ageMs };
  return { provider, state: 'stale', ageMs };
}

export function aggregateSchedulerState(cloudflare, github) {
  if (cloudflare.state === 'healthy') return 'healthy';
  if (github.state === 'healthy' || github.state === 'delayed') return 'degraded';
  if (cloudflare.state === 'stale' && github.state === 'stale') return 'outage';
  if (cloudflare.state === 'uninitialized' && github.state === 'uninitialized') return 'uninitialized';
  return 'unknown';
}

export async function readSchedulerHealth({ db, now = new Date() }) {
  const [cf, gh] = await Promise.all([
    db.getHeartbeat(GLOBAL_SCOPE, SCHEDULER_POLICY.cloudflare.component),
    db.getHeartbeat(GLOBAL_SCOPE, SCHEDULER_POLICY.github.component),
  ]);
  const cloudflare = providerState(cf, 'cloudflare', now);
  const github = providerState(gh, 'github', now);
  return { cloudflare, github, overall: aggregateSchedulerState(cloudflare, github) };
}

export async function checkPeerScheduler({ db, source, systemTelegram, now = new Date() }) {
  try {
    const health = await readSchedulerHealth({ db, now });
    const peer = source === 'cloudflare' ? health.github : health.cloudflare;
    log.info('scheduler_watchdog_state', {
      source, peer: peer.provider, peer_state: peer.state, overall: health.overall,
      peer_age_ms: peer.ageMs,
    });
    let alerted = false;
    if (source === 'github' && peer.state === 'stale') {
      alerted = await systemTelegram.notifyError(
        'scheduler_primary_stale',
        'The frequent briefing scheduler has no recent successful completion; hourly fallback ran.',
      );
    }
    return { ...health, peer: peer.provider, alerted };
  } catch (err) {
    log.warn('scheduler_watchdog_failed', { source, error: describeError(err) });
    return { overall: 'unknown', peer: source === 'cloudflare' ? 'github' : 'cloudflare', alerted: false };
  }
}
