/**
 * P0 回歸測試：Daily / Weekly 的 AI 敘述必須通過 guardNarrative。
 *
 * 修復前的缺陷：
 *   daily.js  coach.daily()  → renderDaily() → Telegram   （沒有守門）
 *   weekly.js coach.weekly() → renderWeekly() → Telegram  （沒有守門）
 * 只有健康問答（bot/answer.js）有守門，兩份每日／每週報告卻直接把
 * LLM 自由文字送進 Telegram。
 *
 * 修復後：兩條路徑都用**同一個** guardNarrative，evidence context 是
 * buildDailyUserMessage / buildWeeklyUserMessage —— 也就是餵給模型的那份
 * 確定性資料本身（純 Node 計算，不含任何 LLM 產物）。
 *
 * V1.1 契約變更：敘述層恢復了。
 *   · 通過守門的安全敘述 → **會**被發布（模型只負責語氣潤飾）
 *   · 沒通過的 → 整段丟掉，換成**確定性敘述**（不是一句假的故障訊息）
 *   · 不論哪一種，確定性的數據簡報都照常送出，而且絕不再出現
 *     「AI 教練分析今天暫時無法生成」—— 那句話在沒有嘗試生成時是假的。
 *
 * 不呼叫真實 OpenRouter / Telegram / WHOOP —— 全部用既有 fakes。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { localDate, localWeekday } from '../src/time.js';
import { FALLBACK_NOTE } from '../src/format.js';
import { makeDataset } from './fixtures.js';
import { fakeDb, fakeTelegram, fakeCoach } from './fakes.js';

const TZ = 'Asia/Taipei';
const U = 'u-guard-test';

/** 台灣時間週一早上 08:00 的那個 UTC 瞬間（週報要週一才會發）。 */
function mondayMorning() {
  let d = new Date('2026-08-24T00:00:00Z');
  while (localWeekday(localDate(d, TZ)) !== 1) d = new Date(d.getTime() + 86_400_000);
  return d;
}

/** 跑一次 daily，coach 會回傳指定的敘述文字。 */
async function runDailyWith(dailyText, { days = 45 } = {}) {
  const ds = makeDataset({ days });
  const ctx = {
    db: fakeDb(),
    userId: U,
    telegram: fakeTelegram(),
    coach: fakeCoach({ dailyText }),
    source: staticDataSource(ds),
    timezone: TZ,
    now: ds.now,
  };
  const res = await runDaily(ctx);
  return { res, sent: ctx.telegram.sent[0] ?? '', ctx };
}

/** 跑一次 weekly，coach 會回傳指定的敘述文字。 */
async function runWeeklyWith(weeklyText) {
  const now = mondayMorning();
  const ds = makeDataset({ days: 45, now });
  const ctx = {
    db: fakeDb(),
    userId: U,
    telegram: fakeTelegram(),
    coach: fakeCoach({ weeklyText }),
    source: staticDataSource(ds),
    timezone: TZ,
    now,
  };
  const res = await runWeekly(ctx);
  return { res, sent: ctx.telegram.sent[0] ?? '', ctx };
}

/** 被守門丟掉之後該有的樣子：確定性敘述在、假的故障訊息不在。 */
function assertDeterministicNarrative(sent, res) {
  assert.doesNotMatch(sent, /暫時無法生成/, '★ 絕不可以宣稱一個沒發生過的故障');
  assert.equal(res.coachUsed, false, '★ 模型那一段被丟掉了');
  assert.equal(res.narrativeSource, 'deterministic');
  assert.ok(sent.length > 0);
}

