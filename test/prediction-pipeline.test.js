/**
 * 預測生產迴圈與 fail-closed 發布閘門（V1.1 Phase 10）。
 *
 * 最重要的一組是「發布閘門」：
 *   品質門檻是 null = **尚未設定 = 一律不合格**，絕不是「沒有限制」。
 *   所以在這個零真實資料的階段，**任何預測數字都不會被發布**。
 *
 * 但閘門本身要能被證明「設定好之後真的會開」——那些測試用注入的 policy，
 * 不動出貨的預設值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  trainEvaluateAndCompare, naiveBaseline, evaluateBaseline, buildSupervised,
  assertNoLeakage, MIN_TRAIN_ROWS, requiredPairsFor, scorecard,
  train, trainOnSamples, predict,
} from '../src/prediction.js';
import {
  PREDICTION_MATURITY, PREDICTION_QUALITY_POLICY,
  qualifyModel, isStale, publishableValue,
} from '../src/predictionPolicy.js';
import { runPredictionCycle, maturityOf } from '../src/predictionPipeline.js';
import { handlePredictions } from '../src/bot/commands.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';
import { trainableRows, unpredictableRows } from './predictionFixtures.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-pred-'));
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

const NOW = new Date('2026-09-09T00:00:00Z');
const anchorOf = (rows) => rows[rows.length - 1].health_date;

/** 一份「門檻都設定好、而且很寬鬆」的政策——只用來證明閘門會開。 */
const CONFIGURED_POLICY = {
  ...PREDICTION_QUALITY_POLICY,
  MAX_MAE: 1000,
  MIN_R2: -1000,
  MIN_INTERVAL_COVERAGE: 0,
};

// ===========================================================================
// ★★★ Fail-closed：null 門檻 = 不合格
// ===========================================================================

test('★★★ 出貨的預設政策：三個絕對門檻全部是 null（尚未設定）', () => {
  assert.equal(PREDICTION_QUALITY_POLICY.MAX_MAE, null);
  assert.equal(PREDICTION_QUALITY_POLICY.MIN_R2, null);
  assert.equal(PREDICTION_QUALITY_POLICY.MIN_INTERVAL_COVERAGE, null);
});

test('★★★ null 門檻一律不合格（絕不可以解讀成「沒有限制」）', () => {
  const perfect = {
    ok: true, n_test: 100, mae: 0, rmse: 0, r2: 1, interval_coverage: 1, beats_baseline: true,
  };
  const v = qualifyModel(perfect);
  assert.equal(v.qualified, false, '★ 就算完美也不合格——因為門檻還沒被設定');
  assert.equal(v.maturity, PREDICTION_MATURITY.EVALUATED_UNQUALIFIED);
  assert.ok(v.reasons.some((r) => r.startsWith('quality_threshold_not_configured')));
});

test('★★ 門檻設定好之後，閘門真的會開（證明不是永久寫死）', () => {
  const good = {
    ok: true, n_test: 100, mae: 5, rmse: 6, r2: 0.5, interval_coverage: 0.8, beats_baseline: true,
  };
  const v = qualifyModel(good, { policy: CONFIGURED_POLICY });
  assert.equal(v.qualified, true);
  assert.equal(v.maturity, PREDICTION_MATURITY.QUALIFIED);
  assert.deepEqual(v.reasons, []);
});

test('★★★ 贏不過樸素基準線 → 不合格（即使門檻都設定好了）', () => {
  const worse = {
    ok: true, n_test: 100, mae: 5, rmse: 6, r2: 0.5, interval_coverage: 0.8, beats_baseline: false,
  };
  const v = qualifyModel(worse, { policy: CONFIGURED_POLICY });
  assert.equal(v.qualified, false);
  assert.ok(v.reasons.includes('does_not_beat_naive_baseline'));
});

test('★★ 個別門檻沒過就不合格', () => {
  const strict = { ...CONFIGURED_POLICY, MAX_MAE: 1 };
  const v = qualifyModel({
    ok: true, n_test: 100, mae: 9, rmse: 9, r2: 0.5, interval_coverage: 0.9, beats_baseline: true,
  }, { policy: strict });
  assert.equal(v.qualified, false);
  assert.ok(v.reasons.some((r) => r.startsWith('mae_above_threshold')));
});

