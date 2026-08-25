# WHOOP 簡報系統 — 待決定的 10 個疑點（D–M）

> **⚠️ 這份文件已完成使命（2026-08-24）。** 審查結果已定案，最新狀態請看 `TODO.md`。
>
> - **已修完上線**：F（`nap` 非布林寫 warn log）、G（health_date + 24 小時補發）、
>   I（昨日 Strain 單向選取 + baseline 口徑一致）、L（註解）、M（`engines` + `.env` 錯誤處理）
> - **刻意延後**（見 `TODO.md`）：D、H、J、K，以及 E 的「Telegram 4096 怎麼算」那一問
> - E 的另一半已處理：`clamp()` 集中成唯一一份，發送層加了 assertion
>
> 以下保留當時的分析原文，程式碼片段對應的是**修改前**的狀態。

---

## 背景（判斷這些問題需要知道的最小前提）

- **是什麼**：每天使用者真正起床後 30 分鐘，抓 WHOOP 數據、跟他自己的個人基準比較，Node 算出紅黃燈與趨勢，AI 把結論講成人話，推到 Telegram。每週一另發一則上週回顧。
- **執行方式**：無狀態 cron，台灣時間 **05:00–15:45 每 15 分鐘**跑一次（UTC cron `*/15 21-23,0-7 * * *`）。跨執行狀態全存 Turso（libSQL）。
- **核心不變式**：所有好壞判斷由 Node 決定，AI 只講話，不參與判斷。
- **基準定義**：「最近 **30 筆有效紀錄**」，不是 30 個日曆天（抓 45 天再挑 30 筆）。一律不含今天。
- **冷啟動分階**：`< 7 筆 = cold`（只顯示數值不給燈）／`7–29 = provisional`／`>= 30 = full`（趨勢預警才啟用）。
- **技術棧**：Node 22+，ESM，唯一 runtime 依賴是 `@libsql/client`。74 個測試全過。

指標一覽（15 個）：`recovery_score`、`hrv`、`rhr`、`respiratory_rate`（→ 這 4 個是趨勢預警檢查的對象）、`sleep_total`、`slow_wave`、`rem`、`sleep_performance`、`sleep_debt`、`sleep_consistency`、`sleep_efficiency`、`disturbance_count`、`spo2`、`skin_temp`、`strain`。

---

## D. `weekOverWeek` 前週平均為 0 時 direction 誤判為 `flat`

**嚴重度：低（真的是 bug，但幾乎踩不到）**

### 程式碼（`src/analyze.js`）

```js
/** 上週 vs 前週的變化（正數 = 上週比前週高）。 */
export function weekOverWeek(lastWeek, prevWeek) {
  const out = {};
  for (const key of WEEKLY_KEYS) {
    const a = lastWeek.averages[key]?.mean ?? null;
    const b = prevWeek.averages[key]?.mean ?? null;
    if (a === null || b === null) {
      out[key] = { delta: null, pct: null, direction: 'unknown' };
      continue;
    }
    const delta = a - b;
    const pct = b > 0 ? (delta / b) * 100 : null;
    out[key] = {
      delta,
      pct,
      direction: Math.abs(pct ?? 0) < 2 ? 'flat' : (delta > 0 ? 'up' : 'down'),
    };
  }
  return out;
}
```

顯示端（`src/format.js`）：

```js
function wowSuffix(w, key) {
  if (!w || w.delta === null) return '（前週無資料可比）';
  // 時間類指標用分鐘講，比百分比直觀（睡眠債基準小，百分比會失真）
  if (key === 'sleep_debt' || key === 'sleep_total') {
    const min = Math.round(w.delta / 60000);
    if (Math.abs(min) < 10) return '（與前週差不多）';
    return `（比前週${min > 0 ? '多' : '少'} ${Math.abs(min)} 分）`;
  }
  if (w.direction === 'flat') return '（與前週差不多）';
  const arrow = w.direction === 'up' ? '↑' : '↓';
  return `（${arrow} 比前週 ${Math.abs(w.pct).toFixed(0)}%）`;
}
```

`WEEKLY_KEYS = ['recovery_score', 'sleep_performance', 'sleep_total', 'sleep_debt', 'hrv', 'rhr']`

### 現象

前週平均 `b` 恰好為 0 時：`pct = null` → `Math.abs(pct ?? 0)` = `Math.abs(0)` = 0 → `0 < 2` 為真 → `direction = 'flat'`，即使 `delta` 很大。