/** 報告一定要送出去，而且確定性數據段完整。 */
function assertDeterministicReportIntact(sent, res, kind) {
  assert.equal(res.status, 'sent', `${kind} 報告必須照常送出`);
  assert.ok(sent.length > 0, `${kind} 必須有訊息內容`);
  if (kind === 'daily') {
    assert.match(sent, /早安，Kelvin/, 'daily 標頭要在');
    assert.match(sent, /HRV/, 'daily 數據段要在');
    assert.match(sent, /恢復/, 'daily 恢復要在');
    assert.match(sent, /基準/, 'daily 基準資訊要在');
  } else {
    assert.match(sent, /上週回顧/, 'weekly 標頭要在');
    assert.match(sent, /恢復平均/, 'weekly 數據段要在');
  }
}

// ===========================================================================
// A. 安全的敘述 → 通過守門 → 保留在訊息裡
// ===========================================================================

test('★★★ P0-A daily: 通過守門的安全敘述會被發布（V1.1 契約）', async () => {
  const safe = '早安，今天整體看起來穩定，照平常節奏走就好，記得多補水';
  const { res, sent } = await runDailyWith(safe);
  assertDeterministicReportIntact(sent, res, 'daily');
  assert.ok(sent.includes(safe), '★ 安全的語氣潤飾應該送到使用者手上');
  assert.equal(res.coachUsed, true);
  assert.equal(res.narrativeSource, 'model');
  assert.doesNotMatch(sent, /暫時無法生成/);
});

test('★★★ P0-A weekly: 通過守門的安全敘述會被發布（V1.1 契約）', async () => {
  const safe = '上週整體算穩定，這週把入睡時間再往前拉一點點就好';
  const { res, sent } = await runWeeklyWith(safe);
  assertDeterministicReportIntact(sent, res, 'weekly');
  assert.ok(sent.includes(safe), '★ 安全的語氣潤飾應該送到使用者手上');
  assert.equal(res.coachUsed, true);
});

test('★★★ R3-H-02 daily: 教練文字引述數字 → 丟掉；報告的數字完全不受影響', async () => {
  // R3 之後 LLM 不可以是生理宣稱的來源。renderDaily() 已經把每一個指標、
  // 基準、判定都確定性地印出來了，所以教練那段話一旦引述數字就整段丟掉
  // —— 使用者少的只是一句鼓勵的話，資訊一個字都不會少。
  const quotesNumbers = '早安 Kelvin，今天的恢復 73%，比基準 65% 高一些；HRV 55ms 跟平常差不多 💛';
  const { res, sent } = await runDailyWith(quotesNumbers);

  assertDeterministicReportIntact(sent, res, 'daily');
  assert.ok(!sent.includes(quotesNumbers), '★ 引述數字的教練文字必須被丟掉');
  assertDeterministicNarrative(sent, res);
  assert.match(sent, /恢復 \d+%/, '★ 報告本身的數字必須完整保留');
  assert.match(sent, /HRV \d+ms/);
  assert.equal(res.coachUsed, false);
});

test('★★★ R3-H-02 daily: 不含生理斷言的教練文字會被發布', async () => {
  const clean = '早安 Kelvin，今天整體看起來穩定，照平常節奏走就好，記得多補水 💛';
  const { res, sent } = await runDailyWith(clean);
  assertDeterministicReportIntact(sent, res, 'daily');
  assert.ok(!sent.includes(clean), '看似安全的 provider 敘述也不發布');
  assertDeterministicNarrative(sent, res);
});

test('★★★ R3-H-02 weekly: 教練文字引述數字 → 丟掉；週回顧的數字不受影響', async () => {
  const quotesNumbers = '上週恢復平均 65%，比前週低 2%；HRV 55ms 與前週差不多。';
  const { res, sent } = await runWeeklyWith(quotesNumbers);
  assertDeterministicReportIntact(sent, res, 'weekly');
  assert.ok(!sent.includes(quotesNumbers), '★ 引述數字的教練文字必須被丟掉');
  assert.match(sent, /恢復平均/, '★ 週回顧的數據段必須完整保留');
});

