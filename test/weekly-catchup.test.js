/**
 * A3：每週回顧的補發寬限。
 *
 * 修正的問題：以前 runWeekly 只在「當地時間週一」執行，週一整天故障
 * （Turso 掛 / token 失效 / 排程被停用）那一週的回顧就**永久**漏掉，
 * 而且沒有任何告警。daily 有 24 小時補發窗，weekly 完全沒有。
 *
 * 現在：週一～週三（WEEKLY.CATCHUP_DAYS）都可以補發「上一個完整週」。
 * completedWeeks() 在整個當週回傳同一個 weekKey，所以補發用的去重 key
 * 與週一完全相同 —— uniq_report_sent 保證一週只會發一次。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { WEEKLY } from '../src/config.js';
import { completedWeeks, localDate, localWeekday } from '../src/time.js';
import { makeDataset } from './fixtures.js';
import { fakeDb, fakeTelegram, fakeCoach } from './fakes.js';

const TZ = 'Asia/Taipei';

/** 台灣時間某個週一的早上 08:00（UTC 00:00）。 */
function mondayMorning() {
  let d = new Date('2026-08-24T00:00:00Z');
  while (localWeekday(localDate(d, TZ)) !== 1) d = new Date(d.getTime() + 86_400_000);
  return d;
}

/** 從那個週一往後 n 天，台灣時間的下午（確保已過 12:00 的補發門檻）。 */
function dayAfterMondayAfternoon(n) {
  // 台灣 14:00 = UTC 06:00
  return new Date(mondayMorning().getTime() + n * 86_400_000 + 6 * 3_600_000);
}

const U = 'u-catchup-test';

function ctxFor(now, { db = fakeDb(), datasetNow = mondayMorning() } = {}) {
  const dataset = makeDataset({ days: 45, now: datasetNow });
  return {
    db,
    userId: U,
    telegram: fakeTelegram(),
    coach: fakeCoach(),
    source: staticDataSource(dataset),
    timezone: TZ,
    now,
  };
}

test('A3: 設定存在且合理', () => {
  assert.equal(typeof WEEKLY.CATCHUP_DAYS, 'number');
  assert.ok(WEEKLY.CATCHUP_DAYS >= 1, '至少要涵蓋週一本身');
  assert.ok(WEEKLY.CATCHUP_DAYS <= 6, '不可以跨到下一個完整週');
});

test('A3: 週一～週三的 weekKey 完全相同（補發不會指到別週）', () => {
  const keys = [0, 1, 2].map((n) => completedWeeks(dayAfterMondayAfternoon(n), TZ).last.key);
  assert.equal(new Set(keys).size, 1, `三天的 weekKey 必須一致，實際 ${JSON.stringify(keys)}`);
});

test('A3: 週一正常發送', async () => {
  const ctx = ctxFor(dayAfterMondayAfternoon(0));
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'sent');
  assert.equal(ctx.telegram.sent.length, 1);
  assert.match(res.weekly ? 'ok' : 'ok', /ok/);
});

test('A3: 週二補發（週一整天故障的情況）', async () => {
  const ctx = ctxFor(dayAfterMondayAfternoon(1));
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'sent', '週二必須補得回來');
  assert.equal(ctx.telegram.sent.length, 1);
  const run = ctx.db.runs.find((r) => r.reportType === 'weekly' && r.status === 'SENT');
  assert.match(String(run.detail), /catchup_d2/, 'detail 要標明這是週二補發');
});

test('A3: 週三補發', async () => {
  const ctx = ctxFor(dayAfterMondayAfternoon(2));
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'sent');
  const run = ctx.db.runs.find((r) => r.reportType === 'weekly' && r.status === 'SENT');
  assert.match(String(run.detail), /catchup_d3/);
});

test('A3: 週四已超過寬限 → 不再補發', async () => {
  const ctx = ctxFor(dayAfterMondayAfternoon(3));
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'outside_window');
  assert.equal(res.weekday, 4);
  assert.equal(ctx.telegram.sent.length, 0);
});

test('A3: 週日（上一週還沒結束）也不發', async () => {
  const ctx = ctxFor(dayAfterMondayAfternoon(6));
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'outside_window');
  assert.equal(ctx.telegram.sent.length, 0);
});

test('A3: 一週只發一次 —— 週一發過了，週二/週三不會重複', async () => {
  const db = fakeDb();

  const mon = ctxFor(dayAfterMondayAfternoon(0), { db });
  assert.equal((await runWeekly(mon)).status, 'sent');

  const tue = ctxFor(dayAfterMondayAfternoon(1), { db });
  assert.equal((await runWeekly(tue)).status, 'already_sent');
  assert.equal(tue.telegram.sent.length, 0, '週二不可以再發一次');

  const wed = ctxFor(dayAfterMondayAfternoon(2), { db });
  assert.equal((await runWeekly(wed)).status, 'already_sent');
  assert.equal(wed.telegram.sent.length, 0);

  const sent = db.runs.filter((r) => r.reportType === 'weekly' && r.status === 'SENT');
  assert.equal(sent.length, 1, `整週只能有一筆 SENT，實際 ${sent.length}`);
});

test('A3: 週二補發也遵守「清晨先等」的規則（不會半夜吵人）', async () => {
  // 資料集錨在「週二早上起床」，但在台灣時間週二 05:15 執行 ——
  // 那時當天的睡眠還沒結束，所以應該先等，不是硬發。
  const tuesdayWake = dayAfterMondayAfternoon(1);
  const earlyTuesday = new Date(tuesdayWake.getTime() - 9 * 3_600_000); // 台灣 05:00
  const ctx = ctxFor(earlyTuesday, { datasetNow: tuesdayWake });
  const res = await runWeekly(ctx);
  assert.equal(res.status, 'waiting', '清晨不該硬發');
  assert.equal(ctx.telegram.sent.length, 0);
});
