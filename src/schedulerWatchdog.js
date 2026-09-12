import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { log, describeError } from './logger.js';

export const SCHEDULER_MAX_AGE_MS = Object.freeze({
  cloudflare: 30 * 60_000,
  github: 2 * 60 * 60_000,
});

const componentFor = (source) => source === 'cloudflare'
  ? HEARTBEAT_COMPONENT.CLOUDFLARE : HEARTBEAT_COMPONENT.GITHUB;

export async function checkPeerScheduler({ db, source, systemTelegram, now = new Date() }) {
  const peer = source === 'cloudflare' ? 'github' : 'cloudflare';
  try {
    const heartbeat = await db.getHeartbeat(GLOBAL_SCOPE, componentFor(peer));
    if (!heartbeat?.lastOkAt) {
      log.warn('scheduler_peer_unknown', { source, peer });
      return { peer, status: 'unknown', alerted: false };
    }
    const ageMs = now.getTime() - Date.parse(heartbeat.lastOkAt);
    if (!Number.isFinite(ageMs) || ageMs <= SCHEDULER_MAX_AGE_MS[peer]) {
      return { peer, status: 'healthy', alerted: false, ageMs };
    }
    const alerted = await systemTelegram.notifyError(
      `scheduler_${peer}_stale`,
      `${peer} briefing trigger has no successful heartbeat within its expected tolerance.`,
    );
    return { peer, status: 'stale', alerted, ageMs };
  } catch (err) {
    log.warn('scheduler_watchdog_failed', { source, peer, error: describeError(err) });
    return { peer, status: 'unknown', alerted: false, error: true };
  }
}
