/**
 * AI 用量帳本 / 成本 / model routing / prompt 版本 / Evidence / Telegram UX
 * （Phase AC / AD / AE / AF / AG）。
 *
 * 全部 mock，不會呼叫真實 OpenRouter / Telegram / WHOOP。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createCoach, isModelUnavailableError } from '../src/coach.js';
import { computeCost, extractTokens, costSummary, renderCost } from '../src/usage.js';
import { resolveModel, AI_PURPOSE, PROMPT_VERSIONS, loadPricing } from '../src/config.js';
import {
  makeEvidenceCard, fromCorrelation, fromRegression, fromPrediction,
  fromExperiment, fromTrend, fromDeviation, getEvidence, renderEvidence,
} from '../src/evidence.js';
import { analyseAssociation } from '../src/analytics/correlation.js';
import { analyzeRecoveryDrivers } from '../src/analytics/regression.js';
import { analyseExperimentData } from '../src/experiments.js';
import { recordInsight } from '../src/healthMemory.js';
import { createRouter } from '../src/bot/router.js';

const TZ = 'Asia/Taipei';
const CHAT = '12345';
const NOW = new Date('2026-09-01T04:00:00Z'); // 台灣 12:00

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-ledger-'));
  return {
    url: `file:${path.join(dir, 'l.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
async function freshDb() {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  return { db, cleanup };
}

/** 假 OpenRouter：可控制 usage、model、以及要不要失敗。 */
function fakeFetch({ usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
  model = 'anthropic/claude-sonnet-5', failFor = null, content = '好的' } = {}) {
  // 注意：呼叫端要模擬「provider 沒回 usage」時必須傳 null，傳 undefined
  // 會觸發上面的預設值（JS 預設參數的行為）。
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (failFor && body.model === failFor) {
        return new Response(JSON.stringify({ error: { message: 'No endpoints found for model' } }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'gen', model, usage,
        choices: [{ message: { content }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

const routerFor = (db, coach = null) =>
  createRouter({ db, coach, timezone: TZ, now: () => NOW });

// ===========================================================================
// Phase AE — 用量與成本
// ===========================================================================

test('AE: computeCost 手算驗證', () => {
  // sonnet-5: input $3/M, output $15/M → 1000 in + 500 out
  const c = computeCost({
    model: 'anthropic/claude-sonnet-5', inputTokens: 1000, outputTokens: 500,
  });
  assert.ok(Math.abs(c - (0.003 + 0.0075)) < 1e-9, `實際 ${c}`);
});

test('★ AE: 未知模型 → cost = null（絕不猜）', () => {
  assert.equal(computeCost({
    model: 'someone/unknown-model-v9', inputTokens: 1000, outputTokens: 500,
  }), null);
});

test('★ AE: 沒有 token 數 → cost = null（絕不估）', () => {
  assert.equal(computeCost({
    model: 'anthropic/claude-sonnet-5', inputTokens: null, outputTokens: 500,
  }), null);
  assert.equal(computeCost({
    model: 'anthropic/claude-sonnet-5', inputTokens: 1000, outputTokens: null,
  }), null);
});

test('AE: extractTokens 吃兩種欄位命名，缺就是 null', () => {
  assert.deepEqual(
    extractTokens({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
  assert.deepEqual(
    extractTokens({ input_tokens: 10, output_tokens: 5 }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
  assert.deepEqual(extractTokens(null), {
    inputTokens: null, outputTokens: null, totalTokens: null,
  });
});

test('AE: 價格表可以用環境變數覆蓋（價格會變，不必改程式）', () => {
  const p = loadPricing({ MODEL_PRICING_JSON: JSON.stringify({
    'my/model': { input_per_million: 1, output_per_million: 2 },
  }) });
  assert.ok(p['my/model']);
  assert.ok(p['anthropic/claude-sonnet-5'], '內建的仍在');
  // 壞掉的 JSON 不可以讓系統起不來
  assert.ok(loadPricing({ MODEL_PRICING_JSON: '{壞掉' })['anthropic/claude-sonnet-5']);
});

test('★ AE: 真實 token 與成本會被寫進 ai_usage', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const f = fakeFetch();
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db, env: {}, fetchImpl: f.impl,
    });
    const out = await coach.ask({ system: 's', user: 'u', purpose: AI_PURPOSE.QA });
    assert.equal(out, '好的');

    const rows = await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.purpose, 'QA');
    assert.equal(r.request_status, 'OK');
    assert.equal(Number(r.input_tokens), 1000);
    assert.equal(Number(r.output_tokens), 500);
    assert.equal(Number(r.total_tokens), 1500);
    assert.ok(Number(r.estimated_cost_usd) > 0);
    assert.ok(Number(r.latency_ms) >= 0);
    assert.equal(r.prompt_version, PROMPT_VERSIONS.QA, '★ prompt 版本要落地');
  } finally { db.close(); cleanup(); }
});

test('★ AE: provider 沒回 usage → token 與 cost 都記 null，不猜', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const f = fakeFetch({ usage: null });
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db, env: {}, fetchImpl: f.impl,
    });
    await coach.ask({ system: 's', user: 'u' });

    const r = (await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' }))[0];
    assert.equal(r.input_tokens, null);
    assert.equal(r.total_tokens, null);
    assert.equal(r.estimated_cost_usd, null, '★ 沒有 token 就不可以有成本');
  } finally { db.close(); cleanup(); }
});

test('AE: 呼叫失敗也會記一筆 FAILED', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db, env: {},
      maxRetries: 1, backoffFor: () => 1,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }),
    });
    assert.equal(await coach.ask({ system: 's', user: 'u' }), null, 'ask 失敗回 null');

    const r = (await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' }))[0];
    assert.equal(r.request_status, 'FAILED');
    assert.equal(r.estimated_cost_usd, null);
  } finally { db.close(); cleanup(); }
});

