/**
 * 對話式健康問答（生產事故修復）。
 *
 * 事故當時的三輪對話：
 *
 *   使用者：我怎麼感覺那麼累 是因為剛剛也喝酒嗎
 *   Bot  ：✅ 已記錄：alcohol（2026-09-11）          ← 問題被丟掉
 *
 *   使用者：為什麼我那麼累
 *   Bot  ：今天沒有特別值得注意的變化。               ← 把「沒偵測到」講成「你沒事」
 *
 *   使用者：因為數據不夠嗎
 *   Bot  ：（一整塊內部診斷：涵蓋率、各資源筆數、capability probe、backfill）
 *
 * 三個根因分別是：複合語句只執行了記錄、主觀症狀被分到 what_changed、
 * 對話句撞到 data_status。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { deterministicIntent } from '../src/bot/intent.js';
import { looksLikeQuestion, mentionsLoggableEvent } from '../src/bot/conversation.js';
import { createUpdateProcessor, UPDATE_OUTCOME } from '../src/bot/updateProcessor.js';
import { createSendReply } from '../src/bot/index.js';
import { createHealthQuery } from '../src/healthQuery.js';

const NOW = new Date('2026-09-11T09:05:00Z');   // Asia/Taipei 17:05
const HD = '2026-09-11';
const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * @param days 要塞幾天的歷史（1 = 只有今天，基準絕對不足）
 * @param calibrating 今天的 recovery 是否在校正期
 */
async function seed({ days = 1, calibrating = true } = {}) {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'Kelvin', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });
  const L = 13_000_000; const S = 7_000_000; const R = 6_160_000;
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.parse(`${HD}T00:00:00Z`) - i * 86_400_000);
    const hd = date.toISOString().slice(0, 10);
    const end = new Date(date.getTime() + 16 * 60_000).toISOString();
    const start = new Date(date.getTime() - 7 * 3600_000).toISOString();
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
              sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
              rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,0,'SCORED',87,?,?,?,?,?,?,?,?)`,
      args: [u.id, `s-${i}`, hd, start, end, L + S + R, L, S, R, start, end, end,
        JSON.stringify({
          id: `s-${i}`,
          score_state: 'SCORED',
          score: {
            sleep_performance_percentage: 87,
            respiratory_rate: 16.2,
            stage_summary: {
              total_light_sleep_time_milli: L, total_slow_wave_sleep_time_milli: S,
              total_rem_sleep_time_milli: R, total_awake_time_milli: 900000,
              total_in_bed_time_milli: L + S + R + 900000,
              disturbance_count: 9, sleep_cycle_count: 5,
            },
            sleep_needed: { baseline_milli: 28000000, need_from_sleep_debt_milli: 600000 },
          },
          start, end, nap: false,
        })],
    });
    await db.raw.execute({
      sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
              recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
              created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,'SCORED',63,65.5599,54,?,?,?,?,?)`,
      args: [u.id, `s-${i}`, `c-${i}`, hd, calibrating ? 1 : 0, start, end, end,
        JSON.stringify({
          cycle_id: `c-${i}`, sleep_id: `s-${i}`, score_state: 'SCORED',
          score: {
            recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54,
            user_calibrating: calibrating,
          },
        })],
    });
  }
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

/** coach.json 回一個 alcohol 解析（journal 用），ask 不會被用到。 */
const alcoholCoach = () => ({
  async json() {
    // 模擬「剛剛喝酒」：解析器明確認出是當下的事，時間精確度才可信。
    return {
      category: 'alcohol', subtype: null, numeric_value: null, unit: null, confidence: 0.9,
      asserted: true, about_self: true, negated: false, hypothetical: false,
      time_precision: 'now',
    };
  },
  async ask() { return 'x'; },
});

const makeBot = (db, user, coachFor = alcoholCoach) => {
  const router = createRouter({ db, coachFor, now: () => NOW });
  return (text) => router.handle({ text, chatId: '5001', user: { id: user.id, timezone: TZ } });
};

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-08-01', to: '2026-10-01', limit: 200,
})).length;

const tgUpdate = (updateId, text, chatId = 5001) => ({
  update_id: updateId,
  message: {
    message_id: updateId, chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false }, text, date: 1,
  },
});

/**
 * 走**真正的**耐久邊界：telegram_updates 收據 → 對話通道 → 路由 → 送達狀態。
 *
 * 冪等的證據必須在這一層取得。只呼叫 router.handle() 完全繞過收據，那樣的
 * 測試不論寫得多嚴格，都證明不了生產環境裡「Telegram 重送同一則 update」
 * 會發生什麼事。
 *
 * ⚠️ 任何延遲都只能放在 coach 裡，不可以放進 handleMessage —— 後者持有寫入
 * 交易，在交易裡等網路是生產環境不存在的情況，本機 SQLite 會直接 BUSY。
 */