test('★★★ 量測不出來的指標不可以被當成通過（Number(null) === 0 的陷阱）', () => {
  // R² 在 ssTot === 0 時會是 null；interval_coverage 在沒有任何區間時也是 null。
  // 直接比 Number(null) <= threshold 會變成 0 <= threshold → 靜靜地通過。
  const nullMetrics = {
    ok: true, n_test: 100, mae: null, rmse: null, r2: null,
    interval_coverage: null, beats_baseline: true,
  };
  const v = qualifyModel(nullMetrics, { policy: CONFIGURED_POLICY });
  assert.equal(v.qualified, false, '★ 算不出來 ≠ 通過');
  assert.ok(v.reasons.some((r) => r.startsWith('metric_not_measurable:mae')));
  assert.ok(v.reasons.some((r) => r.startsWith('metric_not_measurable:r2')));
  assert.ok(v.reasons.some((r) => r.startsWith('metric_not_measurable:interval_coverage')));
});

test('★★ NaN / undefined 量測值同樣不合格', () => {
  for (const bad of [NaN, undefined, 'abc', Infinity]) {
    const v = qualifyModel({
      ok: true, n_test: 100, mae: bad, r2: 0.5, interval_coverage: 0.9, beats_baseline: true,
    }, { policy: CONFIGURED_POLICY });
    assert.equal(v.qualified, false, `mae=${String(bad)} 不該通過`);
  }
});

test('★ 測試集太小 → TRAINABLE，不是不合格（還沒評估，不是評估後被否決）', () => {
  const v = qualifyModel({ ok: true, n_test: 1, mae: 1, r2: 1, interval_coverage: 1, beats_baseline: true });
  assert.equal(v.maturity, PREDICTION_MATURITY.TRAINABLE);
  assert.equal(v.qualified, false);
});

test('★★★ publishableValue：不合格一律回 null', () => {
  assert.equal(publishableValue({
    maturity: PREDICTION_MATURITY.EVALUATED_UNQUALIFIED, qualified: false, predictedValue: 72,
  }), null);
  assert.equal(publishableValue({
    maturity: PREDICTION_MATURITY.QUALIFIED, qualified: false, predictedValue: 72,
  }), null, 'maturity 對但 qualified 是 false → 仍然 null');
  assert.equal(publishableValue({
    maturity: PREDICTION_MATURITY.STALE, qualified: true, predictedValue: 72,
  }), null, '過期的模型即使 qualified 也不可以發布');
  // 只有這一種組合會放行
  assert.equal(publishableValue({
    maturity: PREDICTION_MATURITY.QUALIFIED, qualified: true, predictedValue: 72,
  }), 72);
});

// ===========================================================================
// 樸素基準線與無洩漏
// ===========================================================================

test('naiveBaseline 用的是訓練集平均（資訊與模型對等）', () => {
  const train = [{ recovery: 10 }, { recovery: 20 }, { recovery: 30 }];
  const b = naiveBaseline(train);
  assert.equal(b.ok, true);
  assert.equal(b.kind, 'train_mean');
  assert.equal(b.value, 20);
});

test('naiveBaseline 對空訓練集回 ok:false，不硬算', () => {
  assert.equal(naiveBaseline([]).ok, false);
  assert.equal(naiveBaseline([{ recovery: null }]).ok, false);
});

test('evaluateBaseline 算出基準線在測試集上的 MAE', () => {
  const b = { ok: true, kind: 'train_mean', value: 50 };
  const e = evaluateBaseline(b, [{ recovery: 55 }, { recovery: 45 }]);
  assert.equal(e.mae, 5);
  assert.equal(e.n, 2);
});

test('★★★ trainEvaluateAndCompare 全程無洩漏，且每次都真的斷言一次', () => {
  const rows = trainableRows(60);
  const run = trainEvaluateAndCompare(rows);

  assert.equal(run.ok, true);
  assert.equal(run.leakage_checked, true);
  // 訓練期完全早於測試期
  assert.ok(run.train_end < run.test_start, `${run.train_end} 必須早於 ${run.test_start}`);
  assert.equal(assertNoLeakage(
    [{ health_date: run.train_end }], [{ health_date: run.test_start }],
  ).ok, true);
});

test('★★★ 時序切分之後不可以二次配對（目標會被多推一天）', () => {
  const rows = trainableRows(60);
  const samples = buildSupervised(rows);

  // trainOnSamples 直接吃配好對的樣本：n 應該原封不動
  const direct = trainOnSamples(samples);
  assert.equal(direct.n, samples.length);

  // train() 吃的是原始列，會自己配對。把配好對的樣本再餵進去，
  // buildSupervised 會**再配一次**，樣本數因此少掉——這正是二次配對的指紋。
  const doubled = train(samples);
  assert.ok(
    doubled.n < samples.length,
    '這個斷言在記錄「為什麼不可以把配好對的樣本餵給 train()」',
  );

  // 生產路徑必須用沒有被二次配對的那一個
  const run = trainEvaluateAndCompare(rows);
  assert.equal(run.n_train + run.n_pairs - run.n_train, run.n_pairs);
  assert.equal(run.model.n, run.n_train, '模型看到的樣本數必須等於訓練集大小');
});