test('★ AE: 帳本寫入失敗不影響回覆（主功能優先）', async () => {
  const brokenDb = { recordAiUsage: async () => { throw new Error('DB 爆炸'); } };
  const f = fakeFetch();
  const coach = createCoach({
    apiKey: 'k', model: 'anthropic/claude-sonnet-5', db: brokenDb, env: {}, fetchImpl: f.impl,
  });
  assert.equal(await coach.ask({ system: 's', user: 'u' }), '好的', '★ 記帳壞掉還是要回答');
});

test('AE: 沒有給 db 時完全不記帳，也不會壞', async () => {
  const f = fakeFetch();
  const coach = createCoach({ apiKey: 'k', model: 'm', env: {}, fetchImpl: f.impl });
  assert.equal(await coach.ask({ system: 's', user: 'u' }), '好的');
});

// ===========================================================================
// Phase AF — Model routing
// ===========================================================================

test('★ AF: 沒有新環境變數時行為與現在完全相同（向後相容）', () => {
  const env = { OPENROUTER_MODEL: 'anthropic/claude-sonnet-5' };
  for (const p of Object.values(AI_PURPOSE)) {
    assert.equal(
      resolveModel(p, env, 'anthropic/claude-sonnet-5'),
      'anthropic/claude-sonnet-5',
      `${p} 應該仍用既有模型`,
    );
  }
});

test('AF: 任務專屬 > MODEL_DEFAULT > 既有 OPENROUTER_MODEL', () => {
  assert.equal(
    resolveModel(AI_PURPOSE.INTENT_PARSE, { MODEL_PARSE: 'cheap/model', MODEL_DEFAULT: 'mid/model' }, 'old/model'),
    'cheap/model',
  );
  assert.equal(
    resolveModel(AI_PURPOSE.QA, { MODEL_DEFAULT: 'mid/model' }, 'old/model'),
    'mid/model',
  );
  assert.equal(resolveModel(AI_PURPOSE.QA, {}, 'old/model'), 'old/model');
  assert.equal(resolveModel(AI_PURPOSE.EXPERIMENT, { MODEL_ADVANCED: 'strong/model' }, 'x'), 'strong/model');
});

test('AF: isModelUnavailableError 只認「模型用不了」', () => {
  assert.equal(isModelUnavailableError({ status: 404 }), true);
  assert.equal(isModelUnavailableError({ status: 402 }), true);
  assert.equal(isModelUnavailableError({ status: 400, message: 'No endpoints found for model' }), true);
  assert.equal(isModelUnavailableError({ status: 400, message: 'invalid temperature' }), false);
  assert.equal(isModelUnavailableError({ status: 500 }), false, '5xx 是暫時故障，不該換模型');
  assert.equal(isModelUnavailableError({ status: 429 }), false);
});