### 影響評估

- `recovery_score` / `hrv` / `rhr` / `sleep_performance` / `sleep_total` 的週平均**不可能為 0**（除非完全沒資料，但那條路徑已經被 `a === null || b === null` 攔掉了）
- `sleep_debt` **有可能是 0**（睡眠債加成為 0 是正常的），但它在 `wowSuffix` 走「用分鐘講」的分支，用的是 `delta` 不是 `direction`

所以目前實際上踩不到。但如果以後有人加了新的 `WEEKLY_KEYS`（例如某個可能為 0 的計數型指標），或改了 `wowSuffix` 的分支，就會靜默出錯。

### 我的建議

改成明確處理 `pct === null` 的情況：

```js
direction: pct === null
  ? (delta === 0 ? 'flat' : (delta > 0 ? 'up' : 'down'))
  : (Math.abs(pct) < 2 ? 'flat' : (delta > 0 ? 'up' : 'down')),
```

### 要你判斷

1. 這個修法對嗎？還是有更好的處理（例如 `direction: 'unknown'` 更誠實，因為 0 → 5 的百分比變化在數學上是無限大）？
2. `< 2%` 這個 flat 門檻是寫死的。對 HRV 這種天生波動大的指標，2% 是不是太敏感？

---

## E. 字串截斷可能切斷 emoji 的 surrogate pair

**嚴重度：低**

### 程式碼

`src/format.js`：

```js
/** 超過 4096 字元時，從教練文字尾端裁掉（數據永遠保留）。 */
export function clamp(text, max = TELEGRAM_MAX_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
```

`src/telegram.js`：

```js
async function send(text) {
  const body = text.length > TELEGRAM_MAX_CHARS
    ? `${text.slice(0, TELEGRAM_MAX_CHARS - 3)}...`
    : text;
  // ...
}
```

`TELEGRAM_MAX_CHARS = 4096`

另外還有第三層 —— 教練文字的硬上限（daily 900 / weekly 1400 字元），它比較講究，會在句子邊界收尾：

```js
function capCoachText(text, max) {
  if (!text) return null;
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'),
  );
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}
```

### 現象

JS 字串是 UTF-16。Emoji（例如 🔴 U+1F534、💪 U+1F4AA）是 surrogate pair，佔 2 個 code unit。`slice(0, 4093)` 如果剛好切在 pair 中間，會產生一個孤立的 surrogate（無效字元）。

訊息裡 emoji 很多（每行指標開頭都有一個，燈號 🟢🟡🔴⚠️ 也是）。

### 影響評估

要同時滿足：訊息真的超過 4096 字元，**而且**第 4093 個 code unit 剛好落在 emoji 中間。因為前面已經有三層長度保護（教練文字 900/1400 上限、趨勢最多 3 行），實際上很難超過 4096。

### 我的建議

用 `Array.from()` 或 `[...text]` 按 code point 切，或用 `Intl.Segmenter`：

```js
export function clamp(text, max = TELEGRAM_MAX_CHARS) {
  if (text.length <= max) return text;
  const cut = [...text].slice(0, max - 3).join('');
  return `${cut}...`;
}
```

### 要你判斷

1. 這樣改對嗎？（注意 `[...text]` 按 code point 切，但仍可能切斷 ZWJ 組合的 emoji 家族，例如 👨‍👩‍👧。訊息裡沒有這種 emoji，需不需要用 `Intl.Segmenter` 做到 grapheme 層級？）
2. Telegram 的 4096 上限到底是算 **UTF-16 code unit** 還是 **UTF-8 byte** 還是 **grapheme**？如果是 UTF-8 byte，那中文訊息現在的長度計算方式（`text.length`）本身就低估了，這才是更嚴重的問題 —— 一則 4000 字中文訊息大約是 12000 UTF-8 bytes。

---

## F. `buildRecords` 用嚴格 `s.nap === false`

**嚴重度：低（但取決於 WHOOP API 的保證）**

### 程式碼（`src/analyze.js`）

```js
/**
 * 主睡眠(nap===false) + 對應的 recovery(sleep_id 相符) 組成每日紀錄。
 * 依睡眠結束時間新→舊排序。
 */
export function buildRecords({ sleeps = [], recoveries = [], timezone }) {
  const recoveryBySleep = new Map();
  for (const r of recoveries) {
    if (r?.sleep_id) recoveryBySleep.set(String(r.sleep_id), r);
  }

  return sleeps
    .filter((s) => s && s.nap === false && s.end)
    .map((s) => ({
      sleepId: String(s.id),
      date: localDate(s.end, timezone),
      endUtc: new Date(s.end),
      sleep: s,
      recovery: recoveryBySleep.get(String(s.id)) ?? null,
    }))
    .sort((a, b) => b.endUtc - a.endUtc);
}
```

