/**
 * 相關性（Phase V 基礎）。
 *
 * ## 用詞紀律
 *
 * 這裡算出來的東西**永遠不是因果**。所有對外描述一律用
 * 「within-person observed association（個人層級的觀察到的關聯）」。
 * 絕不說「A 造成 B」。
 *
 * ## 資料充分度 ≠ 統計顯著性
 *
 * dataQuality 分級（INSUFFICIENT / LOW_CONFIDENCE / MODERATE / BETTER_SUPPORTED）
 * 講的只是「樣本夠不夠多到值得看一眼」，**不是** p 值的替代品，
 * 也不是「這個關聯是真的」的保證。p 值另外算、另外呈現，兩者都不單獨採信。
 */

import { mean, stddev } from './statistics.js';

export const CONFIDENCE = {
  INSUFFICIENT: 'INSUFFICIENT',
  LOW: 'LOW_CONFIDENCE',
  MODERATE: 'MODERATE',
  BETTER: 'BETTER_SUPPORTED',
};

/** 只依樣本數的資料充分度分級。 */
export function dataQualityOf(n) {
  if (n < 10) return CONFIDENCE.INSUFFICIENT;
  if (n < 20) return CONFIDENCE.LOW;
  if (n < 40) return CONFIDENCE.MODERATE;
  return CONFIDENCE.BETTER;
}

/** Pearson 積差相關。任一邊沒有變異就回 null（不是 0）。 */
export function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** 平均排名（處理並列）。 */
export function rankOf(values) {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // 1-based 平均排名
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman 等級相關 = 對排名做 Pearson。對離群值比 Pearson 穩健。 */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(rankOf(xs), rankOf(ys));
}

/**
 * 相關係數的雙尾 p 值（t 分布近似）。
 *
 * ⚠️ 刻意只做近似：這裡不引入統計套件，而且我們**不會**單靠 p 值下結論。
 * 它只是輸出的其中一欄，跟 n 與 effect size 一起看。
 */
export function pValue(r, n) {
  if (r === null || n < 3) return null;
  const absR = Math.min(Math.abs(r), 0.999999);
  const t = absR * Math.sqrt((n - 2) / (1 - absR * absR));
  const df = n - 2;
  // Student's t 雙尾機率的常用近似
  const x = df / (df + t * t);
  return Math.min(1, Math.max(0, incompleteBeta(x, df / 2, 0.5)));
}

/** 正則化不完全 Beta 函數（連分數展開）。 */
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));

    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  return front * (f - 1);
}

function logGamma(z) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * 把兩個時間序列按日期對齊，可指定 lag。
 * lag = 1 表示「x 在第 D 天，y 取第 D+1 天」（例如 昨天喝酒 → 今天恢復）。
 */
export function alignSeries(xSeries, ySeries, { lagDays = 0 } = {}) {
  const yByDate = new Map(ySeries.map((p) => [p.date, p.value]));
  const xs = [];
  const ys = [];
  const dates = [];
  for (const p of xSeries) {
    const target = lagDays === 0
      ? p.date
      : new Date(Date.parse(`${p.date}T00:00:00Z`) + lagDays * 86_400_000)
        .toISOString().slice(0, 10);
    const y = yByDate.get(target);
    if (y === undefined || y === null) continue;
    if (p.value === null || p.value === undefined) continue;
    xs.push(p.value);
    ys.push(y);
    dates.push({ x: p.date, y: target });
  }
  return { xs, ys, dates };
}

/**
 * 完整的關聯分析。
 *
 * @returns 一律回結構完整的物件；樣本不足時 confidence = INSUFFICIENT，
 *          而且呼叫端**不可以**把它講成結論。
 */
export function analyseAssociation({
  xSeries, ySeries, lagDays = 0, xLabel = 'x', yLabel = 'y',
}) {
  const { xs, ys } = alignSeries(xSeries, ySeries, { lagDays });
  const n = xs.length;

  const base = {
    x: xLabel,
    y: yLabel,
    lag_days: lagDays,
    n,
    data_quality: dataQualityOf(n),
    interpretation: 'within-person observed association',
    causal: false,
  };

  if (n < 3) {
    return { ...base, pearson: null, spearman: null, p_value: null, direction: null };
  }

  const r = pearson(xs, ys);
  const rho = spearman(xs, ys);
  return {
    ...base,
    pearson: r,
    spearman: rho,
    p_value: pValue(r, n),
    direction: r === null ? null : (r > 0 ? 'positive' : (r < 0 ? 'negative' : 'flat')),
    x_mean: mean(xs),
    y_mean: mean(ys),
    x_stddev: stddev(xs),
    y_stddev: stddev(ys),
  };
}

/**
 * journal 事件 → 隔天某個指標的關聯。
 *
 * 作法：把每一天編碼成「當天有沒有這個事件（或事件的數量）」，
 * 再與 lag=1 的指標對齊。這是最基本的 within-person 對照。
 *
 * @param {object[]} journalEvents db.getJournalEvents() 的輸出
 * @param {object[]} metricSeries [{date, value}] 舊→新
 */
export function journalAssociation({
  journalEvents = [], metricSeries = [], category, metricLabel = 'metric',
  useCount = false, lagDays = 1,
}) {
  const byDate = new Map();
  for (const e of journalEvents) {
    if (e.category !== category) continue;
    const cur = byDate.get(e.health_date) ?? 0;
    byDate.set(e.health_date, cur + (useCount ? Number(e.numeric_value ?? 1) : 1));
  }

  // 指標有值的每一天都要有一個 x（沒有事件就是 0），否則只看「有喝酒的日子」
  // 會完全沒有對照組，相關係數毫無意義。
  const xSeries = metricSeries.map((p) => {
    const shifted = new Date(Date.parse(`${p.date}T00:00:00Z`) - lagDays * 86_400_000)
      .toISOString().slice(0, 10);
    return { date: shifted, value: byDate.get(shifted) ?? 0 };
  });

  const result = analyseAssociation({
    xSeries, ySeries: metricSeries, lagDays,
    xLabel: `journal:${category}`, yLabel: metricLabel,
  });

  const exposedDays = xSeries.filter((p) => p.value > 0).length;
  return {
    ...result,
    exposed_days: exposedDays,
    unexposed_days: xSeries.length - exposedDays,
    // 沒有對照組（全有或全無）時相關係數沒有意義
    usable: exposedDays >= 3 && (xSeries.length - exposedDays) >= 3,
  };
}