test('★ AF: 指定模型不可用 → 退回預設模型，且只退一次', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const f = fakeFetch({ failFor: 'broken/model' });
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db,
      env: { MODEL_QA: 'broken/model' },
      fetchImpl: f.impl, maxRetries: 1, backoffFor: () => 1,
    });
    const out = await coach.ask({ system: 's', user: 'u', purpose: AI_PURPOSE.QA });
    assert.equal(out, '好的', '退回預設模型後應該成功');

    const r = (await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' }))[0];
    assert.equal(r.requested_model, 'broken/model', '★ 要記下原本想用哪個');
    assert.equal(Number(r.fallback_occurred), 1, '★ 要標記發生過 fallback');
    assert.equal(r.model, 'anthropic/claude-sonnet-5', '實際跑的是預設模型');

    // 沒有無限重試：壞模型 1 次 + 預設模型 1 次（各自的參數階梯內）
    assert.ok(f.calls.length <= 4, `呼叫次數應該有限，實際 ${f.calls.length}`);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// Phase AG — Prompt versioning
// ===========================================================================

test('★ AG: 每個用途都有自己的 prompt 版本，並寫進帳本', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const f = fakeFetch({ content: '{"intent":"today_status"}' });
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db, env: {}, fetchImpl: f.impl,
    });
    await coach.ask({ system: 's', user: 'u', purpose: AI_PURPOSE.QA });
    await coach.json({
      system: 's', user: 'u',
      purpose: AI_PURPOSE.JOURNAL_PARSE, promptVersion: PROMPT_VERSIONS.JOURNAL_PARSE,
    });

    const rows = await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' });
    const byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, r.prompt_version]));
    assert.equal(byPurpose.QA, 'qa-v1');
    assert.equal(byPurpose.JOURNAL_PARSE, 'journal-parser-v1');
  } finally { db.close(); cleanup(); }
});

test('AG: daily / weekly 也帶版本（prompt 內容未變）', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const f = fakeFetch();
    const coach = createCoach({
      apiKey: 'k', model: 'anthropic/claude-sonnet-5', db, env: {}, fetchImpl: f.impl,
    });
    await coach.daily({
      localDate: '2026-09-01', stage: 'cold', sampleCount: 0, metrics: [],
      trends: { enabled: false, alerts: [] },
    });
    const r = (await db.getAiUsage({ fromIso: '2000-01-01', toIso: '2100-01-01' }))[0];
    assert.equal(r.purpose, 'DAILY');
    assert.equal(r.prompt_version, 'daily-v1');
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// Phase AC — Evidence cards
// ===========================================================================

test('★ AC: 每張 card 的 causal 永遠是 false', () => {
  const c = makeEvidenceCard({ metric: 'x', method: 'y', sampleCount: 100, effect: 0.9 });
  assert.equal(c.causal, false);
  assert.equal(c.interpretation, 'within-person observed association');
});

test('AC: correlation → card', () => {
  const r = analyseAssociation({
    xSeries: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10),
      value: i,
    })),
    ySeries: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10),
      value: 2 * i,
    })),
    xLabel: 'alcohol', yLabel: 'recovery',
  });
  const card = fromCorrelation(r, { metric: 'alcohol → recovery' });
  assert.equal(card.sample_count, 30);
  assert.equal(card.causal, false);
  assert.equal(card.confidence, 'MODERATE');
  assert.ok(Math.abs(card.effect - 1) < 1e-6);
  assert.equal(card.detail.p_value !== null, true);
});

test('AC: regression → card（含不可用的情況）', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    recovery: 60 + (i % 9), sleep_total: 20 + (i % 7), hrv: 50 + (i % 5),
  }));
  const fit = analyzeRecoveryDrivers({
    rows, target: 'recovery', features: ['sleep_total', 'hrv'],
  });
  const card = fromRegression(fit);
  assert.equal(card.method, 'multiple_linear_regression');
  assert.equal(card.sample_count, 60);
  assert.equal(card.causal, false);
  assert.ok(card.detail.features_used.includes('sleep_total'));

  const bad = analyzeRecoveryDrivers({ rows: rows.slice(0, 3), target: 'recovery', features: ['hrv'] });
  const badCard = fromRegression(bad);
  assert.equal(badCard.sufficient, false);
  assert.equal(badCard.effect, null, '不可用時不可以有效果量');
});

