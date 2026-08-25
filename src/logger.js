/**
 * Structured log（一行一個 JSON），並自動遮蔽 token / key。
 * Render 的 log 面板直接看得懂，也方便日後 grep。
 */

const SECRET_KEYS = [
  'access_token', 'refresh_token', 'authorization', 'api_key', 'apikey',
  'client_secret', 'auth_token', 'bot_token', 'code', 'password', 'token',
];

const SECRET_ENV_VALUES = () =>
  [
    process.env.WHOOP_CLIENT_SECRET,
    process.env.OPENROUTER_API_KEY,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TURSO_AUTH_TOKEN,
  ].filter((v) => typeof v === 'string' && v.length >= 8);

function redactString(s) {
  let out = s;
  for (const secret of SECRET_ENV_VALUES()) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(k.toLowerCase())) {
      out[k] = typeof v === 'string' && v.length ? `[REDACTED:${v.length}]` : '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function emit(level, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields || {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const log = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};

/** Error → 可安全寫進 log / Telegram 的短字串（不含 token）。 */
export function describeError(err) {
  if (!err) return 'unknown error';
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactString(msg).slice(0, 500);
}
