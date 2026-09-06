/**
 * 多元線性迴歸（Phase W 基礎）。
 *
 * 自行實作而不加大型套件：專案目前只有一個相依（@libsql/client），
 * 保持這樣有價值。演算法本身很標準（normal equations + 高斯消去），
 * 而且下面有完整測試對照手算結果。
 *
 * ## 這一輪不宣稱任何真實結果
 *
 * 沒有真實 WHOOP 資料，所以這裡只提供 interface 與數學，
 * 全部用 synthetic data 驗證。
 *
 * ## 一定會處理的三件事
 *  1. 樣本太少（n <= p）→ 直接拒絕，不硬解
 *  2. 共線性 → 用 VIF 標警告
 *  3. 缺資料 → 整列剔除（listwise deletion），並回報剔掉幾列
 */

import { num } from '../config.js';
import { mean, stddev } from './statistics.js';

export const MIN_ROWS_PER_FEATURE = 5;
export const VIF_WARN = 5;
export const VIF_SEVERE = 10;

/** 解 Ax = b（高斯消去 + 部分主元）。奇異矩陣回 null。 */
export function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // 奇異
    [M[col], M[pivot]] = [M[pivot], M[col]];

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 最小平方（含截距）。X 是 n×p，y 是長度 n。 */
export function ordinaryLeastSquares(X, y) {
  const n = X.length;
  if (!n) return null;
  const p = X[0].length;

  // 加一欄常數項
  const Xd = X.map((row) => [1, ...row]);
  const k = p + 1;

  // XᵀX 與 Xᵀy
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += Xd[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += Xd[i][a] * Xd[i][b];
    }
  }

  const beta = solveLinearSystem(XtX, Xty);
  if (!beta) return null;

  const yMean = mean(y);
  let ssRes = 0;
  let ssTot = 0;
  const fitted = [];
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += beta[a] * Xd[i][a];
    fitted.push(pred);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yMean) ** 2;
  }

  const r2 = ssTot === 0 ? null : 1 - ssRes / ssTot;
  // adjusted R² 會懲罰多餘的變數；n - p - 1 <= 0 時沒有意義
  const adjR2 = (r2 === null || n - p - 1 <= 0)
    ? null
    : 1 - (1 - r2) * ((n - 1) / (n - p - 1));

  return {
    intercept: beta[0],
    coefficients: beta.slice(1),
    fitted,
    r2,
    adjusted_r2: adjR2,
    ss_residual: ssRes,
    ss_total: ssTot,
    n,
    p,
  };
}

/** 用其他特徵去解釋某個特徵，R² 越高代表共線性越嚴重。VIF = 1/(1-R²)。 */
export function varianceInflationFactors(X, names) {
  const p = X[0].length;
  const out = {};
  for (let j = 0; j < p; j++) {
    const y = X.map((r) => r[j]);
    const others = X.map((r) => r.filter((_, idx) => idx !== j));
    if (!others[0]?.length) { out[names[j]] = 1; continue; }
    const fit = ordinaryLeastSquares(others, y);
    if (!fit || fit.r2 === null || fit.r2 >= 0.999999) {
      out[names[j]] = Infinity;
      continue;
    }
    out[names[j]] = 1 / (1 - fit.r2);
  }
  return out;
}

/**
 * 完整的多元迴歸分析。
 *
 * @param {object[]} rows      每列一個觀測
 * @param {string}   target    被解釋變數的欄位名
 * @param {string[]} features  解釋變數的欄位名
 * @returns 一律回結構完整的物件；不可用時 ok=false 並說明原因
 */