### 現象

如果 WHOOP v2 的某些睡眠紀錄沒有 `nap` 欄位（`undefined`）或回 `null`，那筆會被**整筆丟掉** —— 不只是「不當成主睡眠」，而是完全不存在於系統裡。

連鎖後果：
- 該日不會進 baseline（樣本少一筆）
- 起床偵測拿不到那筆 → 那天不發簡報
- 趨勢的資料點會出現空隙

### 影響評估

`nap` 是 WHOOP v2 sleep 物件的文件欄位，實務上應該都有。但這是「靜默丟資料」型的寫法 —— 出問題時完全沒有 log，只會表現成「那天莫名沒發簡報」。

### 我的建議

改成 `s.nap !== true`（缺欄位時當主睡眠，因為主睡眠是常態），並在 `nap` 不是布林值時寫一行 warn log。

### 要你判斷

1. `!== true` 對嗎？還是保守起見該維持 `=== false`，但加上「發現 `nap` 不是布林」的 warn log？（哪個方向的錯誤代價比較高：把小睡誤當主睡眠 → 簡報用錯資料；還是丟掉主睡眠 → 那天不發簡報。）
2. 你知道 WHOOP v2 API 是否保證 `nap` 一定存在嗎？

---

## G. 起床時間落在 cron 視窗外 → 當天不發

**嚴重度：設計取捨，需要確認是不是刻意的**

### 程式碼

Cron（UTC）：`*/15 21-23,0-7 * * *` ≈ 台灣時間 **05:00–15:45**

起床偵測（`src/analyze.js` → `detectWake`）的第 6 道檢查：

```js
const minutes = minutesBetween(now, latest.endUtc);
if (minutes < WAKE.MIN_MINUTES_AFTER_SLEEP_END) {
  return {
    ready: false,
    reason: 'too_soon',
    minutesSinceWake: Math.round(minutes),
    record: latest,
  };
}
if (latest.date !== today) {
  return { ready: false, reason: 'sleep_not_today', sleepDate: latest.date, record: latest };
}
return { ready: true, record: latest, minutesSinceWake: Math.round(minutes), localDate: today };
```

`latest.date` = 該筆睡眠**結束時間**的當地日期。

### 現象

如果某天台灣時間 16:00 之後才起床（睡到下午、輪班、時差）：

1. 當天 05:00–15:45 的所有 run 都看到「最新睡眠是昨天的」→ `sleep_not_today` → 不發
2. 隔天 05:00 的 run，最新睡眠變成「昨天 16:00 結束的那筆」→ 當地日期是昨天 ≠ 今天 → 又是 `sleep_not_today` → 也不發

所以那天的簡報就永久消失了。

### 影響評估

`sleep_not_today` 那道檢查的原意是「避免拿舊資料重複報成今天」—— 這是對的，不能拿掉。問題是它同時也讓「視窗外起床」變成永久跳過。

實務上使用者是上班族，16:00 後起床應該罕見。但沒有任何 log 或通知會告訴他「今天為什麼沒收到」（`daily_not_ready` 只是 info log）。

### 我的建議（三個方向，我傾向 2）

1. **維持現狀**，只是在 README 寫清楚這個限制
2. **放寬視窗** —— cron 改成全天每 30 分鐘（`*/30 * * * *`），去重機制本來就會擋掉重複。成本是 GitHub Actions 的執行次數變多（但「沒事就 return」的 run 只查 DB，很便宜）
3. **允許補發昨天** —— 把「當地結束日期 === 今天」放寬成「在 N 小時內」，但這會讓「今天」的定義變模糊，去重 key 也要跟著改，複雜度上升不少

### 要你判斷

這是刻意的取捨還是漏洞？如果要修，選哪個方向？（方向 2 有沒有我沒想到的副作用？）

---

## H. `stage` 用「總筆數」決定，但每指標另有 7 筆門檻

**嚴重度：需要確認是否為意圖**

### 程式碼（`src/analyze.js`）

