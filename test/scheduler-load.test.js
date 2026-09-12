/**
 * 排程頻率的下游成本（WHOOP / Turso / 模型 / Telegram）。
 *
 * Cloudflare 每 10 分鐘觸發一次 = 一天 144 次。那個數字本身在 Cloudflare 是免費的，
 * 但**下游不是**：每一次觸發都可能去打 WHOOP。獨立審查指出這一層從來沒有被
 * 計數過，所以任何讓「每 10 分鐘做一次完整同步」的退化都不會有人發現。
 *
 * 這一組直接數呼叫次數，不是斷言一個寫死的預期值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDataSource } from '../src/dataSource.js';
import { isSyncDue } from '../src/sync.js';
import { WHOOP_SYNC, WAKE } from '../src/config.js';

/** 會計數每一個 endpoint 呼叫的假 WHOOP client。 */
function countingWhoop() {
  const calls = [];
  const mk = (name) => async (...args) => { calls.push({ name, args }); return []; };
  return {
    calls,
    counts() {
      return calls.reduce((acc, c) => { acc[c.name] = (acc[c.name] ?? 0) + 1; return acc; }, {});
    },
    sleeps: mk('sleeps'),
    recoveries: mk('recoveries'),
    cycles: mk('cycles'),
    workouts: mk('workouts'),
    bodyMeasurement: mk('bodyMeasurement'),
    getAccessToken: mk('getAccessToken'),
  };
}

test('★★★ 輕量 poll 每次觸發只打兩個 WHOOP endpoint', async () => {
  const whoop = countingWhoop();
  const source = createDataSource({ whoop, now: new Date('2026-09-12T00:00:00Z') });
  await source.poll();
  const counts = whoop.counts();
  assert.equal(counts.sleeps, 1, '★ sleep 一次');
  assert.equal(counts.recoveries, 1, '★ recovery 一次');
  assert.equal(counts.cycles ?? 0, 0, '★ poll 不可以抓 cycle');
  assert.equal(counts.workouts ?? 0, 0, '★ poll 不可以抓 workout');
  assert.equal(counts.bodyMeasurement ?? 0, 0, '★ poll 不可以抓 body measurement');
  assert.equal(whoop.calls.length, 2, `★ 一次 poll 恰好 2 次呼叫（實際 ${whoop.calls.length}）`);
});

test('★★★ 同一輪內重複 poll 會共用結果（不會倍增呼叫）', async () => {
  const whoop = countingWhoop();
  const source = createDataSource({ whoop, now: new Date('2026-09-12T00:00:00Z') });
  await Promise.all([source.poll(), source.poll(), source.poll()]);
  await source.poll();
  assert.equal(whoop.calls.length, 2, '★ 同一個 source 內 poll 只打一次網路');
});

test('★★★ 完整歷史抓取只在真的要發報告時才做，而且是另一組呼叫', async () => {
  const whoop = countingWhoop();
  const source = createDataSource({ whoop, now: new Date('2026-09-12T00:00:00Z') });
  await source.history();
  const counts = whoop.counts();
  assert.equal(counts.sleeps, 1);
  assert.equal(counts.recoveries, 1);
  assert.equal(counts.cycles, 1, '★ history 才需要 cycle');
  assert.equal(whoop.calls.length, 3);
});

test('★★ 回填未完成時刻意繞過節流（這是設計，不是退化）', async () => {
  const db = {
    getSyncState: async () => ({
      lastSuccessAt: '2026-09-12T00:00:00.000Z', lastError: null, lastErrorAt: null,
      backfillComplete: false,
    }),
  };
  assert.equal(
    await isSyncDue({ db, userId: 'u', now: new Date('2026-09-12T00:10:00.000Z') }),
    true, '★ 回填沒跑完就應該繼續推進',
  );
});

test('★★★ 完整五資源同步受每小時節流保護（不會每 10 分鐘跑一次）', async () => {
  assert.equal(WHOOP_SYNC.MIN_INTERVAL_MS, 60 * 60_000, '★ 節流必須是一小時');
  const recent = new Date('2026-09-12T00:00:00Z');
  const db = {
    // backfillComplete 必須是 true：回填未完成時會**刻意**繞過節流，
    // 那是正確行為，但不是這個測試要驗的東西。
    getSyncState: async () => ({
      lastSuccessAt: recent.toISOString(), lastError: null, lastErrorAt: null,
      backfillComplete: true,
    }),
  };
  // 10 分鐘後：不該同步
  assert.equal(
    await isSyncDue({ db, userId: 'u', now: new Date(recent.getTime() + 10 * 60_000) }),
    false, '★ 10 分鐘後不可以又做完整同步',
  );
  // 61 分鐘後：可以
  assert.equal(
    await isSyncDue({ db, userId: 'u', now: new Date(recent.getTime() + 61 * 60_000) }),
    true, '★ 超過節流窗之後才同步',
  );
});

test('★★★ 一天的下游成本上限（依實際計數推算，不是寫死的數字）', async () => {
  const whoop = countingWhoop();
  const source = createDataSource({ whoop, now: new Date('2026-09-12T00:00:00Z') });
  await source.poll();
  const perPoll = whoop.calls.length;

  const triggersPerDay = (24 * 60) / 10;            // Cloudflare 每 10 分鐘
  const syncsPerDay = (24 * 60 * 60_000) / WHOOP_SYNC.MIN_INTERVAL_MS;
  const resources = WHOOP_SYNC.RESOURCES.length;

  // 最壞情況：整天都還沒發出簡報，所以每一次觸發都會 poll。
  const worstPolls = triggersPerDay * perPoll;
  const worstSync = syncsPerDay * resources;
  const worstTotal = worstPolls + worstSync;

  assert.equal(perPoll, 2);
  assert.equal(triggersPerDay, 144);
  assert.equal(worstPolls, 288);
  assert.equal(worstSync, 120);
  // WHOOP 的文件上限是 10,000 次/日（見 src/whoop.js 的說明）。
  assert.ok(worstTotal < 1000, `★ 單一使用者一天的最壞情況應遠低於上限（${worstTotal}）`);
  // 十個使用者仍然要在上限之內 —— 這是文件寫明的擴充邊界。
  assert.ok(worstTotal * 10 < 10_000, `★ 十人規模仍需在上限內（${worstTotal * 10}）`);
  // 若有人把完整同步改成每次觸發都做，這個數字會爆掉：
  const regressed = triggersPerDay * resources;
  assert.ok(regressed > worstSync * 5, '★ 這個測試必須能看見「每次觸發都完整同步」的退化');
});

test('★★ poll 的回看天數維持在設定值（放大回看＝放大分頁成本）', () => {
  assert.equal(WAKE.POLL_LOOKBACK_DAYS, 5);
});
