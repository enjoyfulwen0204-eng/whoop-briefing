/**
 * capability 閘門對**所有**訊號型別一視同仁（M-04）。
 *
 * ## 修的是什麼
 *
 * `assessChangeDetection()` 的參數列裡根本沒有 `capabilityStatus`。
 * `baselineShiftSignal()` 一直有把它傳進去，但那只是一個被默默丟掉的多餘
 * 屬性——於是 `capabilityGate` 對 BASELINE_SHIFT **完全沒有生效**。
 *
 * 實測（HRV 最後 14 天明顯下滑的序列）：
 *
 *   capability            DEVIATION   BASELINE_SHIFT
 *   APP_ONLY              null        HRV_SHIFT_LOW   ← 應該被擋
 *   UNAVAILABLE           null        HRV_SHIFT_LOW   ← 應該被擋
 *   UNAUTHORIZED          null        HRV_SHIFT_LOW   ← 應該被擋
 *
 * 也就是說一個**已經證實拿不到**的欄位，只要資料庫裡還有舊資料，就能拿去
 * 推論基準漂移、觸發主動追問、寫進使用者看得到的敘述。
 *
 * ## 現在的不變量
 *
 *   **已經證實拿不到的指標，任何訊號型別都不可能產生。**
 *
 * 而且 UNKNOWN / 未 probe / SUPPORTED / PARTIAL **不算**「拿不到」——
 * 那些交給樣本數邏輯決定，否則一個還沒 probe 過的正常帳號會被整組關掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNAL_TYPE, deviationSignal, baselineShiftSignal, detectSignals,
} from '../src/signals.js';
import {
  assessDeviation, assessChangeDetection, READINESS_STATUS,
} from '../src/readiness.js';
import { STATUS as CAPABILITY_STATUS } from '../src/capabilities.js';
import { SIGNAL_POLICY } from '../src/proactivePolicy.js';

/** 三種「已經證實拿不到」的狀態——與 capabilityGate 的判準完全一致。 */
const KNOWN_UNAVAILABLE = [
  CAPABILITY_STATUS.APP_ONLY,
  CAPABILITY_STATUS.UNAVAILABLE,
  CAPABILITY_STATUS.UNAUTHORIZED,
];

/** 這些**不算**拿不到，必須繼續走樣本數邏輯。 */
const NOT_A_REJECTION = [
  null, undefined, CAPABILITY_STATUS.UNKNOWN,
  CAPABILITY_STATUS.SUPPORTED, CAPABILITY_STATUS.PARTIAL,
];

/**
 * 一條序列，同時足以觸發**兩種**訊號：
 *   - 最後 14 天整體下滑一階 → BASELINE_SHIFT
 *   - 最後一天再重摔一次     → DEVIATION
 * 刻意不用 fixture——要確定訊號真的會產生，否則整個檔案是假通過。
 */
function decliningSeries({
  high = 70, low = 55, anchorValue = 20, days = 60, shiftAt = 46,
} = {}) {
  const start = Date.parse('2026-07-01T00:00:00Z');
  const out = [];
  for (let i = 0; i < days; i += 1) {
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      value: i === days - 1 ? anchorValue : (i < shiftAt ? high : low) + (i % 5),
    });
  }
  return out;
}

const SERIES = decliningSeries();
const ANCHOR = SERIES.at(-1).date;

// ===========================================================================
// 前置：確定這組資料真的會產生訊號（否則下面全是假通過）
// ===========================================================================

test('前置：沒有 capability 限制時，這組資料確實會產生兩種訊號', () => {
  const shift = baselineShiftSignal({ metric: 'hrv', series: SERIES, anchorDate: ANCHOR });
  assert.ok(shift, '★ 測試資料必須真的會觸發訊號，否則整個檔案是假通過');
  assert.equal(shift.type, SIGNAL_TYPE.BASELINE_SHIFT);
  assert.equal(shift.code, 'HRV_SHIFT_LOW');

  const dev = deviationSignal({ metric: 'hrv', series: SERIES, anchorDate: ANCHOR });
  assert.ok(dev, '★ DEVIATION 也必須真的會產生');
  assert.equal(dev.type, SIGNAL_TYPE.DEVIATION);
});

// ===========================================================================
// ★★★ 每一種訊號型別 × 每一種「拿不到」狀態
// ===========================================================================