test('AC: prediction scorecard → card（沒有預測時也要有卡）', () => {
  const none = fromPrediction({ available: false, reason: 'no_evaluated_predictions', total_runs: 0 });
  assert.equal(none.sufficient, false);
  assert.equal(none.effect, null);
  assert.ok(none.warnings.includes('no_evaluated_predictions'));

  const some = fromPrediction({
    available: true, n: 40, mae: 5.2, rmse: 6.8, bias: 0.3, interval_coverage: 0.72,
  });
  assert.equal(some.sample_count, 40);
  assert.equal(some.effect, 5.2);
  assert.equal(some.effect_unit, 'MAE');
});

test('AC: experiment → card', () => {
  const rows = Array.from({ length: 28 }, (_, i) => ({
    health_date: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10),
    recovery: i < 14 ? 60 : 70,
  }));
  const result = analyseExperimentData({
    rows,
    experiment: {
      id: 1, name: 't', target_metrics: JSON.stringify(['recovery']),
      baseline_start: '2026-08-01', baseline_end: '2026-08-14',
      start_date: '2026-08-15', end_date: '2026-08-28',
    },
  });
  const card = fromExperiment(result, 'recovery');
  assert.equal(card.method, 'within_person_before_after');
  assert.equal(card.sample_count, 28);
  assert.equal(card.causal, false);
  assert.equal(card.detail.mean_difference, 10);
});

test('AC: trend / deviation → card', () => {
  const t = fromTrend({
    windowDays: 30, n: 28, sufficient: true, slope_per_day: -0.15,
    total_change: -4.2, r2: 0.65, direction: 'DECLINING',
  }, { metric: 'hrv' });
  assert.equal(t.effect, -0.15);
  assert.equal(t.detail.direction, 'DECLINING');

  const d = fromDeviation({
    metric: 'hrv', current: 42, baseline_mean: 55, baseline_stddev: 5,
    baseline_n: 30, baseline_window_days: 30, z_score: -2.6, level: 'STRONG', direction: 'low',
  });
  assert.equal(d.effect, -2.6);
  assert.equal(d.effect_unit, 'z');
  assert.equal(d.sample_count, 30);
});

test('★ AC: 沒有任何證據時明講，不編', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = await getEvidence({ db, now: NOW });
    assert.equal(r.available, false);
    assert.deepEqual(r.cards, []);
    assert.match(r.note, /還沒有累積足夠的資料/);
    const text = renderEvidence(r);
    assert.match(text, /還沒有足夠的資料/);
    assert.ok(!/\d+\.\d+/.test(text), '★ 沒有證據時不可以出現任何數字');
  } finally { db.close(); cleanup(); }
});

test('AC: 有 insight 時 getEvidence 會回出來', async () => {
  const { db, cleanup } = await freshDb();
  try {
    await recordInsight(db, {
      insightType: 'association', subject: 'alcohol->recovery',
      statement: '喝酒隔天恢復偏低', evidence: { pearson: -0.5 },
      sampleCount: 45, effectSize: 0.7,
    }, { now: NOW });

    const r = await getEvidence({ db, now: NOW });
    assert.equal(r.available, true);
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].sample_count, 45);
    assert.equal(r.cards[0].causal, false);
    const text = renderEvidence(r);
    assert.match(text, /樣本數：45/);
    assert.match(text, /不是因果關係/);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// Phase AD — Telegram UX（全部在「沒有 WHOOP 資料」的狀態下）
// ===========================================================================

test('★ AD: /help 不會把沒資料的分析講成已經可用', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/help', chatId: CHAT });
    assert.match(reply, /現在就能用/);
    assert.match(reply, /還不能用（等 WHOOP 資料）/);
    assert.match(reply, /健康問答 —— 目前沒有任何生理資料可以分析/);
    assert.match(reply, /目前尚未形成/, 'insights 要標明尚未形成');
    assert.match(reply, /資料量還不足/, 'predictions 要標明不足');
  } finally { db.close(); cleanup(); }
});