function makeProcessor(db, sent, { workerId = 'instance-1' } = {}) {
  let nextMessageId = 7000;
  const api = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      nextMessageId += 1;
      return { message_id: nextMessageId };
    },
  };
  const router = createRouter({ db, coachFor: alcoholCoach, now: () => NOW });
  const processor = createUpdateProcessor({
    db,
    resolveUser: async (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: async (m) => router.handle({ text: m.text, chatId: m.chatId, user: m.user }),
    handleUnlinked: async () => null,
    sendReply: createSendReply({ db, api }),
    workerId,
    now: () => NOW,
    sleepImpl: async () => {},
  });
  return { processor, api };
}

/** 絕不可以出現在對話裡的內部診斷用語。 */
const DIAGNOSTIC_LEAK = [
  'capability', 'backfill', 'probe', 'schema', 'resource', 'endpoint',
  '涵蓋率', '資料品質', 'SUPPORTED', 'UNAVAILABLE', 'whoop_sleeps', 'journal_events',
];
function assertNoDiagnosticLeak(reply, label) {
  for (const term of DIAGNOSTIC_LEAK) {
    assert.ok(!reply.includes(term), `★ ${label} 不可以洩漏內部診斷字樣「${term}」`);
  }
}

// ===========================================================================
// CASE 1 — 複合語句：記錄 + 提問
// ===========================================================================

test('★★★ CASE 1: 複合語句兩件事都要做，確認不可以取代回答', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await makeBot(db, user)('我怎麼感覺那麼累 是因為剛剛也喝酒嗎');

    assert.equal(await journalCount(db, user.id), 1, '★ journal 恰好寫一次');
    assert.ok(reply.length > 60, '★ 回覆不可以只是一句「已記錄」');
    assert.ok(!/^✅[^\n]*$/.test(reply.trim()), '★ 不可以只有確認行');
    assert.match(reply, /累/, '★ 必須回應「累」這個問題');
    // 可能的因素，不是證明
    assert.match(reply, /可能/, '★ 酒精只能講成可能');
    // 只抓「肯定式」的因果宣稱。「還不足以確認…」是相反的意思，不該被誤判。
    assert.ok(!/(就是|確定是|證實是|一定是|可以證明)[^。]{0,8}(酒|喝|造成|導致)/.test(reply),
      '★ 不可以宣稱因果');
    // 時序限制
    assert.match(reply, /睡眠期間|之前/, '★ 要說明測量時間早於剛剛那件事');
    assertNoDiagnosticLeak(reply, 'CASE 1');
  } finally { cleanup(); }
});

test('★★★ CASE 1b: 泛化到非酒精的複合語句', async () => {
  for (const q of ['我昨晚熬夜，為什麼今天這麼累？', '我今天壓力很大，會影響 HRV 嗎？']) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await makeBot(db, user)(q);
      assert.ok(!/^✅[^\n]*$/.test(reply.trim()), `★ ${q} 不可以只回確認行`);
      assert.ok(reply.length > 40, `★ ${q} 必須有實際回答`);
      assertNoDiagnosticLeak(reply, q);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// CASE 2 — 疲勞 + 歷史不足
// ===========================================================================

test('★★★ CASE 2: 歷史不足時不可以說「沒有特別值得注意的變化」', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await makeBot(db, user)('為什麼我那麼累');

    assert.ok(!reply.includes('今天沒有特別值得注意的變化'),
      '★ 這句話把「我們沒偵測到」偷換成「你沒事」');
    assert.match(reply, /無法確定|沒辦法判斷|不夠/, '★ 要誠實說判斷不出來');
    // 同樣只抓肯定式的「你沒事」，不要被「不是判斷你的身體沒有狀況」這種否定句誤傷。
    assert.ok(!/(你沒事|一切正常|身體沒問題|沒什麼好擔心)(?![^。]*不)/.test(reply),
      '★ 不可以暗示使用者其實不累');
    assert.ok(!/等.*同步/.test(reply), '★ 不可以推給同步');
    assertNoDiagnosticLeak(reply, 'CASE 2');
  } finally { cleanup(); }
});