for (const status of KNOWN_UNAVAILABLE) {
  test(`★★★ M-04: capability=${status} → BASELINE_SHIFT 不可以產生`, () => {
    const shift = baselineShiftSignal({
      metric: 'hrv', series: SERIES, anchorDate: ANCHOR, capabilityStatus: status,
    });
    assert.equal(shift, null, '★ 已經證實拿不到的指標不可以推論基準漂移');
  });

  test(`★★★ M-04: capability=${status} → DEVIATION 不可以產生`, () => {
    const dev = deviationSignal({
      metric: 'hrv', series: SERIES, anchorDate: ANCHOR, capabilityStatus: status,
    });
    assert.equal(dev, null);
  });

  test(`★★★ M-04: capability=${status} → detectSignals 對所有監看指標都回空`, () => {
    const seriesByMetric = {};
    const capabilityByMetric = {};
    for (const m of SIGNAL_POLICY.MONITORED_METRICS) {
      seriesByMetric[m] = SERIES;
      capabilityByMetric[m] = status;
    }
    const out = detectSignals({
      seriesByMetric, capabilityByMetric, anchorDate: ANCHOR,
      metrics: SIGNAL_POLICY.MONITORED_METRICS,
    });
    assert.deepEqual(out, [], `★ 任何訊號型別都不可以逃過 capability 閘門（${status}）`);
  });
}

// ===========================================================================
// ★★★ 窮舉：SIGNAL_TYPE 裡的每一種都必須被證實擋得住
// ===========================================================================

test('★★★ M-04: SIGNAL_TYPE 裡每一種型別都被實際驗證過（新增型別會讓這題掛掉）', () => {
  // 先確認沒有 capability 限制時，每一種型別都真的產生得出來
  const produced = new Set();
  for (const m of SIGNAL_POLICY.MONITORED_METRICS) {
    for (const s of detectSignals({
      seriesByMetric: { [m]: SERIES }, anchorDate: ANCHOR, metrics: [m],
    })) produced.add(s.type);
  }
  assert.deepEqual(
    [...produced].sort(), Object.values(SIGNAL_TYPE).sort(),
    '★ 這組資料必須涵蓋 SIGNAL_TYPE 的每一種——否則下面的擋阻證明有漏',
  );

  // 再確認每一種都被擋掉
  for (const status of KNOWN_UNAVAILABLE) {
    const blocked = [];
    for (const m of SIGNAL_POLICY.MONITORED_METRICS) {
      blocked.push(...detectSignals({
        seriesByMetric: { [m]: SERIES },
        capabilityByMetric: { [m]: status },
        anchorDate: ANCHOR, metrics: [m],
      }));
    }
    assert.deepEqual(blocked, [], `★ ${status} 之下不可以有任何訊號`);
  }
});

// ===========================================================================
// ★★ 不能過度封鎖：UNKNOWN / 未 probe / SUPPORTED 必須照常運作
// ===========================================================================

for (const status of NOT_A_REJECTION) {
  test(`★★ M-04 false positive: capability=${String(status)} 不算拒絕，訊號照常產生`, () => {
    const shift = baselineShiftSignal({
      metric: 'hrv', series: SERIES, anchorDate: ANCHOR, capabilityStatus: status,
    });
    assert.ok(shift, `★ ${String(status)} 不可以被當成「拿不到」——會把正常帳號整組關掉`);
  });
}

// ===========================================================================
// readiness 這一層本身
// ===========================================================================

for (const status of KNOWN_UNAVAILABLE) {
  test(`★★ M-04: assessChangeDetection(${status}) 回 UNAVAILABLE，理由與 deviation 一致`, () => {
    const change = assessChangeDetection({
      metricKey: 'hrv', series: SERIES, anchorDate: ANCHOR, capabilityStatus: status,
    });
    const dev = assessDeviation({ series: SERIES, anchorDate: ANCHOR, capabilityStatus: status });
    assert.equal(change.status, READINESS_STATUS.UNAVAILABLE);
    assert.equal(change.status, dev.status, '★ 兩條路必須用同一套判準');
    assert.equal(change.reason, dev.reason, '★ 理由也要一致，不可以各自發明');
  });
}

test('★★ M-04: 樣本充足但 capability 拿不到 → UNAVAILABLE，不是 READY', () => {
  const r = assessChangeDetection({
    metricKey: 'hrv', series: SERIES, anchorDate: ANCHOR,
    capabilityStatus: CAPABILITY_STATUS.UNAVAILABLE,
  });
  assert.notEqual(r.status, READINESS_STATUS.READY,
    '★ 資料再多也不能蓋過「這個欄位拿不到」');
});