test('★ AD: /status 沒有 WHOOP 也正常', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/status', chatId: CHAT });
    assert.match(reply, /Bot：✅ 運作中/);
    assert.match(reply, /WHOOP 資料：尚未開始/);
    assert.match(reply, /授權：尚未授權/);
    assert.match(reply, /Backfill：尚未開始/);
    assert.match(reply, /Capability probe：尚未執行/);
    assert.match(reply, /預測就緒：尚未（0\/30 筆可用樣本）/);
    assert.match(reply, /長期規律：尚未形成/);
  } finally { db.close(); cleanup(); }
});

test('AD: /journal 空的時候給明確訊息', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/journal', chatId: CHAT });
    assert.match(reply, /目前沒有 Journal 紀錄/);
    assert.match(reply, /\/log/);
  } finally { db.close(); cleanup(); }
});

test('AD: /journal 有資料時依日期分組，支援天數參數', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = routerFor(db);
    await r.handle({ text: '/log alcohol 3 drinks', chatId: CHAT });
    await r.handle({ text: '/log caffeine 2 coffee', chatId: CHAT });

    const reply = await r.handle({ text: '/journal 7', chatId: CHAT });
    assert.match(reply, /最近 7 天的記錄（2 筆）/);
    assert.match(reply, /alcohol/);
    assert.match(reply, /caffeine/);
    assert.match(reply, /3 drinks/);
  } finally { db.close(); cleanup(); }
});

test('★ AD: /insights 空的時候不假裝有規律', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/insights', chatId: CHAT });
    assert.match(reply, /目前資料還不足以形成長期規律/);
    assert.ok(!/effect size/.test(reply));
  } finally { db.close(); cleanup(); }
});

test('AD: /insights 不顯示 RETIRED，history 可看版本鏈', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const { id } = await recordInsight(db, {
      insightType: 'association', subject: 's', statement: '第一版說法',
      sampleCount: 15, effectSize: 0.6,
    }, { now: NOW });
    const { reviseInsight } = await import('../src/healthMemory.js');
    await reviseInsight(db, id, {
      statement: '第二版說法', sampleCount: 45, effectSize: 0.8,
    }, { now: NOW });

    const reply = await routerFor(db).handle({ text: '/insights', chatId: CHAT });
    assert.match(reply, /第二版說法/);
    assert.ok(!reply.includes('第一版說法'), '★ RETIRED 的不顯示');

    const hist = await routerFor(db).handle({ text: '/insights history', chatId: CHAT });
    assert.match(hist, /第一版說法/, 'history 要看得到舊版本');
  } finally { db.close(); cleanup(); }
});

test('★ AD: /predictions 資料不足時絕不給預測數字', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/predictions', chatId: CHAT });
    assert.match(reply, /INSUFFICIENT_DATA/);
    assert.match(reply, /目前可用樣本：0 筆/);
    assert.match(reply, /最低需求：30 筆/);
    assert.ok(!/預測.*\d+%/.test(reply), '★ 不可以出現任何預測值');
  } finally { db.close(); cleanup(); }
});

test('★ AD: /cost 空的時候顯示沒有紀錄', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/cost', chatId: CHAT });
    assert.match(reply, /AI 使用成本/);
    assert.match(reply, /（沒有呼叫紀錄）/);
  } finally { db.close(); cleanup(); }
});

test('AD: /cost 有紀錄時分組顯示，未知成本明講 cost unavailable', async () => {
  const { db, cleanup } = await freshDb();
  try {
    // 一筆有 token、一筆沒有
    await db.recordAiUsage({
      timestamp: NOW.toISOString(), provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5', purpose: 'QA', promptVersion: 'qa-v1',
      inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
      estimatedCostUsd: 0.0105, pricingVersion: 'x', requestStatus: 'OK', latencyMs: 100,
    });
    await db.recordAiUsage({
      timestamp: NOW.toISOString(), provider: 'openrouter',
      model: 'unknown/model', purpose: 'JOURNAL_PARSE', promptVersion: 'journal-parser-v1',
      inputTokens: null, outputTokens: null, totalTokens: null,
      estimatedCostUsd: null, requestStatus: 'OK', latencyMs: 50,
    });

    const summary = await costSummary({ db, timezone: TZ, now: NOW });
    assert.equal(summary.available, true);
    assert.equal(summary.todaySummary.calls, 2);
    assert.equal(summary.todaySummary.calls_with_unknown_cost, 1);

    const text = renderCost(summary);
    assert.match(text, /Q&A/);
    assert.match(text, /Parsing: cost unavailable/, '★ 沒 token 就顯示 cost unavailable');
    assert.match(text, /Total: \$/);
    assert.match(text, /1 次沒有 token 用量資料/);
  } finally { db.close(); cleanup(); }
});