test('★★★ CASE 2b: 當下的事實仍然看得到（與分析成熟度分開）', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await makeBot(db, user)('為什麼我那麼累');
    assert.match(reply, /7h16m|睡眠/, '★ 當下的睡眠事實要講');
    assert.match(reply, /66ms|HRV/, '★ 校正期中 HRV 事實仍然可見');
  } finally { cleanup(); }
});

// ===========================================================================
// CASE 3 — 對話式追問（成熟度）
// ===========================================================================

test('★★★ CASE 3: 「因為數據不夠嗎」得到對話式說明，不是診斷區塊', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const bot = makeBot(db, user);
    await bot('為什麼我那麼累');
    const reply = await bot('因為數據不夠嗎');

    assert.equal(deterministicIntent('因為數據不夠嗎')?.intent, 'readiness_query');
    assert.match(reply, /^對|主要就是/, '★ 要直接回答「是」');
    assert.match(reply, /基準|歷史|累積/, '★ 要用人話解釋限制');
    assertNoDiagnosticLeak(reply, 'CASE 3');
    assert.ok(reply.length < 400, '★ 要簡潔，不是報表');
  } finally { cleanup(); }
});

test('★★★ CASE 3b: 不可以憑空發明門檻天數', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await makeBot(db, user)('因為數據不夠嗎');
    // 只能引用產品既有的 ANALYTICS.MIN_SAMPLES，不可以出現別的數字當門檻
    const nums = [...reply.matchAll(/(\d+)\s*天/g)].map((m) => Number(m[1]));
    for (const n of nums) {
      assert.ok([1, 5].includes(n), `★ 出現了沒有來源的天數 ${n}`);
    }
  } finally { cleanup(); }
});

test('★★ CASE 3c: 其他成熟度問法也不會掉進診斷', async () => {
  for (const q of ['我的資料夠嗎', '是不是因為資料還太少', '所以你現在還判斷不出來嗎']) {
    const { db, user, cleanup } = await seed({ days: 1 });
    try {
      const reply = await makeBot(db, user)(q);
      assertNoDiagnosticLeak(reply, q);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// CASE 4 — 明確診斷指令仍然可用
// ===========================================================================

test('★★★ CASE 4: /healthdata 仍然給得出完整診斷', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await makeBot(db, user)('/healthdata');
    assert.ok(reply.length > 100, '★ 明確指令要保留完整診斷');
    assert.match(reply, /資料|WHOOP/, '★ 應該是資料狀態報告');
  } finally { cleanup(); }
});

// ===========================================================================
// CASE 5 — 有足夠歷史時的推理
// ===========================================================================

test('★★★ CASE 5: 有足夠可比較歷史時，可以跟基準比較', async () => {
  const { db, user, cleanup } = await seed({ days: 20, calibrating: false });
  try {
    const reply = await makeBot(db, user)('為什麼我那麼累');
    assert.match(reply, /平常/, '★ 要跟個人基準比較');
    assert.ok(!/證明|就是因為/.test(reply), '★ 仍然不可以宣稱因果');
    assert.ok(!reply.includes('今天沒有特別值得注意的變化'));
    assertNoDiagnosticLeak(reply, 'CASE 5');
  } finally { cleanup(); }
});

// ===========================================================================
// CASE 6 — 有當下事實但校正期限制分析
// ===========================================================================

test('★★★ CASE 6: 校正期 → 值看得到、但不過度解讀，也不說同步失敗', async () => {
  const { db, user, cleanup } = await seed({ days: 1, calibrating: true });
  try {
    const reply = await makeBot(db, user)('為什麼我那麼累');
    assert.match(reply, /66ms|54bpm|63%/, '★ 當下的值要看得到');
    assert.ok(!/沒有.*資料|拿不到/.test(reply), '★ 不可以說這些值不存在');
    assert.match(reply, /合格歷史|個人基準|校正期/, '★ 限制要說成基準不足或校正期');
    assert.ok(!/等.*同步/.test(reply), '★ 不可以說是同步問題');
  } finally { cleanup(); }
});

// ===========================================================================
// CASE 7 — 重播與冪等（走真正的耐久邊界）
// ===========================================================================
//
// ⚠️ 這一組刻意**不**用 `after <= before + 1` 這種寫法。
//
// 那個斷言宣稱「重複輸入不會寫出第二筆」，但它同時允許 before=1 → after=2，
// 也就是它允許它自己宣稱禁止的那件事。獨立稽核實際觀察到第 1 筆與第 2 筆，
// 測試卻是綠的。任何「允許自己所禁止之事」的斷言都比沒有斷言更糟：它會
// 買下一份不存在的保證。
//
// 這裡改成精確計數，而且分清楚兩種語義：
//
//   (a) **同一個 update_id 重播** —— Telegram 在沒收到 ack 時會重送同一則
//       update。這必須是嚴格冪等：一筆 journal、一則回覆，結果是 REPLAYED。
//       擋下它的是 telegram_operations 收據，不是任何啟發式判斷。
//
//   (b) **不同 update_id、同樣的字** —— 這是使用者真的又講了一次。系統
//       無法、也不應該假裝這不是新的一則訊息：「我剛剛喝酒了」講兩次，
//       第二次很可能就是第二杯。靜靜地丟掉它會竄改使用者自己陳述的事實。
//       所以它**會**寫出第二筆 —— 這是行為的真相，測試如實記下來。
//
//       重複不會變成分析上的誤導，靠的是另一道防線（Repair 8）：可能因素
//       在彙整時依類別去重，所以同一類別出現兩筆不會放大任何信心。
//       下面的 7c 同時驗這一點。

test('★★★ CASE 7a: 重播同一個 update_id → 恰好一筆 journal、恰好一則回覆', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const sent = [];
    const { processor } = makeProcessor(db, sent);
    const update = tgUpdate(9001, '我怎麼感覺那麼累 是因為剛剛也喝酒嗎');

    const first = await processor.processUpdate(update);
    assert.equal(first.outcome, UPDATE_OUTCOME.PROCESSED, '★ 第一次必須真的處理');
    assert.equal(await journalCount(db, user.id), 1, '★ 第一次寫入恰好一筆');
    assert.equal(sent.length, 1, '★ 第一次送出恰好一則');

    const replay = await processor.processUpdate(update);
    assert.equal(replay.outcome, UPDATE_OUTCOME.REPLAYED, '★ 重播必須被認出來');
    assert.equal(await journalCount(db, user.id), 1, '★ 重播後仍然恰好一筆（不是「至多兩筆」）');
    assert.equal(sent.length, 1, '★ 重播不可以再送一則回覆');

    // 連續重播（Telegram 會重送多次）也一樣。
    for (let i = 0; i < 3; i += 1) {
      const again = await processor.processUpdate(update);
      assert.equal(again.outcome, UPDATE_OUTCOME.REPLAYED);
    }
    assert.equal(await journalCount(db, user.id), 1, '★ 多次重播仍然恰好一筆');
    assert.equal(sent.length, 1, '★ 多次重播仍然恰好一則回覆');
  } finally { cleanup(); }
});

