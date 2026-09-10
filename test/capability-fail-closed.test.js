/**
 * capability 狀態與主動分析訊息的授權（R2-M-04）。
 *
 * ## 修的是什麼
 *
 * 上一輪把 capability 閘門接進了**訊號產生**（BASELINE_SHIFT 不再繞過）。
 * 但「可不可以主動發訊息」這一層還有三個殘留缺口，獨立稽核全部重現：
 *
 *   getCapabilities 拋錯    → 仍然送出 ASK_CONTEXT（`.catch(() => ({}))`
 *                             把故障默默代換成「還沒 probe 過」）
 *   capability = PARTIAL    → 仍然送出（degraded 也被當成可用）
 *   capability = UNKNOWN    → 仍然送出（沒 probe 過也被當成可用）
 *
 * ## 現在的不變量
 *
 *   **unreadable / unknown / unsupported / unauthorized / unavailable /
 *   app-only / degraded 一律不授權主動分析訊息。**
 *
 * 只有 SUPPORTED（已經實際驗證過這個帳號拿得到這個欄位）才授權。
 *
 * 風險不對稱是這個嚴格度的理由：分析結果錯了只是內部狀態，主動訊息錯了
 * 是直接對使用者說錯話。所以這一關比分析層嚴格，而且刻意**不**共用
 * `isKnownUnavailable()` 那個判準。
 *
 * ## 代價（刻意接受）
 *
 * 從來沒跑過 `npm run probe` 的帳號不會收到主動訊息，而且每一輪都會留下
 * `proactive_suppressed_capability_unverified`。這正是 fail closed 該有的
 * 樣子，運維動作是跑一次 probe。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { deviationSignal, baselineShiftSignal, detectSignals } from '../src/signals.js';
import {
  normalizeCapabilityStatus, authorizesProactiveMessaging, CAPABILITY_AUTHORIZATION,
} from '../src/capabilityMap.js';
import { STATUS } from '../src/capabilities.js';
import { PROACTIVE_DECISION } from '../src/schema.js';
import { SIGNAL_POLICY } from '../src/proactivePolicy.js';
import { fakeTelegram } from './fakes.js';
import { seedSingleUser, seedProbedCapabilities } from './users.js';

// ===========================================================================
// 狀態正規化：每一種狀態都明確分級
// ===========================================================================

const ALL_STATUSES = [
  [STATUS.SUPPORTED, CAPABILITY_AUTHORIZATION.AUTHORIZED, true],
  [STATUS.PARTIAL, CAPABILITY_AUTHORIZATION.DEGRADED, false],
  [STATUS.UNKNOWN, CAPABILITY_AUTHORIZATION.UNVERIFIED, false],
  [STATUS.UNAVAILABLE, CAPABILITY_AUTHORIZATION.UNAVAILABLE, false],
  [STATUS.UNAUTHORIZED, CAPABILITY_AUTHORIZATION.UNAVAILABLE, false],
  [STATUS.APP_ONLY, CAPABILITY_AUTHORIZATION.UNAVAILABLE, false],
  [null, CAPABILITY_AUTHORIZATION.UNVERIFIED, false],
  [undefined, CAPABILITY_AUTHORIZATION.UNVERIFIED, false],
  ['SOME_FUTURE_STATUS', CAPABILITY_AUTHORIZATION.UNVERIFIED, false],
  ['', CAPABILITY_AUTHORIZATION.UNVERIFIED, false],
  [CAPABILITY_AUTHORIZATION.UNREADABLE, CAPABILITY_AUTHORIZATION.UNREADABLE, false],
];

for (const [status, expected, authorizes] of ALL_STATUSES) {
  test(`★★★ R2-M-04: ${JSON.stringify(status)} → ${expected}，授權=${authorizes}`, () => {
    assert.equal(normalizeCapabilityStatus(status), expected);
    assert.equal(authorizesProactiveMessaging(status), authorizes);
  });
}

test('★★★ R2-M-04: STATUS 列舉裡的每一個值都被明確分級（新增值會落到 UNVERIFIED）', () => {
  for (const value of Object.values(STATUS)) {
    const level = normalizeCapabilityStatus(value);
    assert.ok(Object.values(CAPABILITY_AUTHORIZATION).includes(level),
      `★ ${value} 沒有被分級`);
  }
  assert.equal(
    Object.values(STATUS).filter((v) => authorizesProactiveMessaging(v)).length, 1,
    '★ 只有一個狀態可以授權主動訊息（SUPPORTED）',
  );
});

// ===========================================================================
// 訊號層：每一種訊號型別都帶著授權結論
// ===========================================================================

function decliningSeries() {
  const out = [];
  const start = Date.parse('2026-07-01T00:00:00Z');
  for (let i = 0; i < 60; i += 1) {
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      value: i === 59 ? 20 : (i < 46 ? 70 : 55) + (i % 5),
    });
  }
  return out;
}
const SERIES = decliningSeries();
const ANCHOR = SERIES.at(-1).date;

test('前置：這組資料在沒有限制時會產生兩種訊號', () => {
  assert.ok(deviationSignal({ metric: 'hrv', series: SERIES, anchorDate: ANCHOR }));
  assert.ok(baselineShiftSignal({ metric: 'hrv', series: SERIES, anchorDate: ANCHOR }));
});

for (const [status, , authorizes] of ALL_STATUSES) {
  test(`★★★ R2-M-04 訊號層: ${JSON.stringify(status)} → messaging_authorized=${authorizes}`, () => {
    for (const build of [deviationSignal, baselineShiftSignal]) {
      const sig = build({
        metric: 'hrv', series: SERIES, anchorDate: ANCHOR, capabilityStatus: status,
      });
      if (!sig) continue;   // UNAVAILABLE 系列在訊號層就被擋掉了
      assert.equal(sig.messaging_authorized, authorizes,
        `★ ${build.name} 的授權結論錯了`);
      assert.equal(sig.capability_authorization, normalizeCapabilityStatus(status));
    }
  });
}

test('★★ R2-M-04: PARTIAL / UNKNOWN 之下訊號仍然產生（分析不被鎖死），但不授權訊息', () => {
  for (const status of [STATUS.PARTIAL, STATUS.UNKNOWN]) {
    const out = detectSignals({
      seriesByMetric: { hrv: SERIES },
      capabilityByMetric: { hrv: status },
      anchorDate: ANCHOR, metrics: ['hrv'],
    });
    assert.ok(out.length > 0, '★ 分析仍然要跑（部分資料也是真實資料）');
    for (const s of out) {
      assert.equal(s.messaging_authorized, false, '★ 但不可以授權主動訊息');
    }
  }
});

// ===========================================================================
// 端到端：主動代理
// ===========================================================================

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';
const BASELINE_DAYS = 35;
const calm = (i) => ({ recovery: 60 + (i % 3) - 1, hrv: 50 + (i % 4) - 2, rhr: 55 + (i % 3) - 1 });

async function seedOneDay(db, user, i, v) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + i * DAY_MS);
  const sleepId = `d-sleep-${i}`;
  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: i, user_id: 999,
    start: day.toISOString(), end: new Date(day.getTime() + 8 * 3600_000).toISOString(),
    nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
    score: {
      respiratory_rate: 15, sleep_performance_percentage: 85,
      sleep_consistency_percentage: 85, sleep_efficiency_percentage: 90,
      stage_summary: {
        total_light_sleep_time_milli: 3_000_000, total_slow_wave_sleep_time_milli: 1_000_000,
        total_rem_sleep_time_milli: 1_000_000, total_awake_time_milli: 0,
        total_no_data_time_milli: 0, total_in_bed_time_milli: 8_000_000,
        disturbance_count: 1, sleep_cycle_count: 4,
      },
      sleep_needed: {
        baseline_milli: 28_800_000, need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
      },
    },
  }], { timezone: user.timezone });
  await db.upsertRecoveries(user.id, [{
    sleep_id: sleepId, cycle_id: `d-c-${i}`, user_id: 999, score_state: 'SCORED',
    score: {
      recovery_score: v.recovery, hrv_rmssd_milli: v.hrv, resting_heart_rate: v.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);
}

/** 跑到「第二天、持續性訊號、應該 ASK_CONTEXT」，第二次呼叫時套用 patch。 */
async function runToDay2({ patch = null, probed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m04-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await seedSingleUser(db, { probed });
    for (let i = 0; i < BASELINE_DAYS; i += 1) await seedOneDay(db, user, i, calm(i));
    await seedOneDay(db, user, BASELINE_DAYS, { ...calm(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const common = { userId: user.id, timezone: user.timezone, telegram, chatId };
    await checkAndAct({ db, ...common, now: new Date('2026-02-06T08:00:00Z') });
    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calm(BASELINE_DAYS + 1), hrv: 14 });

    const sentBefore = telegram.sent.length;
    const result = await checkAndAct({
      db: patch ? patch(db) : db, ...common, now: new Date('2026-02-07T08:00:00Z'),
    });
    return {
      result,
      sentOnDay2: telegram.sent.length - sentBefore,
      async events() {
        return (await db.raw.execute({
          sql: 'SELECT decision, reason_json FROM proactive_events WHERE user_id = ? ORDER BY id',
          args: [user.id],
        })).rows;
      },
      cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (err) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const capsWith = (status) => (db) => ({
  ...db,
  getCapabilities: async () => Object.fromEntries(
    SIGNAL_POLICY.MONITORED_METRICS.map((m) => [m, { key: m, status }]),
  ),
});

test('前置：已經 probe 過（SUPPORTED）時第二天確實會送出主動訊息', async () => {
  const r = await runToDay2({});
  try {
    assert.equal(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
    assert.equal(r.sentOnDay2, 1, '★ 前置必須真的會送，否則下面全是假通過');
  } finally { r.cleanup(); }
});

test('★★★ R2-M-04: getCapabilities 拋錯 → 絕不送出主動訊息', async () => {
  const r = await runToDay2({
    patch: (db) => ({ ...db, getCapabilities: async () => { throw new Error('db down'); } }),
  });
  try {
    assert.equal(r.sentOnDay2, 0, '★ 查不到資料能力就不可以主動打擾');
    assert.notEqual(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
  } finally { r.cleanup(); }
});

for (const status of [STATUS.PARTIAL, STATUS.UNKNOWN, STATUS.UNAVAILABLE,
  STATUS.UNAUTHORIZED, STATUS.APP_ONLY]) {
  test(`★★★ R2-M-04: capability = ${status} → 絕不送出主動訊息`, async () => {
    const r = await runToDay2({ patch: capsWith(status) });
    try {
      assert.equal(r.sentOnDay2, 0, `★ ${status} 不可以授權主動訊息`);
      assert.notEqual(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
      assert.notEqual(r.result.decision, PROACTIVE_DECISION.NOTIFY);
    } finally { r.cleanup(); }
  });
}

test('★★★ R2-M-04: 從來沒 probe 過的帳號不會收到主動訊息', async () => {
  const r = await runToDay2({ probed: false });
  try {
    assert.equal(r.sentOnDay2, 0,
      '★ 「大概拿得到吧」不是授權——運維動作是跑一次 npm run probe');
  } finally { r.cleanup(); }
});

test('★★★ R2-M-04: 抑制的理由被明確記下來（事後查得出為什麼沒送）', async () => {
  const r = await runToDay2({ patch: capsWith(STATUS.PARTIAL) });
  try {
    const events = await r.events();
    const reason = JSON.parse(events[events.length - 1].reason_json);
    assert.equal(reason.reason, 'capability_not_authorized_for_messaging');
    assert.equal(reason.factors.capability_authorization, CAPABILITY_AUTHORIZATION.DEGRADED);
    assert.equal(reason.factors.metric, 'hrv');
  } finally { r.cleanup(); }
});

test('★★★ R2-M-04: 抑制時分析與稽核軌跡完全不受影響', async () => {
  const r = await runToDay2({ patch: capsWith(STATUS.UNKNOWN) });
  try {
    assert.ok(r.result.signals.length >= 1, '★ 訊號分析照跑');
    assert.equal(r.result.signals[0].metric, 'hrv');
    const events = await r.events();
    assert.equal(events.length, 2, '★ 兩天都要有事件紀錄');
    assert.equal(events[1].decision, PROACTIVE_DECISION.LOG_ONLY);
  } finally { r.cleanup(); }
});

test('★★★ R2-M-04: 「讀不到」與「讀到了但不授權」的理由必須可區分', async () => {
  // 兩種抑制的運維處置完全不同：
  //   permission_state_unreadable            → 去修資料庫／連線
  //   capability_not_authorized_for_messaging → 去跑一次 npm run probe
  const unreadable = await runToDay2({
    patch: (db) => ({ ...db, getCapabilities: async () => { throw new Error('db down'); } }),
  });
  try {
    const events = await unreadable.events();
    const reason = JSON.parse(events[events.length - 1].reason_json);
    assert.equal(reason.reason, 'permission_state_unreadable',
      '★ 讀不到就要說讀不到，不可以混成「未驗證」');
    assert.deepEqual(reason.factors.unreadable_gates, ['capabilities']);
  } finally { unreadable.cleanup(); }

  const unverified = await runToDay2({ patch: capsWith(STATUS.UNKNOWN) });
  try {
    const events = await unverified.events();
    const reason = JSON.parse(events[events.length - 1].reason_json);
    assert.equal(reason.reason, 'capability_not_authorized_for_messaging',
      '★ 讀到了但沒驗證過，就要說是未授權');
  } finally { unverified.cleanup(); }
});

// ===========================================================================
// 多使用者
// ===========================================================================

test('★★★ R2-M-04: Alice 沒 probe 不影響 Bob 已 probe 的授權', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m04-mu-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const alice = await seedSingleUser(db, { id: 'u-a', chatId: '1001', probed: false });
    const bob = await seedSingleUser(db, { id: 'u-b', chatId: '1002', probed: true });

    const aliceCaps = await db.getCapabilities(alice.id);
    const bobCaps = await db.getCapabilities(bob.id);
    assert.deepEqual(aliceCaps, {}, 'Alice 沒 probe 過');
    assert.equal(bobCaps.hrv.status, STATUS.SUPPORTED);

    assert.equal(authorizesProactiveMessaging(aliceCaps.hrv?.status ?? null), false);
    assert.equal(authorizesProactiveMessaging(bobCaps.hrv.status), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ R2-M-04: seedProbedCapabilities 會覆蓋所有被監看的指標', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m04-cov-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await seedSingleUser(db, { probed: false });
    await seedProbedCapabilities(db, user.id);
    const caps = await db.getCapabilities(user.id);
    for (const metric of SIGNAL_POLICY.MONITORED_METRICS) {
      const { FIELD_TO_CAPABILITY } = await import('../src/capabilityMap.js');
      const key = FIELD_TO_CAPABILITY[metric] ?? metric;
      assert.ok(caps[key], `★ 被監看的指標 ${metric}（capability key ${key}）必須被 probe`);
      assert.equal(authorizesProactiveMessaging(caps[key].status), true);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