test('★★ 預測區間算不出來時回 null，絕不回 NaN', () => {
  const run = trainEvaluateAndCompare(trainableRows(60));
  const featureValues = {
    sleep_total: 7 * 3600_000, previous_day_strain: 10, hrv: 55, rhr: 50, sleep_debt: 0,
  };
  const p = predict(run.model, featureValues);
  assert.ok(Number.isFinite(p.predicted_value));
  // 有 ss_residual 就該有區間，而且一定是有限數
  assert.ok(Number.isFinite(p.predicted_low));
  assert.ok(Number.isFinite(p.predicted_high));

  // 缺 ss_residual 的模型 → 區間是 null，不是 NaN
  const noSsr = { ok: true, fit: { ...run.model.fit, ss_residual: undefined }, n: 30 };
  const p2 = predict(noSsr, featureValues);
  assert.equal(p2.predicted_low, null);
  assert.equal(p2.predicted_high, null);
  assert.equal(p2.interval_kind, null);
  assert.ok(Number.isFinite(p2.predicted_value));
});

test('★★ 模型與基準線都在同一個測試集上被評估', () => {
  const run = trainEvaluateAndCompare(trainableRows(60));
  assert.ok(run.n_test > 0);
  assert.equal(typeof run.mae, 'number');
  assert.equal(typeof run.baseline_mae, 'number');
  assert.equal(typeof run.beats_baseline, 'boolean');
});

test('★★★ 特徵與結果無關的資料 → 模型贏不過歷史平均', () => {
  const run = trainEvaluateAndCompare(unpredictableRows(80));
  if (run.ok) {
    // 沒有訊號可學，所以不該贏過「就用平均猜」
    assert.equal(run.beats_baseline, false, `模型 MAE ${run.mae} vs 基準 ${run.baseline_mae}`);
    const v = qualifyModel(run, { policy: CONFIGURED_POLICY });
    assert.equal(v.qualified, false);
  }
});

// ===========================================================================
// 成熟度階梯
// ===========================================================================

test('0 筆 → NO_DATA', () => {
  const run = trainEvaluateAndCompare([]);
  assert.equal(maturityOf(run).maturity, PREDICTION_MATURITY.NO_DATA);
});

test('★★ 需要的配對數是從 MIN_TRAIN_ROWS 與 testRatio 推導出來的，不是另外發明的', () => {
  // 訓練集拿 75%，要讓它達到 30 → 總數至少 ceil(30 / 0.75) = 40
  assert.equal(requiredPairsFor(0.25), Math.ceil(MIN_TRAIN_ROWS / 0.75));
  assert.ok(requiredPairsFor(0.25) > MIN_TRAIN_ROWS,
    'readiness 的「夠訓練」比這裡的「夠訓練又夠評估」寬鬆——兩者本來就不同');
});

test('★ 差一組配對 → INSUFFICIENT_DATA（邊界）', () => {
  const need = requiredPairsFor(0.25);
  // n 列資料只會產生 n-1 組 D→D+1 配對
  const rows = trainableRows(need);
  const run = trainEvaluateAndCompare(rows);
  assert.equal(run.n_pairs, need - 1);
  assert.equal(maturityOf(run).maturity, PREDICTION_MATURITY.INSUFFICIENT_DATA);
});

test('★ 剛好到門檻 → 跨過（邊界）', () => {
  const need = requiredPairsFor(0.25);
  const rows = trainableRows(need + 1);
  const run = trainEvaluateAndCompare(rows);
  assert.equal(run.n_pairs, need);
  assert.notEqual(maturityOf(run).maturity, PREDICTION_MATURITY.INSUFFICIENT_DATA);
});

test('★★ 有足夠資料時預設成熟度是 EVALUATED_UNQUALIFIED（不是 QUALIFIED）', () => {
  const rows = trainableRows(80);
  const run = trainEvaluateAndCompare(rows);
  const v = maturityOf(run, { anchorDate: anchorOf(rows) });
  assert.equal(v.maturity, PREDICTION_MATURITY.EVALUATED_UNQUALIFIED);
  assert.equal(v.qualified, false);
});

