/**
 * Telegram Q&A 的健康事實語義（QAA 修復）。
 *
 * 四個獨立的錯，共同結果是：使用者手機上看得到的數字，bot 說「沒有」。
 *
 *   1. 事實可用性被綁在校正期上 —— 校正期把 recovery/HRV/RHR 抹成 null
 *   2. 「現在心跳」被悄悄當成靜息心率回答
 *   3. 任何缺資料都講成「等 WHOOP 同步」（實測那天早就同步完了）
 *   4. 內部欄位名 previous_day_strain 直接印給使用者看
 *
 * 生產樣態（2026-09-11，校正期中）：
 *   睡眠 7h16m｜睡眠表現 87%｜recovery 63｜HRV 65.5599｜RHR 54
 *   previous_day_strain 2.5513885｜user_calibrating = true
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { computeDailyMetrics, loadDailyMetrics, seriesOf } from '../src/dailyMetrics.js';
import { deterministicIntent, INTENTS } from '../src/bot/intent.js';
import { fact } from '../src/publishableFacts.js';
import { renderAssertion, renderAssertions, displayLabelFor } from '../src/assertionRenderer.js';

const NOW = new Date('2026-09-11T09:05:00Z');   // Asia/Taipei 17:05
const HD = '2026-09-11';
const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaa-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 生產樣態的完整重現。 */
async function seedProductionLike({ calibrating = true } = {}) {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'Kelvin', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });
  const light = 13_000_000; const sws = 7_000_000; const rem = 6_160_000;   // 合計 7h16m
  await db.raw.execute({
    sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
            sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
            rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
          VALUES (?,?,?,?,?,0,'SCORED',87,?,?,?,?,?,?,?,?)`,
    args: [u.id, 's-1', HD, '2026-09-10T17:00:00.000Z', '2026-09-11T00:16:00.000Z',
      light + sws + rem, light, sws, rem,
      '2026-09-11T00:17:53.000Z', '2026-09-11T01:58:00.000Z', '2026-09-11T04:32:23.000Z',
      JSON.stringify({
        id: 's-1',
        score_state: 'SCORED',
        score: {
          sleep_performance_percentage: 87,
          respiratory_rate: 16.2,
          stage_summary: {
            total_light_sleep_time_milli: light,
            total_slow_wave_sleep_time_milli: sws,
            total_rem_sleep_time_milli: rem,
            total_awake_time_milli: 900000,
            total_in_bed_time_milli: light + sws + rem + 900000,
            disturbance_count: 9,
            sleep_cycle_count: 5,
          },
          sleep_needed: { baseline_milli: 28000000, need_from_sleep_debt_milli: 600000 },
        },
        start: '2026-09-10T17:00:00.000Z',
        end: '2026-09-11T00:16:00.000Z',
        nap: false,
      })],
  });
  await db.raw.execute({
    sql: `INSERT INTO whoop_cycles (user_id,id,start_at,end_at,score_state,strain,
            average_heart_rate,max_heart_rate,kilojoule,created_at,updated_at,synced_at,raw_json)
          VALUES (?,?,?,?,'SCORED',?,?,?,?,?,?,?,?)`,
    args: [u.id, 'c-1', '2026-09-09T16:00:00.000Z', '2026-09-10T16:00:00.000Z',
      2.5513885, 62, 141, 7200,
      '2026-09-10T16:00:00.000Z', '2026-09-10T16:30:00.000Z', '2026-09-11T04:32:23.000Z',
      JSON.stringify({
        id: 'c-1',
        score_state: 'SCORED',
        score: { strain: 2.5513885, average_heart_rate: 62, max_heart_rate: 141, kilojoule: 7200 },
        start: '2026-09-09T16:00:00.000Z',
        end: '2026-09-10T16:00:00.000Z',
      })],
  });
  await db.raw.execute({
    sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
            recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
            created_at,updated_at,synced_at,raw_json)
          VALUES (?,?,?,?,'SCORED',63,65.5599,54,?,?,?,?,?)`,
    args: [u.id, 's-1', 'c-1', HD, calibrating ? 1 : 0,
      '2026-09-11T00:17:53.000Z', '2026-09-11T01:58:00.000Z', '2026-09-11T04:32:23.000Z',
      JSON.stringify({
        cycle_id: 'c-1',
        sleep_id: 's-1',
        score_state: 'SCORED',
        score: {
          recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54,
          user_calibrating: calibrating,
        },
      })],
  });
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

