/**
 * 預測相關測試共用的合成 daily_metrics。
 *
 * 刻意放在**非 .test.js** 的檔案裡：如果從別的測試檔 import 一個
 * `*.test.js`，node:test 會把那個檔案的測試重複註冊一次。
 *
 * 全部確定性（固定 seed 的 LCG），測試不可以有隨機性。
 */

/** 固定 seed 的線性同餘產生器。 */
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * 「條件良好、真的訓練得起來」的列。
 *
 * 四個特徵各自獨立、變異足夠，所以最小平方法不會拿到退化矩陣 ——
 * 否則 assessPrediction 會回 DEGRADED 而不是 READY，測到的就不是
 * 我們想測的那件事。
 */
export function trainableRows(n, { seed = 12345, start = [2026, 0, 1] } = {}) {
  const rnd = lcg(seed);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const date = new Date(Date.UTC(start[0], start[1], start[2] + i)).toISOString().slice(0, 10);
    const sleepTotal = (6 + rnd() * 3) * 3600_000;
    const strain = 5 + rnd() * 15;
    const hrv = 40 + rnd() * 40;
    const rhr = 45 + rnd() * 20;
    const debt = rnd() * 3600_000;
    rows.push({
      health_date: date,
      recovery: Math.max(
        1,
        Math.min(100, 20 + hrv * 0.5 - rhr * 0.3 + sleepTotal / 3600_000 + rnd() * 4),
      ),
      sleep_total: sleepTotal,
      previous_day_strain: strain,
      hrv,
      rhr,
      sleep_debt: debt,
    });
  }
  return rows;
}

/**
 * 「特徵與結果完全無關」的列 —— 模型應該贏不了單純的歷史平均。
 * recovery 是獨立雜訊，跟任何特徵都沒有關係。
 */
export function unpredictableRows(n, { seed = 999, start = [2026, 0, 1] } = {}) {
  const rnd = lcg(seed);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const date = new Date(Date.UTC(start[0], start[1], start[2] + i)).toISOString().slice(0, 10);
    rows.push({
      health_date: date,
      recovery: 30 + rnd() * 60,          // 與特徵無關的雜訊
      sleep_total: (6 + rnd() * 3) * 3600_000,
      previous_day_strain: 5 + rnd() * 15,
      hrv: 40 + rnd() * 40,
      rhr: 45 + rnd() * 20,
      sleep_debt: rnd() * 3600_000,
    });
  }
  return rows;
}
