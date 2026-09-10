/**
 * L-01 / L-02 / L-03。
 *
 * 三個都不是「顯眼的錯誤」，而是**看起來完全正常的錯誤**——
 * 這正是它們值得修的原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { assessDailyState, assessBaseline, READINESS_STATUS } from '../src/readiness.js';
import { PROACTIVE_QUESTION_INTENT } from '../src/schema.js';
import { BASELINE } from '../src/config.js';
import { localDate } from '../src/time.js';
import { ANALYSED_METRICS } from '../src/analytics/index.js';

const NOW = new Date('2026-09-09T02:00:00Z');
const ANCHOR = '2026-09-09';

async function withUser(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await fn(db, user);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// L-01：壞掉的 pending question context
// ===========================================================================
//
// 舊版 `getOpenPendingQuestion()` 直接 `JSON.parse(row.context_json)`。
// 那支函式是 route() 的**第一步**，所以一列壞掉的 context 會讓那個使用者
// 送的**每一則**訊息（連 /status 都算）只拿到「我這邊出了點問題」。
// 而且追問永遠停在 OPEN（惰性過期的 UPDATE 根本走不到）——**永久**卡死，
// 只能人工改資料庫才救得回來。實測確認。

const coachFor = () => ({
  async json() { return { category: 'alcohol', confidence: 0.9 }; },
  async ask() { return null; },
});

async function openBrokenQuestion(db, userId) {
  const qid = await db.openPendingQuestion(userId, {
    chatId: '1', question: '昨天有喝酒嗎？', intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { proactive_event_id: 1 }, ttlMs: 30 * 60_000,
  }, { now: NOW });
  await db.raw.execute({
    sql: "UPDATE pending_questions SET context_json = '{壞掉的 JSON' WHERE id = ?",
    args: [qid],
  });
  return qid;
}

const statusOf = async (db, qid) => (await db.raw.execute({
  sql: 'SELECT status FROM pending_questions WHERE id = ?', args: [qid],
})).rows[0].status;

test('★★★ L-01: 壞掉的 context 不會讓 getOpenPendingQuestion 拋錯', async () => {
  await withUser(async (db, user) => {
    await openBrokenQuestion(db, user.id);
    const q = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.equal(q, null, '★ 解不開的追問視為不存在，而不是拋錯');
  });
});

test('★★★ L-01: 壞掉的 context 會被就地收掉（自我修復，不留地雷）', async () => {
  await withUser(async (db, user) => {
    const qid = await openBrokenQuestion(db, user.id);
    await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.equal(await statusOf(db, qid), 'EXPIRED',
      '★ 不可以永遠停在 OPEN——那會每一輪都再炸一次');
  });
});

test('★★★ L-01: 壞掉的 context 之後，bot 對每一種訊息都還能正常回應', async () => {
  await withUser(async (db, user) => {
    await openBrokenQuestion(db, user.id);
    const router = createRouter({ db, coachFor, now: () => NOW });
    for (const text of ['有，喝了兩杯', '/status', '我今天怎樣？']) {
      const reply = await router.handle({
        text, chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
      });
      assert.ok(reply, `「${text}」要有回應`);
      assert.doesNotMatch(String(reply), /我這邊出了點問題/,
        `★ 「${text}」不可以拿到系統錯誤`);
    }
  });
});

test('★★ L-01: 正常的 context 完全不受影響', async () => {
  await withUser(async (db, user) => {
    await db.openPendingQuestion(user.id, {
      chatId: '1', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { health_date: ANCHOR, category: 'alcohol' }, ttlMs: 30 * 60_000,
    }, { now: NOW });
    const q = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.deepEqual(q.context, { health_date: ANCHOR, category: 'alcohol' });
  });
});

test('★★ L-01: 完全沒有 context（NULL）仍然是合法的追問', async () => {
  await withUser(async (db, user) => {
    await db.openPendingQuestion(user.id, {
      chatId: '1', question: 'q', intent: 'today_status',
      contextJson: null, ttlMs: 30 * 60_000,
    }, { now: NOW });
    const q = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.ok(q, '★ NULL context 不是壞掉，不可以被誤收');
    assert.equal(q.context, null);
  });
});

// ===========================================================================
// L-02：readiness 數的是「列」還是「可用的數值」
// ===========================================================================
//
// `computeDailyMetrics()` 對每一個觀測到的睡眠都會產生一列，即使 WHOOP
// 對那一天沒有回傳任何評分。那樣的列每一個指標都是 null。
// 實測：40 列全 null，assessDailyState 與 assessBaseline 都回報 **READY**。

const emptyRow = (d) => Object.fromEntries([
  ['health_date', d], ...ANALYSED_METRICS.map((k) => [k, null]),
]);
const fullRow = (d) => ({ ...emptyRow(d), recovery: 60, hrv: 50, rhr: 55 });

function daysBack(n, make) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(make(new Date(Date.parse(`${ANCHOR}T00:00:00Z`) - i * 86_400_000)
      .toISOString().slice(0, 10)));
  }
  return out;
}

test('★★★ L-02: 40 列全空 → assessDailyState 不是 READY', () => {
  const r = assessDailyState({ rows: daysBack(40, emptyRow), anchorDate: ANCHOR });
  assert.notEqual(r.status, READINESS_STATUS.READY,
    '★ 有列不等於有資料——一個數值都沒有時不可以說「今天的狀態可以講了」');
  assert.equal(r.status, READINESS_STATUS.DEGRADED);
  assert.ok(r.missing_requirements.includes('today_row_has_no_scored_values'));
});

test('★★★ L-02: 40 列全空 → assessBaseline 是 NO_DATA', () => {
  const r = assessBaseline({ rows: daysBack(40, emptyRow), anchorDate: ANCHOR });
  assert.equal(r.status, READINESS_STATUS.NO_DATA,
    '★ 絕不可以宣稱「個人基準已建立」然後對著一片空白算紅黃綠燈');
});

test('★★★ L-02: 空列與有值的列混在一起時，只數有值的', () => {
  const rows = [
    ...daysBack(BASELINE.MIN_FOR_LIGHTS - 1, fullRow),
    ...daysBack(40, emptyRow).slice(BASELINE.MIN_FOR_LIGHTS - 1),
  ];
  const r = assessBaseline({ rows, anchorDate: ANCHOR });
  assert.equal(r.usable_samples, BASELINE.MIN_FOR_LIGHTS - 1,
    '★ usable_samples 必須是「真的有數值的天數」');
  assert.equal(r.status, READINESS_STATUS.WARMING_UP);
});

test('★★ L-02 false positive: 有值的列照常 READY（沒有把功能鎖死）', () => {
  const rows = daysBack(40, fullRow);
  assert.equal(assessDailyState({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.READY);
  assert.equal(assessBaseline({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.READY);
});

test('★★ L-02: 只要有**任何一個**指標有值就算可用', () => {
  const rows = daysBack(40, (d) => ({ ...emptyRow(d), spo2: 96.5 }));
  assert.equal(assessDailyState({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.READY);
  assert.equal(assessBaseline({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.READY);
});

test('★★ L-02: 非數值的髒資料不算可用', () => {
  const rows = daysBack(40, (d) => ({ ...emptyRow(d), hrv: '', rhr: 'n/a', recovery: NaN }));
  assert.notEqual(assessDailyState({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.READY);
  assert.equal(assessBaseline({ rows, anchorDate: ANCHOR }).status, READINESS_STATUS.NO_DATA);
});

test('★★ L-02: 「今天那一列根本不存在」與「存在但沒評分」理由不同', () => {
  const noToday = assessDailyState({
    rows: daysBack(40, fullRow).slice(1), anchorDate: ANCHOR,
  });
  const unscored = assessDailyState({ rows: daysBack(40, emptyRow), anchorDate: ANCHOR });
  assert.equal(noToday.status, READINESS_STATUS.DEGRADED);
  assert.equal(unscored.status, READINESS_STATUS.DEGRADED);
  assert.notEqual(noToday.reason, unscored.reason,
    '★ 兩件事的處理方式不同，理由不可以混為一談');
});

// ===========================================================================
// L-03：per-user 腳本必須用該使用者的時區
// ===========================================================================
//
// `env.timezone` 只是 bootstrap 預設 —— config.js 自己就寫明「真正的時區在
// users.timezone」。三支 per-user 腳本卻拿它算日期。

test('★★★ L-03: per-user 腳本不再使用 bootstrap 時區', () => {
  for (const f of ['scripts/health-status.js', 'scripts/sync.js', 'scripts/probe-fields.js']) {
    const src = fs.readFileSync(f, 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\benv\.timezone\b/.test(code),
      `★ ${f} 是 per-user 腳本，不可以用 bootstrap 時區`);
    assert.match(code, /user\.timezone/, `★ ${f} 必須改用 user.timezone`);
  }
});

test('★★★ L-03: 兩個時區在同一個 UTC 瞬間確實是不同的「今天」', () => {
  // 台北 2026-09-09 07:00 = 紐約 2026-09-08 19:00
  const instant = new Date('2026-09-08T23:00:00Z');
  assert.equal(localDate(instant, 'Asia/Taipei'), '2026-09-09');
  assert.equal(localDate(instant, 'America/New_York'), '2026-09-08');
  assert.notEqual(
    localDate(instant, 'Asia/Taipei'), localDate(instant, 'America/New_York'),
    '★ 用錯時區就是整整差一天——落後天數與 backfill 進度都會算錯',
  );
});

test('★★ L-03: preflight 只在「還沒有使用者」的那一行用 bootstrap 時區', () => {
  const src = fs.readFileSync('scripts/preflight.js', 'utf8');
  const lines = src.split('\n');
  const pickUserLine = lines.findIndex((l) => /await pickUser\(/.test(l));
  assert.ok(pickUserLine > 0, '前置：preflight 確實會挑一個使用者');

  lines.forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    if (!/\benv\.timezone\b/.test(line)) return;
    assert.ok(i < pickUserLine,
      `★ 第 ${i + 1} 行在 pickUser 之後還用 bootstrap 時區：${line.trim()}`);
  });
  // pickUser 之後的日期計算必須用使用者的時區
  assert.match(lines.slice(pickUserLine).join('\n'), /user\.timezone/);
});