test('★★★ CASE 7b: 跨 processor 實例重播（另一個 Render 實例）也不重複', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const sent = [];
    const a = makeProcessor(db, sent, { workerId: 'instance-1' }).processor;
    const b = makeProcessor(db, sent, { workerId: 'instance-2' }).processor;
    const update = tgUpdate(9002, '我剛剛喝酒了，為什麼這麼累？');

    assert.equal((await a.processUpdate(update)).outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal((await b.processUpdate(update)).outcome, UPDATE_OUTCOME.REPLAYED,
      '★ 收據是耐久的，換一個實例也認得');
    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一筆');
    assert.equal(sent.length, 1, '★ 恰好一則回覆');
  } finally { cleanup(); }
});

test('★★★ CASE 7c: 不同 update_id、同樣的字 → 兩則都被處理、兩筆事實，但分析不被放大', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const sent = [];
    const { processor } = makeProcessor(db, sent);
    const text = '我怎麼感覺那麼累 是因為剛剛也喝酒嗎';

    const r1 = await processor.processUpdate(tgUpdate(9101, text));
    const r2 = await processor.processUpdate(tgUpdate(9102, text));

    // 使用者真的講了兩次 —— 兩則都是新訊息，都必須得到答覆。
    assert.equal(r1.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(r2.outcome, UPDATE_OUTCOME.PROCESSED, '★ 新的 update 不可以被當成重播吞掉');
    assert.equal(sent.length, 2, '★ 兩則訊息恰好兩則回覆');

    // 兩次陳述 = 兩筆事實。系統不替使用者判斷第二句是不是「講錯了」。
    assert.equal(await journalCount(db, user.id), 2,
      '★ 兩個不同的 update 恰好兩筆（這是行為的真相，不是冪等）');

    // ★ 但重複不可以放大分析上的信心：可能因素依類別去重。
    const q = createHealthQuery({ db, userId: user.id, timezone: TZ, now: NOW });
    const explained = await q.causeExplanation({});
    assert.equal(explained.contributors.length, 1,
      '★ 同一類別的兩筆事實在分析時只算一個因素');
    assert.equal(explained.contributors[0].category, 'alcohol');
  } finally { cleanup(); }
});

