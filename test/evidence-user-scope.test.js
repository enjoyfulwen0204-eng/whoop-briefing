/**
 * 預測證據的 user scope（V1.1 Phase 6）。
 *
 * 修的是一個**靜默**的 bug：evidence.js 呼叫 `scorecard(db, {})`。
 * `{}` 是 truthy，requireUserId 又用 String() 正規化，所以它變成字面上的
 * "[object Object]" —— 守衛不拋錯，查詢卻永遠 0 列。結果是預測記分卡
 * 從來不曾出現在 /evidence，而且連 log 都不會有。
 *
 * 這個檔案裡的每一個測試，在修好之前都會失敗。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { getEvidence, EVIDENCE_METHODS } from '../src/evidence.js';
import { persistPrediction, backfillActuals, scorecard, MODEL_VERSION } from '../src/prediction.js';
import { requireUserId, MissingUserIdError } from '../src/userContext.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-evid-'));
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

/** 給某個使用者塞一組「已經有實際值」的預測，讓記分卡算得出來。 */
async function seedScoredPredictions(db, user, { base = 60, n = 4 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const targetDate = `2026-09-${String(10 + i).padStart(2, '0')}`;
    await persistPrediction(db, user.id, {
      targetDate,
      targetMetric: 'recovery',
      prediction: {
        status: 'OK',
        predicted_value: base + i,
        predicted_low: base + i - 5,
        predicted_high: base + i + 5,
        model_version: MODEL_VERSION,
        n_train: 30,
      },
      features: { hrv: 55 },
    });
    rows.push({ health_date: targetDate, recovery: base + i + 1 });
  }
  await backfillActuals(db, user.id, rows, { targetMetric: 'recovery' });
}

// ---------------------------------------------------------------------------
// 守衛本身
// ---------------------------------------------------------------------------

test('★★ requireUserId 拒絕物件（就是這個洞讓 bug 靜默通過）', () => {
  assert.throws(() => requireUserId({}, 'x'), MissingUserIdError);
  assert.throws(() => requireUserId([], 'x'), MissingUserIdError);
  assert.throws(() => requireUserId(() => {}, 'x'), MissingUserIdError);
  assert.throws(() => requireUserId(true, 'x'), MissingUserIdError);
  assert.throws(() => requireUserId(NaN, 'x'), MissingUserIdError);
});

test('requireUserId 仍然接受字串與數字（沒有變嚴到影響既有用法）', () => {
  assert.equal(requireUserId('u-1', 'x'), 'u-1');
  assert.equal(requireUserId(' u-2 ', 'x'), 'u-2');
  assert.equal(requireUserId(123, 'x'), '123');
});

test('requireUserId 仍然拒絕 null / undefined / 空字串', () => {
  assert.throws(() => requireUserId(null, 'x'), MissingUserIdError);
  assert.throws(() => requireUserId(undefined, 'x'), MissingUserIdError);
  assert.throws(() => requireUserId('   ', 'x'), MissingUserIdError);
});

test('★ 絕不會有 "[object Object]" 這種 user id 被送進查詢', () => {
  assert.throws(() => requireUserId({}, 'scorecard'), MissingUserIdError);
  // 確認舊行為真的消失了
  let coerced = null;
  try { coerced = requireUserId({}, 'scorecard'); } catch { /* 預期 */ }
  assert.notEqual(coerced, '[object Object]');
});

// ---------------------------------------------------------------------------
// 這個 bug 的直接回歸測試
// ---------------------------------------------------------------------------

test('★★★ Alice 的預測記分卡真的會出現在 Alice 的 /evidence', async () => {
  await withDb(async (db) => {
    await seedScoredPredictions(db, ALICE);

    const sc = await scorecard(db, ALICE.id, {});
    assert.equal(sc.available, true, '前提：記分卡本身要算得出來');

    const ev = await getEvidence({ db, userId: ALICE.id });
    assert.equal(ev.available, true);

    const card = ev.cards.find((c) => c.method === EVIDENCE_METHODS.PREDICTION);
    assert.ok(card, '預測記分卡必須出現在證據裡（修好之前永遠不會出現）');
    assert.equal(card.sample_count, sc.n);
  });
});

test('★★★ Bob 看不到 Alice 的預測記分卡', async () => {
  await withDb(async (db) => {
    await seedScoredPredictions(db, ALICE);

    const ev = await getEvidence({ db, userId: BOB.id });
    const card = ev.cards.find((c) => c.method === EVIDENCE_METHODS.PREDICTION);
    assert.equal(card, undefined, 'Bob 不可以看到 Alice 的記分卡');
  });
});

test('★★ 兩個人各自的記分卡不會互相污染', async () => {
  await withDb(async (db) => {
    await seedScoredPredictions(db, ALICE, { base: 60, n: 4 });
    await seedScoredPredictions(db, BOB, { base: 30, n: 6 });

    const aliceEv = await getEvidence({ db, userId: ALICE.id });
    const bobEv = await getEvidence({ db, userId: BOB.id });

    const aliceCard = aliceEv.cards.find((c) => c.method === EVIDENCE_METHODS.PREDICTION);
    const bobCard = bobEv.cards.find((c) => c.method === EVIDENCE_METHODS.PREDICTION);

    assert.ok(aliceCard && bobCard);
    assert.equal(aliceCard.sample_count, 4);
    assert.equal(bobCard.sample_count, 6);
  });
});

test('★ 沒有任何預測時，evidence 誠實地不給記分卡（不是報錯，也不是編一張）', async () => {
  await withDb(async (db) => {
    const ev = await getEvidence({ db, userId: ALICE.id });
    const card = ev.cards.find((c) => c.method === EVIDENCE_METHODS.PREDICTION);
    assert.equal(card, undefined);
    assert.equal(ev.available, false);
    assert.match(ev.note, /還沒有累積足夠的資料/);
  });
});

test('getEvidence 缺 userId 一律拋錯', async () => {
  await withDb(async (db) => {
    await assert.rejects(() => getEvidence({ db, userId: null }), MissingUserIdError);
    // 物件同樣要被擋下來
    await assert.rejects(() => getEvidence({ db, userId: {} }), MissingUserIdError);
  });
});

test('★ scorecard 直接被餵物件時會拋錯，不再靜默回空', async () => {
  await withDb(async (db) => {
    await seedScoredPredictions(db, ALICE);
    await assert.rejects(() => scorecard(db, {}, {}), MissingUserIdError);
  });
});
