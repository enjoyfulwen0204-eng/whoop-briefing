/**
 * Personal Healthspan 漸進式框架（V1.1 Phase 12）。
 *
 * 兩件最重要的事：
 *   1. **分數永遠是 null**，而且那是正確答案，不是待辦事項
 *   2. 對外文字**絕不**出現 WHOOP Age / WHOOP 官方 Healthspan
 *
 * 其次：成熟度由 readiness 決定，不是「滿 30 天就解鎖」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  buildPersonalHealthspan, runHealthspanSnapshot, renderPersonalHealthspan,
  maturityFromReadiness,
} from '../src/healthspanEngine.js';
import {
  HEALTHSPAN_MATURITY, HEALTHSPAN_POLICY, HEALTHSPAN_ALGORITHM_VERSION,
  hasQualifiedScoringPolicy, publishableScore, historyTierLabel,
} from '../src/healthspanPolicy.js';
import { READINESS_STATUS } from '../src/readiness.js';
import { AVAILABILITY } from '../src/healthspan.js';
import { STATUS } from '../src/capabilities.js';
import { handleHealthspan } from '../src/bot/commands.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-hs-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

/** n 天完整資料。 */
const rowsFor = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  health_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  recovery: 60 + (i % 10),
  hrv: 55 + (i % 5),
  rhr: 50 + (i % 4),
  respiratory_rate: 15,
  sleep_total: 7 * 3600_000,
  sleep_consistency: 80,
  previous_day_strain: 12,
  workout_duration_minutes: 40,
  zone1_3_minutes: 30,
  zone4_5_minutes: 10,
  strength_minutes_derived: 15,
  weight: 70,
  body_max_hr: 190,
  spo2: 97,
  skin_temp: 33.5,
  ...extra,
}));

const NOW = new Date('2026-09-09T00:00:00Z');

// ===========================================================================
// ★★★ 永遠沒有分數
// ===========================================================================

test('★★★ 出貨政策：所有權重都是 null，總開關是關的', () => {
  const weights = Object.values(HEALTHSPAN_POLICY.WEIGHTS);
  assert.ok(weights.length > 0);
  for (const w of weights) assert.equal(w, null, '絕不可以有任何權重被填上');
  assert.equal(HEALTHSPAN_POLICY.SCORE_ENABLED, false);
  assert.equal(hasQualifiedScoringPolicy(), false);
});

test('★★★ 資料再充足，score 與 scoreKind 仍然是 null', () => {
  const result = buildPersonalHealthspan(rowsFor(180));
  assert.equal(result.maturity, HEALTHSPAN_MATURITY.STRUCTURALLY_READY);
  assert.equal(result.score, null, '★ 分數永遠是 null');
  assert.equal(result.scoreKind, null);
  assert.equal(result.scoringPolicyActive, false);
});

test('★★★ 只填一部分權重也不算有政策（不可以「填一個就開始給分」）', () => {
  const partial = {
    ...HEALTHSPAN_POLICY,
    SCORE_ENABLED: true,
    WEIGHTS: { ...HEALTHSPAN_POLICY.WEIGHTS, hrv: 1 },
  };
  assert.equal(hasQualifiedScoringPolicy({ policy: partial }), false);
  assert.equal(publishableScore({
    maturity: HEALTHSPAN_MATURITY.QUALIFIED, score: 83, policy: partial,
  }), null);
});

test('★★★ 就算權重全填、開關也開，maturity 不對仍然不給分數', () => {
  const full = {
    ...HEALTHSPAN_POLICY,
    SCORE_ENABLED: true,
    WEIGHTS: Object.fromEntries(Object.keys(HEALTHSPAN_POLICY.WEIGHTS).map((k) => [k, 1])),
  };
  assert.equal(hasQualifiedScoringPolicy({ policy: full }), true);
  assert.equal(publishableScore({
    maturity: HEALTHSPAN_MATURITY.STRUCTURALLY_READY, score: 83, policy: full,
  }), null, '結構就緒 ≠ 可以發布');
  // 只有這一種組合會放行（證明閘門不是永久寫死）
  assert.equal(publishableScore({
    maturity: HEALTHSPAN_MATURITY.QUALIFIED, score: 83, policy: full,
  }), 83);
});

