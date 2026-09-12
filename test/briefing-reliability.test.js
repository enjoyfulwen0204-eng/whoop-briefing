/**
 * 簡報可靠性（2026-09-12 事故）。
 *
 * ## 事故
 *
 * 排程器那天只在 00:54:49Z（台北 08:54）跑過一次，那時使用者還沒起床，最新
 * 觀測仍是前一天已送出的 09-11，流程正確地回 `already_sent` 就結束。設計上
 * 「等下一輪 cron 補」—— 但 GitHub Actions 那天只產生了約 15% 的預期排程
 * 事件（實測間隔 2h11m～4h33m），下一輪整個早上都沒有來。
 *
 * 結果：WHOOP 沒有被重新輪詢、沒有產生任何 09-12 的報告、沒有嘗試送出，
 * 而且**整條鏈上沒有留下任何使用者看得到的東西**。
 *
 * ## 這一組守的是什麼
 *
 * 不是「保證排程器會跑」—— 程式碼保證不了那件事。守的是：
 *
 *   1. 每一種「跑了但還不能發」都留下可區分的證據（log 欄位）
 *   2. 超過補發時限的丟棄是**顯著的終局事件**，不是沉默的 return
 *   3. 使用者問「今天的晨報呢？」時，得到一句由已存在證據支撐的誠實回答
 *   4. 排程器沒在跑的時候，**不假裝**知道下一次什麼時候會發生
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { runDaily } from '../src/daily.js';
import { detectWake, buildObservations } from '../src/analyze.js';
import {
  assessBriefingStatus, renderBriefingStatus, decide,
  BRIEFING_STATUS,
} from '../src/briefingStatus.js';
import { deterministicIntent } from '../src/bot/intent.js';
import { createHealthQuery } from '../src/healthQuery.js';
import { createRouter } from '../src/bot/router.js';
import { GLOBAL_SCOPE } from '../src/schema.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';
import { WAKE } from '../src/config.js';
import { TelegramError } from '../src/telegram.js';

const TZ = 'Asia/Taipei';
/** 生產觀測到的唯一一筆睡眠（09-11 那一夜）。 */
const PRIOR = { start: '2026-09-10T17:48:37.880Z', end: '2026-09-11T01:43:34.100Z', hd: '2026-09-11' };
/** 事故當晚（09-11→09-12）使用者「應該」的睡眠，作息沿用前一晚。 */
const LAST_NIGHT = { start: '2026-09-11T17:48:00.000Z', end: '2026-09-12T01:43:00.000Z', hd: '2026-09-12' };
/** 當天唯一真的發生過的排程執行。 */
const ONLY_RUN = '2026-09-12T00:54:49.260Z';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const sleepRaw = (s, id) => ({
  id, score_state: 'SCORED', start: s.start, end: s.end, nap: false,
  score: {
    sleep_performance_percentage: 87, respiratory_rate: 16.2,
    stage_summary: {
      total_light_sleep_time_milli: 13e6, total_slow_wave_sleep_time_milli: 7e6,
      total_rem_sleep_time_milli: 6.16e6, total_awake_time_milli: 9e5,
      total_in_bed_time_milli: 27e6, disturbance_count: 9, sleep_cycle_count: 5,
    },
    sleep_needed: { baseline_milli: 28e6, need_from_sleep_debt_milli: 6e5 },
  },
});
const recRaw = (id, { scored = true } = {}) => ({
  cycle_id: `c${id}`, sleep_id: id, score_state: scored ? 'SCORED' : 'PENDING_SCORE',
  score: scored
    ? { recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54, user_calibrating: true }
    : undefined,
});

/**
 * @param nights           要放哪幾夜的睡眠
 * @param sentDates        哪些 health_date 已經 SENT
 * @param heartbeatAt      cron heartbeat 的時間（null = 從來沒跑過）
 * @param sleepScored      睡眠是否已評分
 * @param recovery         'scored' | 'unscored' | 'missing'
 * @param openCycle        最新的 cycle 是否還開著
 */