test('★★★ CASE 7d: 併發送出同一個 update → 只有一個成功，恰好一筆一則', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const sent = [];
    const p1 = makeProcessor(db, sent, { workerId: 'same-process' }).processor;
    const p2 = makeProcessor(db, sent, { workerId: 'same-process' }).processor;
    const update = tgUpdate(9201, '我怎麼感覺那麼累 是因為剛剛也喝酒嗎');

    const [r1, r2] = await Promise.all([
      p1.processUpdate(update), p2.processUpdate(update),
    ]);
    const outcomes = [r1.outcome, r2.outcome];
    assert.equal(outcomes.filter((o) => o === UPDATE_OUTCOME.PROCESSED).length, 1,
      '★ 恰好一個宣稱處理完');
    assert.equal(sent.length, 1, '★ 恰好一則回覆');
    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一筆 journal');
  } finally { cleanup(); }
});

// ===========================================================================
// CASE 9 — 口語/無標點變體
// ===========================================================================

test('★★★ CASE 9: 口語與無標點的變體都走對路', () => {
  const expect = {
    我好累是不是剛剛喝酒的關係: 'cause_query',
    喝完酒很累正常嗎: 'cause_query',
    今天怎麼這麼沒精神: 'cause_query',
    是不是因為資料還太少: 'readiness_query',
    所以你現在還判斷不出來嗎: 'readiness_query',
  };
  for (const [q, want] of Object.entries(expect)) {
    assert.equal(deterministicIntent(q)?.intent, want, `★ ${q}`);
  }
});

test('★★★ 問句偵測：「…嗎」結尾算問句，單純回答不算', () => {
  for (const q of ['我怎麼感覺那麼累 是因為剛剛也喝酒嗎', '因為數據不夠嗎', '喝完酒很累正常嗎']) {
    assert.equal(looksLikeQuestion(q), true, `★ ${q} 必須被認成問句`);
  }
  for (const a of ['喝了三杯酒', '沒有', '昨天喝了兩杯']) {
    assert.equal(looksLikeQuestion(a), false, `★ ${a} 是回答不是問句`);
  }
  assert.equal(mentionsLoggableEvent('我怎麼感覺那麼累 是因為剛剛也喝酒嗎'), true);
  assert.equal(mentionsLoggableEvent('為什麼我那麼累'), false);
});

// ===========================================================================
// CASE 10 — 四種狀態不可以塌成同一句
// ===========================================================================

test('★★★ CASE 10: 「沒偏離」與「沒依據」是不同的回答', async () => {
  const rich = await seed({ days: 20, calibrating: false });
  const poor = await seed({ days: 1, calibrating: true });
  try {
    const a = await makeBot(rich.db, rich.user)('為什麼我那麼累');
    const b = await makeBot(poor.db, poor.user)('為什麼我那麼累');
    assert.notEqual(a, b, '★ 兩種狀態不可以給出一模一樣的回覆');
    assert.match(a, /平常/, '★ 有基準時要比較');
    assert.match(b, /無法確定|沒辦法判斷|不夠/, '★ 沒基準時要說判斷不出來');
    assert.ok(!b.includes('平常大約'), '★ 沒基準時不可以假裝有基準');
  } finally { rich.cleanup(); poor.cleanup(); }
});

// ===========================================================================
// 追問不可以吃掉問題
// ===========================================================================

test('★★★ 追問開著時，使用者的問題不可以被當成答案吃掉', async () => {
  const { db, user, cleanup } = await seed();
  try {
    // 開一個反應式追問
    await db.openPendingQuestion(user.id, {
      chatId: '5001', question: '昨天有喝酒嗎？', intent: 'today_status',
      // 與 openFollowUp 寫進去的形狀一致（含目標日期，否則會走「問清楚哪一天」）
      contextJson: { health_date: HD, question_target_date: '2026-09-10' },
      ttlMs: 3600_000,
    }, { now: NOW });

    const reply = await makeBot(db, user)('為什麼我那麼累');
    assert.ok(!/^✅/.test(reply.trim()), '★ 問題不可以被當成追問的答案');
    assert.match(reply, /累/, '★ 必須回答問題本身');

    // 追問應該還開著，等真正的答覆
    const still = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.ok(still, '★ 追問要保持開啟');

    // 而真正的答覆仍然被正常收下
    const ack = await makeBot(db, user)('喝了三杯酒');
    assert.match(ack, /已記錄|記下/, '★ 單純的答覆照舊被收下');
  } finally { cleanup(); }
});