// ===========================================================================
// ★★★ 命名：絕不冒充 WHOOP
// ===========================================================================

test('★★★ 對外文字絕不出現 WHOOP Age 或官方 Healthspan 評分', () => {
  for (const n of [0, 10, 90, 180]) {
    const text = renderPersonalHealthspan(buildPersonalHealthspan(rowsFor(n)));
    assert.ok(!/WHOOP Age/i.test(text), `n=${n}：不可以出現 WHOOP Age`);
    assert.ok(!/WHOOP\s*Healthspan/i.test(text), `n=${n}：不可以出現 WHOOP Healthspan`);
    assert.match(text, /Personal Healthspan/);
  }
});

test('★★★ 輸出裡沒有任何綜合分數或推估年齡的**數值**', () => {
  const text = renderPersonalHealthspan(buildPersonalHealthspan(rowsFor(180)));

  // 注意：不能單純禁止「推估年齡」這幾個字——那句話本身就是在說
  // 「我們不給你推估年齡」。要禁止的是**後面接著一個數字**。
  assert.ok(!/分數[：:]\s*-?\d/.test(text), '不可以有「分數：<數字>」');
  assert.ok(!/推估年齡[：:]\s*-?\d/.test(text), '不可以有「推估年齡：<數字>」');
  assert.ok(!/生理年齡[：:]\s*-?\d/.test(text));
  assert.ok(!/Estimated Age[：:\s]*-?\d/i.test(text));
  assert.ok(!/\b\d+(\.\d+)?\s*歲/.test(text), '不可以出現「xx 歲」');

  // 而「我們不給」這句話必須在
  assert.match(text, /不會.*給你一個綜合分數或推估年齡/s);
});

test('★ 明確聲明與 WHOOP App 的評分無關', () => {
  const text = renderPersonalHealthspan(buildPersonalHealthspan(rowsFor(90)));
  assert.match(text, /與 WHOOP App 內的任何評分無關/);
});

