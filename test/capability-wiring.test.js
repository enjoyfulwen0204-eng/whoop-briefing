/**
 * Capability 接線（V1.1 Phase 11）。
 *
 * capability 系統本身早就正確（capabilityGate 分得清 KNOWN_UNAVAILABLE
 * 與 NOT_YET_VERIFIED），問題是**沒有人把資料餵進去**：proactiveAgent
 * 從來沒傳 capabilityByMetric、healthspan 的 capabilities 永遠是 {}。
 * 於是整套閘門形同虛設。
 *
 * 這個檔案要證明兩件事：
 *   1. 命名對應是明確且正確的（三套命名並存，不可以用猜的）
 *   2. UNKNOWN 在接線之後**仍然**不會變成 UNAVAILABLE
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  FIELD_TO_CAPABILITY, CONTRIBUTOR_TO_CAPABILITY,
  capabilityStatusForField, capabilityStatusForContributor,
  capabilityByMetricFor, isKnownUnavailable,
} from '../src/capabilityMap.js';
import { STATUS } from '../src/capabilities.js';
import { METRICS } from '../src/config.js';
import { buildContributors, AVAILABILITY, CONTRIBUTORS } from '../src/healthspan.js';
import { detectSignals } from '../src/signals.js';
import { SIGNAL_POLICY } from '../src/proactivePolicy.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-cap-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // 這個檔案專門測 capability 本身，所以刻意用**沒有 probe 過**的帳號
    await seedAliceAndBob(db, { probed: false });
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

const cap = (key, status) => ({ [key]: { key, status } });

// ===========================================================================
// 命名對應
// ===========================================================================

test('★★★ 對應表裡的每一個 capability key 都真的存在於 METRICS 或已知的 probe key', () => {
  const metricKeys = new Set(METRICS.map((m) => m.key));
  // capabilities.js 的 EXTRA_PROBES 會另外產生這些 key
  const extraProbeKeys = new Set([
    'body_weight', 'body_max_heart_rate', 'body_height',
    'workout_zone_durations', 'workout_sport_name', 'workout_strain',
  ]);

  for (const [field, key] of Object.entries(FIELD_TO_CAPABILITY)) {
    assert.ok(
      metricKeys.has(key) || extraProbeKeys.has(key),
      `${field} → ${key}：這個 capability key 不存在，對應表寫錯了`,
    );
  }
});

test('★★★ 名字不一樣的那幾個對應正確（就是這幾個會安靜出錯）', () => {
  assert.equal(FIELD_TO_CAPABILITY.recovery, 'recovery_score');
  assert.equal(FIELD_TO_CAPABILITY.previous_day_strain, 'strain');
  assert.equal(FIELD_TO_CAPABILITY.deep_sleep, 'slow_wave');
  assert.equal(FIELD_TO_CAPABILITY.rem_sleep, 'rem');
  assert.equal(FIELD_TO_CAPABILITY.disturbances, 'disturbance_count');
  assert.equal(FIELD_TO_CAPABILITY.weight, 'body_weight');
  assert.equal(FIELD_TO_CAPABILITY.body_max_hr, 'body_max_heart_rate');
});

test('★★ 主動代理監看的每一個指標都有明確的 capability 對應', () => {
  for (const m of SIGNAL_POLICY.MONITORED_METRICS) {
    assert.ok(
      Object.hasOwn(FIELD_TO_CAPABILITY, m),
      `${m} 是被監看的指標，卻沒有 capability 對應——閘門對它會失效`,
    );
  }
});

test('★★ 每一個 healthspan contributor 都在對應表裡（null 也要明確寫出來）', () => {
  for (const c of CONTRIBUTORS) {
    assert.ok(
      Object.hasOwn(CONTRIBUTOR_TO_CAPABILITY, c.key),
      `contributor ${c.key} 沒有在對應表裡——是漏寫還是刻意的？必須明確`,
    );
  }
});

test('沒有對應的欄位回 null（=無法判斷），不是 UNAVAILABLE', () => {
  assert.equal(capabilityStatusForField('workout_duration_minutes', {}), null);
  assert.equal(capabilityStatusForField('完全不存在的欄位', {}), null);
  assert.equal(capabilityStatusForContributor('workout_volume', {}), null);
  assert.equal(capabilityStatusForContributor('strength_activity', {}), null);
});

test('★★ 用對的 key 查得到，用錯的 key 查不到（證明對應真的有作用）', () => {
  const caps = cap('recovery_score', STATUS.UNAVAILABLE);
  assert.equal(capabilityStatusForField('recovery', caps), STATUS.UNAVAILABLE);
  // 直接用 daily_metrics 的欄位名當 key —— 這正是修好之前的錯誤做法
  assert.equal(caps.recovery, undefined);
});

test('capabilityByMetricFor 只放查得到的（缺席 = 交給樣本數邏輯）', () => {
  const caps = { ...cap('hrv', STATUS.SUPPORTED), ...cap('strain', STATUS.UNAVAILABLE) };
  const out = capabilityByMetricFor(['hrv', 'previous_day_strain', 'rhr'], caps);
  assert.deepEqual(out, { hrv: STATUS.SUPPORTED, previous_day_strain: STATUS.UNAVAILABLE });
  assert.ok(!Object.hasOwn(out, 'rhr'), 'rhr 沒被 probe 過 → 不該出現');
});

// ===========================================================================
// ★★★ UNKNOWN 不可以變成 UNAVAILABLE
// ===========================================================================

test('★★★ isKnownUnavailable：只有那三種才算已證實拿不到', () => {
  assert.equal(isKnownUnavailable(STATUS.APP_ONLY), true);
  assert.equal(isKnownUnavailable(STATUS.UNAVAILABLE), true);
  assert.equal(isKnownUnavailable(STATUS.UNAUTHORIZED), true);

  assert.equal(isKnownUnavailable(STATUS.UNKNOWN), false, '★ 樣本不足 ≠ 不支援');
  assert.equal(isKnownUnavailable(STATUS.SUPPORTED), false);
  assert.equal(isKnownUnavailable(STATUS.PARTIAL), false);
  assert.equal(isKnownUnavailable(null), false, '★ 還沒 probe ≠ 不支援');
  assert.equal(isKnownUnavailable(undefined), false);
});

test('★★★ 完全沒 probe 過（空的 capability 表）不會讓任何指標變成不支援', () => {
  const out = capabilityByMetricFor(SIGNAL_POLICY.MONITORED_METRICS, {});
  assert.deepEqual(out, {}, '沒有任何指標會被標成任何狀態');
});

test('★★★ UNKNOWN 傳到 detectSignals 也不會被當成不支援', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: 50 + (i % 5),
  }));
  const anchorDate = series[series.length - 1].date;

  // UNKNOWN 與完全不給，行為必須一致
  const withUnknown = detectSignals({
    seriesByMetric: { hrv: series },
    capabilityByMetric: { hrv: STATUS.UNKNOWN },
    anchorDate,
    metrics: ['hrv'],
  });
  const without = detectSignals({
    seriesByMetric: { hrv: series }, anchorDate, metrics: ['hrv'],
  });
  assert.deepEqual(withUnknown, without);
});

test('★★ 已證實不支援的指標不會產生訊號', () => {
  // 造一個「HRV 明顯偏低」的序列，正常情況下會產生訊號
  const series = Array.from({ length: 40 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: i === 39 ? 10 : 55 + (i % 3),
  }));
  const anchorDate = series[series.length - 1].date;

  const normal = detectSignals({
    seriesByMetric: { hrv: series }, anchorDate, metrics: ['hrv'],
  });
  assert.ok(normal.length > 0, '前提：這個序列本來會產生訊號');

  const gated = detectSignals({
    seriesByMetric: { hrv: series },
    capabilityByMetric: { hrv: STATUS.UNAVAILABLE },
    anchorDate,
    metrics: ['hrv'],
  });
  assert.deepEqual(gated, [], '已證實拿不到的指標不該產生訊號');
});

// ===========================================================================
// Healthspan
// ===========================================================================

const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({
  health_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  rhr: 50 + (i % 5),
  hrv: 55 + (i % 5),
  sleep_total: 7 * 3600_000,
  weight: 70,
}));

test('★★★ healthspan：probe 說 UNAVAILABLE → contributor 標成 UNAVAILABLE', () => {
  const rows = rowsFor(90);
  const anchor = rows[rows.length - 1].health_date;

  const before = buildContributors(rows, { endDate: anchor, capabilities: {} });
  const rhrBefore = before.find((c) => c.metricKey === 'resting_heart_rate');
  assert.notEqual(rhrBefore.availability, AVAILABILITY.UNAVAILABLE);

  const after = buildContributors(rows, {
    endDate: anchor,
    capabilities: cap('rhr', STATUS.UNAVAILABLE),
  });
  const rhrAfter = after.find((c) => c.metricKey === 'resting_heart_rate');
  assert.equal(rhrAfter.availability, AVAILABILITY.UNAVAILABLE);
});

test('★★★ healthspan：contributor 命名對應真的生效（修好之前永遠查不到）', () => {
  const rows = rowsFor(90);
  const anchor = rows[rows.length - 1].health_date;

  // `sleep_duration` 這個 contributor 對應的 probe key 是 `sleep_total`
  const out = buildContributors(rows, {
    endDate: anchor,
    capabilities: cap('sleep_total', STATUS.UNAVAILABLE),
  });
  const sleep = out.find((c) => c.metricKey === 'sleep_duration');
  assert.equal(sleep.availability, AVAILABILITY.UNAVAILABLE);
});

test('★★★ healthspan：UNKNOWN 不會讓 contributor 變成 UNAVAILABLE', () => {
  const rows = rowsFor(90);
  const anchor = rows[rows.length - 1].health_date;
  const out = buildContributors(rows, {
    endDate: anchor,
    capabilities: cap('rhr', STATUS.UNKNOWN),
  });
  const rhr = out.find((c) => c.metricKey === 'resting_heart_rate');
  assert.notEqual(rhr.availability, AVAILABILITY.UNAVAILABLE);
});

test('★★ healthspan：UNAUTHORIZED 也算已證實拿不到', () => {
  const rows = rowsFor(90);
  const anchor = rows[rows.length - 1].health_date;
  const out = buildContributors(rows, {
    endDate: anchor,
    capabilities: cap('body_weight', STATUS.UNAUTHORIZED),
  });
  const weight = out.find((c) => c.metricKey === 'weight');
  assert.equal(weight.availability, AVAILABILITY.UNAVAILABLE);
});

test('★★ healthspan：APP_ONLY 的三個永遠是 APP_ONLY 且 value 為 null', () => {
  const rows = rowsFor(90);
  const out = buildContributors(rows, { endDate: rows[rows.length - 1].health_date });
  for (const key of ['steps', 'vo2_max', 'lean_body_mass']) {
    const c = out.find((x) => x.metricKey === key);
    assert.equal(c.availability, AVAILABILITY.APP_ONLY);
    assert.equal(c.value, null);
  }
});

// ===========================================================================
// per-user 隔離
// ===========================================================================

test('★★★ Alice 的 capability 完全不影響 Bob', async () => {
  await withDb(async (db) => {
    await db.saveCapabilities(ALICE.id, [{
      key: 'hrv', status: STATUS.UNAVAILABLE, sampleCount: 10, nonNullCount: 0,
    }]);

    const aliceCaps = await db.getCapabilities(ALICE.id);
    const bobCaps = await db.getCapabilities(BOB.id);

    assert.equal(capabilityStatusForField('hrv', aliceCaps), STATUS.UNAVAILABLE);
    assert.equal(capabilityStatusForField('hrv', bobCaps), null, 'Bob 沒被 probe 過');

    // 接線之後：Alice 的 hrv 被閘門擋掉，Bob 的不受影響
    assert.deepEqual(
      capabilityByMetricFor(['hrv'], aliceCaps), { hrv: STATUS.UNAVAILABLE },
    );
    assert.deepEqual(capabilityByMetricFor(['hrv'], bobCaps), {});
  });
});

test('★★ getCapabilities 缺 userId 一律拋錯', async () => {
  await withDb(async (db) => {
    await assert.rejects(() => db.getCapabilities(null), /缺少 userId/);
  });
});

// ===========================================================================
// 絕不看 membership tier
// ===========================================================================

/**
 * 把註解拿掉，只留真的會執行的程式碼。
 *
 * 必要：capabilities.js 的檔頭**明文寫著**「絕不用 membership tier 判斷
 * 能力。沒有 `if (membership === 'one')`」——那是在記錄這條禁令，不是在
 * 違反它。掃原始碼時如果不先去掉註解，就會把說明文字誤判成違規。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 區塊註解
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行註解（避開 https://）
}

test('★★★ 整個 capability 路徑沒有任何 membership / tier 判斷', () => {
  for (const f of ['src/capabilityMap.js', 'src/capabilities.js', 'src/healthspan.js', 'src/signals.js']) {
    const src = codeOnly(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    for (const forbidden of ['membership', 'tier']) {
      assert.ok(
        !src.toLowerCase().includes(forbidden.toLowerCase()),
        `${f} 的程式碼不該出現 ${forbidden}——唯一可信的判準是「欄位有沒有值」`,
      );
    }
  }
});

test('★ 註解剝除本身是對的（否則上一個測試會變成空砲）', () => {
  const src = codeOnly(`
    /* membership */
    // tier
    const x = 1; // membership
    const url = 'https://example.com';
  `);
  assert.ok(!src.includes('membership'));
  assert.ok(!src.includes('tier'));
  assert.ok(src.includes('const x = 1;'), '程式碼本身必須保留');
  assert.ok(src.includes('https://example.com'), 'URL 裡的 // 不可以被當成註解');
});