```js
/** 冷啟動分階（寫死）。 */
export function stageFor(validCount) {
  if (validCount < BASELINE.MIN_FOR_LIGHTS) return 'cold';        // 7
  if (validCount < BASELINE.TARGET_SAMPLES) return 'provisional'; // 30
  return 'full';
}

export function evaluateMetric({ metric, record, cycle, baselines, stage }) {
  const calibrating = metric.source === 'recovery' && isCalibrating(record);
  const value = metric.source === 'cycle'
    ? metric.get(cycle)
    : metricValueFromRecord(metric, record, { allowCalibrating: true });

  const base = baselines[metric.key] ?? { mean: null, n: 0 };
  const enoughSamples = base.n >= BASELINE.MIN_PER_METRIC;   // 7
  const lightsAllowed = stage !== 'cold' && enoughSamples && !calibrating;

  const severity = lightsAllowed ? severityFor(metric.key, value, base.mean) : null;
  // ...
}
```

`stage` 的來源（`src/daily.js`）：

```js
const baseSet = baselineRecords({
  records,
  todayLocalDate: today,
  excludeSleepId: todayRecord.sleepId,
});
const sampleCount = Math.min(baseSet.length, BASELINE.TARGET_SAMPLES);
const stage = stageFor(baseSet.length);
```

而每個指標的 `base.n` 是**各自獨立**算的（`computeBaselines` 對每個指標分別掃過 `baseSet`，收集非 null 值直到滿 30 筆）。

常數：`MIN_FOR_LIGHTS: 7`、`MIN_PER_METRIC: 7`、`TARGET_SAMPLES: 30`

### 現象

兩層門檻可能不一致。例如：

- `baseSet.length = 35` → `stage = 'full'` → 趨勢預警啟用、訊息不顯示「基準建立中」
- 但 `spo2` 這個帳號常常沒回傳 → `baselines.spo2.n = 3` → 不給燈

所以訊息上會出現「大部分指標有燈、少數幾個沒燈」的混合狀態，而且**沒有任何說明為什麼**（`spo2` 是 `dir: 'none'` 本來就不給燈，但如果是 `hrv` 因為樣本不足而沒燈，使用者會困惑）。

訊息尾端只會寫「基準 30/30 筆」—— 那是總筆數，不是那個指標的筆數。

### 影響評估

看起來是刻意的兩層保護（總體成熟度 + 單指標資料量），設計上合理。但：
1. 沒有對使用者說明，混合狀態會造成困惑
2. `MIN_FOR_LIGHTS` 和 `MIN_PER_METRIC` 都是 7，兩個常數同值但語意不同，未來改一個忘了另一個很容易出錯

### 要你判斷

1. 兩層門檻的設計對嗎？還是該簡化成一層？
2. 需不需要在訊息裡標示「這個指標的樣本數不足」？（例如 `❤️ HRV 55ms（樣本不足 4/7）`）
3. 兩個常數同值是巧合還是應該綁在一起？

---

## I. `strain` 的 baseline 取樣集合與其他指標不同

**嚴重度：需要確認**

### 程式碼（`src/analyze.js`）

```js
export function baselineRecords({ records, todayLocalDate, excludeSleepId }) {
  return records.filter((r) => {
    if (r.date === todayLocalDate) return false;
    if (excludeSleepId && r.sleepId === excludeSleepId) return false;
    return r.sleep.score_state === 'SCORED';
  });
}
```

`cycles` 傳進來的是 `completedCycles(rawCycles)`：

```js
export function completedCycles(cycles = []) {
  return cycles
    .filter((c) => c && c.end && c.score_state === 'SCORED' && num(c?.score?.strain) !== null)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
}
```

### 現象

兩個取樣集合的過濾條件不對稱：

| | 其他 14 個指標 | `strain` |
|---|---|---|
| 來源 | `baseSet`（記錄層） | `cyclesDesc`（cycle 層） |
| 排除今天 | ✅ | ❌ 只排除 `excludeCycleId` 那一筆 |
| 要求 sleep SCORED | ✅ | 不適用 |
| 要求 cycle SCORED | 不適用 | ✅（在 `completedCycles`） |

`excludeCycleId` 傳的是「被當成今天『昨日 Strain』顯示的那一筆 cycle」的 id，所以那一筆確實被排除了。但如果 WHOOP 回了一筆「今天已完成」的 cycle 而它不是被顯示的那筆，就會進基準。

### 影響評估

