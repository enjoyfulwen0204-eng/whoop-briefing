/**
 * V1.2 Phase 1 — WHOOP webhook 的認證、解析與路由。
 *
 * 這一支只碰「請求進來到耐久寫下」那一段，完全不打任何網路，
 * 不碰生產環境，也不註冊任何 webhook。
 *
 * 認證用的是官方機制（developer.whoop.com）：
 *   X-WHOOP-Signature            = base64(HMACSHA256(timestamp + rawBody, client_secret))
 *   X-WHOOP-Signature-Timestamp  = 毫秒 epoch
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

import { createDb } from '../src/db.js';
import {
  verifyWhoopWebhook, computeWhoopSignature,
  WHOOP_AUTH_FAILURE, WHOOP_SIGNATURE_HEADER, WHOOP_TIMESTAMP_HEADER,
} from '../src/whoopWebhookAuth.js';
import { parseWhoopEvent, WHOOP_PARSE_FAILURE } from '../src/whoopWebhookEvent.js';
import { createWhoopWebhookIngest, INGEST_OUTCOME, statusForIngest } from '../src/whoopWebhookIngest.js';
import { createWebhookHandler, whoopWebhookConfiguration } from '../src/bot/webhook.js';
import { WHOOP_WEBHOOK } from '../src/config.js';

const SECRET = 'whoop-client-secret-for-tests-only';
const NOW = 1_789_000_000_000;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-wh-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const body = (over = {}) => JSON.stringify({
  user_id: 10129,
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  type: 'sleep.updated',
  trace_id: 'd3709ee7-104e-4f70-a928-2932964b017b',
  ...over,
});

const signed = (raw, { ts = NOW, secret = SECRET } = {}) => ({
  [WHOOP_TIMESTAMP_HEADER]: String(ts),
  [WHOOP_SIGNATURE_HEADER]: computeWhoopSignature(String(ts), raw, secret),
});

// ===========================================================================
// 認證
// ===========================================================================

test('★★★ 官方公式：timestamp + rawBody，HMAC-SHA256，base64', () => {
  const raw = body();
  const expected = createHmac('sha256', SECRET)
    .update(String(NOW) + raw).digest('base64');
  assert.equal(computeWhoopSignature(String(NOW), raw, SECRET), expected,
    '★ 必須與官方文件的公式逐字一致');
  const r = verifyWhoopWebhook({ headers: signed(raw), rawBody: raw, clientSecret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.timestampMs, NOW);
});

test('★★★ 簽的是**原始位元組**：重新序列化過的 JSON 一定對不上', () => {
  const raw = body();
  const headers = signed(raw);
  // 同樣的資料、不同的鍵順序／空白 —— 這正是「先 parse 再驗」會踩到的坑。
  const reserialized = JSON.stringify(JSON.parse(raw), Object.keys(JSON.parse(raw)).reverse());
  assert.notEqual(reserialized, raw);
  assert.equal(
    verifyWhoopWebhook({ headers, rawBody: reserialized, clientSecret: SECRET, now: NOW }).ok,
    false, '★ 驗證一定要用原始 body',
  );
});

test('★★★ 缺認證 / 壞認證一律 fail closed', () => {
  const raw = body();
  const cases = [
    ['完全沒有標頭', {}, WHOOP_AUTH_FAILURE.MISSING_SIGNATURE],
    ['只有簽章沒有時間戳', { [WHOOP_SIGNATURE_HEADER]: 'x' }, WHOOP_AUTH_FAILURE.MISSING_TIMESTAMP],
    ['時間戳不是數字', {
      [WHOOP_SIGNATURE_HEADER]: 'x', [WHOOP_TIMESTAMP_HEADER]: '17890abc',
    }, WHOOP_AUTH_FAILURE.BAD_TIMESTAMP],
    ['簽章錯誤', {
      ...signed(raw), [WHOOP_SIGNATURE_HEADER]: computeWhoopSignature(String(NOW), raw, 'wrong'),
    }, WHOOP_AUTH_FAILURE.BAD_SIGNATURE],
    ['簽章是空字串', {
      ...signed(raw), [WHOOP_SIGNATURE_HEADER]: '',
    }, WHOOP_AUTH_FAILURE.MISSING_SIGNATURE],
  ];
  for (const [label, headers, reason] of cases) {
    const r = verifyWhoopWebhook({ headers, rawBody: raw, clientSecret: SECRET, now: NOW });
    assert.equal(r.ok, false, `★ ${label} 必須被拒絕`);
    assert.equal(r.reason, reason, `★ ${label} 的分類`);
  }
});

test('★★★ 沒有 client secret → 無法驗證 → 拒絕（絕不 fail open）', () => {
  const raw = body();
  for (const secret of [null, undefined, '']) {
    const r = verifyWhoopWebhook({ headers: signed(raw), rawBody: raw, clientSecret: secret, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.reason, WHOOP_AUTH_FAILURE.NOT_CONFIGURED);
  }
});

test('★★★ 時間戳新鮮度：太舊與太新都要擋（重放窗口是雙向的）', () => {
  const raw = body();
  const tol = 5 * 60_000;
  const mk = (ts) => verifyWhoopWebhook({
    headers: signed(raw, { ts }), rawBody: raw, clientSecret: SECRET, now: NOW, toleranceMs: tol,
  });
  assert.equal(mk(NOW).ok, true);
  assert.equal(mk(NOW - tol + 1000).ok, true, '窗內的舊請求可以');
  assert.equal(mk(NOW - tol - 1000).reason, WHOOP_AUTH_FAILURE.STALE_TIMESTAMP, '★ 太舊要擋');
  assert.equal(mk(NOW + tol + 1000).reason, WHOOP_AUTH_FAILURE.STALE_TIMESTAMP,
    '★★★ 太新也要擋 —— 否則偽造一個未來時間戳就能無限重放');
});

test('★★★ Telegram 的 secret token 絕不可能通過 WHOOP 驗證（兩條路完全分離）', () => {
  const raw = body();
  const telegramStyle = { 'x-telegram-bot-api-secret-token': SECRET };
  assert.equal(
    verifyWhoopWebhook({ headers: telegramStyle, rawBody: raw, clientSecret: SECRET, now: NOW }).ok,
    false, '★ Telegram 的認證標頭在 WHOOP 這條路上什麼都不是',
  );
});

// ===========================================================================
// 解析
// ===========================================================================

test('★★★ 六種官方事件都認得，而且對到正確的資源類型', () => {
  const expected = {
    'sleep.updated': ['sleep', 'updated'],
    'sleep.deleted': ['sleep', 'deleted'],
    'recovery.updated': ['recovery', 'updated'],
    'recovery.deleted': ['recovery', 'deleted'],
    'workout.updated': ['workout', 'updated'],
    'workout.deleted': ['workout', 'deleted'],
  };
  for (const [type, [resourceType, action]] of Object.entries(expected)) {
    const r = parseWhoopEvent(body({ type }));
    assert.equal(r.ok, true, `★ ${type} 必須被支援`);
    assert.equal(r.event.resourceType, resourceType);
    assert.equal(r.event.action, action);
  }
});

test('★★★ 壞掉的 body / 缺欄位 / 不支援的事件都各自分類', () => {
  const cases = [
    ['不是 JSON', 'not json at all', WHOOP_PARSE_FAILURE.NOT_JSON],
    ['是陣列', '[]', WHOOP_PARSE_FAILURE.NOT_OBJECT],
    ['是 null', 'null', WHOOP_PARSE_FAILURE.NOT_OBJECT],
    ['缺 type', JSON.stringify({ user_id: 1, id: 'x', trace_id: 't' }), WHOOP_PARSE_FAILURE.MISSING_TYPE],
    ['缺 user_id', body({ user_id: undefined }), WHOOP_PARSE_FAILURE.MISSING_USER],
    ['缺 id', body({ id: undefined }), WHOOP_PARSE_FAILURE.MISSING_ID],
    ['缺 trace_id', body({ trace_id: undefined }), WHOOP_PARSE_FAILURE.MISSING_TRACE],
    ['不支援的事件', body({ type: 'cycle.updated' }), WHOOP_PARSE_FAILURE.UNSUPPORTED_TYPE],
    ['發明的事件', body({ type: 'sleep.exploded' }), WHOOP_PARSE_FAILURE.UNSUPPORTED_TYPE],
  ];
  for (const [label, raw, reason] of cases) {
    const r = parseWhoopEvent(raw);
    assert.equal(r.ok, false, `★ ${label} 必須被拒絕`);
    assert.equal(r.reason, reason, `★ ${label} 的分類`);
  }
});

test('★★★ 會失真的 id 一律拒絕（指到別筆資料比拒絕危險得多）', () => {
  assert.equal(parseWhoopEvent(body({ id: 1e30 })).reason, WHOOP_PARSE_FAILURE.MISSING_ID);
  assert.equal(parseWhoopEvent(body({ id: 1.5 })).reason, WHOOP_PARSE_FAILURE.MISSING_ID);
  // v1 的整數 id 仍然要能用
  assert.equal(parseWhoopEvent(body({ id: 10235 })).event.resourceId, '10235');
});

// ===========================================================================
// 入口：耐久寫下 + 去重
// ===========================================================================

async function ingestWith(db, raw, headerOver = {}) {
  const ingest = createWhoopWebhookIngest({
    db, clientSecret: SECRET, now: () => new Date(NOW),
  });
  return ingest({ headers: { ...signed(raw), ...headerOver }, rawBody: raw });
}

test('★★★ 合法事件 → 耐久寫下；同一則重送 → 去重（不是錯誤）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const raw = body();
    const first = await ingestWith(db, raw);
    assert.equal(first.outcome, INGEST_OUTCOME.RECORDED);
    assert.ok(first.eventId > 0);

    // WHOOP 明說會重複投遞同一個觸發事件。
    for (let i = 0; i < 4; i += 1) {
      const dup = await ingestWith(db, raw);
      assert.equal(dup.outcome, INGEST_OUTCOME.DUPLICATE, `第 ${i + 2} 次投遞`);
      assert.equal(dup.eventId, first.eventId, '★ 必須是同一則邏輯事件');
    }
    const stats = await db.whoopEventStats();
    assert.deepEqual(stats, [{ state: 'RECEIVED', eventType: 'sleep.updated', count: 1 }],
      '★★★ 帳本裡只可以有一則');
  } finally { cleanup(); }
});

test('★★★ 去重身分是複合鍵：同 trace 不同資源／類型是**不同**事件', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const trace = 'shared-trace-id';
    await ingestWith(db, body({ trace_id: trace, id: 'res-A', type: 'sleep.updated' }));
    await ingestWith(db, body({ trace_id: trace, id: 'res-B', type: 'sleep.updated' }));
    await ingestWith(db, body({ trace_id: trace, id: 'res-A', type: 'sleep.deleted' }));
    // 官方沒有定義 trace_id 的唯一性範圍，所以保守：不可以把不同的事件
    // 誤認成同一則（那會造成永久遺失，比重複處理更糟）。
    const total = (await db.whoopEventStats()).reduce((a, b) => a + b.count, 0);
    assert.equal(total, 3, '★★★ 三則不同的事件必須都留下');
  } finally { cleanup(); }
});

test('★★★ 去重是 per-WHOOP-user 的：兩個人的相同 id/trace 不會互相吃掉', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const same = { id: 'identical-resource-id', trace_id: 'identical-trace' };
    await ingestWith(db, body({ ...same, user_id: 1001 }));
    await ingestWith(db, body({ ...same, user_id: 2002 }));
    const total = (await db.whoopEventStats()).reduce((a, b) => a + b.count, 0);
    assert.equal(total, 2, '★★★ 不同 WHOOP 使用者的事件必須各自保留');
  } finally { cleanup(); }
});

test('★★★ 認證失敗時，帳本一個字都不會被寫', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const raw = body();
    const ingest = createWhoopWebhookIngest({ db, clientSecret: SECRET, now: () => new Date(NOW) });
    // 錯誤簽章
    const bad = await ingest({
      headers: { ...signed(raw), [WHOOP_SIGNATURE_HEADER]: 'AAAA' }, rawBody: raw,
    });
    assert.equal(bad.outcome, INGEST_OUTCOME.UNAUTHORIZED);
    // 完全沒有標頭
    const none = await ingest({ headers: {}, rawBody: raw });
    assert.equal(none.outcome, INGEST_OUTCOME.UNAUTHORIZED);
    assert.deepEqual(await db.whoopEventStats(), [], '★★★ 未認證絕不可以留下任何狀態');
  } finally { cleanup(); }
});

test('★★★ DB 寫不進去 → 不可以 ack（回 503 讓 WHOOP 重送）', async () => {
  const fakeDb = { recordWhoopEvent: async () => { throw new Error('turso down'); } };
  const raw = body();
  const ingest = createWhoopWebhookIngest({ db: fakeDb, clientSecret: SECRET, now: () => new Date(NOW) });
  const r = await ingest({ headers: signed(raw), rawBody: raw });
  assert.equal(r.outcome, INGEST_OUTCOME.TRANSIENT_ERROR);
  assert.equal(statusForIngest(r.outcome), 503,
    '★ ack 等於「收下了」；寫不進去卻 ack 會讓事件直接消失');
});

test('★★★ HTTP 狀態碼對應：結構性問題不要求重送，暫時性問題要求重送', () => {
  assert.equal(statusForIngest(INGEST_OUTCOME.RECORDED), 200);
  assert.equal(statusForIngest(INGEST_OUTCOME.DUPLICATE), 200);
  assert.equal(statusForIngest(INGEST_OUTCOME.UNSUPPORTED), 200, '★ 重送一百次還是不支援');
  assert.equal(statusForIngest(INGEST_OUTCOME.BAD_REQUEST), 400);
  assert.equal(statusForIngest(INGEST_OUTCOME.UNAUTHORIZED), 401);
  assert.equal(statusForIngest(INGEST_OUTCOME.TRANSIENT_ERROR), 503);
});

// ===========================================================================
// 路由 + 正式環境閘門
// ===========================================================================

function fakeReqRes({ method = 'POST', url = WHOOP_WEBHOOK.PATH, headers = {}, payload = '' }) {
  const listeners = {};
  const req = {
    method,
    url,
    headers,
    on(ev, fn) { listeners[ev] = fn; return req; },
    destroy() {},
  };
  const res = {
    statusCode: null, body: null, finished: false,
    writeHead(code) { res.statusCode = code; },
    end(text) { res.body = text ? JSON.parse(text) : null; res.finished = true; },
    on(ev, fn) { if (ev === 'finish') fn(); },
  };
  queueMicrotask(() => {
    listeners.data?.(Buffer.from(payload, 'utf8'));
    listeners.end?.();
  });
  return { req, res };
}

test('★★★ 啟用閘門：預設關閉，而且缺 client secret 時不可以啟用', () => {
  assert.deepEqual(whoopWebhookConfiguration({}), { enabled: false, state: 'disabled' });
  assert.deepEqual(whoopWebhookConfiguration({ enabledFlag: 'false', clientSecret: 's' }),
    { enabled: false, state: 'disabled' });
  // ★ 字串 'false' 是 truthy —— 這一題就是在擋那個經典錯誤。
  assert.deepEqual(whoopWebhookConfiguration({ enabledFlag: '0', clientSecret: 's' }),
    { enabled: false, state: 'disabled' });
  assert.deepEqual(whoopWebhookConfiguration({ enabledFlag: 'true' }),
    { enabled: false, state: 'missing_client_secret' });
  assert.deepEqual(whoopWebhookConfiguration({ enabledFlag: 'true', clientSecret: 's' }),
    { enabled: true, state: 'enabled' });
});

test('★★★ 關閉時路由完全不存在（404，不是 401 —— 不對外宣告這裡有東西）', async () => {
  const handler = createWebhookHandler({
    processUpdate: async () => ({ outcome: 'processed' }),
    secret: 'telegram-secret',
    whoopIngest: null,
  });
  const raw = body();
  const { req, res } = fakeReqRes({ headers: signed(raw), payload: raw });
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('★★★ 啟用時：合法請求 200、偽造簽章 401、Telegram 路由完全不受影響', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const telegramCalls = [];
    const handler = createWebhookHandler({
      processUpdate: async (u) => { telegramCalls.push(u.update_id); return { outcome: 'processed' }; },
      secret: 'telegram-secret',
      whoopIngest: createWhoopWebhookIngest({ db, clientSecret: SECRET, now: () => new Date(NOW) }),
    });

    const raw = body();
    const ok = fakeReqRes({ headers: signed(raw), payload: raw });
    await handler(ok.req, ok.res);
    assert.equal(ok.res.statusCode, 200);
    assert.equal(ok.res.body.outcome, INGEST_OUTCOME.RECORDED);

    // ★ 用 Telegram 的 secret 當 WHOOP 認證 → 必須失敗
    const cross = fakeReqRes({
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' }, payload: raw,
    });
    await handler(cross.req, cross.res);
    assert.equal(cross.res.statusCode, 401, '★★★ 絕不接受另一條路的認證');

    // ★ Telegram 路由本身完全沒被影響
    const tgPayload = JSON.stringify({ update_id: 42, message: { text: 'hi' } });
    const tg = fakeReqRes({
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      payload: tgPayload,
    });
    await handler(tg.req, tg.res);
    assert.equal(tg.res.statusCode, 200);
    assert.deepEqual(telegramCalls, [42], '★ Telegram 處理鏈必須照常運作');

    // ★ /health 也沒被影響
    const health = fakeReqRes({ method: 'GET', url: '/health' });
    await handler(health.req, health.res);
    assert.equal(health.res.statusCode, 200);
    assert.equal(health.res.body.service, 'telegram-webhook');
  } finally { cleanup(); }
});

test('★★★ 路由層雜項：非 POST、帶 query、body 過大', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const handler = createWebhookHandler({
      processUpdate: async () => ({ outcome: 'processed' }),
      secret: 'telegram-secret',
      whoopIngest: createWhoopWebhookIngest({ db, clientSecret: SECRET, now: () => new Date(NOW) }),
      whoopMaxBodyBytes: 64,
    });
    const raw = body();

    const get = fakeReqRes({ method: 'GET', headers: signed(raw), payload: '' });
    await handler(get.req, get.res);
    assert.equal(get.res.statusCode, 405);

    const q = fakeReqRes({ url: `${WHOOP_WEBHOOK.PATH}?x=1`, headers: signed(raw), payload: raw });
    await handler(q.req, q.res);
    assert.equal(q.res.statusCode, 400);

    const big = JSON.stringify({ ...JSON.parse(raw), pad: 'x'.repeat(500) });
    const large = fakeReqRes({ headers: signed(big), payload: big });
    await handler(large.req, large.res);
    assert.equal(large.res.statusCode, 413);

    assert.deepEqual(await db.whoopEventStats(), [], '★ 這些都不可以留下任何事件');
  } finally { cleanup(); }
});