async function seed({
  nights = [PRIOR], sentDates = ['2026-09-11'], heartbeatAt = ONLY_RUN,
  sleepScored = true, recovery = 'scored', openCycle = true,
} = {}) {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'incident', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });

  for (const [i, s] of nights.entries()) {
    const id = `s${i}`;
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
              sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
              rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,0,?,87,?,?,?,?,?,?,?,?)`,
      args: [u.id, id, s.hd, s.start, s.end, sleepScored ? 'SCORED' : 'PENDING_SCORE',
        26.16e6, 13e6, 7e6, 6.16e6, s.start, s.end, s.end,
        JSON.stringify({ ...sleepRaw(s, id), score_state: sleepScored ? 'SCORED' : 'PENDING_SCORE' })],
    });
    if (recovery !== 'missing') {
      await db.raw.execute({
        sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
                recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
                created_at,updated_at,synced_at,raw_json)
              VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
        args: [u.id, id, `c${i}`, s.hd, recovery === 'scored' ? 'SCORED' : 'PENDING_SCORE',
          recovery === 'scored' ? 63 : null, recovery === 'scored' ? 65.5599 : null,
          recovery === 'scored' ? 54 : null,
          s.start, s.end, s.end, JSON.stringify(recRaw(id, { scored: recovery === 'scored' }))],
      });
    }
    await db.raw.execute({
      sql: `INSERT INTO whoop_cycles (user_id,id,whoop_user_id,start_at,end_at,timezone_offset,
              score_state,strain,kilojoule,average_heart_rate,max_heart_rate,
              created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,'+08:00','SCORED',2.6,4000,60,120,?,?,?,?)`,
      args: [u.id, `cy${i}`, 'w', s.start,
        openCycle && i === nights.length - 1 ? null : s.end,
        s.start, s.end, s.end, JSON.stringify({ id: `cy${i}` })],
    });
  }
  for (const d of sentDates) {
    await db.recordRun({
      userId: u.id, reportType: 'daily', localDateKey: d, healthDate: d,
      telegramMessageId: 1, status: 'SENT', detail: 'seed',
    });
  }
  if (heartbeatAt) {
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, {
      detail: 'users=1', now: new Date(heartbeatAt),
    });
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CLOUDFLARE, {
      detail: 'outcome=completed;users=1', now: new Date(heartbeatAt),
    });
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.GITHUB, {
      detail: 'outcome=completed;users=1', now: new Date(heartbeatAt),
    });
  }
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

const source = (db, uid) => ({
  async poll() {
    const sleeps = (await db.getSleeps(uid, { from: '2026-09-01', to: '2026-09-30' }))
      .map((r) => JSON.parse(r.raw_json));
    const recoveries = (await db.getRecoveries(uid, { from: '2026-09-01', to: '2026-09-30' }))
      .map((r) => JSON.parse(r.raw_json));
    return { sleeps, recoveries, cycles: [] };
  },
  async history() { return this.poll(); },
});
const coach = { async ask() { return 'stub'; }, async json() { return null; } };
function telegramStub({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(text) {
      if (fail) throw new TelegramError('telegram down');
      sent.push(text); return { messageId: 99 };
    },
    async notifyError() {},
  };
}

/** 捕捉 log 事件名稱與欄位。 */
async function captureLogs(fn) {
  const { log } = await import('../src/logger.js');
  const events = [];
  const orig = {};
  for (const level of ['info', 'warn', 'error']) {
    orig[level] = log[level];
    log[level] = (event, fields) => { events.push({ level, event, fields: fields ?? {} }); };
  }
  try { return { result: await fn(), events }; } finally {
    for (const level of ['info', 'warn', 'error']) log[level] = orig[level];
  }
}

// ===========================================================================
// 1–4 事故本身的四個時點
// ===========================================================================

test('★★★ 1: 起床前的排程執行 → already_sent（前一天），且標成 stale_observation', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const { result, events } = await captureLogs(() => runDaily({
      db, userId: user.id, source: source(db, user.id), coach,
      telegram: telegramStub(), timezone: TZ, now: new Date(ONLY_RUN),
    }));
    assert.equal(result.status, 'already_sent');
    assert.equal(result.healthDate, '2026-09-11');
    assert.equal(result.staleObservation, true, '★ 必須標出「觀測是舊的那一天」');
    const ev = events.find((e) => e.event === 'daily_already_sent');
    assert.ok(ev, '★ 要有 daily_already_sent');
    assert.equal(ev.fields.stale_observation, true);
    assert.equal(ev.fields.awaiting_current_date, true, '★ 要記下使用者其實在等今天的');
    assert.equal(ev.fields.local_date, '2026-09-12');
    assert.equal(ev.fields.observation_health_date, '2026-09-11');
    assert.equal(ev.fields.timezone, TZ);
    assert.ok(Number.isFinite(ev.fields.observation_age_minutes));
  } finally { cleanup(); }
});

test('★★★ 2: 完全沒有主睡眠 → not_ready(no_main_sleep)，retryable', async () => {
  const { db, user, cleanup } = await seed({ nights: [], sentDates: [] });
  try {
    const { result, events } = await captureLogs(() => runDaily({
      db, userId: user.id, source: source(db, user.id), coach,
      telegram: telegramStub(), timezone: TZ, now: new Date(ONLY_RUN),
    }));
    assert.equal(result.status, 'not_ready');
    assert.equal(result.reason, 'no_main_sleep');
    assert.equal(result.retryable, true);
    const ev = events.find((e) => e.event === 'daily_not_ready');
    assert.equal(ev.fields.retryable, true);
    assert.equal(ev.fields.evaluated_at, new Date(ONLY_RUN).toISOString());
  } finally { cleanup(); }
});

test('★★★ 3: 當前 cycle 還開著 → 狀態是「在等這一晚的資料」，而且說得出口', async () => {
  const { db, user, cleanup } = await seed({ openCycle: true });
  try {
    const now = new Date('2026-09-12T03:55:00.000Z');
    const { status, evidence } = await assessBriefingStatus({
      db, userId: user.id, timezone: TZ, now,
    });
    assert.equal(evidence.cycle_open, true, '★ 要看得出這一夜還沒結算');
    assert.equal(status, BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA);
    const reply = renderBriefingStatus({ status, evidence });
    assert.match(reply, /這一晚|結算/, '★ 要講清楚在等什麼');
    assert.doesNotMatch(reply, /已經發出來/, '★ 不可以說已經發了');
  } finally { cleanup(); }
});

test('★★★ 4: 昨晚的睡眠終於進來 → 同一條流程就會發出 2026-09-12', async () => {
  const { db, user, cleanup } = await seed({ nights: [PRIOR, LAST_NIGHT] });
  try {
    const tg = telegramStub();
    const r = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach,
      telegram: tg, timezone: TZ, now: new Date('2026-09-12T03:55:00.000Z'),
    });
    assert.equal(r.status, 'sent');
    assert.equal(r.healthDate, '2026-09-12');
    assert.equal(tg.sent.length, 1);
    assert.equal(await db.isSent(user.id, 'daily', '2026-09-12'), true);
  } finally { cleanup(); }
});

// ===========================================================================
// 5–7 缺很多輪、長時間之後才被叫起來、重啟
// ===========================================================================

test('★★★ 5-6: 連續缺好幾個排程時段之後才被叫起來 → 仍然只發一次、日期正確', async () => {
  const { db, user, cleanup } = await seed({ nights: [PRIOR, LAST_NIGHT] });
  try {
    const tg = telegramStub();
    // 模擬 01:00～03:30 每個半小時都沒有人來，04:00 才有一輪
    const late = new Date('2026-09-12T04:00:00.000Z');
    const first = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ, now: late,
    });
    assert.equal(first.status, 'sent');
    // 之後的每一輪都不可以再發
    for (const t of ['2026-09-12T04:30:00.000Z', '2026-09-12T05:00:00.000Z']) {
      const again = await runDaily({
        db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
        now: new Date(t),
      });
      assert.equal(again.status, 'already_sent');
    }
    assert.equal(tg.sent.length, 1, '★ 恰好一則');
  } finally { cleanup(); }
});

test('★★★ 7: not_ready 之後換一個新的 db 連線（重啟）→ 資料到了照樣發', async () => {
  const { db, user, cleanup } = await seed({ nights: [], sentDates: [] });
  try {
    const early = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach,
      telegram: telegramStub(), timezone: TZ, now: new Date('2026-09-11T22:00:00.000Z'),
    });
    assert.equal(early.status, 'not_ready');
    // not_ready 沒有留下任何 report_runs 列 —— 所以重啟不會被舊狀態卡住
    const runs = await db.raw.execute('SELECT COUNT(*) n FROM report_runs');
    assert.equal(Number(runs.rows[0].n), 0, '★ not_ready 不可以寫 report_runs');
    // 資料補進來（等同下一次 sync）
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
              sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
              rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,0,'SCORED',87,?,?,?,?,?,?,?,?)`,
      args: [user.id, 'sX', LAST_NIGHT.hd, LAST_NIGHT.start, LAST_NIGHT.end, 26.16e6,
        13e6, 7e6, 6.16e6, LAST_NIGHT.start, LAST_NIGHT.end, LAST_NIGHT.end,
        JSON.stringify(sleepRaw(LAST_NIGHT, 'sX'))],
    });
    await db.raw.execute({
      sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
              recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
              created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,'SCORED',63,65.5599,54,1,?,?,?,?)`,
      args: [user.id, 'sX', 'cX', LAST_NIGHT.hd, LAST_NIGHT.start, LAST_NIGHT.end,
        LAST_NIGHT.end, JSON.stringify(recRaw('sX'))],
    });
    const tg = telegramStub();
    const later = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date('2026-09-12T03:00:00.000Z'),
    });
    assert.equal(later.status, 'sent');
    assert.equal(later.healthDate, '2026-09-12');
  } finally { cleanup(); }
});

// ===========================================================================
// 8–10 24 小時邊界：丟棄必須是顯著的終局事件
// ===========================================================================

test('★★★ 8: 補發邊界 —— 48 小時（含）可補發，超過就是終局', async () => {
  const end = Date.parse(LAST_NIGHT.end);
  for (const [label, offsetH, wantReady] of [
    ['23.5h (normal)', 23.5, true],
    ['24.5h (late)', 24.5, true],
    ['47h59m59s (late)', 47 + 59 / 60 + 59 / 3600, true],
    ['exactly 48h (late, inclusive)', 48, true],
    ['48h + 1ms (missed)', 48 + 1 / 3_600_000, false],
    ['72h (missed)', 72, false],
  ]) {
    const { db, user, cleanup } = await seed({ nights: [LAST_NIGHT], sentDates: [] });
    try {
      const now = new Date(end + offsetH * 3600_000);
      const { sleeps, recoveries } = await source(db, user.id).poll();
      const wake = detectWake({
        observations: buildObservations({ sleeps, recoveries, timezone: TZ }), now, timezone: TZ,
      });
      assert.equal(wake.ready, wantReady, `★ ${label} ready 應為 ${wantReady}`);
      if (!wantReady) assert.equal(wake.reason, 'sleep_too_old');
    } finally { cleanup(); }
  }
});

test('★★★ 9: 晚了但仍在時限內 → 照發（不是丟掉）', async () => {
  const { db, user, cleanup } = await seed({ nights: [LAST_NIGHT], sentDates: [] });
  try {
    const tg = telegramStub();
    const r = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date(Date.parse(LAST_NIGHT.end) + 20 * 3600_000),
    });
    assert.equal(r.status, 'sent', '★ 晚 20 小時仍然要發');
    assert.equal(tg.sent.length, 1);
  } finally { cleanup(); }
});

test('★★★ 10: 超過 48 小時 → 持久化 MISSED、顯著終局事件、只通知一次', async () => {
  const { db, user, cleanup } = await seed({ nights: [LAST_NIGHT], sentDates: [] });
  try {
    const tg = telegramStub();
    const notices = [];
    tg.notifyError = async (type, msg) => { notices.push({ type, msg }); return true; };
    const now = new Date(Date.parse(LAST_NIGHT.end) + 72 * 3600_000);
    const { result, events } = await captureLogs(() => runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg,
      timezone: TZ, now,
    }));
    assert.equal(result.status, 'missed');
    assert.equal(result.reason, 'sleep_too_old');
    assert.equal(result.retryable, false, '★ 這是終局，不是可重試');

    const term = events.find((e) => e.event === 'daily_discarded_window_expired');
    assert.ok(term, '★ 必須有一條專門的終局事件');
    assert.equal(term.level, 'warn');
    assert.equal(term.fields.terminal, true);
    assert.equal(term.fields.late_window_hours, 48);

    // 持久化的 MISSED
    const evalRow = await db.getBriefingEvaluation(user.id, 'daily');
    assert.equal(evalRow.outcome, 'MISSED');
    assert.equal(evalRow.retryable, false);
    assert.equal(evalRow.targetHealthDate, LAST_NIGHT.hd);

    // 通知恰好一次，而且沒有整份過期報告
    assert.equal(notices.length, 1, '★ 只通知一次');
    assert.match(notices[0].type, /daily_missed_/);
    assert.doesNotMatch(notices[0].msg, /7h16m|63%|66ms/, '★ 不可以倒一份過期的數據');
    assert.equal(tg.sent.length, 0, '★ 不可以送出整份報告');

    // 再跑幾輪都不可以重複通知，也不可以突然發出來
    for (const extra of [73, 74, 80]) {
      await runDaily({
        db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
        now: new Date(Date.parse(LAST_NIGHT.end) + extra * 3600_000),
      });
    }
    assert.equal(notices.length, 1, '★ 每一輪都重複通知就是新的騷擾來源');
    assert.equal(tg.sent.length, 0);
  } finally { cleanup(); }
});

test('★★★ 10b: 補發窗內（24–48h）會送出，而且標示成補發', async () => {
  const { db, user, cleanup } = await seed({ nights: [LAST_NIGHT], sentDates: [] });
  try {
    const tg = telegramStub();
    const r = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date(Date.parse(LAST_NIGHT.end) + 30 * 3600_000),
    });
    assert.equal(r.status, 'sent');
    assert.equal(r.late, true);
    assert.equal(r.healthDate, LAST_NIGHT.hd, '★ 去重鍵仍然是原本的 health_date');
    assert.equal(tg.sent.length, 1, '★ 恰好一則');
    assert.match(tg.sent[0], /補發/, '★ 必須看得出是補發');
    assert.ok(tg.sent[0].includes(LAST_NIGHT.hd), '★ 要顯示是哪一天的報告');
    const evalRow = await db.getBriefingEvaluation(user.id, 'daily');
    assert.equal(evalRow.outcome, 'SENT_LATE');

    // 不可以再送一份「正常版」
    const again = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date(Date.parse(LAST_NIGHT.end) + 31 * 3600_000),
    });
    assert.equal(again.status, 'already_sent');
    assert.equal(tg.sent.length, 1, '★ 正常版與補發版不可以各送一次');
  } finally { cleanup(); }
});

// ===========================================================================
// 11–14 去重 / 併發
// ===========================================================================

test('★★★ 11-13: 前一天已送 ≠ 今天已送；今天沒有假的 SENT 標記', async () => {
  const { db, user, cleanup } = await seed();
  try {
    assert.equal(await db.isSent(user.id, 'daily', '2026-09-11'), true);
    assert.equal(await db.isSent(user.id, 'daily', '2026-09-12'), false, '★ 今天不可以有 SENT');
    const rows = await db.raw.execute(
      "SELECT COUNT(*) n FROM report_runs WHERE local_date='2026-09-12'",
    );
    assert.equal(Number(rows.rows[0].n), 0);
  } finally { cleanup(); }
});

test('★★★ 14: 兩個併發的排程執行 → 只送一則', async () => {
  const { db, user, cleanup } = await seed({ nights: [PRIOR, LAST_NIGHT] });
  try {
    const tg = telegramStub();
    const now = new Date('2026-09-12T03:55:00.000Z');
    const [a, b] = await Promise.all([
      runDaily({ db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ, now }),
      runDaily({ db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ, now }),
    ]);
    assert.equal(tg.sent.length, 1, '★ 恰好一則');
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses.includes('sent'), '★ 一個成功');
    assert.ok(statuses.filter((s) => s === 'sent').length === 1, '★ 只有一個宣稱送出');
  } finally { cleanup(); }
});

// ===========================================================================
// 15–16 送出失敗 / 收據寫失敗
// ===========================================================================

test('★★★ 15: Telegram 失敗 → 記 FAILED、釋放 claim、下一輪可以重試', async () => {
  const { db, user, cleanup } = await seed({ nights: [PRIOR, LAST_NIGHT] });
  try {
    const now = new Date('2026-09-12T03:55:00.000Z');
    const bad = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach,
      telegram: telegramStub({ fail: true }), timezone: TZ, now,
    });
    assert.ok(['telegram_failed'].includes(bad.status), `★ 得到 ${bad.status}`);
    assert.equal(await db.isSent(user.id, 'daily', '2026-09-12'), false, '★ 不可以標成已送');
    // 下一輪重試會成功
    const tg = telegramStub();
    const good = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date('2026-09-12T04:25:00.000Z'),
    });
    assert.equal(good.status, 'sent', '★ 重試要能成功');
    assert.equal(tg.sent.length, 1);
  } finally { cleanup(); }
});

test('★★★ 16: 收據寫入失敗 → 已送出的事實仍然釘在 claim 上', async () => {
  const { db, user, cleanup } = await seed({ nights: [PRIOR, LAST_NIGHT] });
  try {
    const tg = telegramStub();
    const origRecord = db.recordRun;
    db.recordRun = async (args, opts) => {
      if (args.status === 'SENT') throw new Error('turso down');
      return origRecord(args, opts);
    };
    const r = await runDaily({
      db, userId: user.id, source: source(db, user.id), coach, telegram: tg, timezone: TZ,
      now: new Date('2026-09-12T03:55:00.000Z'),
    });
    db.recordRun = origRecord;
    assert.equal(r.status, 'sent');
    assert.equal(r.recorded, false, '★ 要老實說收據沒寫進去');
    const claim = await db.raw.execute(
      "SELECT telegram_sent_at FROM report_claims WHERE local_date='2026-09-12'",
    );
    assert.ok(claim.rows[0]?.telegram_sent_at, '★ claim 必須留著「已送出」的證據');
  } finally { cleanup(); }
});

// ===========================================================================
// 17–19 heartbeat 與看門狗獨立性
// ===========================================================================

test('★★★ 17: heartbeat 過期 → 狀態直接說「排程沒在跑」，而且不承諾時間', async () => {
  const { db, user, cleanup } = await seed({
    nights: [PRIOR, LAST_NIGHT], sentDates: ['2026-09-11'],
    heartbeatAt: '2026-09-12T00:54:49.260Z',
  });
  try {
    // 主要排程 3 小時、備用排程 13 小時都已超過各自的角色門檻。
    const now = new Date('2026-09-12T03:55:00.000Z');
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.GITHUB, {
      detail: 'outcome=completed;users=1', now: new Date(now.getTime() - 13 * 60 * 60_000),
    });
    const { status, evidence } = await assessBriefingStatus({ db, userId: user.id, timezone: TZ, now });
    assert.equal(evidence.scheduler_stale, true);
    assert.equal(status, BRIEFING_STATUS.SCHEDULER_STALE);
    const reply = renderBriefingStatus({ status, evidence });
    assert.match(reply, /排程/, '★ 要指出是排程沒跑');
    assert.match(reply, /問題不在你的資料/, '★ 要讓使用者知道不是他的資料有問題');
    assert.doesNotMatch(reply, /下一次檢查就會|後續排程成功檢查/, '★ 排程掛著時不可以承諾下一輪');
    assert.doesNotMatch(reply, /分鐘後|小時後|馬上/, '★ 不可以給時間承諾');
  } finally { cleanup(); }
});

test('★★★ 18: heartbeat 新鮮時才能提下一輪，而且只能用條件句', async () => {
  const { db, user, cleanup } = await seed({
    nights: [PRIOR, LAST_NIGHT], sentDates: ['2026-09-11'],
    heartbeatAt: '2026-09-12T03:40:00.000Z',
  });
  try {
    const now = new Date('2026-09-12T03:55:00.000Z');
    const { status, evidence } = await assessBriefingStatus({ db, userId: user.id, timezone: TZ, now });
    assert.equal(evidence.scheduler_stale, false);
    assert.equal(status, BRIEFING_STATUS.READY_NOT_YET_PROCESSED);
    const reply = renderBriefingStatus({ status, evidence });
    // ★ 心跳只證明上一輪跑完，證明不了下一輪會發生 —— 一律條件句。
    assert.match(reply, /後續排程成功檢查/);
    assert.doesNotMatch(reply, /下一次檢查就會發|馬上|立刻/, '★ 不可以給保證');
  } finally { cleanup(); }
});

test('★★★ 18b: 看門狗的循環依賴 —— 狀態評估本身完全不依賴排程器執行', async () => {
  // 從來沒有 heartbeat（排程器從未跑完一輪）也必須答得出話。
  const { db, user, cleanup } = await seed({ heartbeatAt: null, sentDates: [] });
  try {
    const { status, evidence } = await assessBriefingStatus({
      db, userId: user.id, timezone: TZ, now: new Date('2026-09-12T03:55:00.000Z'),
    });
    assert.equal(evidence.scheduler_last_ok_at, null);
    assert.equal(evidence.scheduler_stale, null, '★ 沒有證據時不可以假裝知道');
    const reply = renderBriefingStatus({ status, evidence });
    assert.ok(reply.length > 10, '★ 仍然要給得出答案');
    // 條件句（「後續排程成功檢查之後」）是核可的措辭 —— 它沒有承諾時間。
    // 要擋的是無條件承諾。
    assert.doesNotMatch(reply, /下一次檢查就會發|馬上|立刻|分鐘後|小時後/, '★ 不可以給時間承諾');
  } finally { cleanup(); }
});

test('★★★ 19: 狀態評估是唯讀的 —— 不寫入任何表', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const before = {};
    for (const t of ['report_runs', 'report_claims', 'system_heartbeats', 'whoop_sleeps',
      'whoop_recoveries', 'journal_events']) {
      before[t] = Number((await db.raw.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n);
    }
    await assessBriefingStatus({
      db, userId: user.id, timezone: TZ, now: new Date('2026-09-12T03:55:00.000Z'),
    });
    for (const [t, n] of Object.entries(before)) {
      const after = Number((await db.raw.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n);
      assert.equal(after, n, `★ ${t} 不可以被診斷改變`);
    }
    const hb = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
    assert.equal(hb.lastOkAt, ONLY_RUN, '★ heartbeat 也不可以被碰');
  } finally { cleanup(); }
});

// ===========================================================================
// 20 使用者提問
// ===========================================================================

test('★★★ 20: 「今天的晨報呢？」四種問法都走 briefing_status，不撞既有意圖', () => {
  for (const q of ['今天為什麼沒有 briefing？', '今天的晨報呢？', '起床報告怎麼沒來？',
    'briefing 有跑嗎？', '今天的簡報發了嗎']) {
    assert.equal(deterministicIntent(q)?.intent, 'briefing_status', `★ ${q}`);
  }
  // 不可以偷走既有路徑
  for (const [q, want] of [['WHOOP 有同步成功嗎', 'sync_status'],
    ['今天的資料同步了嗎', 'sync_status'], ['因為數據不夠嗎', 'readiness_query'],
    ['我今天狀態怎樣', 'today_status'], ['為什麼我那麼累', 'cause_query']]) {
    assert.equal(deterministicIntent(q)?.intent, want, `★ ${q} 必須維持 ${want}`);
  }
});

test('★★★ 20b: 端到端 —— 事故當下問「今天的晨報呢？」得到誠實答案', async () => {
  const { db, user, cleanup } = await seed({
    nights: [PRIOR], sentDates: ['2026-09-11'], heartbeatAt: ONLY_RUN, openCycle: true,
  });
  try {
    const now = new Date('2026-09-12T03:55:00.000Z');
    const router = createRouter({
      db,
      coachFor: () => ({ async json() { return null; }, async ask() { return 'x'; } }),
      now: () => now,
    });
    const reply = await router.handle({
      text: '今天的晨報呢？', chatId: '5001', user: { id: user.id, timezone: TZ },
    });
    assert.ok(reply.length > 20, '★ 要有實質回答');
    assert.doesNotMatch(reply, /我不太確定你想問什麼/, '★ 不可以回指令清單');
    assert.doesNotMatch(reply, /已經發出來/, '★ 不可以謊稱已送出');
    // 不洩漏內部診斷
    for (const leak of ['heartbeat', 'cron', 'report_runs', 'capability', 'backfill',
      'detectWake', 'health_date', 'sleep_too_old']) {
      assert.ok(!reply.includes(leak), `★ 不可以洩漏「${leak}」`);
    }
  } finally { cleanup(); }
});

// ===========================================================================
// 21 時區邊界
// ===========================================================================

test('★★★ 21: 同一個 UTC 瞬間，台北與胡志明市的「今天」可能不同', async () => {
  // UTC 2026-09-11T16:30 = 台北 09-12 00:30，胡志明市 09-11 23:30
  const now = new Date('2026-09-11T16:30:00.000Z');
  for (const [tz, wantToday] of [['Asia/Taipei', '2026-09-12'], ['Asia/Ho_Chi_Minh', '2026-09-11']]) {
    const { db, user, cleanup } = await seed({ nights: [PRIOR], sentDates: [], heartbeatAt: null });
    try {
      const { evidence } = await assessBriefingStatus({ db, userId: user.id, timezone: tz, now });
      assert.equal(evidence.today, wantToday, `★ ${tz} 的今天應為 ${wantToday}`);
      assert.equal(evidence.timezone, tz);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// 22 判定表（純函式，把每一種組合釘住）
// ===========================================================================

test('★★★ 22: decide() 判定表', () => {
  const base = {
    today: '2026-09-12', yesterday: '2026-09-11', sent_today: false, sent_yesterday: true,
    scheduler_stale: false, observation_health_date: '2026-09-11', wake_reason: null,
  };
  const D = BRIEFING_STATUS;
  assert.equal(decide({ ...base, sent_today: true }), D.DELIVERED);
  assert.equal(decide({ ...base, wake_reason: 'no_main_sleep' }), D.WAITING_FOR_SLEEP_DATA);
  assert.equal(decide({ ...base, wake_reason: 'sleep_not_scored' }), D.WAITING_FOR_SCORING);
  assert.equal(decide({ ...base, wake_reason: 'recovery_missing' }), D.WAITING_FOR_SCORING);
  assert.equal(decide({ ...base, wake_reason: 'recovery_not_scored' }), D.WAITING_FOR_SCORING);
  assert.equal(decide({ ...base, wake_reason: 'too_soon' }), D.TOO_SOON_AFTER_WAKE);
  // 舊觀測過期、而且那一天已經送過 → 使用者在等今晚的，不是等一份過期報告
  assert.equal(decide({ ...base, wake_reason: 'sleep_too_old' }), D.WAITING_FOR_SLEEP_DATA);
  // 今天的觀測自己過期且沒送過 → 真的是時限到了
  assert.equal(decide({
    ...base, wake_reason: 'sleep_too_old', observation_health_date: '2026-09-12',
    sent_yesterday: false,
  }), D.WINDOW_EXPIRED);
  // 資料齊了：排程活著 → 等下一輪；排程掛了 → 那才是答案
  // ★ ready 的觀測屬於**已經送出**的前一天（補發窗讓它仍然 ready）
  //   → 使用者真正在等的是今晚的資料。
  assert.equal(decide(base, { ready: true }), D.WAITING_FOR_SLEEP_DATA);
  // 觀測就是今天的 → 真的只差有人去處理
  const todayObs = { ...base, observation_health_date: base.today };
  assert.equal(decide(todayObs, { ready: true }), D.READY_NOT_YET_PROCESSED);
  assert.equal(decide({ ...todayObs, scheduler_stale: true }, { ready: true }), D.SCHEDULER_STALE);
  // 前一天還沒送出 → 那份仍然可以補發，不是在等今晚
  assert.equal(
    decide({ ...base, sent_yesterday: false }, { ready: true }),
    D.READY_NOT_YET_PROCESSED,
  );
  // 什麼都不知道
  assert.equal(decide({ ...base, wake_reason: null }), D.UNKNOWN);
  assert.equal(decide({ ...base, wake_reason: null, scheduler_stale: true }), D.SCHEDULER_STALE);
});