test('AD: /evidence 與自然語言「證據呢？」都能觸發', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = routerFor(db);
    const a = await r.handle({ text: '/evidence', chatId: CHAT });
    assert.match(a, /目前的證據/);

    for (const q of ['證據呢？', '你憑什麼這樣說？', '樣本多少？', '這個結論可信嗎？']) {
      const reply = await r.handle({ text: q, chatId: CHAT });
      assert.match(reply, /目前的證據/, `「${q}」應該觸發 evidence`);
    }
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// /experiment 完整生命週期（Telegram）
// ===========================================================================

test('★ AD: /experiment 完整流程 —— create 五步 → list → status → stop', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = routerFor(db);

    const start = await r.handle({ text: '/experiment create', chatId: CHAT });
    assert.match(start, /（1\/5）/);
    assert.match(start, /叫什麼名字/);

    assert.match(await r.handle({ text: '睡前不喝咖啡', chatId: CHAT }), /（2\/5）/);
    assert.match(await r.handle({ text: '深睡會變多', chatId: CHAT }), /（3\/5）/);
    assert.match(await r.handle({ text: '14:00 後不喝咖啡因', chatId: CHAT }), /（4\/5）/);

    // 不認得的指標要重問，不推進
    const badMetric = await r.handle({ text: '心情', chatId: CHAT });
    assert.match(badMetric, /我不認得/);
    assert.match(badMetric, /（4\/5）/, '★ 不合法時不可以推進步驟');

    assert.match(await r.handle({ text: '深睡', chatId: CHAT }), /（5\/5）/);

    const done = await r.handle({ text: '21', chatId: CHAT });
    assert.match(done, /實驗已建立並開始/);
    assert.match(done, /睡前不喝咖啡/);
    assert.match(done, /deep_sleep/);
    assert.match(done, /不能證明因果/, '★ 一定要標明非因果');

    // pending 已清空
    assert.equal(await db.getOpenPendingQuestion(CHAT, { now: NOW }), null);

    const list = await r.handle({ text: '/experiment list', chatId: CHAT });
    assert.match(list, /睡前不喝咖啡/);
    assert.match(list, /RUNNING/);

    const status = await r.handle({ text: '/experiment status', chatId: CHAT });
    assert.match(status, /睡前不喝咖啡/);
    assert.match(status, /資料還不夠/, '★ 沒有健康資料時不可以生成結果');

    const stopped = await r.handle({ text: '/experiment stop', chatId: CHAT });
    assert.match(stopped, /已結束/);
    const after = await db.listExperiments({});
    assert.equal(after[0].status, 'COMPLETED');
  } finally { db.close(); cleanup(); }
});

test('AD: /experiment create 中途可以取消', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = routerFor(db);
    await r.handle({ text: '/experiment create', chatId: CHAT });
    const cancelled = await r.handle({ text: '取消', chatId: CHAT });
    assert.match(cancelled, /先不建立/);
    assert.equal(await db.getOpenPendingQuestion(CHAT, { now: NOW }), null);
    assert.equal((await db.listExperiments({})).length, 0);
  } finally { db.close(); cleanup(); }
});

test('AD: /experiment 沒有子指令時顯示用法', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const reply = await routerFor(db).handle({ text: '/experiment', chatId: CHAT });
    assert.match(reply, /experiment create/);
    assert.match(reply, /experiment list/);
  } finally { db.close(); cleanup(); }
});

test('AD: /experiment status 沒有實驗時不會爆', async () => {
  const { db, cleanup } = await freshDb();
  try {
    assert.match(
      await routerFor(db).handle({ text: '/experiment status', chatId: CHAT }),
      /目前沒有任何實驗/,
    );
    assert.match(
      await routerFor(db).handle({ text: '/experiment stop', chatId: CHAT }),
      /沒有進行中的實驗/,
    );
  } finally { db.close(); cleanup(); }
});
