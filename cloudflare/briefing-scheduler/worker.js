const PATH = '/internal/briefing/run';
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 120_000;

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function canonicalMessage({ timestamp, requestId, method, path, body }) {
  return [timestamp, requestId, method.toUpperCase(), path, await sha256(body)].join('\n');
}

export async function signRequest(args, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return `v1=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(await canonicalMessage(args))))}`;
}

export function retryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function invoke(env, {
  fetchImpl = fetch, now = () => Date.now(), sleep = delay,
  timeoutMs = TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const endpoint = new URL(env.BRIEFING_ENDPOINT_URL);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== PATH || endpoint.search || endpoint.hash) {
    throw new Error('BRIEFING_ENDPOINT_URL must be the exact HTTPS scheduler endpoint');
  }
  if (/replace|placeholder/i.test(endpoint.hostname)) {
    throw new Error('BRIEFING_ENDPOINT_URL placeholder must be replaced');
  }
  if (!env.BRIEFING_TRIGGER_SECRET || new TextEncoder().encode(env.BRIEFING_TRIGGER_SECRET).length < 32) {
    throw new Error('BRIEFING_TRIGGER_SECRET must be at least 32 bytes');
  }

  // Reuse metadata for transport retries: the Render process can suppress a duplicate request
  // in memory, while durable report_claims remains the correctness boundary after restart.
  const body = '{}';
  const requestId = crypto.randomUUID();

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timestamp = String(now());
    const args = { timestamp, requestId, method: 'POST', path: PATH, body };
    const signature = await signRequest(args, env.BRIEFING_TRIGGER_SECRET);
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint.toString(), {
        method: 'POST', body, signal: controller.signal, redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-briefing-timestamp': timestamp,
          'x-briefing-request-id': requestId,
          'x-briefing-signature': signature,
        },
      });
      // Drain only a bounded prefix, but never include server text in Worker errors/logs.
      (await response.text()).slice(0, 256);
      if (response.ok) {
        console.log(JSON.stringify({ event: 'briefing_trigger_ok', attempt, status: response.status }));
        return { ok: true, status: response.status, attempt };
      }
      lastError = new Error(`endpoint status ${response.status}`);
      if (response.status >= 300 && response.status < 400) lastError.nonRetryable = true;
      if (!retryableStatus(response.status)) lastError.nonRetryable = true;
      if (lastError.nonRetryable || attempt === MAX_ATTEMPTS) throw lastError;
    } catch (err) {
      lastError = err;
      if (err?.nonRetryable || attempt === MAX_ATTEMPTS) throw err;
    } finally {
      clearTimer(timer);
    }
    await sleep(attempt * 500);
  }
  throw lastError;
}

export default {
  scheduled(_event, env, ctx) {
    const task = invoke(env).catch((err) => {
      console.error(JSON.stringify({
        event: 'briefing_trigger_failed', error: String(err?.name ?? 'Error'),
      }));
      throw err;
    });
    ctx.waitUntil(task);
  },
  async fetch() {
    return new Response(JSON.stringify({ ok: true, service: 'briefing-scheduler' }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
};
