/**
 * 統計層接進 Daily Brief 的整合測試。
 *
 * 守的是最重要的一條紅線：
 * **新功能絕不可以讓 Daily Brief 停止工作。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDaily } from '../src/daily.js';
import { createDb } from '../src/db.js';
import { createSync } from '../src/sync.js';
import { staticDataSource } from '../src/dataSource.js';
import { buildInsightsSafe } from '../src/insights.js';
import { loadDailyMetrics } from '../src/dailyMetrics.js';
import { localDate } from '../src/time.js';
import { makeDataset, degradedOverrides } from './fixtures.js';
import { fakeDb, fakeTelegram, fakeCoach } from './fakes.js';

const TZ = 'Asia/Taipei';
const DAY = 86_400_000;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-ins-'));
  return {
    url: `file:${path.join(dir, 'i.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------

test('★ 沒有健康資料表時，簡報與以前完全一樣（向後相容）', async () => {
  const ds = makeDataset({ days: 45 });
  const ctx = {
    db: fakeDb(), // fakeDb 沒有 getSleeps → insights 直接回 null
    telegram: fakeTelegram(),
    coach: fakeCoach(),
    source: staticDataSource(ds),
    timezone: TZ,
    now: ds.now,
  };
  const res = await runDaily(ctx);
  assert.equal(res.status, 'sent');

  const text = ctx.telegram.sent[0];
  assert.ok(!text.includes('今天最值得注意'), '沒有資料就不該有這一段');
  // 既有內容一項都不能少
  assert.match(text, /早安，Kelvin/);
  assert.match(text, /HRV/);
  assert.match(text, /恢復/);
  assert.match(text, /基準/);
});

test('★ 分析層爆炸時，簡報照樣發（只是沒有那一段）', async () => {
  const ds = makeDataset({ days: 45 });
  const brokenDb = {
    ...fakeDb(),
    // 假裝有健康資料表，但一查就爆
    getSleeps: async () => { throw new Error('Turso 查詢爆炸'); },
    getRecoveries: async () => { throw new Error('boom'); },
    getCycles: async () => { throw new Error('boom'); },
    getWorkouts: async () => { throw new Error('boom'); },
    getLatestBodyMeasurement: async () => { throw new Error('boom'); },
  };
  const ctx = {
    db: brokenDb,
    telegram: fakeTelegram(),
    coach: fakeCoach(),
    source: staticDataSource(ds),
    timezone: TZ,
    now: ds.now,
  };

  const res = await runDaily(ctx);
  assert.equal(res.status, 'sent', '★ 分析掛掉不可以讓簡報失敗');
  assert.equal(ctx.telegram.sent.length, 1);
  assert.match(ctx.telegram.sent[0], /HRV/);
  assert.ok(!ctx.telegram.sent[0].includes('今天最值得注意'));
});

test('★ 部分 DB 查詢失敗不會造成 unhandledRejection（會殺掉整支 cron）', async () => {
  // Promise.all 會讓「後到的 reject」變成 unhandledRejection，Node 22 預設
  // 直接終止 process —— 那會連已經算好的簡報都發不出去。
  const slowFail = (ms) => () => new Promise((_, rej) => {
    setTimeout(() => rej(new Error('慢一步才失敗')), ms);
  });
  const db = {
    getSleeps: async () => [],
    getRecoveries: slowFail(5),
    getCycles: slowFail(8),
    getWorkouts: slowFail(3),
    getLatestBodyMeasurement: slowFail(6),
  };
  const rows = await loadDailyMetrics({ db, timezone: TZ, from: '2026-08-01', to: '2026-09-01' });
  assert.deepEqual(rows, [], '沒有睡眠資料就是空的，但不可以爆炸');
  // 給那些「慢一步才 reject」的 promise 時間浮出來
  await new Promise((r) => { setTimeout(r, 30); });
});

test('必要資料（睡眠）查詢失敗時往外拋，由呼叫端決定', async () => {
  const db = {
    getSleeps: async () => { throw new Error('睡眠查詢失敗'); },
    getRecoveries: async () => [],
    getCycles: async () => [],
    getWorkouts: async () => [],
    getLatestBodyMeasurement: async () => null,
  };
  await assert.rejects(
    () => loadDailyMetrics({ db, timezone: TZ, from: '2026-08-01', to: '2026-09-01' }),
    /睡眠查詢失敗/,
  );
});

test('buildInsightsSafe 自己吞掉所有錯誤', async () => {
  const out = await buildInsightsSafe({
    db: {
      getSleeps: async () => { throw new Error('x'); },
      getRecoveries: async () => [],
      getCycles: async () => [],
      getWorkouts: async () => [],
      getLatestBodyMeasurement: async () => null,
    },
    timezone: TZ,
    healthDate: '2026-09-01',
  });
  assert.equal(out, null, '失敗要回 null，不可以拋');
});

test('db 缺方法時直接跳過，不會留下沒人接的 rejection', async () => {
  const out = await buildInsightsSafe({
    db: { getSleeps: async () => { throw new Error('不該被呼叫'); } }, // 其他方法都沒有
    timezone: TZ,
    healthDate: '2026-09-01',
  });
  assert.equal(out, null);
  await new Promise((r) => { setTimeout(r, 20); });
});

test('★ 有長期資料且今天明顯偏離 → 簡報出現「今天最值得注意」', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const now = new Date('2026-09-01T00:00:00Z');
    const ds = makeDataset({ days: 60, now, overrides: degradedOverrides() });

    // 把資料灌進長期表
    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => [],
      bodyMeasurement: async () => null,
    };
    const sync = createSync({ db, whoop, timezone: TZ, now });
    await sync.incremental('sleep');
    await sync.incremental('recovery');
    await sync.incremental('cycle');

    // 讓 db 同時具備 report 相關的假行為
    const fake = fakeDb();
    const hybrid = {
      ...fake,
      getSleeps: db.getSleeps,
      getRecoveries: db.getRecoveries,
      getCycles: db.getCycles,
      getWorkouts: db.getWorkouts,
      getLatestBodyMeasurement: db.getLatestBodyMeasurement,
    };

    const ctx = {
      db: hybrid,
      telegram: fakeTelegram(),
      coach: fakeCoach(),
      source: staticDataSource(ds),
      timezone: TZ,
      now,
    };
    const res = await runDaily(ctx);
    assert.equal(res.status, 'sent');

    const text = ctx.telegram.sent[0];
    assert.match(text, /今天最值得注意/, '有長期資料且明顯偏離時應該出現');
    assert.match(text, /z=/, '要顯示 z-score');
    assert.ok(text.length <= 4096, '仍然不可超過 Telegram 上限');

    // 數據區照舊完整
    assert.match(text, /早安，Kelvin/);
    assert.match(text, /HRV/);
    assert.equal(localDate(now, TZ) >= res.healthDate, true);
  } finally { db.close(); cleanup(); }
});

test('資料很平穩時不會硬報「值得注意」（不製造雜訊）', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const now = new Date('2026-09-01T00:00:00Z');
    const ds = makeDataset({ days: 60, now }); // 沒有 overrides = 正常波動

    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => [],
      bodyMeasurement: async () => null,
    };
    const sync = createSync({ db, whoop, timezone: TZ, now });
    await sync.incremental('sleep');
    await sync.incremental('recovery');
    await sync.incremental('cycle');

    const fake = fakeDb();
    const ctx = {
      db: {
        ...fake,
        getSleeps: db.getSleeps,
        getRecoveries: db.getRecoveries,
        getCycles: db.getCycles,
        getWorkouts: db.getWorkouts,
        getLatestBodyMeasurement: db.getLatestBodyMeasurement,
      },
      telegram: fakeTelegram(),
      coach: fakeCoach(),
      source: staticDataSource(ds),
      timezone: TZ,
      now,
    };
    await runDaily(ctx);
    const text = ctx.telegram.sent[0];
    // 平穩資料下最多只該有很弱的項目；至少不可以塞滿
    const changeLines = text.split('\n').filter((l) => l.startsWith('· ') && /z=/.test(l));
    assert.ok(changeLines.length <= 2, `最多 2 行，實際 ${changeLines.length}`);
  } finally { db.close(); cleanup(); }
});

test('★ 長期資料只有幾天時不會亂報（樣本不足就不下結論）', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const now = new Date('2026-09-01T00:00:00Z');
    const ds = makeDataset({ days: 3, now, overrides: degradedOverrides() });

    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => [],
      bodyMeasurement: async () => null,
    };
    const sync = createSync({ db, whoop, timezone: TZ, now });
    await sync.incremental('sleep');
    await sync.incremental('recovery');

    const insights = await buildInsightsSafe({
      db, timezone: TZ, healthDate: localDate(new Date(now.getTime() - 3_600_000), TZ),
    });
    assert.ok(insights, '有資料就該回東西');
    assert.deepEqual(insights.whatChanged, [], '★ 只有 3 天不可以下任何統計結論');
  } finally { db.close(); cleanup(); }
});