/** coach.json 回 null → 走確定性 intent（正式環境最常見的路徑）。 */
const plainCoach = () => ({ async json() { return null; }, async ask() { return '好的。'; } });

const askBot = (db, user, text, coachFor = plainCoach) =>
  createRouter({ db, coachFor, now: () => NOW })
    .handle({ text, chatId: '5001', user: { id: user.id, timezone: TZ } });

// ===========================================================================
// 1. 事實可用性 vs 分析資格
// ===========================================================================

test('★★★ Case 1: 校正期中仍然答得出今天的 HRV', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '我今天的 HRV 是多少？');
    assert.match(reply, /66ms/, '★ 必須給得出數值（65.5599 → 66ms）');
    assert.doesNotMatch(reply, /等 WHOOP 同步/, '★ 資料早就同步了，不可以叫人等同步');
    assert.doesNotMatch(reply, /還沒有 hrv 的資料/, '★ 不可以說沒有資料');
  } finally { cleanup(); }
});

test('★★★ Case 2: 校正期中仍然答得出今天的靜息心率', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '今天靜息心率多少');
    assert.match(reply, /54bpm/);
    assert.doesNotMatch(reply, /等 WHOOP 同步/);
    assert.match(reply, /校正期/, '★ 趨勢判斷受限要講清楚原因');
  } finally { cleanup(); }
});

test('★★★ Case 4: 今天狀態含全部事實，且沒有「拿不到」', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '今天狀態怎樣');
    for (const [what, re] of [
      ['恢復', /恢復 63/], ['HRV', /HRV 66ms/], ['靜息心率', /靜息心率 54bpm/],
      ['睡眠', /睡眠 7h16m/], ['睡眠表現', /睡眠表現 87%/],
    ]) assert.match(reply, re, `★ 應該包含${what}`);
    assert.doesNotMatch(reply, /目前拿不到/, '★ 這些值都存在，不可以說拿不到');
  } finally { cleanup(); }
});

test('★★★ 分析安全：校正期的值不可以進統計序列', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const rows = await loadDailyMetrics({
      db, userId: user.id, timezone: TZ, from: '2026-09-01', to: '2026-09-30',
      includeCalibratingFacts: true,
    });
    const today = rows.find((r) => r.health_date === HD);
    assert.equal(today.calibrating, true);
    assert.ok(Number.isFinite(today.hrv), '事實在');
    for (const key of ['hrv', 'recovery', 'rhr']) {
      assert.equal(seriesOf(rows, key).length, 0,
        `★ ${key} 的統計序列必須排除校正期`);
    }
    assert.ok(seriesOf(rows, 'sleep_total').length > 0, '睡眠不受影響');
  } finally { cleanup(); }
});

test('★★ 非校正期：值同時進事實與統計', async () => {
  const { db, user, cleanup } = await seedProductionLike({ calibrating: false });
  try {
    const rows = await loadDailyMetrics({
      db, userId: user.id, timezone: TZ, from: '2026-09-01', to: '2026-09-30',
    });
    assert.equal(rows[0].calibrating, false);
    assert.ok(seriesOf(rows, 'hrv').length > 0, '★ 沒有校正就該進統計');
  } finally { cleanup(); }
});

// ===========================================================================
// 2. 即時心率
// ===========================================================================

test('★★★ Case 3: 「我的心跳怎麼那麼快」不可以被當成靜息心率回答', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '我的心跳怎麼那麼快');
    assert.match(reply, /沒有即時心率|看不到你「現在」/, '★ 要明講拿不到即時心率');
    assert.doesNotMatch(reply, /等 WHOOP 同步/);
    // 可以提今天的靜息心率，但必須清楚標示它不是當下心跳
    if (/54bpm/.test(reply)) {
      assert.match(reply, /靜息心率/, '★ 提到 54 時一定要標明是靜息心率');
      assert.match(reply, /不是你當下的心跳|睡眠時的值/, '★ 必須排除誤解');
    }
  } finally { cleanup(); }
});

test('★★★ 即時心率意圖：現在/很快類的問法不會落到 rhr', () => {
  for (const q of ['我的心跳怎麼那麼快', '我現在心跳很快', '現在心率多少',
    '我現在幾 bpm', '目前心跳多少', '心跳狂跳', 'my heart is racing',
    'current heart rate', 'what is my pulse now']) {
    const r = deterministicIntent(q);
    assert.equal(r?.intent, 'current_hr', `★ ${q} 應該是 current_hr`);
    assert.notEqual(r?.metric, 'rhr', `★ ${q} 絕不可以變成 rhr`);
  }
});

