/**
 * 60 天排程停用的提醒。
 *
 * 重點：
 *  - 只在 GitHub Actions 環境生效（沒有 REPO_LAST_COMMIT_AT 就完全跳過）
 *  - 55 天才開始提醒，同一天最多一次
 *  - 提醒失敗絕不能影響簡報
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRepoFreshness, daysSince, buildStaleMessage } from '../src/maintenance.js';
import { REPO_FRESHNESS } from '../src/config.js';
import { fakeDb, fakeTelegram } from './fakes.js';

const NOW = new Date('2026-08-25T00:00:00Z');
const agoDays = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

test('daysSince：算得出天數，壞掉的字串回 null', () => {
  assert.equal(daysSince(agoDays(10), NOW), 10);
  assert.equal(Math.round(daysSince(agoDays(55.5), NOW) * 10) / 10, 55.5);
  assert.equal(daysSince('not-a-date', NOW), null);
  assert.equal(daysSince(undefined, NOW), null);
});

test('沒有 commit 資訊（本機 / Render）→ 完全跳過，不查 DB 也不發訊息', async () => {
  const db = fakeDb();
  const telegram = fakeTelegram();
  const res = await checkRepoFreshness({ db, telegram, now: NOW, lastCommitAt: null });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'no_commit_info');
  assert.equal(telegram.sent.length, 0);
  assert.equal(db.notifies.size, 0);
});

test('時間字串壞掉 → 跳過，不拋錯', async () => {
  const telegram = fakeTelegram();
  const res = await checkRepoFreshness({
    db: fakeDb(), telegram, now: NOW, lastCommitAt: 'garbage',
  });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'unparsable');
  assert.equal(telegram.sent.length, 0);
});

test('還沒到 55 天 → 不提醒', async () => {
  const telegram = fakeTelegram();
  for (const d of [0, 30, 54, REPO_FRESHNESS.WARN_AFTER_DAYS - 0.1]) {
    const res = await checkRepoFreshness({
      db: fakeDb(), telegram, now: NOW, lastCommitAt: agoDays(d),
    });
    assert.equal(res.status, 'fresh', `${d} 天不該提醒`);
  }
  assert.equal(telegram.sent.length, 0);
});

test('滿 55 天 → 發提醒，內容講清楚天數與剩餘時間', async () => {
  const db = fakeDb();
  const telegram = fakeTelegram();
  const res = await checkRepoFreshness({ db, telegram, now: NOW, lastCommitAt: agoDays(56) });

  assert.equal(res.status, 'notified');
  assert.equal(telegram.sent.length, 1);
  const msg = telegram.sent[0];
  assert.match(msg, /維護提醒/);
  assert.match(msg, /56 天沒有新的 commit/);
  assert.match(msg, /還剩約 4 天/, '60 - 56 = 4');
  assert.match(msg, /推任何一個 commit 就會重置計時/);
  assert.doesNotMatch(msg, /🚨/, '這不是系統異常，不該用錯誤通知的樣式');
});

test('同一天內重複執行 → 只提醒一次（冷卻 24 小時）', async () => {
  const db = fakeDb();
  const telegram = fakeTelegram();
  const args = { db, telegram, now: NOW, lastCommitAt: agoDays(56) };

  assert.equal((await checkRepoFreshness(args)).status, 'notified');
  assert.equal((await checkRepoFreshness(args)).status, 'suppressed');
  assert.equal((await checkRepoFreshness(args)).status, 'suppressed');
  assert.equal(telegram.sent.length, 1, '每 30 分鐘跑一次也只該收到一則');
});

test('已經超過 60 天 → 文案改成「請去確認排程還在不在」', async () => {
  const telegram = fakeTelegram();
  await checkRepoFreshness({ db: fakeDb(), telegram, now: NOW, lastCommitAt: agoDays(65) });
  assert.match(telegram.sent[0], /已經超過 60 天/);
  assert.doesNotMatch(telegram.sent[0], /還剩約/);
});

test('Telegram 掛掉 → 回 failed 但不拋錯（不能影響簡報）', async () => {
  const telegram = {
    sent: [],
    send: async () => { throw new Error('Telegram 500'); },
    notifyError: async () => true,
  };
  const res = await checkRepoFreshness({
    db: fakeDb(), telegram, now: NOW, lastCommitAt: agoDays(56),
  });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /Telegram 500/);
});

test('DB 掛掉 → 回 failed 但不拋錯', async () => {
  const db = { ...fakeDb(), claimErrorNotify: async () => { throw new Error('Turso 掛了'); } };
  const res = await checkRepoFreshness({
    db, telegram: fakeTelegram(), now: NOW, lastCommitAt: agoDays(56),
  });
  assert.equal(res.status, 'failed');
});

test('buildStaleMessage 是純函式，邊界天數不會算出負數', () => {
  assert.match(buildStaleMessage(55), /還剩約 5 天/);
  assert.match(buildStaleMessage(60), /已經超過 60 天/);
  assert.match(buildStaleMessage(200), /已經超過 60 天/);
});