test('★★ 原始碼裡沒有任何 WHOOP Age 的實作意圖', () => {
  for (const f of ['src/healthspanEngine.js', 'src/healthspanPolicy.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    // 只允許出現在「明講我們不做這個」的說明裡，不可以有對應的欄位或函式
    assert.ok(!/function\s+\w*whoopAge/i.test(src));
    assert.ok(!/whoop_age\s*[:=]/i.test(src));
  }
});

// ===========================================================================
// 成熟度看 readiness，不看日曆
// ===========================================================================

test('★★★ 成熟度由 readiness 決定，不是日曆天數', () => {
  assert.equal(maturityFromReadiness(READINESS_STATUS.NO_DATA), HEALTHSPAN_MATURITY.NO_DATA);
  assert.equal(maturityFromReadiness(READINESS_STATUS.WARMING_UP), HEALTHSPAN_MATURITY.WARMING_UP);
  assert.equal(maturityFromReadiness(READINESS_STATUS.LIMITED), HEALTHSPAN_MATURITY.LIMITED);
  assert.equal(
    maturityFromReadiness(READINESS_STATUS.READY),
    HEALTHSPAN_MATURITY.STRUCTURALLY_READY,
    '★ READY 只到「結構就緒」，不是 QUALIFIED',
  );
  // DEGRADED / UNAVAILABLE 保守處理
  assert.equal(maturityFromReadiness(READINESS_STATUS.DEGRADED), HEALTHSPAN_MATURITY.NO_DATA);
});

test('★★★ 有 180 天日曆歷史但資料稀疏 → 不會因為「天數夠」就解鎖', () => {
  // 180 天的日期跨度，但只有前 3 天有值
  const sparse = rowsFor(180).map((r, i) => (i < 3 ? r : {
    health_date: r.health_date,
    recovery: null, hrv: null, rhr: null, respiratory_rate: null,
    sleep_total: null, sleep_consistency: null, previous_day_strain: null,
    workout_duration_minutes: null, zone1_3_minutes: null, zone4_5_minutes: null,
    strength_minutes_derived: null, weight: null, body_max_hr: null,
    spo2: null, skin_temp: null,
  }));

  const result = buildPersonalHealthspan(sparse);
  assert.notEqual(
    result.maturity, HEALTHSPAN_MATURITY.STRUCTURALLY_READY,
    '★ 日曆天數多不代表資料夠',
  );
  assert.equal(result.score, null);
});

test('★ 歷史長度標籤純粹是描述性的', () => {
  assert.equal(historyTierLabel(10), null);
  assert.equal(historyTierLabel(30), '一個月');
  assert.equal(historyTierLabel(95), '三個月');
  assert.equal(historyTierLabel(365), '半年');
});

test('零資料 → NO_DATA，而且不會當掉', () => {
  const result = buildPersonalHealthspan([]);
  assert.equal(result.maturity, HEALTHSPAN_MATURITY.NO_DATA);
  assert.equal(result.score, null);
  assert.equal(result.anchorDate, null);
  const text = renderPersonalHealthspan(result);
  assert.match(text, /還沒有可以盤點的資料/);
});

// ===========================================================================
// capability 整合
// ===========================================================================

test('★★ probe 說拿不到 → contributor 標成 UNAVAILABLE，且不算進覆蓋率分子', () => {
  const rows = rowsFor(90);
  const withCap = buildPersonalHealthspan(rows, {
    capabilities: { rhr: { key: 'rhr', status: STATUS.UNAVAILABLE } },
  });
  const rhr = withCap.contributors.find((c) => c.metricKey === 'resting_heart_rate');
  assert.equal(rhr.availability, AVAILABILITY.UNAVAILABLE);

  const without = buildPersonalHealthspan(rows, { capabilities: {} });
  assert.ok(withCap.usableCount < without.usableCount);
});

test('★★ UNKNOWN 不會讓 contributor 變成 UNAVAILABLE', () => {
  const rows = rowsFor(90);
  const result = buildPersonalHealthspan(rows, {
    capabilities: { rhr: { key: 'rhr', status: STATUS.UNKNOWN } },
  });
  const rhr = result.contributors.find((c) => c.metricKey === 'resting_heart_rate');
  assert.notEqual(rhr.availability, AVAILABILITY.UNAVAILABLE);
});

test('★★ APP_ONLY 的三個不算進覆蓋率分母（否則永遠上不去）', () => {
  const result = buildPersonalHealthspan(rowsFor(90));
  assert.equal(result.appOnlyCount, 3);
  assert.equal(result.scopedCount, result.contributors.length - 3);
  for (const key of ['steps', 'vo2_max', 'lean_body_mass']) {
    const c = result.contributors.find((x) => x.metricKey === key);
    assert.equal(c.value, null);
    assert.equal(c.availability, AVAILABILITY.APP_ONLY);
  }
});

// ===========================================================================
// 持久化
// ===========================================================================

test('★★★ 快照真的被寫進去，而且 score / score_kind 都是 NULL', async () => {
  await withDb(async (db) => {
    const rows = rowsFor(90);
    const res = await runHealthspanSnapshot({
      db, userId: ALICE.id, rows, endDate: rows[rows.length - 1].health_date, now: NOW,
    });
    assert.equal(res.saved, true);

    const snaps = await db.getHealthspanSnapshots(ALICE.id, 5);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].score, null, '★ 資料庫裡也必須是 NULL');
    assert.equal(snaps[0].score_kind, null);
    assert.equal(snaps[0].algorithm_version, HEALTHSPAN_ALGORITHM_VERSION);
    assert.equal(snaps[0].status, HEALTHSPAN_MATURITY.STRUCTURALLY_READY);

    const metrics = await db.getLatestHealthspanMetrics(ALICE.id);
    assert.ok(metrics.length > 0, 'contributor 明細也要落地');
  });
});

test('★★ 快照是冪等的：同一天同一版本重跑只會有一列', async () => {
  await withDb(async (db) => {
    const rows = rowsFor(90);
    const end = rows[rows.length - 1].health_date;
    for (let i = 0; i < 3; i += 1) {
      await runHealthspanSnapshot({ db, userId: ALICE.id, rows, endDate: end, now: NOW });
    }
    const snaps = await db.getHealthspanSnapshots(ALICE.id, 10);
    assert.equal(snaps.length, 1);
  });
});

