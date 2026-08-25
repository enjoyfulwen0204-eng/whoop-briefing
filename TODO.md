# 待辦（上線後再處理）

這批是 2026-08-24 定稿時**刻意延後**的項目。編號沿用邏輯規格書第 18 章。
A / B / C / F / G / I / M 已修完並上線；L 順手做了。

---

## D. `weekOverWeek` 前週平均為 0 時 direction 誤判為 `flat`

`src/analyze.js`：

```js
const pct = b > 0 ? (delta / b) * 100 : null;
direction: Math.abs(pct ?? 0) < 2 ? 'flat' : (delta > 0 ? 'up' : 'down'),
```

前週平均恰好為 0 時 `pct` 是 null → `pct ?? 0` = 0 → 判成 `flat`，即使 `delta` 很大。

**目前踩不到**：`WEEKLY_KEYS` 裡 recovery / hrv / rhr / sleep_performance / sleep_total 的週平均不可能為 0；`sleep_debt` 可能為 0，但它在 `wowSuffix` 走「用分鐘講」的分支，用的是 `delta` 不是 `direction`。

**風險**：以後有人加了可能為 0 的新 `WEEKLY_KEYS`，或改了 `wowSuffix` 的分支，就會靜默出錯。

**修法**：`pct === null` 時改用 `delta` 判方向（或回 `'unknown'`，因為 0 → 5 的百分比在數學上是無限大）。

---

## H. `stage` 用「總筆數」決定，但每指標另有 7 筆門檻

- `stage = stageFor(baseSet.length)` 用**健康日總數**（>= 30 → full）
- 單一指標給燈另外要求 `baselines[key].n >= BASELINE.MIN_PER_METRIC`（7）

所以會出現「stage 是 full、趨勢預警啟用，但某個指標因樣本不足而沒燈」的混合狀態，訊息上**沒有任何說明**。而訊息尾端寫的「基準 30/30 筆」是總數，不是那個指標自己的筆數。

另外 `MIN_FOR_LIGHTS` 與 `MIN_PER_METRIC` 都是 7 —— 同值但語意不同，未來改一個忘了另一個很容易出錯。

**可能修法**：樣本不足的指標標註出來（例如 `❤️ HRV 55ms（樣本 4/7，暫不判斷）`），或把兩個常數的關係在 config 裡寫清楚。

---

## J. 趨勢資料點含今天，baseline 不含今天

`buildBriefing` 傳給 `detectTrends` 的 observations 含本次報告的健康日，而 `baselines` 是排除它算出來的。

三個資料點裡「今天」不在 baseline 裡、另兩天在，所以它們對照的基準對自己的「自我包含程度」不同。以 30 筆平均估影響約 1/30 ≈ 3.3%，而黃燈門檻是 7–8%，量級上不至於翻轉判定，但不是零。

**順帶一提**：昨日 Strain 也有同型的自我包含 —— 今天顯示的那顆 cycle，通常也會是「昨天那筆 observation」的 yesterdayStrain 樣本（真實 WHOOP 資料裡 cycle.end ≈ 前一次起床時間）。同樣是 1/30 量級。

**可能修法**：leave-one-out 基準，或趨勢改用 z-score / 滾動中位數。實作複雜度不低，效益待評估。

---

## K. `claimErrorNotify` 不是原子操作

`src/db.js` 先 SELECT 再 UPSERT，中間有窗口。兩個並行 run 可能都發通知。

**目前撞不到**：排程器（GitHub Actions `concurrency` group / Render cron）保證同一時間只有一個 run。最壞後果也只是多收一則重複的錯誤通知。

**可能修法**：改成一次條件式 UPDATE（`WHERE last_notified_at < ?`）看 `rowsAffected`。

---

## E（部分）. Telegram 4096 到底怎麼算

`clamp()` 已經集中成唯一一份（`src/format.js`），發送層另外做 assertion。但兩個問題還沒確認：

1. **Telegram 的 4096 上限是 UTF-16 code unit、UTF-8 byte、還是 grapheme？** 程式用 `text.length`（UTF-16）。如果實際是 UTF-8 byte，一則 4000 字的中文訊息約 12000 bytes，那長度計算就低估了 3 倍。
2. `slice()` 按 UTF-16 切，可能切斷 emoji 的 surrogate pair。

**目前踩不到**：教練文字有硬上限（daily 900 / weekly 1400 字元）、趨勢最多 3 行，實際訊息長度都在 600 字元以內（dry-run 實測 289–592）。真的接近 4096 才需要處理。

---

## N. 同一 health_date 的代表若未評分，該天會落出統計

`buildObservations` 取 `sleep.end` **最晚**那一筆當代表，不看它是否 SCORED。所以「同一天兩筆主睡眠，較晚那筆還沒評分」時，該健康日暫時沒有有效資料 —— 實測週回顧會從 7 天變成 6 天。

**為什麼不改**：這條「一律取最晚那筆」的規則是 daily 觸發、趨勢、baseline、Strain、週統計**共用**的單一口徑，改成「取最晚的有效那筆」會讓 daily 的觸發語意變糊（daily 本來就該等最新那筆評分完才發）。

**為什麼可接受**：WHOOP 通常在一小時內評分完，而週回顧是週一統計**上一整週**，那時早就評分好了。daily 的話下一輪（30 分鐘後）就會重試。

---

## 其他

- **`PROCESSING` lease**：目前不做。第一版明確採 at-least-once（README 有記錄）。若之後要加，只能當稽核或 lease，**永久卡在 `PROCESSING` 不可阻擋後續補發**，也不可描述成 exactly-once。
- **`claimErrorNotify` 被借去做維護提醒的冷卻**：`error_notifications` 表現在也存
  `repo_stale` 這個非錯誤的通知類型。函式名稱略有語意落差，但不值得為此改名churn。
- **`test/fixtures.js` 的 cycle 時間軸偏移**：`500001` 的 `end` 落在 day 0 而不是 day 1（day 1 沒有對應 cycle）。只影響測試資料的直覺性，不影響生產邏輯；寫新的 Strain 測試時要注意。
