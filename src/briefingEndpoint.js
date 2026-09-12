import { BRIEFING_TRIGGER, verifyTriggerRequest } from './briefingTriggerAuth.js';
import { log, describeError } from './logger.js';

function aggregate(summary) {
  const daily = {};
  for (const item of summary?.perUser ?? []) {
    const key = item.daily ?? 'not_run';
    daily[key] = (daily[key] ?? 0) + 1;
  }
  return {
    users_evaluated: summary?.users ?? 0,
    users_ok: summary?.ok ?? 0,
    users_failed: summary?.failed ?? 0,
    users_skipped: summary?.skipped ?? 0,
    daily,
    application_errors: (summary?.errors?.length ?? 0) + (summary?.failed ?? 0),
  };
}

export function createBriefingEndpoint({
  secret, runBriefing, now = () => Date.now(), maxBodyBytes = BRIEFING_TRIGGER.MAX_BODY_BYTES,
}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('BRIEFING_TRIGGER_SECRET must be at least 32 bytes');
  }
  if (typeof runBriefing !== 'function') throw new Error('runBriefing is required');
  const recent = new Map();
  let activeRun = null;
  const prune = (at) => {
    for (const [id, v] of recent) if (at - v.at > BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS) recent.delete(id);
  };

  return async function briefingEndpoint(req, body) {
    const rawUrl = String(req.url ?? '');
    const path = rawUrl.split('?')[0];
    if (path !== BRIEFING_TRIGGER.PATH) return null;
    if (rawUrl !== path) return { status: 400, body: { ok: false, error: 'query_not_allowed' } };
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return { status: 415, body: { ok: false, error: 'unsupported_media_type' } };
    }
    if (Buffer.byteLength(body) > maxBodyBytes) return { status: 413, body: { ok: false, error: 'body_too_large' } };
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_json' } };
    }

    const timestamp = String(req.headers?.['x-briefing-timestamp'] ?? '');
    const requestId = String(req.headers?.['x-briefing-request-id'] ?? '');
    const signature = String(req.headers?.['x-briefing-signature'] ?? '');
    const at = now();
    const auth = verifyTriggerRequest({
      timestamp, requestId, method: req.method, path, body, signature, secret, now: at,
    });
    if (!auth.ok) {
      log.warn('briefing_trigger_rejected', { reason: auth.reason });
      return { status: 401, body: { ok: false, error: 'unauthorized' } };
    }

    prune(at);
    if (recent.has(requestId)) return recent.get(requestId).promise;
    const started = Date.now();
    log.info('briefing_trigger_received', { source: 'cloudflare', request_id: requestId });
    const promise = (async () => {
      try {
        // Different authenticated Cron invocations may overlap during a cold/slow run. They join
        // one process-local canonical run; durable report_claims still protect across processes.
        if (!activeRun) {
          activeRun = Promise.resolve(runBriefing({ triggerSource: 'cloudflare' }))
            .finally(() => { activeRun = null; });
        }
        const result = aggregate(await activeRun);
        const ok = result.application_errors === 0;
        log.info('briefing_trigger_finished', {
          source: 'cloudflare', request_id: requestId, ok, duration_ms: Date.now() - started,
          users: result.users_evaluated, failed: result.users_failed,
        });
        return { status: ok ? 200 : 207, body: { ok, source: 'cloudflare', result } };
      } catch (err) {
        log.error('briefing_trigger_failed', {
          source: 'cloudflare', request_id: requestId, error: describeError(err),
        });
        return { status: 503, body: { ok: false, error: 'briefing_run_failed' } };
      }
    })();
    recent.set(requestId, { at, promise });
    return promise;
  };
}
