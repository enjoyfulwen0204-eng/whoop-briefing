import test from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { TelegramError } from '../src/telegram.js';
import { localDate, localWeekday, completedWeeks } from '../src/time.js';
import { FALLBACK_NOTE } from '../src/format.js';
import { makeDataset, degradedOverrides } from './fixtures.js';
import { fakeDb, fakeTelegram, fakeCoach } from './fakes.js';

const TZ = 'Asia/Taipei';

/** 台灣時間週一早上 08:00 的那個 UTC 瞬間。 */
function mondayMorning() {
  let d = new Date('2026-08-24T00:00:00Z');
  while (localWeekday(localDate(d, TZ)) !== 1) d = new Date(d.getTime() + 86_400_000);
  return d;
}

function ctxFor({ now, dataset, coach = fakeCoach(), telegram = fakeTelegram(), db = fakeDb() }) {
  return {
    db,
    telegram,
    coach,
    source: staticDataSource(dataset),
    timezone: TZ,
    now,
  };
}

test('daily：正常情況會發送並寫入 SENT 紀錄', async () => {
  const ds = makeDataset({ days: 45 });
  const ctx = ctxFor({ now: ds.now, dataset: ds });

  const res = await runDaily(ctx);
  assert.equal(res.status, 'sent');
  assert.equal(ctx.telegram.sent.length, 1);
  assert.match(ctx.telegram.sent[0], /早安，Kelvin/);

  const run = ctx.db.runs.at(-1);
  assert.equal(run.reportType, 'daily');
  assert.equal(run.status, 'SENT');
  assert.equal(run.localDateKey, localDate(ds.now, TZ));
  assert.equal(run.sleepId, 'sleep-000-uuid');
  assert.ok(run.cycleId);
  assert.ok(run.telegramMessageId);
});

test('daily：同一天第二次執行不會重複發（去重）', async () => {
  const ds = makeDataset({ days: 45 });
  const ctx = ctxFor({ now: ds.now, dataset: ds });

  await runDaily(ctx);
  const second = await runDaily(ctx);
  assert.equal(second.status, 'already_sent');
  assert.equal(ctx.telegram.sent.length, 1);
});

test('daily：起床未滿 30 分鐘 → 不發、不寫 SENT，下一輪還會再試', async () => {
  const ds = makeDataset({ days: 45, wakeMinutesAgo: 10 });
  const ctx = ctxFor({ now: ds.now, dataset: ds });

  const res = await runDaily(ctx);
  assert.equal(res.status, 'not_ready');
  assert.equal(res.reason, 'too_soon');
  assert.equal(ctx.telegram.sent.length, 0);
  assert.equal(ctx.db.runs.length, 0);
});

test('daily：Claude 掛掉仍然發數據簡報（fallback）', async () => {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  const ctx = ctxFor({ now: ds.now, dataset: ds, coach: fakeCoach({ fail: true }) });

  const res = await runDaily(ctx);
  assert.equal(res.status, 'sent');
  assert.equal(res.coachUsed, false);
  assert.ok(ctx.telegram.sent[0].includes(FALLBACK_NOTE));
  assert.match(ctx.telegram.sent[0], /HRV/);
  assert.equal(ctx.db.runs.at(-1).detail, 'coach_fallback');
});

test('daily：Telegram 掛掉 → 記 FAILED、不遞迴呼叫 Telegram、明天/下一輪還能重試', async () => {
  const ds = makeDataset({ days: 45 });
  const telegram = {
    sent: [],
    send: async () => { throw new TelegramError('Telegram 500'); },
    notifyError: async () => { throw new Error('notifyError 不該被呼叫'); },
  };
  const ctx = ctxFor({ now: ds.now, dataset: ds, telegram });

  const res = await runDaily(ctx);
  assert.equal(res.status, 'telegram_failed');
  assert.equal(ctx.db.runs.at(-1).status, 'FAILED');
  assert.equal(await ctx.db.isSent('daily', localDate(ds.now, TZ)), false);

  // 下一輪：Telegram 恢復了就補發
  const ctx2 = ctxFor({ now: ds.now, dataset: ds, db: ctx.db });
  const retry = await runDaily(ctx2);
  assert.equal(retry.status, 'sent');
});

test('weekly：週一會發，且與 daily 各自獨立去重', async () => {
  const now = mondayMorning();
  const ds = makeDataset({ days: 45, now });
  const ctx = ctxFor({ now, dataset: ds });
  const weekKey = completedWeeks(now, TZ).last.key;

  const daily = await runDaily(ctx);
  assert.equal(daily.status, 'sent');

  // 關鍵：daily 已經 SENT，不可以擋掉 weekly
  const weekly = await runWeekly(ctx);
  assert.equal(weekly.status, 'sent');
  assert.equal(ctx.telegram.sent.length, 2);
  assert.match(ctx.telegram.sent[1], /上週回顧/);
  assert.equal(await ctx.db.isSent('weekly', weekKey), true);

  // weekly 再跑一次不會重複
  assert.equal((await runWeekly(ctx)).status, 'already_sent');
  assert.equal(ctx.telegram.sent.length, 2);
});

test('weekly：daily 失敗也不影響 weekly 發送（互不阻擋）', async () => {
  const now = mondayMorning();
  const ds = makeDataset({ days: 45, unscoredDays: [0] }); // 今天睡眠沒評分 → daily 不會發
  const dataset = makeDataset({ days: 45, now, unscoredDays: [0] });
  const ctx = ctxFor({ now, dataset });

  const daily = await runDaily(ctx);
  assert.equal(daily.status, 'not_ready');

  // 過中午的補發路徑：不需要偵測到起床
  const afternoon = new Date(now.getTime() + 6 * 3_600_000); // 台灣 14:00
  const ctxPm = ctxFor({ now: afternoon, dataset, db: ctx.db, telegram: ctx.telegram });
  const weekly = await runWeekly(ctxPm);
  assert.equal(weekly.status, 'sent');
  assert.ok(ds.sleeps.length > 0);
});

test('weekly：非週一不發', async () => {
  const monday = mondayMorning();
  const tuesday = new Date(monday.getTime() + 86_400_000);
  const dataset = makeDataset({ days: 45, now: tuesday });
  const ctx = ctxFor({ now: tuesday, dataset });

  const res = await runWeekly(ctx);
  assert.equal(res.status, 'not_monday');
  assert.equal(ctx.telegram.sent.length, 0);
});

test('weekly：清晨還沒起床時先等，過中午才補發', async () => {
  const monday = mondayMorning();
  // 台灣 05:15，睡眠還沒結束（wake 在 3 小時後）
  const earlyUtc = new Date(monday.getTime() - 2.75 * 3_600_000);
  const dataset = makeDataset({ days: 45, now: monday });
  const ctx = ctxFor({ now: earlyUtc, dataset });

  const early = await runWeekly(ctx);
  assert.equal(early.status, 'waiting');
  assert.equal(ctx.telegram.sent.length, 0);
});

test('教練文字長度受控（daily 假文字也不會撐爆訊息）', async () => {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  const ctx = ctxFor({
    now: ds.now, dataset: ds, coach: fakeCoach({ dailyText: '好'.repeat(3000) }),
  });
  await runDaily(ctx);
  assert.ok(ctx.telegram.sent[0].length <= 4096);
});