`strain` 是 `dir: 'none'` —— **不給紅黃燈**，只顯示數值與基準。所以錯誤影響僅限於「顯示的基準值稍微偏移」，不會導致誤判。

### 要你判斷

1. 這個不對稱是可接受的（因為 strain 不給燈），還是該對齊？
2. WHOOP 的 cycle 語意上是「一個生理週期」（大致對應一天但不完全），跟以「睡眠結束日」為基準的 record 本來就對不齊。強行對齊有意義嗎？

---

## J. `detectTrends` 的資料點含今天，baseline 不含今天

**嚴重度：刻意設計，但需要確認沒有偏誤**

### 程式碼（`src/daily.js`）

```js
const baseSet = baselineRecords({
  records,
  todayLocalDate: today,
  excludeSleepId: todayRecord.sleepId,
});
const sampleCount = Math.min(baseSet.length, BASELINE.TARGET_SAMPLES);
const stage = stageFor(baseSet.length);

const baselines = computeBaselines({
  records: baseSet,
  cycles: cyclesDesc,
  excludeCycleId: yesterdayCycle?.id ?? null,
});

const metrics = evaluateAll({ record: todayRecord, cycle: yesterdayCycle, baselines, stage });

// 趨勢用「含今天」的連續資料點
const trends = detectTrends({
  records: records.filter((r) => r.sleep.score_state === 'SCORED'),
  baselines,
  stage,
  cycles: cyclesDesc,
});
```

趨勢判定（`src/analyze.js`）：

```js
const sevs = points.map((p) => severityFor(key, p.value, base.mean));
const deviating = (s) => s === 'yellow' || s === 'red';

// A 持續偏低：連續 3 個資料點都超出門檻
const sustainedLow = sevs.every(deviating);

// B 持續惡化：舊→新逐點變差，而且「最新那點已經超出門檻」。
// 後面這個條件很重要：只看單調遞減的話，在基準附近正常波動也會
// 隨機湊出 3 點連續下降（機率約 1/6），每天都亂報就沒人看了。
const chron = [...points].reverse().map((p) => p.value);
const monotonic = t.dir === 'higher'
  ? chron[0] > chron[1] && chron[1] > chron[2]
  : chron[0] < chron[1] && chron[1] < chron[2];
const worsening = monotonic && deviating(sevs[0]);
```

### 現象

3 個資料點是「今天 + 前 2 個有值的日子」，但拿來比的 `base.mean` 是「不含今天的最近 30 筆平均」。

### 影響評估

我認為這是**正確的**：
- 判斷「今天是否偏離」時，基準不該包含今天（不然今天的數值會把基準往自己的方向拉，偏離幅度被低估）
- 這跟第 2、3 個資料點的處理方式一致（它們也在 baseline 裡，但 30 筆的平均對單筆不敏感）

但要注意的不對稱：**今天不在 baseline 裡，而前 2 個資料點在**。所以嚴格說，3 個點對照的基準對它們的「自我包含程度」不同。以 30 筆平均來說影響大約是 1/30 ≈ 3.3%，而黃燈門檻是 7–8%，量級上不至於翻轉判定，但不是零。

### 要你判斷

1. 這個不對稱可接受嗎？還是趨勢判定該用「各自排除自己」的 leave-one-out 基準（實作會複雜不少）？
2. 有沒有更標準的做法？（例如趨勢改用 z-score 或滾動中位數，而不是拿每個點各自跟固定平均比）

---

## K. `claimErrorNotify` 不是原子操作

**嚴重度：低**

### 程式碼（`src/db.js`）

```js
/** 回傳 true 表示「可以通知」，同時記錄這次通知時間。 */
async function claimErrorNotify(errorType, cooldownHours) {
  const now = Date.now();
  const rs = await client.execute({
    sql: 'SELECT last_notified_at, hits FROM error_notifications WHERE error_type = ?',
    args: [errorType],
  });
  const row = rs.rows[0];
  if (row) {
    const last = new Date(row.last_notified_at).getTime();
    if (Number.isFinite(last) && now - last < cooldownHours * 3600_000) {
      await client.execute({
        sql: 'UPDATE error_notifications SET hits = hits + 1 WHERE error_type = ?',
        args: [errorType],
      });
      return false;
    }
  }
  await client.execute({
    sql: `INSERT INTO error_notifications (error_type, last_notified_at, hits)
          VALUES (?, ?, 1)
          ON CONFLICT(error_type) DO UPDATE SET
            last_notified_at = excluded.last_notified_at, hits = 1`,
    args: [errorType, new Date(now).toISOString()],
  });
  return true;
}
```

