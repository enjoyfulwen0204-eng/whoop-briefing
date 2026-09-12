import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const BRIEFING_TRIGGER = Object.freeze({
  PATH: '/internal/briefing/run',
  MAX_BODY_BYTES: 1024,
  MAX_CLOCK_SKEW_MS: 5 * 60_000,
  REQUEST_ID_RE: /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/,
});

export function bodySha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function canonicalTriggerMessage({ timestamp, requestId, method, path, body }) {
  return [timestamp, requestId, method.toUpperCase(), path, bodySha256(body)].join('\n');
}

export function signTriggerRequest(args, secret) {
  return `v1=${createHmac('sha256', secret).update(canonicalTriggerMessage(args)).digest('hex')}`;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function verifyTriggerRequest({
  timestamp, requestId, method, path, body, signature, secret, now = Date.now(),
}) {
  if (!secret || !signature || !timestamp || !requestId) return { ok: false, reason: 'missing_auth' };
  if (!BRIEFING_TRIGGER.REQUEST_ID_RE.test(requestId)) return { ok: false, reason: 'malformed_request_id' };
  if (!/^\d{10,13}$/.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };
  const raw = Number(timestamp);
  const requestMs = timestamp.length === 10 ? raw * 1000 : raw;
  if (!Number.isFinite(requestMs)) return { ok: false, reason: 'malformed_timestamp' };
  if (Math.abs(now - requestMs) > BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: requestMs > now ? 'future_timestamp' : 'stale_timestamp' };
  }
  const expected = signTriggerRequest({ timestamp, requestId, method, path, body }, secret);
  if (!safeEqual(signature, expected)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}