test('★★★ 靜息心率的問法仍然正確落到 rhr', () => {
  for (const q of ['今天靜息心率多少', '我的 RHR 是多少', '靜息心率最近怎樣']) {
    const r = deterministicIntent(q);
    assert.equal(r?.metric, 'rhr', `★ ${q} 應該是 rhr`);
    assert.notEqual(r?.intent, 'current_hr');
  }
});

test('★★ current_hr 是合法的結構化意圖（LLM 不必被迫挑 rhr）', () => {
  assert.ok(INTENTS.includes('current_hr'),
    '★ 意圖詞彙裡要有它，否則分類器只能在現有選項裡硬挑一個');
});

// ===========================================================================
// 3. 原因專屬的「給不出來」
// ===========================================================================

test('★★★ 沒有任何該指標紀錄 → 不可以宣稱是同步問題', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const u = await db.createUser({ displayName: 'K', timezone: TZ });
    await db.linkTelegram({ chatId: '5001', userId: u.id });
    // 只有睡眠，沒有 recovery
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
              total_sleep_milli,created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,0,'SCORED',26160000,?,?,?,?)`,
      args: [u.id, 's-1', HD, '2026-09-10T17:00:00.000Z', '2026-09-11T00:16:00.000Z',
        '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', '2026-09-11T04:32:23.000Z',
        JSON.stringify({ id: 's-1', score_state: 'SCORED', score: {}, start: '2026-09-10T17:00:00.000Z', end: '2026-09-11T00:16:00.000Z', nap: false })],
    });
    const reply = await askBot(db, u, '今天靜息心率多少');
    assert.doesNotMatch(reply, /等 WHOOP 同步/,
      '★ 沒有證據顯示同步有問題，就不可以把責任推給同步');
  } finally { db.close(); cleanup(); }
});

test('★★ 不認得的指標 → 說不認得，而不是說要等同步', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '我的血糖趨勢怎樣',
      () => ({ async json() { return { intent: 'trend_query', metric: 'blood_glucose' }; },
        async ask() { return 'x'; } }));
    assert.doesNotMatch(reply, /等 WHOOP 同步/);
    assert.doesNotMatch(reply, /blood_glucose|unknown_internal_metric/,
      '★ 未知的模型／內部 key 不可以被原樣回顯');
  } finally { cleanup(); }
});

// ===========================================================================
// 4. 內部欄位名不可外洩
// ===========================================================================

test('★★★ Case 4: previous_day_strain 顯示成「昨日 Strain」', async () => {
  const { db, user, cleanup } = await seedProductionLike();
  try {
    const reply = await askBot(db, user, '今天狀態怎樣');
    assert.match(reply, /昨日 Strain 2\.6/, '★ 要有語義正確的標籤');
    assert.doesNotMatch(reply, /previous_day_strain/, '★ 內部欄位名絕不可外洩');
  } finally { cleanup(); }
});

test('★★★ Case 5: 沒有核可標籤的內部 key 一律不發布（fail closed）', () => {
  for (const key of ['previous_day_strain_raw', 'unknown_internal_metric',
    'deep_sleep', 'rem_sleep', 'some_db_column']) {
    const f = fact(key, 42, { publishable: true, display: '42' });
    const rendered = renderAssertion(f);
    if (rendered !== null) {
      assert.doesNotMatch(rendered.text, new RegExp(key),
        `★ ${key} 這個內部 key 不可以出現在輸出裡`);
    }
    assert.equal(displayLabelFor(f), null, `★ ${key} 不該有核可標籤`);
  }
});

test('★★★ 未對應的 key 也不可以出現在「目前拿不到」清單裡', () => {
  const f = fact('mystery_internal_key', null, { publishable: false });
  const { lines, unavailable } = renderAssertions({ facts: [f] });
  assert.deepEqual(lines, []);
  assert.ok(!unavailable.some((u) => /mystery_internal_key/.test(u)),
    '★ 連「拿不到」的清單都不可以印內部 key');
});

test('★★ 核可的指標仍然正常顯示', () => {
  const r = renderAssertion(fact('hrv', 65.5599, { publishable: true, display: '66ms' }));
  assert.equal(r.text, 'HRV 66ms');
  const s = renderAssertion(fact('strain', 2.55, {
    publishable: true, display: '2.6', displayLabel: '昨日 Strain',
  }));
  assert.equal(s.text, '昨日 Strain 2.6', '★ 語義標籤要蓋過預設標籤');
});