test('★ 完全沒資料時不寫任何快照（不留一列全 null 的垃圾）', async () => {
  await withDb(async (db) => {
    const res = await runHealthspanSnapshot({ db, userId: ALICE.id, rows: [], now: NOW });
    assert.equal(res.saved, false);
    assert.equal((await db.getHealthspanSnapshots(ALICE.id, 5)).length, 0);
  });
});

test('★★ 寫入失敗不會拋錯（附加能力不可以拖垮任何東西）', async () => {
  await withDb(async (db) => {
    const broken = {
      ...db,
      saveHealthspanMetrics: async () => { throw new Error('boom'); },
    };
    const rows = rowsFor(90);
    const res = await runHealthspanSnapshot({
      db: broken, userId: ALICE.id, rows, endDate: rows[rows.length - 1].health_date, now: NOW,
    });
    assert.equal(res.saved, false);
    assert.equal(res.score, null);
  });
});

test('runHealthspanSnapshot 缺 userId 一律拋錯', async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => runHealthspanSnapshot({ db, userId: null, rows: [], now: NOW }),
      /缺少 userId/,
    );
  });
});

test('★ 損壞的 contributors JSON 讀回來不會讓查詢炸掉', async () => {
  await withDb(async (db) => {
    await db.saveHealthspanSnapshot(ALICE.id, {
      snapshotDate: '2026-09-09', algorithmVersion: 'x',
      score: null, scoreKind: null, contributors: null, coverage: 0, status: 'NO_DATA',
    });
    const snaps = await db.getHealthspanSnapshots(ALICE.id, 5);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].contributors_json, null);
  });
});

// ===========================================================================
// per-user 隔離
// ===========================================================================

test('★★★ Alice 與 Bob 的 healthspan 完全隔離（同日期、同版本）', async () => {
  await withDb(async (db) => {
    const aliceRows = rowsFor(90);
    const bobRows = rowsFor(40);
    const end = aliceRows[aliceRows.length - 1].health_date;

    await runHealthspanSnapshot({ db, userId: ALICE.id, rows: aliceRows, endDate: end, now: NOW });
    await runHealthspanSnapshot({
      db, userId: BOB.id, rows: bobRows, endDate: bobRows[bobRows.length - 1].health_date, now: NOW,
    });

    const a = await db.getHealthspanSnapshots(ALICE.id, 5);
    const b = await db.getHealthspanSnapshots(BOB.id, 5);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(String(a[0].user_id), ALICE.id);
    assert.equal(String(b[0].user_id), BOB.id);
    // 兩人的 score 都必須是 null
    assert.equal(a[0].score, null);
    assert.equal(b[0].score, null);
  });
});

// ===========================================================================
// /healthspan 指令
// ===========================================================================

test('★★ /healthspan 在零資料時給誠實的回覆', async () => {
  await withDb(async (db) => {
    const text = await handleHealthspan({ db, userId: ALICE.id, rows: [] });
    assert.match(text, /Personal Healthspan/);
    assert.match(text, /尚未開始累積/);
    assert.ok(!/WHOOP Age/i.test(text));
  });
});

test('★★★ /healthspan 在資料充足時仍然不給分數', async () => {
  await withDb(async (db) => {
    const text = await handleHealthspan({ db, userId: ALICE.id, rows: rowsFor(90) });
    assert.match(text, /資料充足/);
    assert.match(text, /不會.*給你一個綜合分數或推估年齡/s);
    assert.ok(!/WHOOP Age/i.test(text));
    assert.ok(!/分數[：:]\s*\d/.test(text));
  });
});

test('★ /healthspan 會列出每一項指標拿不拿得到', async () => {
  await withDb(async (db) => {
    const text = await handleHealthspan({ db, userId: ALICE.id, rows: rowsFor(90) });
    assert.match(text, /目前盤點到的指標/);
    assert.match(text, /hrv/);
    assert.match(text, /steps/);   // APP_ONLY 的也要誠實列出來
  });
});