Schema：

```sql
CREATE TABLE error_notifications (
  error_type       TEXT PRIMARY KEY,
  last_notified_at TEXT NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 1
);
```

用途：同一 `error_type` 在 2 小時內最多通知一次，避免每 15 分鐘洗版。

### 現象

先 SELECT 再 UPSERT，中間有時間窗口。兩個並行的 run 可能都讀到「已經超過 2 小時」→ 都發通知。

### 影響評估

實務上排程器（GitHub Actions 的 `concurrency` group / Render cron）保證同一時間只有一個 run，所以撞不到。最壞後果也只是「多收一則重複的錯誤通知」。

### 我的建議

可以用一次條件式 UPDATE 做到原子：

```sql
UPDATE error_notifications
   SET last_notified_at = ?, hits = 1
 WHERE error_type = ?
   AND last_notified_at < ?     -- now - cooldown
```

看 `rowsAffected` 是否為 1 來決定要不要通知；為 0 再判斷是「不存在」（要 INSERT）還是「在冷卻中」（hits += 1）。

### 要你判斷

1. 為了一個「排程器已經保證不會並行」的情境增加這個複雜度，值得嗎？
2. 如果值得，上面的 SQL 寫法對嗎？（SQLite 的 `UPDATE ... WHERE` 加上 `rowsAffected` 判斷是否可靠？）

---

## L. 註解殘留「Claude」

**嚴重度：文件債，不影響行為**

系統原本直連 Anthropic API，後來改走 OpenRouter（改用 `fetch` 打 OpenAI 格式的 `/chat/completions`，不裝任何 SDK）。以下註解沒跟著改：

```
src/analyze.js:3    * Claude 只把這裡算好的結果講成人話，不參與任何好壞判斷。
src/analyze.js:177  * 判斷完全由這裡決定，Claude 不得改動。
src/daily.js:60     // 4) Claude 只負責講話；掛掉就走 fallback（照樣發數據簡報）
src/format.js:51    * @param {string|null} coachText Claude 的教練文字；null = Claude 掛了走 fallback
src/format.js:97    // Claude 掛掉時 coachText 是 null → 照樣發數據簡報，底下加上 fallback 說明
```

### 要你判斷

改成中性說法（「模型」／「AI 教練」）就好，還是有其他偏好？目前預設模型還是 `anthropic/claude-sonnet-5`（透過 OpenRouter），所以說「Claude」其實不算錯，只是綁死了可替換的實作細節。

---

## M. `engines` 的 Node 下限寫錯

**嚴重度：文件債，實務上碰不到**

### 程式碼

`package.json`：

```json
"engines": { "node": ">=20.6.0" }
```

`src/config.js`：

```js
/** 本機開發：如果有 .env 就載入（Render 上用平台環境變數，不會有 .env）。 */
export function loadDotEnvIfPresent() {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* 沒有 .env 檔就跳過，正常情況 */
  }
}
```

### 現象

`process.loadEnvFile()` 需要 **Node 20.12+ / 21.7+**。在 20.6–20.11 上它會 throw，被 `catch` 靜默吃掉 → `.env` 完全沒載入 → 接著噴一個看起來莫名的「缺少環境變數：WHOOP_CLIENT_ID, ...」，而使用者明明填好了 `.env`。

### 影響評估

開發機是 Node v24、CI 用 22，所以實際碰不到。但這個 catch 把「檔案不存在」（正常）和「Node 版本太舊」（設定錯誤）混在一起，是個診斷陷阱。

### 我的建議

1. `engines` 改成 `">=20.12.0"`
2. `catch` 區分兩種情況 —— 如果 `.env` 檔案存在但 `loadEnvFile` 失敗，寫一行 warn log

### 要你判斷

要不要加第 2 點？（會多一次 `fs.existsSync` 呼叫，換到明確的錯誤訊息。）

---

## 想請你（GPT）回答的

1. **每一項的「要你判斷」小節** —— 尤其 E 的第 2 點（Telegram 的 4096 到底怎麼算）、G 的方向選擇、J 的統計正確性，這三個我最沒把握。
2. **有沒有我漏掉的問題？** 上面貼的都是真實程式碼，如果你看到別的 bug 或設計問題，請直接指出。
3. **優先順序** —— 這 10 項如果只修 3 個，你會修哪 3 個？
