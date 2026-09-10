/**
 * /healthspan 的錨點必須是最新的健康日（M-10）。
 *
 * ## 修的是什麼
 *
 * `buildPersonalHealthspan()` 用 `rows[rows.length - 1].health_date` 當錨點，
 * 也就是假設 rows 是「舊→新」。但這個系統的 daily metrics 是**新→舊**：
 *
 *   - `buildObservations()` 用 `b.endUtc - a.endUtc` 排序
 *   - `healthQuery.js` 全篇都拿 `rows[0]` 當「最新」、
 *     `rows[rows.length - 1]` 當「最早」
 *
 * 所以 `/healthspan` 的錨點取到的是**最舊**的那一天。
 *
 * 後果不是差一天：以 120 天歷史為例，錨點落在 119 天前，90 天窗口於是
 * 覆蓋「四個月前到七個月前」——整份盤點都在描述一段早就過去的時間，
 * 而且畫面上**不會有任何地方看起來壞掉**。
 *
 * ## 現在的不變量
 *
 *   錨點 = `max(health_date)`，**與陣列順序無關**。
 *   兩個呼叫端（cron 傳 endDate、bot 不傳）都不可能再被順序假設咬到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { buildPersonalHealthspan } from '../src/healthspanEngine.js';
import { handleHealthspan } from '../src/bot/commands.js';
import { buildObservations } from '../src/analyze.js';

const LATEST = '2026-09-09';
const DAYS = 120;

/** 新→舊，與 loadDailyMetrics 的實際輸出順序一致。 */
function rowsNewestFirst(days = DAYS) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    out.push({
      health_date: new Date(Date.parse(`${LATEST}T00:00:00Z`) - i * 86_400_000)
        .toISOString().slice(0, 10),
      hrv: 50 + (i % 7), rhr: 52, recovery: 60,
      sleep_total_minutes: 420, respiratory_rate: 15,
    });
  }
  return out;
}

const OLDEST = rowsNewestFirst().at(-1).health_date;

// ===========================================================================
// ★★★ 錨點
// ===========================================================================

test('★★★ M-10: 新→舊的 rows（實際的輸出順序）→ 錨點是最新那天', () => {
  const r = buildPersonalHealthspan(rowsNewestFirst(), { capabilities: {} });
  assert.equal(r.anchorDate, LATEST);
  assert.notEqual(r.anchorDate, OLDEST, '★ 絕不可以取到最舊的一天');
});

test('★★★ M-10: 舊→新的 rows 也得到同一個錨點（完全不依賴順序）', () => {
  const asc = [...rowsNewestFirst()].reverse();
  const r = buildPersonalHealthspan(asc, { capabilities: {} });
  assert.equal(r.anchorDate, LATEST);
});

test('★★★ M-10: 亂序的 rows 也得到同一個錨點', () => {
  const shuffled = [...rowsNewestFirst()].sort(() => (Math.random() < 0.5 ? -1 : 1));
  const r = buildPersonalHealthspan(shuffled, { capabilities: {} });
  assert.equal(r.anchorDate, LATEST);
});

test('★★★ M-10: 三種順序算出來的盤點結果完全一樣', () => {
  const desc = rowsNewestFirst();
  const asc = [...desc].reverse();
  const shuffled = [...desc].sort(() => (Math.random() < 0.5 ? -1 : 1));

  const a = buildPersonalHealthspan(desc, { capabilities: {} });
  const b = buildPersonalHealthspan(asc, { capabilities: {} });
  const c = buildPersonalHealthspan(shuffled, { capabilities: {} });

  assert.deepEqual(b.contributors, a.contributors, '★ 順序不可以改變任何一個 contributor');
  assert.deepEqual(c.contributors, a.contributors);
  assert.equal(b.maturity, a.maturity);
  assert.equal(b.coverage, a.coverage);
});

test('★★ M-10: 明確傳 endDate 時仍然以它為準（cron 那條路不變）', () => {
  const r = buildPersonalHealthspan(rowsNewestFirst(), {
    capabilities: {}, endDate: '2026-08-01',
  });
  assert.equal(r.anchorDate, '2026-08-01');
});

test('★★ M-10: 沒有任何資料時錨點是 null，狀態是 NO_DATA', () => {
  const r = buildPersonalHealthspan([], { capabilities: {} });
  assert.equal(r.anchorDate, null);
  assert.equal(r.maturity, 'NO_DATA');
});

test('★★ M-10: health_date 壞掉／缺漏的列會被略過，不會變成錨點', () => {
  const rows = [
    { health_date: null, hrv: 50 },
    { health_date: '', hrv: 50 },
    { hrv: 50 },
    ...rowsNewestFirst(10),
  ];
  const r = buildPersonalHealthspan(rows, { capabilities: {} });
  assert.equal(r.anchorDate, LATEST);
});

// ===========================================================================
// ★★★ 端到端：/healthspan 指令
// ===========================================================================

test('★★★ M-10 端到端: /healthspan 盤點的是最近的窗口，不是四個月前的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });

    // 只有**最近 30 天**才有 HRV。錨點取對 → 盤點得到 HRV；
    // 錨點取到最舊那天 → 90 天窗口完全看不到任何 HRV。
    const rows = rowsNewestFirst().map((r, i) => (
      i < 30 ? r : { ...r, hrv: null }
    ));

    const text = await handleHealthspan({ db, userId: user.id, rows });
    assert.match(text, /hrv/i,
      `★ 錨點取對才看得到最近的 HRV，實際輸出：\n${text}`);

    // 直接驗錨點與窗口內容
    const result = buildPersonalHealthspan(rows, { capabilities: {} });
    assert.equal(result.anchorDate, LATEST);
    const hrv = result.contributors.find((c) => c.metricKey === 'hrv');
    assert.ok(hrv, 'contributor 清單裡要有 HRV');
    assert.equal(hrv.sampleCount, 30,
      '★ 最近 30 天明明有 HRV；錨點取到最舊那天的話這裡會是 0');
    assert.ok(Number.isFinite(hrv.value));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 前置：確認 daily metrics 真的是新→舊（這才是這個 bug 的成因）
// ===========================================================================

test('前置：buildObservations 的輸出確實是新→舊', () => {
  const mkSleep = (i) => {
    const day = new Date(Date.parse('2026-09-01T15:00:00.000Z') + i * 86_400_000);
    return {
      id: `s-${i}`, nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
      start: day.toISOString(), end: new Date(day.getTime() + 8 * 3600_000).toISOString(),
      score: { respiratory_rate: 15 },
    };
  };
  const obs = buildObservations({
    sleeps: [mkSleep(0), mkSleep(1), mkSleep(2)], recoveries: [], timezone: 'Asia/Taipei',
  });
  assert.equal(obs.length, 3);
  assert.ok(obs[0].healthDate > obs.at(-1).healthDate,
    '★ 這個系統的觀測序列是新→舊——M-10 的成因就是把它當成舊→新');
});