test('★★★ R3-H-02 weekly: 不含生理斷言的教練文字會被發布', async () => {
  const clean = '上週整體算穩定，這週我們把入睡時間再往前拉一點點就好 💪';
  const { res, sent } = await runWeeklyWith(clean);
  assertDeterministicReportIntact(sent, res, 'weekly');
  assert.ok(sent.includes(clean), '★ 不含生理斷言的語氣潤飾應該送到使用者手上');
  assert.equal(res.coachUsed, true);
});

// ===========================================================================
// B. 捏造的、沒有出處的數字 → 擋下
// ===========================================================================

test('★ P0-B daily: 捏造的數字（HRV 999ms）被擋下，不會進 Telegram', async () => {
  const bad = '早安 Kelvin，你今天的 HRV 是 999ms，比平常高很多喔！';
  const { res, sent } = await runDailyWith(bad);

  assert.ok(!sent.includes('999'), '★ 捏造的數字絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad), '★ 有問題的原文整段都不可以出現');
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'daily');
  assert.equal(res.coachUsed, false, '守門擋下後視為沒有教練文字');
});

test('★ P0-B weekly: 捏造的數字被擋下', async () => {
  const bad = '上週你的恢復平均是 999%，非常驚人。';
  const { res, sent } = await runWeeklyWith(bad);

  assert.ok(!sent.includes('999'), '★ 捏造的數字絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'weekly');
});

// ===========================================================================
// C. 醫學診斷措辭 → 擋下
// ===========================================================================

test('★ P0-C daily: 診斷措辭被擋下', async () => {
  const bad = '早安 Kelvin，看這個趨勢你可能得了感冒，要多休息。';
  const { res, sent } = await runDailyWith(bad);

  assert.ok(!sent.includes('得了感冒'), '★ 診斷措辭絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'daily');
});

test('★ P0-C weekly: 診斷措辭被擋下', async () => {
  const bad = '上週的數字顯示你可能得了某種感染，建議就醫。';
  const { res, sent } = await runWeeklyWith(bad);

  assert.ok(!sent.includes(bad), '★ 診斷措辭絕不可以送到 Telegram');
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'weekly');
});

// ===========================================================================
// D. 強因果宣稱 → 擋下
// ===========================================================================

test('★ P0-D daily: 強因果語言被擋下', async () => {
  const bad = '早安 Kelvin，這一定是因為你昨天熬夜導致的，證明晚睡會害你恢復變差。';
  const { res, sent } = await runDailyWith(bad);

  assert.ok(!sent.includes('導致'), '★ 因果宣稱絕不可以送到 Telegram');
  assert.ok(!sent.includes('證明'));
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'daily');
});

