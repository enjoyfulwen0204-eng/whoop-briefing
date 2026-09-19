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

// Operational logs are not a health store. Keep a positive field allowlist:
// secret filtering alone cannot make arbitrary subjects, names, prompts,
// physiological dates or provider error text safe to retain.
const OPAQUE_FIELDS=new Set(['user_id','update_id','event_id','run_id','job_id','message_id','request_id','attempt_id','owner_id']);
const COUNT_FIELDS=new Set(['attempt','attempts','count','changed','unchanged','blocked','rows','duration_ms','elapsed_ms',
  'generation','lifecycle_generation','auth_generation','input_generation','purge_generation','version','from','to',
  'status_code','http_status','retry_after_ms','bytes','tokens','input_tokens','output_tokens']);
const ENUM_FIELDS=new Set(['status','state','result','reason','code','error_code','quality','level','class','resource','resource_type','mode']);
const SAFE_ENUMS=new Set(['ACTIVE','INACTIVE','PENDING','RUNNING','COMPLETED','FAILED','RETRY','READY','BLOCKED','UNAVAILABLE',
  'SHADOW','LIVE','DELIVERED','AMBIGUOUS','DELIVERY_STARTED','NOT_REQUIRED','ACTION_READY','REDACTED','PRESENT','COMPLETE',
  'SOURCE_CHANGED','SOURCE_DELETED','SOURCE_CORRECTED','CONTENT_REDACTED','AUTH_CHANGED','LIFECYCLE_CHANGED',
  'claimed','completed','abandoned','in_progress','unavailable','identity_conflict','sleep','recovery','cycle','workout',
  'processing_failed','ownership_lost','non_private_chat','bot_sender','sender_chat_mismatch','LIGHT','HEAVY']);
export function operationalLogFields(fields={}) {
  const result={};
  for(const [key,value] of Object.entries(fields)) {
    if(OPAQUE_FIELDS.has(key) && (typeof value==='number' && Number.isSafeInteger(value)
      || typeof value==='string' && /^[A-Za-z0-9:._@#-]{1,256}$/.test(value)))result[key]=redact(value);
    else if(COUNT_FIELDS.has(key) && typeof value==='number' && Number.isFinite(value))result[key]=value;
    else if(ENUM_FIELDS.has(key) && SAFE_ENUMS.has(value))result[key]=value;
    else if(['table','column'].includes(key) && typeof value==='string' && /^[a-z_]{1,64}$/.test(value))result[key]=value;
    else if(key==='error')result.error='OPERATION_FAILED';
  }
  return result;
}
function emit(level, event, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event:typeof event==='string' && /^[a-z0-9_.:-]{1,100}$/.test(event)?event:'operation_event',
    ...operationalLogFields(fields || {}),
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
  if (!err) return 'UNKNOWN_ERROR';
  const codes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','SQLITE_BUSY','SQLITE_CONSTRAINT','ABORT_ERR']);
  if(codes.has(err.code))return err.code;
  if(err.name==='AbortError')return 'ABORT_ERR';
  // These closed local admission messages contain schema numbers or opaque
  // identity only. Provider errors, URLs, query text and payloads never match.
  const message=String(err.message??'');
  const localAdmission=[
    /^schema 版本 \d+ ≠ 程式碼 \d+；請先有意識地執行 npm run migrate$/,
    /^無法讀取 schema_version（(?:OPERATION_FAILED|SQLITE_BUSY|SQLITE_CONSTRAINT)）；拒絕執行$/,
    /^缺少環境變數：(?:WHOOP_CLIENT_ID|WHOOP_CLIENT_SECRET|TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)(?:[,、 ]+(?:WHOOP_CLIENT_ID|WHOOP_CLIENT_SECRET|TURSO_DATABASE_URL|TURSO_AUTH_TOKEN))*$/,
    /^找不到使用者：[A-Za-z0-9_-]{1,128}$/,
    /^使用者 [A-Za-z0-9_-]{1,128} 的狀態是 (?:PAUSED|DISABLED)（非 ACTIVE）。對帳預設不處理停用帳號；確定要做資料修復請加 --allow-inactive。$/,
  ];
  if(localAdmission.some(pattern=>pattern.test(message)))return message;
  return 'OPERATION_FAILED';
}