test('★★ capability 證實拿不到 → UNSUPPORTED，優先於一切', () => {
  const run = trainEvaluateAndCompare(trainableRows(80));
  const v = maturityOf(run, { capabilityUnavailable: true });
  assert.equal(v.maturity, PREDICTION_MATURITY.UNSUPPORTED);
  assert.equal(v.qualified, false);
});

test('★★ 訓練期滑出基準窗 → STALE，而且蓋過 QUALIFIED', () => {
  const rows = trainableRows(80);
  const run = trainEvaluateAndCompare(rows);
  const farFuture = '2027-06-01';
  const v = maturityOf(run, { anchorDate: farFuture, policy: CONFIGURED_POLICY });
  assert.equal(v.maturity, PREDICTION_MATURITY.STALE);
  assert.equal(v.qualified, false);
});

test('isStale 的邊界', () => {
  const days = PREDICTION_QUALITY_POLICY.STALE_AFTER_DAYS;
  const end = '2026-01-01';
  const within = new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10);
  const beyond = new Date(Date.UTC(2026, 0, 1 + days + 1)).toISOString().slice(0, 10);
  assert.equal(isStale(end, within), false);
  assert.equal(isStale(end, beyond), true);
  assert.equal(isStale(null, beyond), false);
});

// ===========================================================================
// 生產迴圈（真的寫進 DB）
// ===========================================================================

test('★★★ 完整迴圈：訓練 → 存模型 → 存候選預測 → 但不發布數字', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    const res = await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });

    assert.equal(res.modelSaved, true, '模型層要有紀錄');
    assert.equal(res.predictionSaved, true, '候選預測要被存起來（否則永遠沒有記分卡）');
    assert.equal(res.maturity, PREDICTION_MATURITY.EVALUATED_UNQUALIFIED);
    assert.equal(res.qualified, false);
    assert.equal(res.publishedValue, null, '★★★ 不合格 → 一個數字都不給');

    const model = await db.getLatestPredictionModel(ALICE.id, { targetMetric: 'recovery' });
    assert.ok(model);
    assert.equal(model.qualified, false);
    assert.equal(model.maturity, PREDICTION_MATURITY.EVALUATED_UNQUALIFIED);
    assert.equal(typeof model.mae, 'number');
    assert.equal(typeof model.baselineMae, 'number');
    assert.ok(model.unqualifiedReason.includes('quality_threshold_not_configured'));

    // 候選預測真的進了 prediction_runs
    const runs = await db.getPredictions(ALICE.id, { targetMetric: 'recovery' });
    assert.equal(runs.length, 1);
    assert.ok(runs[0].predicted_value !== null, '存起來的候選值本身可以有數字');
  });
});

test('★★ 資料不足時：不存模型、不存預測、成熟度誠實', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(10);
    const res = await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });

    assert.equal(res.maturity, PREDICTION_MATURITY.INSUFFICIENT_DATA);
    assert.equal(res.modelSaved, false);
    assert.equal(res.predictionSaved, false);
    assert.equal(res.publishedValue, null);
    assert.equal((await db.getPredictions(ALICE.id, {})).length, 0);
  });
});

test('★★ 零資料：乾淨的 NO_DATA，不寫任何東西', async () => {
  await withDb(async (db) => {
    const res = await runPredictionCycle({
      db, userId: ALICE.id, rows: [], anchorDate: null, now: NOW,
    });
    assert.equal(res.maturity, PREDICTION_MATURITY.NO_DATA);
    assert.equal(res.modelSaved, false);
    assert.equal(res.predictionSaved, false);
    assert.equal(res.publishedValue, null);
  });
});

test('★★ 迴圈冪等：連跑三次只會有一列模型', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    for (let i = 0; i < 3; i += 1) {
      await runPredictionCycle({
        db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
      });
    }
    const models = await db.getPredictionModels(ALICE.id, { targetMetric: 'recovery' });
    assert.equal(models.length, 1, '同一段訓練資料只會有一列');

    const runs = await db.getPredictions(ALICE.id, {});
    assert.equal(runs.length, 1, '同一個 target_date 只會有一列');
  });
});

test('★★★ 存 → 回填實際值 → 記分卡真的算得出來', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    const anchor = anchorOf(rows);

    // 第一輪：產生對「明天」的候選預測
    const first = await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchor, now: NOW,
    });
    assert.equal(first.predictionSaved, true);

    // 隔天：那一天的實際值出現了 → 再跑一次迴圈就會回填
    const withTomorrow = trainableRows(81);
    const second = await runPredictionCycle({
      db, userId: ALICE.id, rows: withTomorrow, anchorDate: anchorOf(withTomorrow), now: NOW,
    });
    assert.ok(second.actualsBackfilled >= 1, '應該至少回填一筆實際值');

    const sc = await scorecard(db, ALICE.id, { targetMetric: 'recovery' });
    assert.equal(sc.available, true, '★ 記分卡終於算得出來了');
    assert.equal(typeof sc.mae, 'number');
  });
});