export function analyzeRecoveryDrivers({
  rows = [], target = 'recovery', features = [], standardize = true,
} = {}) {
  const base = {
    ok: false,
    target,
    features_requested: features,
    features_used: [],
    n: 0,
    dropped_rows: 0,
    warnings: [],
    interpretation: 'within-person observed association',
    causal: false,
  };

  if (!features.length) return { ...base, reason: 'no_features' };

  // 1. listwise deletion：target 或任一特徵缺值就整列剔除
  // ⚠️ 一定要用 num() 而不是 Number()。`Number(null) === 0` —— 直接用 Number
  // 會把「這天沒有資料」悄悄變成「這天的值是 0」，整個迴歸就被污染了，
  // 而且不會有任何錯誤訊息。
  const complete = [];
  let dropped = 0;
  for (const r of rows) {
    const y = num(r[target]);
    if (y === null) { dropped += 1; continue; }
    const xs = features.map((f) => num(r[f]));
    if (xs.some((v) => v === null)) { dropped += 1; continue; }
    complete.push({ y, xs });
  }

  const n = complete.length;
  base.n = n;
  base.dropped_rows = dropped;

  // 2. 剔掉沒有變異的特徵（常數欄位會讓矩陣奇異）
  const keep = [];
  for (let j = 0; j < features.length; j++) {
    const col = complete.map((r) => r.xs[j]);
    const sd = stddev(col);
    if (sd === null || sd === 0) {
      base.warnings.push(`feature_no_variance:${features[j]}`);
      continue;
    }
    keep.push(j);
  }
  const usedFeatures = keep.map((j) => features[j]);
  base.features_used = usedFeatures;

  if (!usedFeatures.length) return { ...base, reason: 'no_usable_features' };

  // 3. 樣本量：每個特徵至少要有幾列，否則過度配適
  const required = Math.max(usedFeatures.length + 2, usedFeatures.length * MIN_ROWS_PER_FEATURE);
  if (n < required) {
    return {
      ...base,
      reason: 'insufficient_data',
      required_n: required,
      warnings: [...base.warnings, `need_at_least_${required}_rows_got_${n}`],
    };
  }

  let X = complete.map((r) => keep.map((j) => r.xs[j]));
  const y = complete.map((r) => r.y);

  // 4. 共線性
  const vif = varianceInflationFactors(X, usedFeatures);
  for (const [name, v] of Object.entries(vif)) {
    if (!Number.isFinite(v) || v >= VIF_SEVERE) {
      base.warnings.push(`severe_multicollinearity:${name}`);
    } else if (v >= VIF_WARN) {
      base.warnings.push(`multicollinearity:${name}`);
    }
  }

  // 5. 標準化係數（讓不同單位的特徵可以比較重要性）
  const rawFit = ordinaryLeastSquares(X, y);
  if (!rawFit) {
    return { ...base, reason: 'singular_matrix', warnings: [...base.warnings, 'singular_matrix'] };
  }

  let standardized = null;
  if (standardize) {
    const means = usedFeatures.map((_, j) => mean(X.map((r) => r[j])));
    const sds = usedFeatures.map((_, j) => stddev(X.map((r) => r[j])));
    const yMean = mean(y);
    const ySd = stddev(y);
    if (ySd && sds.every((s) => s && s > 0)) {
      const Xs = X.map((r) => r.map((v, j) => (v - means[j]) / sds[j]));
      const ys = y.map((v) => (v - yMean) / ySd);
      const sf = ordinaryLeastSquares(Xs, ys);
      if (sf) standardized = sf.coefficients;
    }
  }

  const coefficients = {};
  const standardizedCoefficients = {};
  usedFeatures.forEach((f, j) => {
    coefficients[f] = rawFit.coefficients[j];
    if (standardized) standardizedCoefficients[f] = standardized[j];
  });

  return {
    ...base,
    ok: true,
    intercept: rawFit.intercept,
    coefficients,
    standardized_coefficients: standardized ? standardizedCoefficients : null,
    r2: rawFit.r2,
    adjusted_r2: rawFit.adjusted_r2,
    vif,
    // 提醒呼叫端：R² 高不代表因果，也不代表對未來有預測力
    note: 'R² 只描述這批資料的配適程度，不是因果證據，也不是預測準確度。',
  };
}

/** 用擬合結果預測一筆新資料。 */
export function predictFrom(fit, featureValues) {
  if (!fit?.ok) return null;
  let out = fit.intercept;
  for (const f of fit.features_used) {
    // 同上：null 不可以被當成 0
    const v = num(featureValues[f]);
    if (v === null) return null;
    out += fit.coefficients[f] * v;
  }
  return out;
}
