/**
 * PA2：readiness UX（/status、/predictions 的 Proactive Agent 摘要）。
 *
 * 這裡順便補上一個先前完全沒有測試覆蓋、因此沒被抓到的既有 bug：
 * handlePredictions() 呼叫 scorecard(db, userId, {}) 時 userId 從未被
 * 解構出來，導致「過往預測準確度」那一段永遠因為 ReferenceError 被
 * try/catch 吞掉、從來沒有顯示過。PA2 順手修好（見 src/bot/commands.js）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { seedSingleUser } from './users.js';
import { MIN_TRAIN_ROWS } from '../src/prediction.js';
import { handlePredictions, renderProactiveStatusLines } from '../src/bot/commands.js';

const DAY = 86_400_000;
function makeRows(startDate, n, fn) {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    health_date: new Date(t0 + i * DAY).toISOString().slice(0, 10),
    ...fn(i),
  }));
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-ux-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('handlePredictions: 樣本不足時顯示 readiness 算出來的確切數字', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const rows = makeRows('2026-01-01', 5, () => ({ recovery: 50, sleep_total: 25_000_000 }));
    const text = await handlePredictions({ db, userId: user.id, rows });
    assert.match(text, /INSUFFICIENT_DATA/);
    assert.match(text, new RegExp(`最低需求：${MIN_TRAIN_ROWS} 筆`));
  } finally {
    db.close();
    cleanup();
  }
});

test('★ handlePredictions: 修好 userId 沒解構出來的 bug——有已評估的記分卡時要顯示準確度', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);

    const noise = (i, seed) => (((i + 1) * 9301 + seed * 49297) % 233280) / 233280;
    const rows = makeRows('2026-01-01', MIN_TRAIN_ROWS + 10, (i) => ({
      recovery: 40 + noise(i, 1) * 40,
      sleep_total: 20_000_000 + noise(i, 2) * 8_000_000,
      previous_day_strain: 5 + noise(i, 3) * 15,
      hrv: 30 + noise(i, 4) * 40,
      rhr: 45 + noise(i, 5) * 20,
      sleep_debt: noise(i, 6) * 3_000_000,
    }));

    // 直接寫一筆「已評估」的 prediction_run（不透過有 bug 的 recordPredictionActual，
    // 純粹是為了在測試裡準備資料；那個既有 bug 已記錄在 PA1 review 的已知限制）。
    await db.savePrediction(user.id, {
      targetDate: '2026-02-01', targetMetric: 'recovery', modelVersion: 'test-v1',
      status: 'OK', features: ['hrv'], predictedValue: 50, predictedLow: 45, predictedHigh: 55, nTrain: 40,
    });
    await db.raw.execute({
      sql: `UPDATE prediction_runs SET actual_value = 48, error = -2, evaluated_at = ?
             WHERE user_id = ? AND target_date = ?`,
      args: [new Date().toISOString(), user.id, '2026-02-01'],
    });

    const text = await handlePredictions({ db, userId: user.id, rows });
    assert.match(text, /狀態：可訓練/);
    assert.match(text, /過往預測準確度/, 'scorecard 區塊應該要出現，不該被 ReferenceError 吃掉');
    assert.match(text, /已評估 1 次/);
  } finally {
    db.close();
    cleanup();
  }
});

test('renderProactiveStatusLines: 沒有資料時顯示「尚未開始累積資料」', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const text = await renderProactiveStatusLines({
      db, userId: user.id, timezone: user.timezone, rows: [], now: new Date('2026-09-07T00:00:00Z'),
    });
    assert.match(text, /尚未開始累積資料/);
    assert.match(text, /待回答問題：無/);
  } finally {
    db.close();
    cleanup();
  }
});

test('renderProactiveStatusLines: 資料足夠時顯示「已啟用」', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const rows = makeRows('2026-06-01', 40, (i) => ({
      recovery: 60 + (i % 5), hrv: 50 + (i % 4), rhr: 55 - (i % 3),
    }));
    const anchor = rows.at(-1).health_date;
    const text = await renderProactiveStatusLines({
      db, userId: user.id, timezone: user.timezone, rows, now: new Date(`${anchor}T12:00:00Z`),
    });
    assert.match(text, /✅ 已啟用/);
  } finally {
    db.close();
    cleanup();
  }
});
