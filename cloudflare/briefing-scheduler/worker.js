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

/** 設定錯誤：永遠不該重試，而且要在日誌裡跟傳輸錯誤分得開。 */
function configError(message) {
  const err = new Error(message);
  err.nonRetryable = true;
  err.category = 'configuration';
  return err;
}

export async function invoke(env, {
  fetchImpl = fetch, now = () => Date.now(), sleep = delay,
  timeoutMs = TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const endpoint = new URL(env.BRIEFING_ENDPOINT_URL);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== PATH || endpoint.search || endpoint.hash) {
    throw configError('BRIEFING_ENDPOINT_URL must be the exact HTTPS scheduler endpoint');
  }
  if (/replace|placeholder/i.test(endpoint.hostname)) {
    throw configError('BRIEFING_ENDPOINT_URL placeholder must be replaced');
  }
  if (!env.BRIEFING_TRIGGER_SECRET || new TextEncoder().encode(env.BRIEFING_TRIGGER_SECRET).length < 32) {
    throw configError('BRIEFING_TRIGGER_SECRET must be at least 32 bytes');
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
      lastError.category = response.status === 401 || response.status === 403
        ? 'authentication' : `http_${Math.floor(response.status / 100)}xx`;
      if (response.status >= 300 && response.status < 400) lastError.nonRetryable = true;
      if (!retryableStatus(response.status)) lastError.nonRetryable = true;
      if (lastError.nonRetryable || attempt === MAX_ATTEMPTS) throw lastError;
    } catch (err) {
      lastError = err;
      // ★ 重新導向是**永久**狀況，不是暫時性的傳輸錯誤。
      // redirect:'error' 會讓 fetch 直接丟出來，所以在這裡分類；重試三次
      // 只是白白打三次同一個壞設定。
      if (err?.name === 'TypeError' && /redirect/i.test(String(err?.message ?? ''))) {
        err.nonRetryable = true;
        err.category = 'redirect';
      }
      if (!err.category) {
        err.category = err?.name === 'AbortError' ? 'timeout' : 'transport';
      }
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
      // 只記類別與型別，永遠不記 secret / signature / body / endpoint 憑證 /
      // 個人或健康資料，也不記伺服器回傳的文字。
      console.error(JSON.stringify({
        event: 'briefing_trigger_failed',
        category: String(err?.category ?? 'unknown'),
        error: String(err?.name ?? 'Error'),
        retryable: !err?.nonRetryable,
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