test('★ P0-D weekly: 強因果語言被擋下', async () => {
  const bad = '上週的訓練造成你的恢復下降，這證明了你需要減量。';
  const { res, sent } = await runWeeklyWith(bad);

  assert.ok(!sent.includes('造成'), '★ 因果宣稱絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'weekly');
});

// ===========================================================================
// E. 假造的「即時／現在」生理宣稱 → 擋下
//    （WHOOP Developer API v2 沒有即時生理 endpoint，這種話必然是編的）
// ===========================================================================

test('★ P0-E daily: 宣稱即時心率被擋下', async () => {
  const bad = '早安 Kelvin，你現在的心率看起來偏高，先深呼吸一下。';
  const { res, sent } = await runDailyWith(bad);

  assert.ok(!sent.includes('現在的心率'), '★ 假造的即時生理宣稱絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'daily');
});

test('★ P0-E weekly: 宣稱即時監測被擋下', async () => {
  const bad = '我從即時心率看到你這週壓力偏高。';
  const { res, sent } = await runWeeklyWith(bad);

  assert.ok(!sent.includes('即時心率'), '★ 假造的即時生理宣稱絕不可以送到 Telegram');
  assert.ok(!sent.includes(bad));
  assertDeterministicNarrative(sent, res);
  assertDeterministicReportIntact(sent, res, 'weekly');
});

// ===========================================================================
// F. 守門失敗不可以阻擋確定性報告本身
// ===========================================================================

test('★ P0-F daily: 守門擋下敘述後，確定性簡報仍完整送出並寫入 SENT', async () => {
  const bad = '你的 HRV 現在是 999ms，這一定是因為你生病了，你可能得了流感。';
  const { res, sent, ctx } = await runDailyWith(bad);

  assert.equal(res.status, 'sent', '★ 守門失敗不可以讓簡報發不出去');
  assert.equal(ctx.telegram.sent.length, 1, '訊息只送一則');

  // 完整的確定性內容都還在
  assert.match(sent, /早安，Kelvin/);
  assert.match(sent, /HRV \d+ms/, '真實的 HRV 數值仍然照常顯示');
  assert.match(sent, /💓 靜息心率/);
  assert.match(sent, /🌙 睡眠/);
  assert.match(sent, /基準 30\/30 筆/);
  assertDeterministicNarrative(sent, res);

  // 捏造內容一個字都沒進去
  assert.ok(!sent.includes('999'));
  assert.ok(!sent.includes('流感'));

  // DB 仍然記 SENT
  const run = ctx.db.runs.find((r) => r.reportType === 'daily' && r.status === 'SENT');
  assert.ok(run, '★ 必須有 SENT 紀錄（去重仍然有效）');
  assert.match(String(run.detail), /narrative=deterministic;reason=/, '★ 記下失敗分類');
});

test('★ P0-F weekly: 守門擋下敘述後，週回顧仍完整送出並寫入 SENT', async () => {
  const bad = '上週恢復平均 999%，你現在的心率也很奇怪，這證明你生病了。';
  const { res, sent, ctx } = await runWeeklyWith(bad);

  assert.equal(res.status, 'sent', '★ 守門失敗不可以讓週回顧發不出去');
  assert.equal(ctx.telegram.sent.length, 1);

  assert.match(sent, /上週回顧/);
  assert.match(sent, /💪 恢復平均/);
  assert.match(sent, /❤️ HRV/);
  assertDeterministicNarrative(sent, res);
  assert.ok(!sent.includes('999'));

  const run = ctx.db.runs.find((r) => r.reportType === 'weekly' && r.status === 'SENT');
  assert.ok(run, '★ 必須有 SENT 紀錄');
  assert.match(String(run.detail), /narrative=deterministic;reason=/);
});

// ===========================================================================
// 既有行為不可退化
// ===========================================================================

test('P0: LLM 本來就掛掉（回 null）時行為與修復前相同', async () => {
  const ds = makeDataset({ days: 45 });
  const ctx = {
    db: fakeDb(),
    userId: U,
    telegram: fakeTelegram(),
    coach: fakeCoach({ fail: true }),   // daily() 回 null
    source: staticDataSource(ds),
    timezone: TZ,
    now: ds.now,
  };
  const res = await runDaily(ctx);
  assert.equal(res.status, 'sent');
  assertDeterministicNarrative(ctx.telegram.sent[0], res);
  assert.match(ctx.telegram.sent[0], /HRV/);
});

test('P0: 守門用的 context 只含確定性資料（不含任何 LLM 產物）', async () => {
  // buildDailyUserMessage 只吃 briefing（Node 算出來的），所以同一份 briefing
  // 不論 LLM 回什麼，context 都完全一樣 —— 守門的基準不會被模型污染。
  const { buildDailyUserMessage } = await import('../src/coach.js');
  const { buildBriefing } = await import('../src/daily.js');
  const ds = makeDataset({ days: 45 });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const a = buildDailyUserMessage(briefing);
  const b = buildDailyUserMessage(briefing);
  assert.equal(a, b, 'context 必須是確定性的');
  assert.ok(a.includes('今日指標（程式已判定）'), 'context 是那份算好的資料');
  assert.doesNotMatch(a, /暫時無法生成/);
});