test('★ 錨點當天特徵不完整 → 不產生候選預測（絕不用 0 補）', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    rows[rows.length - 1].hrv = null; // 錨點那天缺一個特徵
    const res = await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });
    assert.equal(res.predictionSaved, false);
    assert.equal((await db.getPredictions(ALICE.id, {})).length, 0);
  });
});

test('★★ 迴圈永遠不拋錯：store 壞掉也只是回報失敗', async () => {
  await withDb(async (db) => {
    const broken = {
      ...db,
      savePredictionModel: async () => { throw new Error('boom'); },
      savePrediction: async () => { throw new Error('boom'); },
      recordPredictionActual: async () => { throw new Error('boom'); },
    };
    const rows = trainableRows(80);
    const res = await runPredictionCycle({
      db: broken, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });
    assert.equal(res.modelSaved, false);
    assert.equal(res.predictionSaved, false);
    assert.equal(res.publishedValue, null);
  });
});

test('runPredictionCycle 缺 userId 一律拋錯', async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => runPredictionCycle({ db, userId: null, rows: [], now: NOW }),
      /缺少 userId/,
    );
  });
});

// ===========================================================================
// 多使用者隔離
// ===========================================================================

test('★★★ Alice 與 Bob 的模型與預測完全隔離', async () => {
  await withDb(async (db) => {
    const aliceRows = trainableRows(80, { seed: 1 });
    const bobRows = trainableRows(80, { seed: 2 });

    await runPredictionCycle({
      db, userId: ALICE.id, rows: aliceRows, anchorDate: anchorOf(aliceRows), now: NOW,
    });
    await runPredictionCycle({
      db, userId: BOB.id, rows: bobRows, anchorDate: anchorOf(bobRows), now: NOW,
    });

    const a = await db.getLatestPredictionModel(ALICE.id, { targetMetric: 'recovery' });
    const b = await db.getLatestPredictionModel(BOB.id, { targetMetric: 'recovery' });

    assert.ok(a && b);
    assert.equal(a.userId, ALICE.id);
    assert.equal(b.userId, BOB.id);
    assert.notEqual(a.mae, b.mae, '不同資料應該得到不同的模型');

    assert.equal((await db.getPredictionModels(ALICE.id, {})).length, 1);
    assert.equal((await db.getPredictionModels(BOB.id, {})).length, 1);
  });
});

test('★★ 兩人同一天、同一版模型、同一段訓練區間也必須共存', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    for (const u of [ALICE, BOB]) {
      await runPredictionCycle({
        db, userId: u.id, rows, anchorDate: anchorOf(rows), now: NOW,
      });
    }
    const rs = await db.raw.execute('SELECT COUNT(*) AS n FROM prediction_models');
    assert.equal(Number(rs.rows[0].n), 2, '兩個人各一列');
  });
});

// ===========================================================================
// /predictions 的對外說法
// ===========================================================================

test('★★★ /predictions 在任何情況下都不輸出預測數字', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });

    const text = await handlePredictions({ db, userId: ALICE.id, rows });

    assert.match(text, /可訓練/);
    assert.match(text, /還沒達到可發布的標準/);
    assert.match(text, /不會.*給你預測數字/s);
    // 不可以出現「預計恢復 xx%」這類東西
    assert.ok(!/預計恢復/.test(text));
    assert.ok(!/預測值/.test(text));
  });
});

test('★ /predictions 會誠實顯示模型與基準線的對照', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });
    const text = await handlePredictions({ db, userId: ALICE.id, rows });
    assert.match(text, /對照「只用歷史平均猜」/);
    assert.match(text, /MAE/);
  });
});

test('★ /predictions 在資料不足時完全不提模型', async () => {
  await withDb(async (db) => {
    const text = await handlePredictions({ db, userId: ALICE.id, rows: [] });
    assert.match(text, /NO_DATA|INSUFFICIENT/);
    assert.ok(!/MAE/.test(text));
  });
});

test('★ Bob 的 /predictions 看不到 Alice 的模型', async () => {
  await withDb(async (db) => {
    const rows = trainableRows(80);
    await runPredictionCycle({
      db, userId: ALICE.id, rows, anchorDate: anchorOf(rows), now: NOW,
    });
    const text = await handlePredictions({ db, userId: BOB.id, rows });
    assert.match(text, /尚未訓練/);
  });
});
