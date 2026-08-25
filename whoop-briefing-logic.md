# WHOOP 每日恢復簡報 — 完整邏輯規格

> 這份文件把整個系統的邏輯完整寫出來，用途是給另一個模型 / 人做邏輯審查。
> 所有數字都是程式裡寫死的實際值，不是示意。
> **狀態：2026-08-24 定稿，準備上線。** 對應 `c42c9f7` + OpenRouter 遷移 + 兩批修正（皆尚未 commit）。
>
> 第 18 章：**A、B、C、F、G、I、L、M 已修完**，內文寫的是修完後的行為。
> **D、H、J、K 刻意延後**，移到 `TODO.md`，不再開新 review。

---

## 0. 一句話說明

每天在使用者（Kelvin）**真正起床後 30 分鐘**，抓 WHOOP 數據、跟他**自己過去 30 筆有效紀錄**的基準比較，由 Node 算出紅黃燈與趨勢，再請 AI 用溫和女教練的口吻把「算好的結論」講成人話，推到 Telegram。每週一另外發一則上週回顧。

**核心設計原則：所有好壞判斷由 Node 決定，AI 只負責講話。** AI 拿到的是已經算好的結論（含「判定：差很多」這種字串），system prompt 明確禁止它自己判斷嚴重度。目的是避免出現「數據綠燈但教練說你很糟」的矛盾。

---

## 1. 執行模型

- 執行環境：Render Cron Job（或 GitHub Actions 作為備案），**無狀態、檔案系統 ephemeral**。
- Cron（UTC）：`*/30 * * * *` —— **全天每 30 分鐘**，48 次/天。刻意全天跑：去重 key 是
  health_date，晚起床 / 跨午夜都要能補發（見 5.1）。
- 每次執行都是完整的 `main()`：判斷有沒有事要做 → 有才做 → 結束。
- 所有跨執行狀態存 Turso（libSQL），**絕不寫檔案**。
- 同一時間只允許一個 run（Render cron 天然序列化；GitHub Actions 用 `concurrency` group）。

### 為什麼是 polling 而不是 webhook
WHOOP 的 recovery 分數不是起床瞬間就有，會延遲數分鐘到數十分鐘。用全天 30 分鐘 polling + health_date 去重，比接 webhook 簡單且不需要公開端點。

### 成本控制
執行前還不知道最新睡眠屬於哪個 health_date，所以無法精確判斷「有沒有事要做」。保守的快速返回條件是：

```
今天的 daily 已 SENT  且  昨天的 daily 已 SENT  且  週報不待發（非週一，或本週週報已 SENT）
```

三者都成立才快速返回（只查 DB，不打 WHOOP）。**「週報不待發」一定要算進去**，否則週一 daily 發完後會永久跳過週報。

代價：若某天完全沒資料（沒戴錶），那天的 health_date 永遠不會 SENT，所以**隔天**會全天輪詢（約 48 次 × 2 個 API 呼叫 = 96 次/天，WHOOP 上限 10,000 次/天，綽綽有餘）。再隔一天就恢復快速返回。

真的要發報告了才抓 45 天歷史。

---

## 2. 外部依賴

| 依賴 | 用途 | 認證 | 失敗時 |
|---|---|---|---|
| WHOOP API v2 | 睡眠 / 恢復 / 生理週期資料 | OAuth2，token 存 Turso | 發 Telegram 錯誤通知，本輪不發簡報，30 分鐘後重試 |
| Turso (libSQL) | token、發送紀錄、錯誤冷卻 | `TURSO_AUTH_TOKEN` | 同上 |
| OpenRouter | AI 教練文字 | `Authorization: Bearer` | **照樣發純數據簡報**，底下加 fallback 說明 |
| Telegram Bot API | 推送 | bot token in URL | 只寫 log，絕不遞迴再呼叫 Telegram |

### 環境變數

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `WHOOP_CLIENT_ID` | ✅ | — | |
| `WHOOP_CLIENT_SECRET` | ✅ | — | |
| `WHOOP_REDIRECT_URI` | 只有授權腳本需要 | `http://localhost:8788/callback` | 必須與 WHOOP 後台完全一致 |
| `OPENROUTER_API_KEY` | ✅ | — | |
| `OPENROUTER_MODEL` | | `anthropic/claude-sonnet-5` | 要帶 namespace |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | |
| `TELEGRAM_CHAT_ID` | ✅ | — | |
| `TURSO_DATABASE_URL` | ✅ | — | |
| `TURSO_AUTH_TOKEN` | ✅ | — | |
| `TIMEZONE` | | `Asia/Taipei` | |
| `DRY_RUN` | | — | 設 `1` 時 Telegram 只印在畫面 |
| `PROBE_DAYS` | | `14` | 只有診斷腳本 `npm run probe` 用 |

**WHOOP 的 access/refresh token 不走環境變數**，只存 Turso。

---

## 3. 模組職責

| 檔案 | 職責 | 純函式？ |
|---|---|---|
| `src/index.js` | 進入點。判斷 due、串起所有元件、頂層錯誤處理 | ✗ |
| `src/config.js` | **唯一的設定來源**：門檻、常數、指標登錄表、env 載入 | 部分 |
| `src/time.js` | 時區工具。local date / 週區間 / 顯示格式 | ✅ |
| `src/db.js` | Turso 持久化。schema、token、發送紀錄、錯誤冷卻 | ✗ |
| `src/whoop.js` | OAuth + API client。token 生命週期、分頁、重試 | ✗ |
| `src/dataSource.js` | 資料取用層（lazy + 記憶化），daily/weekly 共用同一份歷史 | ✗ |
| `src/analyze.js` | **所有數值判斷**：整理紀錄、起床偵測、baseline、嚴重度、趨勢、週統計 | ✅ |
| `src/daily.js` | 每日流程編排 + `buildBriefing`（純函式） | 混合 |
| `src/weekly.js` | 每週流程編排 | ✗ |
| `src/maintenance.js` | 運維提醒（60 天無 commit 會停用排程） | ✗ |
| `src/coach.js` | OpenRouter 呼叫、system prompt、把結論轉成模型輸入 | 混合 |
| `src/format.js` | Telegram 訊息組裝 | ✅ |
| `src/telegram.js` | 推送 + 錯誤通知冷卻 | ✗ |
| `src/logger.js` | 結構化 log（一行一 JSON），自動遮蔽 secret | ✗ |

---

## 4. 主流程（`index.js` → `main({ now })`）

```
1. loadDotEnvIfPresent()        本機有 .env 就載入（雲端沒有）
2. loadEnv()                    缺任何必填變數就 throw
3. db.migrate()                 CREATE TABLE IF NOT EXISTS ×3 + index ×2
4. today     = localDate(now, TZ)
   yesterday = addDays(today, -1)
   weekKey   = completedWeeks(now, TZ).last.key    // 上週一的日期字串
   dailySettled = db.isSent('daily', today) && db.isSent('daily', yesterday)
   weeklyDue    = localWeekday(today) === 1 && !db.isSent('weekly', weekKey)
5. if (dailySettled && !weeklyDue) → return（完全不打 WHOOP API）
6. 建 whoop client → 先 await whoop.getAccessToken()
   （刻意先做：把 refresh 序列化，避免後面平行請求同時 refresh）
7. 建 dataSource（記憶化）、coach、ctx
8. if (!dailySettled) try { runDaily(ctx) } catch → 記 error + 發錯誤通知
9. if (weeklyDue) try { runWeekly(ctx) } catch → 記 error + 發錯誤通知
10. finally db.close()
```

**關鍵不變式：daily 與 weekly 完全獨立。** daily 已 SENT 不會讓程式提早 return 而跳過 weekly；daily 失敗也不影響 weekly。兩者各自去重、各自 retry。

外層 try 包住 3–9，捕捉的是「基礎設施層」失敗（Turso / token / env）→ 發 `bootstrap` 錯誤通知。

`main()` 回傳 `{ daily, weekly, errors[] }`。CLI 模式下 `errors.length ? exit(1) : exit(0)`。

---

## 5. 每日簡報流程（`daily.js` → `runDaily`）

```
1. 輕量 polling：source.poll() 抓最近 5 天的 sleeps + recoveries
   → buildObservations()：每個 health_date 一筆（同日多筆取 sleep.end 最晚那筆）
2. detectWake(...) → 不 ready 就 return 'not_ready'（附 reason）
3. healthDate = wake.healthDate
   去重：if (db.isSent('daily', healthDate)) → return 'already_sent'
   ← 順序刻意是「先 poll 才去重」：health_date 是從最新那筆睡眠算出來的，
     沒抓資料就不知道要用哪個 key。「完全沒事做」的快速返回在 index.js。
4. 準備發了 → source.history() 抓 45 天 sleeps + recoveries + cycles
5. buildBriefing(...)  ← 純函式，算完所有數字
6. coach.daily(briefing) → 文字 or null（失敗不拋錯）
7. renderDaily(briefing, coachText) → Telegram 純文字
8. telegram.send(text)
   失敗 → db.recordRun({ status:'FAILED' }, { throwOnError:false })
          TelegramError → 只寫 log，return 'telegram_failed'（不遞迴通知）
          其他錯誤 → 往上拋
9. 成功之後才記錄（刻意分開 —— 見下）
   db.recordRun({ status:'SENT', detail: coachText ? null : 'coach_fallback' })
   寫入失敗 → **不算發送失敗**（訊息已經出去了，收不回來），
              log.error + 發一則「下一輪可能重複發送」的警告，
              回傳 { status:'sent', recorded:false }
```

**為什麼第 8、9 步要分開：** 訊息一旦送出就收不回來。如果把「紀錄寫入」跟「發送」放在同一個 try 裡，Turso 短暫故障會讓一次**成功的發送**被記成 `FAILED`，而且下一輪 `isSent` 回 false 又發一次。分開之後，發送與記錄各自的失敗互不污染。

### 5.1 起床偵測（`analyze.js` → `detectWake`）

輸入：`records`（已整理、依睡眠結束時間新→舊）、`now`、`timezone`。
取 `records[0]`（最新一筆主睡眠），依序檢查，任一失敗就回傳對應 reason：

| 順序 | 條件 | 不符時的 reason |
|---|---|---|
| 1 | 有任何主睡眠 observation | `no_main_sleep` |
| 2 | `sleep.score_state === 'SCORED'` | `sleep_not_scored` |
| 3 | 有對應的 recovery（`recovery.sleep_id === sleep.id`） | `recovery_missing` |
| 4 | `recovery.score_state === 'SCORED'` | `recovery_not_scored` |
| 5 | `now - sleep.end >= 30 分鐘`（**直接比 UTC timestamp，不轉時區**） | `too_soon` |
| 6 | `now - sleep.end <= 24 小時`（`WAKE.MAX_AGE_HOURS`） | `sleep_too_old` |

第 5 條：起床後馬上收到訊息很煩，而且 WHOOP 的分數還在算。

**第 6 條取代了舊的「`localDate(sleep.end, TZ) === today`」。** 舊條件會讓下午 4 點才起床
那天永久收不到簡報（當天的 run 都看到「最新睡眠是昨天的」，隔天的 run 又看到「不是今天的」）。
防止舊資料重報現在由兩件事負責：**health_date 去重**（呼叫端查 DB）+ **24 小時期限**。

### 5.1a health_date（全系統的「哪一天」）

`health_date` = 主睡眠 `sleep.end` 換算到 `TIMEZONE` 的日期。**不是執行當下的日期。**

daily 的**顯示日期、baseline 排除、去重 key、`report_runs` 紀錄**全部用同一個 health_date。
每週回顧的 week key（上週一）與它**完全獨立**。

同一個 health_date 若有多筆主睡眠（分段睡、補眠），一律取 `sleep.end` **最晚**的那一筆當代表
（`buildObservations`）—— daily 觸發、趨勢、baseline、Strain 對應全部共用這條規則，所以不會
出現「顯示用了 A 筆、趨勢用了 B 筆」而湊出假趨勢。

### 5.2 資料整理（`analyze.js`）

**`buildRecords({ sleeps, recoveries, timezone })`** → 一筆主睡眠一筆紀錄：
- 過濾條件：`s.end` 存在，且 `s.nap === false`（**嚴格 `=== false`**）
- `s.nap` 不是布林 → 寫一行 `sleep_nap_not_boolean` warn log（只記 `sleep_id` 與 `typeof`），
  該筆仍然排除 —— 資料不完整就不去猜它是不是主睡眠
- `date` / `healthDate` 都 = `localDate(s.end, TZ)`（同值，`healthDate` 是之後一律該用的名字）
- 用 `recovery.sleep_id` 對應 recovery（Map lookup），對不到就是 `null`
- 依 `endUtc` **新→舊**排序

**`buildObservations(...)`** → **每個 health_date 一筆**（新→舊）：以 `buildRecords` 為基礎，
同一個 health_date 取 `sleep.end` **最晚**的那一筆。daily 觸發、趨勢、baseline、Strain 對應
全部用這一份，口徑一致。

**`isValidHealthDay(obs)`** → 該健康日是否完整可用：睡眠 SCORED **且** 有 recovery **且**
recovery SCORED **且** 不在校正期。趨勢的連續性判斷用它。

**`completedCycles(cycles)`** → 已完成的生理週期：
- 過濾：`c.end` 非 null（進行中的 cycle `end` 是 null）且 `score_state === 'SCORED'` 且 `score.strain` 是有限數字
- 依 `end` 新→舊排序

**`yesterdayCycleFor(obs, cyclesDesc)`** → 該健康日的「昨日 Strain」對應哪顆 cycle：
- `cycle.end <= obs.endUtc` 之中**最近**的那一顆（單向 —— 結束在起床之後的不算）
- 且不能比 `sleep.end` 早超過 `STRAIN.MAX_CYCLE_AGE_MS`（48 小時），太舊回 `null`
- 找不到回 `null`，**不會**退回用睡眠之後的 cycle 補
- 今日顯示值與歷史 baseline 呼叫的是同一個函式

### 5.3 `buildBriefing`（純函式，dry-run 與測試共用）

```
observations = buildObservations(sleeps, recoveries, TZ)   ← 每個 health_date 一筆
todayRecord  = observations.find(healthDate === healthDate 參數)
               ?? observations.find(sleepId === wakeSleepId)
               ?? observations[0]
               （找不到任何主睡眠 → throw）
reportDate   = healthDate 參數 ?? todayRecord.healthDate

cyclesDesc     = completedCycles(cycles)
yesterdayCycle = yesterdayCycleFor(todayRecord, cyclesDesc)   ← 單向、48h 內

baseSet     = baselineRecords({ records: observations, healthDate: reportDate,
                               excludeSleepId: todayRecord.sleepId })
sampleCount = min(baseSet.length, 30)
stage       = stageFor(baseSet.length)

baselines   = computeBaselines({ records: baseSet, cycles: cyclesDesc })
              ← strain 也走 yesterdayCycleFor，跟今日顯示值同一個口徑
metrics     = evaluateAll({ record: todayRecord, cycle: yesterdayCycle,
                            baselines, stage })
trends      = detectTrends({ observations, baselines, stage,
                             anchorDate: reportDate })   ← 從報告日往回逐日相鄰
```

回傳 `{ kind:'daily', healthDate, localDate（同值）, sleepId, cycleId, stage, sampleCount, baselineTotalRecords, metrics, baselines, trends }`。

---

## 6. Baseline 演算法

### 6.1 取樣集合（`baselineRecords`）

從 45 天的紀錄中排除：
1. `r.healthDate === reportDate`（**一律不含本次報告的健康日** —— 不然當天數值會把基準往自己拉）
2. `r.sleepId === excludeSleepId`（被評估的那一筆）
3. `r.sleep.score_state !== 'SCORED'`

小睡（`nap === true`）在 `buildRecords` 階段就已排除。

### 6.2 冷啟動分階（`stageFor`）

| 有效紀錄數 | stage | 行為 |
|---|---|---|
| `< 7` | `cold` | **只顯示數值**，不顯示基準、不給紅黃燈、不做趨勢 |
| `7 ~ 29` | `provisional` | 顯示基準與燈，訊息標「基準建立中 n/30」 |
| `>= 30` | `full` | 完整功能，趨勢預警才啟用 |

### 6.3 每個指標各自取樣（`computeBaselines`）

**重點：基準是「最近 30 筆有效紀錄」，不是「30 個日曆天」。** 缺資料的日子（沒戴錶、沒同步）不該算進去，所以抓最近 45 天再挑出最近 30 筆有效的。

對每個非 cycle 來源的指標，**各自獨立**掃過 `baseSet`（新→舊），收集非 null 值直到滿 30 筆，取算術平均。所以不同指標的樣本數可能不同（例如 spo2 這個帳號常常沒值 → n 較小）。

`metricValueFromRecord(metric, record)` 的取值規則：
- `source === 'sleep'` → `metric.get(record.sleep)`
- `source === 'recovery'` → 三個 gate，任一不過回 `null`：
  1. `record.recovery` 存在
  2. `record.recovery.score_state === 'SCORED'`
  3. `record.recovery.score.user_calibrating !== true`（WHOOP 校正期的數字不可信）
     —— **但這條可以用 `allowCalibrating: true` 關掉**，見下面 7.3
- 其他 → `null`

**`strain` 走的是 observation mapping**：對每一筆 baseline observation 呼叫
`yesterdayCycleFor(obs, cyclesDesc)`（跟今日顯示值**完全相同**的函式）取出該健康日的昨日
Strain，收集最近 30 筆非 null 值。某個歷史健康日找不到就跳過，不退回用睡眠之後的 cycle 補。
`baseSet` 已排除本次報告的 health_date，所以不會混進今天。

回傳格式：`{ [metricKey]: { mean, n, samples[] } }`，沒有樣本時 `{ mean: null, n: 0 }`。

---

## 7. 三級嚴重度（`severityFor`）

三種比較方向，由 `THRESHOLDS[key].dir` 決定：

| dir | 公式 | 判定 |
|---|---|---|
| `higher`（越高越好） | `pct = (value - base) / base × 100` | `pct < red` → 🔴；`pct < yellow` → 🟡；else 🟢 |
| `lower`（越低越好） | 同上 | `pct > red` → 🔴；`pct > yellow` → 🟡；else 🟢 |
| `absMin` | `diffMin = (value - base) / 60000` | `diffMin >= red` → 🔴；`>= yellow` → 🟡；else 🟢 |
| `none` | — | 一律回 `null`（只顯示數值與差異，不給燈） |

**回 `null`（不給燈）的情況：**
- `THRESHOLDS[key]` 不存在或 `dir === 'none'`
- `value === null` 或 `baselineMean === null`
- `dir` 是 `higher`/`lower` 且 `baselineMean <= 0`（避免除以 0 或負基準）

`absMin` 存在的理由：睡眠債基準可能是 0，除以 0 會爆，所以改用絕對分鐘差。

### 7.1 完整門檻表

| key | 顯示名稱 | dir | 🟡 門檻 | 🔴 門檻 |
|---|---|---|---|---|
| `recovery_score` | 恢復 | higher | `< -8%` | `< -18%` |
| `hrv` | HRV | higher | `< -7%` | `< -15%` |
| `rhr` | 靜息心率 | lower | `> +5%` | `> +10%` |
| `respiratory_rate` | 呼吸率 | lower | `> +4%` | `> +8%` |
| `sleep_total` | 睡眠 | higher | `< -8%` | `< -18%` |
| `slow_wave` | 深睡 | higher | `< -8%` | `< -18%` |
| `rem` | REM | higher | `< -8%` | `< -18%` |
| `sleep_performance` | 睡眠表現 | higher | `< -8%` | `< -18%` |
| `sleep_consistency` | 睡眠一致性 | higher | `< -8%` | `< -18%` |
| `sleep_efficiency` | 睡眠效率 | higher | `< -8%` | `< -18%` |
| `disturbance_count` | 擾動次數 | lower | `> +8%` | `> +18%` |
| `sleep_debt` | 睡眠債加成 | absMin | `>= +30 分` | `>= +90 分` |
| `spo2` | 血氧 | none | — | — |
| `skin_temp` | 皮膚溫度 | none | — | — |
| `strain` | 昨日 Strain | none | — | — |

### 7.2 兩層樣本數門檻（`evaluateMetric`）

給燈需要**同時**滿足：
1. `stage !== 'cold'`（整體有效紀錄 >= 7 筆）
2. `baselines[key].n >= 7`（`BASELINE.MIN_PER_METRIC`，該指標自己的樣本數）

所以就算整體 stage 是 `full`，某個常常缺值的指標（例如 spo2）樣本數不足 7 也不會給燈。

`pct` / `diff` 的計算與是否給燈**無關**：只要 `value` 與 `base.mean` 都非 null 就算 `diff`；`base.mean > 0` 才算 `pct`。

單一指標的輸出：
```
{ key, label, emoji, tier, available, value, display,
  baseline, baselineDisplay, baselineN, pct, diff, severity, calibrating, scored }
```

### 7.3 WHOOP 校正期（`user_calibrating`）

校正期的 recovery 數字不可信，但「不可信」與「不存在」是兩件事：

| 用途 | 校正期的 recovery 值 |
|---|---|
| baseline 取樣 | **排除**（會污染基準） |
| 趨勢預警的資料點 | **排除**（會產生假警報） |
| 每週平均 | **排除** |
| **今天的顯示值** | **保留** —— 數值照顯示，但 `severity` 強制為 `null` |

實作方式：`metricValueFromRecord(metric, record, { allowCalibrating })` 預設 `false`（排除），只有 `evaluateMetric` 傳 `true`。同時 `evaluateMetric` 會把 `calibrating: true` 放進輸出，並讓 `lightsAllowed = stage !== 'cold' && enoughSamples && !calibrating`。

原則跟 `cold` stage 一致：**顯示數據，不做判斷。**

---

## 8. 指標登錄表（`config.js` → `METRICS`）

`tier: 'core'` = 一定顯示（缺資料就標「無資料」）；`tier: 'optional'` = 有值才顯示（這個 WHOOP 帳號沒回傳就整行不出現）。

| key | 來源 | 取值路徑 | 顯示格式 | tier |
|---|---|---|---|---|
| `recovery_score` | recovery | `score.recovery_score` | `66%` | core |
| `strain` | cycle | `score.strain` | `12.3` | core |
| `hrv` | recovery | `score.hrv_rmssd_milli` | `55ms` | core |
| `rhr` | recovery | `score.resting_heart_rate` | `51bpm` | core |
| `respiratory_rate` | sleep | `score.respiratory_rate` | `14.2` | core |
| `sleep_total` | sleep | **light + slow_wave + REM**（見下） | `7h10m` | core |
| `slow_wave` | sleep | `score.stage_summary.total_slow_wave_sleep_time_milli` | `1h20m` | core |
| `rem` | sleep | `score.stage_summary.total_rem_sleep_time_milli` | `1h45m` | core |
| `sleep_performance` | sleep | `score.sleep_performance_percentage` | `90%` | core |
| `sleep_debt` | sleep | `score.sleep_needed.need_from_sleep_debt_milli` | `+11m` | core |
| `sleep_consistency` | sleep | `score.sleep_consistency_percentage` | `78%` | optional |
| `sleep_efficiency` | sleep | `score.sleep_efficiency_percentage` | `92%` | optional |
| `disturbance_count` | sleep | `score.stage_summary.disturbance_count` | `12 次` | optional |
| `spo2` | recovery | `score.spo2_percentage` | `97.0%` | optional |
| `skin_temp` | recovery | `score.skin_temp_celsius` | `33.5°C` | optional |

**`sleep_total` 的定義（刻意選擇）：** `total_light_sleep_time_milli + total_slow_wave_sleep_time_milli + total_rem_sleep_time_milli`。**不含** awake / no-data，**不用** `total_in_bed_time`。三者全 null 才回 null；部分 null 當 0 加總。

所有取值都經過 `num()`：只接受有限數字，`null` / `undefined` / `NaN` / 字串一律回 `null`。

---

## 9. 趨勢預警（`analyze.js` → `detectTrends`）

**只在 `stage === 'full'`（>= 30 筆正式基準）才啟用**，否則回 `{ enabled: false, alerts: [], level: 'none' }`。

檢查的指標：`hrv`、`rhr`、`respiratory_rate`、`recovery_score`（`TREND.METRICS`）。

對每個指標：

```
1. 從本次報告的 health_date 往回走，取 3 個「逐日相鄰」的健康日資料點（新→舊）。
   任一情況**立即中斷**（回 null，不是跳過那天再往前湊）：
     - 該 health_date 沒有 observation（沒戴錶 / 沒同步）
     - 該日不是完整健康日（睡眠或 recovery 未 SCORED、或 recovery 在校正期）
     - 該指標當天取不到值（null）
2. base = baselines[key]；base.mean 為 null 或 base.n < 7 → 跳過
3. sevs = 3 個點各自對 base.mean 算 severity
4. A「持續偏低」sustainedLow = 三點的 severity 全都是 yellow 或 red
5. B「持續惡化」worsening   = 舊→新單調變差 AND 最新那點的 severity 是 yellow/red
      higher-is-better：chron[0] > chron[1] > chron[2]
      lower-is-better ：chron[0] < chron[1] < chron[2]
6. sustainedLow 或 worsening 任一成立 → 產生一筆 alert
```

**B 後面那個「最新點已超出門檻」的條件是刻意加的。** 只看單調變化的話，在基準附近正常波動也會隨機湊出連續 3 點下降（機率約 1/6），四個指標一起看幾乎每天都會亮，兩天就沒人想看了。

**「連續」是嚴格的日曆連續。** 判定用的是「逐日相鄰的健康日」，中間缺一天就中斷，不會跳過缺日
去湊 3 筆。所以訊息上寫「連續 3 天」是準確的說法。A 與 B 共用同一組資料點與同一套連續性規則。

註：cycle 來源的指標在 streak 裡一律取不到值（會中斷）。目前 `TREND.METRICS` 沒有 cycle 來源的
指標；未來若加入，需要先給它自己的 observation mapping。

### 強度判定

`TREND.STRONG_PAIRS = [['hrv','rhr'], ['hrv','respiratory_rate']]`

- 有 alert 且命中任一組 pair → `level: 'strong'`
- 有 alert 但沒命中 → `level: 'mild'`
- 無 alert → `level: 'none'`

`strong` 會讓訊息標頭變成「📉 趨勢提醒（多項生理訊號同時偏離）」，AI 也會收到「強度：較強，多項生理訊號同時異常」而講得更慎重。

預警**融進當天簡報**，不另外發訊息。

---

## 10. 每週回顧（`weekly.js` + `analyze.js`）

### 10.1 觸發條件（三個都要成立）

1. 今天（當地時間）是**週一**（`WEEKLY.WEEKDAY = 1`）
2. 本週的 weekly 尚未 SENT（週 key = **上週一的日期字串**）
3. **已偵測到起床** 或 **當地時間已過 12:00**（`FALLBACK_SEND_AFTER_HOUR`）

第 3 條的兩半各有用意：前者避免清晨 5 點把訊息丟給還在睡的人；後者保證即使當天沒抓到睡眠（沒戴錶、沒同步）也不會漏掉週回顧。`trigger` 值會記進 DB 的 `detail`（`trigger=wake` 或 `trigger=after_noon`）。

判斷順序上，**先看時間**（`hour >= 12` 直接過關，不打 WHOOP API），才 fallback 去 poll 起床。

### 10.2 週區間定義（`time.js` → `completedWeeks`）

```
thisMonday = today - (localWeekday(today) - 1)
lastMonday = thisMonday - 7      ← 上週（週 key 就是這個）
prevMonday = thisMonday - 14     ← 前週（用來比較）
```

一週 = 週一 `00:00:00.000` ～ 週日 `23:59:59.999`（當地時間）。`endUtc` 用「下週一當地午夜 - 1ms」算，避免邊界重複。

### 10.3 週統計（`weeklyStats`）

**輸入是 `buildObservations`（每個 health_date 一筆），不是 `buildRecords`。** 跟 daily / 趨勢 /
baseline / Strain 對應共用同一套口徑 —— 否則分段睡的那天會被算成兩天（7 天的週回顧顯示
「有效 8 天」，而且那天的數值在平均裡被算兩次）。

篩選：`r.date >= startDate && r.date <= endDate && r.sleep.score_state === 'SCORED'`。
`days` = 符合的 observation 數（= 有效天數，上限 7）。

統計的 6 個指標（`WEEKLY_KEYS`）：`recovery_score`、`sleep_performance`、`sleep_total`、`sleep_debt`、`hrv`、`rhr`。
每個取該週所有非 null 值的算術平均。

最好 / 最差的一天：依 `recovery_score` 排序。**只有 1 天資料時 `best` 有值、`worst` 為 null**（不然同一天會同時是最好和最差）。

`last.days === 0` → 記一筆 `status: 'SKIPPED', detail: 'no_data_last_week'`，不發訊息。

### 10.4 週對週比較（`weekOverWeek`）

```
delta = 上週平均 - 前週平均
pct   = 前週平均 > 0 ? delta / 前週平均 × 100 : null
direction = |pct ?? 0| < 2 ? 'flat' : (delta > 0 ? 'up' : 'down')
```

任一週平均為 null → `{ delta: null, pct: null, direction: 'unknown' }`。

顯示時（`format.js` → `wowSuffix`）：
- `sleep_debt` / `sleep_total` 用**分鐘**講（基準小，百分比會失真）：差 < 10 分 → 「與前週差不多」，否則「比前週多/少 N 分」
- 其他指標用百分比：`flat` → 「與前週差不多」，否則「↑/↓ 比前週 N%」

---

## 11. 訊息組裝（`format.js`）

**一律 plain text，不設 `parse_mode`** —— 避免 Markdown escaping 出包。

### 11.1 每日簡報結構

```
🌅 早安，Kelvin
恢復 66%🟡（基準建立中 12/30）        ← stage 後綴只在非 full 時出現

📊 指標 vs 你的基準                    ← cold stage 時改成「📊 今日指標」
ℹ️ WHOOP 恢復數據還在校正中，...        ← 只在有指標處於校正期時出現
❤️ HRV 42ms（基準 55ms）🟡
💓 靜息心率 58bpm（基準 51bpm）🔴⚠️
...（固定順序，見下）

📉 趨勢提醒（多項生理訊號同時偏離）     ← 有 alert 才出現
· HRV 連續偏離且逐日變差：52ms → 47ms → 42ms
· 靜息心率 逐日變差：51bpm → 55bpm → 58bpm

—
[AI 教練的話]                          ← null 時換成 fallback 說明

8/21（四） · 基準 12/30 筆
```

**固定顯示順序**（`recovery_score` 已在標頭，不重複）：
`hrv, rhr, respiratory_rate, sleep_total, slow_wave, rem, sleep_performance, sleep_debt, sleep_consistency, sleep_efficiency, disturbance_count, spo2, skin_temp, strain`

**行的規則：**
- 不可用（`available === false`）→ `{emoji} {label} 無資料`；但 `tier === 'optional'` 且不可用 → **整行不顯示**
- `stage === 'cold'` → `{emoji} {label} {display}`（不顯示基準、不給燈）
- 否則 → `{emoji} {label} {display}（基準 {baselineDisplay}）{燈}`，基準為 null 時寫「（基準建立中）」

**燈的符號**：`green → 🟢`、`yellow → 🟡`、`red → 🔴⚠️`、`null → 空字串`。

**趨勢區塊**：紅的排前面，最多列 3 項（`MAX_TREND_LINES`），超過就加一行「另有 N 項指標也在偏離」。文案依 types 決定：兩者皆有 → 「連續偏離且逐日變差」；只有 worsening → 「逐日變差」；只有 sustained_low → 「連續 3 天偏離基準」（streak 已保證嚴格連續，所以這句是準確的）。

### 11.2 長度保護（三層）

1. **教練文字硬上限**：daily 900 字元、weekly 1400 字元。超過就在句子邊界（`。！？\n`）收尾；找不到合適斷點（斷點位置 < 上限一半）就直接截斷加 `…`
2. **`clamp`**：整則超過 4096 就從**尾端**裁掉（數據在前面，永遠保留）
3. **`telegram.send`**：再檢查一次 4096，超過截斷加 `...`

設計意圖：**數據永遠不會被裁掉，被犧牲的一定是教練文字。**

### 11.3 fallback 文案

AI 失敗時：`⚠️ AI 教練分析今天暫時無法生成，數據簡報仍正常`

---

## 12. AI 教練呼叫（`coach.js`，走 OpenRouter）

### 12.1 為什麼是 OpenRouter
一把 key 可以換不同模型 / 不同供應商，模型出問題直接改 `OPENROUTER_MODEL`，程式不用動。

OpenRouter **只提供 OpenAI 格式**的 `POST /api/v1/chat/completions`，**沒有** Anthropic 的 `/v1/messages`。所以直接用 `fetch` 打，不裝任何 SDK（整個專案唯一的 runtime 依賴是 `@libsql/client`）。

### 12.2 Request

```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>        ← 不是 x-api-key
Content-Type: application/json
X-Title: whoop-briefing                           ← OpenRouter 的來源標示（選填）

{
  "model": "anthropic/claude-sonnet-5",
  "max_tokens": 1200,                             ← weekly 用 1800
  "messages": [
    { "role": "system", "content": SYSTEM_PROMPT },
    { "role": "user",   "content": <算好的結論> }
  ],
  "reasoning": { "enabled": false }                ← 教練文字不需推理，省 token
}
```

**刻意不設** `temperature` / `top_p` / `top_k` —— 語氣風格完全靠 system prompt 控制。

Timeout 60 秒（`AbortSignal.timeout`）。

### 12.3 參數階梯（`PARAM_TIERS`）

```
[ { reasoning: { enabled: false } },   ← 第一階
  { }                                  ← 第二階（純 messages）
]
```

收到 **400 / 422** 且還有下一階 → 退一階重試。這樣換到不吃 `reasoning` 的模型也不會整份簡報消失。

### 12.4 重試（`send`）

| 狀況 | 行為 |
|---|---|
| 429 / >= 500 | exponential backoff 重試，最多 3 次（`2s → 4s`，上限 30s） |
| 連線錯誤（非 timeout） | 同上 |
| `AbortError` / `TimeoutError` | **不重試**（避免 60s × 3 拖太久） |
| 400 / 422 | 不重試，交給參數階梯處理 |
| 其他 4xx | 不重試，直接拋 |

**OpenRouter 特有的坑：它有時會用 HTTP 200 包一個 `error` 物件**（上游供應商掛掉時）。程式檢查 `json.error` 存在就當失敗，status 取 `error.code`，取不到用 502。

回應非 JSON（例如 gateway 的 HTML 錯誤頁）也會被正確處理成錯誤，不會 crash。

### 12.5 回應解析

`choices[0].message.content`。防禦性處理：正常是字串，少數 provider 會回 content parts 陣列，兩種都吃（`contentToText`）。trim 後為空字串 → 當失敗。

log 記 `model`（實際跑的，OpenRouter 會回）、`param_tier`、`finish_reason`、`prompt_tokens`、`completion_tokens`、`chars`。

### 12.6 失敗策略

`daily()` / `weekly()` **catch 所有錯誤並回 `null`**，絕不往上拋。上層看到 null 就走 fallback，照樣發純數據簡報。

### 12.7 餵給模型的內容（`buildDailyUserMessage`）

**只給算好的結論，絕不給原始 WHOOP payload。** 格式：

```
日期：2026-08-21
基準狀態：正式基準（30 筆）

今日指標（程式已判定）：
- 恢復：66%，基準 72%，-8.3%，判定：偏離
- HRV：42ms，基準 55ms，-23.6%，判定：差很多
- 血氧：無資料                        ← core 才顯示「無資料」，optional 直接略過

趨勢預警（強度：較強，多項生理訊號同時異常）：
- HRV：連續惡化、連續偏低（52ms → 47ms → 42ms）

整體：差很多：HRV；偏離：恢復。
請只輸出要對 Kelvin 說的話本身，不要標題、不要條列數字、不要重複上面的數據表。
```

**`stage === 'cold'` 時不餵基準與判定**（基準還不可信，免得模型拿來評論），`整體：` 那行改成「個人基準還在建立中，這次不做好壞判斷，請以鼓勵與建立習慣為主」。

嚴重度對模型的中文字串：`green → 正常`、`yellow → 偏離`、`red → 差很多`、`null → 未判定`。

### 12.8 System prompt 要點

- 角色：溫暖、專業、體貼的女教練，稱呼「Kelvin」，繁體中文口語
- **禁止自己判斷數值好壞或決定嚴重度**
- 長短依身體狀況決定：全正常就一兩句；有偏離才展開。daily 約 80–180 字，weekly 150–300 字
- 給生活化建議（補水、早睡、放輕鬆），不堆術語
- **是教練不是醫生**：可說「可能是恢復不足、壓力累積」，但不推測特定疾病，不碰中醫概念（如濕氣）
- 多指標同時偏離 → 溫和提醒「若也覺得疲倦或有其他症狀，別硬撐，去看醫生」
- 不重述所有數字（數字已在訊息上方）

---

## 13. WHOOP token 生命週期（`whoop.js`）

**這是整個系統最脆弱的地方**，因為 WHOOP 每次 refresh 都會**輪替 refresh_token**，舊的立刻失效。

### 13.1 取 token（`getAccessToken`）

```
1. loadTokens()：記憶體有快取就用，否則讀 Turso（沒有 → 拋錯叫你跑 authorize）
2. msLeft = expiresAt - now
3. 還有 > 5 分鐘（TOKEN_REFRESH_SKEW_MS）且非 force → 直接重用，不 refresh
4. 需要 refresh：
   - 已經有 refresh 進行中（refreshing 這個 promise）→ 直接回傳它（mutex）
   - 否則發起 doRefresh，存進 refreshing，finally 清掉
```

### 13.2 refresh（`doRefresh`）

```
1. POST /oauth/oauth2/token  grant_type=refresh_token, scope=offline
2. ⚠️ 第一件事：db.saveTokens(新的 access + refresh + expiresAt)
   ← 寫成功前不做任何 WHOOP 資料處理
   ← 寫入失敗會 retry 4 次（500ms → 1s → 2s → 4s），全失敗就拋錯中止本次執行
3. 才更新記憶體快取、才回傳 access token
```

**為什麼順序這麼重要：** 如果拿到新 token 卻沒存下來就去撈資料然後中途掛掉，舊 refresh_token 已失效、新的沒存 → **整個授權死掉**，得重新跑一次授權腳本。所以寧可今天不發簡報，也不要把授權弄壞。

`refresh_token` 缺失時 fallback 用舊的（`fresh.refreshToken ?? t.refreshToken`）。

### 13.3 競態防護（三層）

1. **同一次執行內**：`refreshing` mutex 保證只 refresh 一次
2. **`main()` 開頭先 `await whoop.getAccessToken()`**：把 refresh 移到所有平行請求之前
3. **跨執行**：排程器保證同一時間只有一個 run

跨系統無法真原子，這三層是實務上的折衷。

### 13.4 授權腳本（`scripts/authorize.js`，只跑一次）

標準 OAuth authorization-code flow，沒有偽裝 User-Agent 或任何 workaround：
1. 起一個本機小網站等 WHOOP 導回（預設 `http://localhost:8788/callback`，port 從 redirect URI 解析）
2. 開瀏覽器到授權頁，`state` 用 16 bytes 隨機 hex（WHOOP 要求至少 8 字元）
3. 按 Allow 後拿 code 換第一組 token
4. 寫進 Turso，並檢查有沒有拿到 refresh_token（沒有就提醒 scope 要勾 `offline`）

備案：`node scripts/authorize.js --code <貼上的code>`。

Scope：`offline read:recovery read:sleep read:cycles`（最小集合，注意單複數）。

---

## 14. WHOOP API 存取（`whoop.js`）

### 14.1 分頁（`collect`）

WHOOP v2 的 collection endpoint 每頁最多 25 筆，用 `next_token` 翻頁。

```
do {
  page = apiGet(path, { ...params, limit: 25, nextToken })
  out.push(...page.records)
  nextToken = page.next_token || null
  pages++
  if (pages >= 12 && nextToken) { log.warn('whoop_pagination_capped'); break }
} while (nextToken)
```

`MAX_PAGES = 12` 是安全上限（45 天 × 每天 1~2 筆，12 頁綽綽有餘），避免異常時無限抓。**上限觸發時會寫 warn log，不是靜默截斷。**

### 14.2 單次 GET 的重試（`apiGet`）

| 狀況 | 行為 |
|---|---|
| 網路層失敗 | backoff 重試，最多 4 次（`MAX_RETRIES`） |
| `401` | **強制 refresh 一次**，然後遞迴重試一次；再 401 → 拋 `WhoopAuthError`（refresh_token 已失效，需重新授權） |
| `429` / `>= 500` | 依 `Retry-After` / `X-RateLimit-Reset` 等待，沒 header 就 exponential backoff（`2s → 4s → 8s`，上限 60s + 0~500ms jitter） |
| 其他非 2xx | 直接拋 `WhoopApiError` |

`retryAfterMs` 支援兩種格式：`Retry-After`（秒數）、`X-RateLimit-Reset`（> 10⁹ 視為 epoch 秒，否則視為「還要幾秒」）。

Rate limit 官方值：100 req/分、10,000 req/日。

### 14.3 資料取用層（`dataSource.js`）

**記憶化**：`poll()` 和 `history()` 各自把 promise 存起來，同一次執行內重複呼叫不會重打 API。

| 方法 | 抓什麼 | 區間 |
|---|---|---|
| `poll()` | sleeps + recoveries | 最近 **5 天**（`WAKE.POLL_LOOKBACK_DAYS`） |
| `history()` | sleeps + recoveries + cycles | 最近 **45 天**（`BASELINE.LOOKBACK_DAYS`） |

daily 和 weekly 同一次執行共用同一份 history，不會重複打 API。但兩者的判斷與 retry 仍完全獨立 —— 這層只是共用讀到的資料。

`staticDataSource` 是測試 / dry-run 用的替身。

---

## 15. 資料庫（`db.js`）

### 15.1 Schema

```sql
CREATE TABLE whoop_tokens (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),   -- 只會有一列
  access_token            TEXT NOT NULL,
  refresh_token           TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  scope                   TEXT,
  updated_at              TEXT NOT NULL
);

CREATE TABLE report_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type         TEXT NOT NULL,      -- 'daily' | 'weekly'
  local_date          TEXT NOT NULL,      -- daily: 當天；weekly: 上週一
  sleep_id            TEXT,
  cycle_id            TEXT,
  telegram_message_id INTEGER,
  status              TEXT NOT NULL,      -- 'SENT' | 'FAILED' | 'SKIPPED'
  detail              TEXT,               -- 截斷至 500 字元
  sent_at             TEXT NOT NULL
);

-- 資料庫層級的去重保險：同一天、同一種報告只能有一筆 SENT
CREATE UNIQUE INDEX uniq_report_sent
  ON report_runs (report_type, local_date) WHERE status = 'SENT';

CREATE INDEX idx_report_lookup ON report_runs (report_type, local_date);

CREATE TABLE error_notifications (
  error_type       TEXT PRIMARY KEY,
  last_notified_at TEXT NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 1
);
```

### 15.2 去重不變式

`report_runs` 上的 **partial unique index** 是最後一道防線：就算程式邏輯出錯，資料庫也會擋掉重複的 SENT 紀錄。`daily` 用日期當 key、`weekly` 用「上週一的日期」當 key，兩者天然獨立（`report_type` 不同）。

`recordRun` 把兩種失敗分開處理，這是刻意的：

| 失敗類型 | 判斷方式 | 行為 |
|---|---|---|
| 撞到 `uniq_report_sent` | `isDuplicateSentError(err)` —— message 含 `UNIQUE constraint failed` | warn log，回 `false`。代表「另一個 run 已經送出了」，預期中的安全行為 |
| 其他 DB 錯誤 | 以上皆非 | **重試 3 次**（500ms → 1s），仍失敗就**拋錯**（`throwOnError: false` 時改成 error log + 回 `false`） |

**刻意只認 UNIQUE，不認整個 `SQLITE_CONSTRAINT`**：NOT NULL / CHECK 違反是程式 bug，必須浮出來，不能跟「另一個 run 已送出」混為一談。實測 Turso 回的是 `code: 'SQLITE_CONSTRAINT'` + message 含 `UNIQUE constraint failed: report_runs.report_type, report_runs.local_date`。

記錄「失敗原因」的那幾處（`status: 'FAILED'` / `'SKIPPED'`）一律傳 `throwOnError: false` —— 否則記錄失敗會蓋掉真正要回報的錯誤。

### 15.3 錯誤通知冷卻（`claimErrorNotify`）

同一 `error_type` 在 **2 小時**（`ERROR_NOTIFY_COOLDOWN_HOURS`）內最多通知一次，避免每 30 分鐘洗版。

```
1. SELECT last_notified_at
2. 有紀錄且 now - last < 2h → hits += 1，回 false（不通知）
3. 否則 UPSERT last_notified_at = now, hits = 1，回 true（可以通知）
```

`hits` 保留下來當「這輪錯誤發生幾次」的稽核資訊。

---

## 16. 時區規則（`time.js`）

**三條規則，分得很清楚：**

| 問題類型 | 用什麼算 | 例子 |
|---|---|---|
| **時間長度** | 直接比 UTC timestamp，**絕不轉時區** | 「距離起床是否超過 30 分鐘」 |
| **日曆** | 一律轉成 `TIMEZONE`（預設 `Asia/Taipei`）的 local date | 「今天的簡報發過沒」、訊息上的日期、週區間 |
| **Cron** | 一律用 UTC 設定 | `*/15 21-23,0-7 * * *` |

實作細節：
- 用 `Intl.DateTimeFormat` + `formatToParts`（有 cache），不引任何時區套件
- `localMidnightUtc` **迭代兩次**以正確處理有日光節約的時區（Asia/Taipei 沒有 DST，但不寫死）
- `localWeekday(dateStr)`：1 = 週一 … 7 = 週日
- `prettyDate`：`2026-08-21` → `8/21（四）`

**出差時區的處理：** 沒有任何特例邏輯。去越南（UTC+7）的 1 小時時差，被 05:00–15:45 這個寬視窗吸收掉了。

---

## 17. 失敗模式矩陣

| 壞的東西 | 行為 | 使用者感受 |
|---|---|---|
| OpenRouter / 模型掛了 | `coach.daily()` 回 null → **照樣發數據簡報** + fallback 說明 | 收到簡報，只是沒有教練文字 |
| 模型不吃某個參數（400） | 退一階參數重試 | 無感 |
| OpenRouter 429 / 5xx | backoff 重試 3 次 | 無感（或退化成上面第一列） |
| WHOOP API 掛了 | log + Telegram 錯誤通知，本輪不發，30 分鐘後自動重試 | 簡報晚到 |
| Turso 掛了 | 同上 | 同上 |
| WHOOP token refresh 後 DB 寫入失敗 | **中止本次執行**（寧可不發也不弄壞授權） | 簡報晚到 |
| refresh_token 已失效 | 拋 `WhoopAuthError`，錯誤通知說要重新授權 | 收到錯誤通知，需手動跑 authorize |
| Telegram 掛了 | **只寫 log**，記 `status: 'FAILED'`，絕不遞迴再呼叫 Telegram | 沒收到（下一輪重試） |
| 沒戴錶 / 沒同步 | `detectWake` 回 `no_main_sleep` / `recovery_missing`，安靜跳過 | 沒收到，也沒有雜訊 |
| 上週完全沒資料（weekly） | 記 `status: 'SKIPPED'`，不發訊息 | 沒收到週回顧 |
| 資料不足 7 筆 | `stage: 'cold'`，只顯示數值不給燈 | 收到簡報但沒有紅黃燈 |
| 教練文字失控超長 | 硬上限截斷（daily 900 / weekly 1400），數據永不被裁 | 教練文字被切在句尾 |
| 同一時間兩個 run | unique index 擋掉第二筆 SENT | 不會收到重複訊息 |
| 訊息已送出但紀錄寫不進 Turso | 重試 3 次 → 仍失敗則 **不當成發送失敗**，發一則「下一輪可能重複發送」警告 | 收到簡報 + 一則警告 |

---

## 18. 已知疑點

依嚴重度排序。**A / B / C 已修掉**（下面寫的是修法，請幫我檢查修法對不對）；**D 之後仍待決定**。

### A. `user_calibrating` 的排除同時套用到「今天的數值」 ✅ 已修

`metricValueFromRecord` 同時被 **baseline 取樣**和**今日指標評估**（`evaluateMetric`）呼叫。它會在 `recovery.score.user_calibrating === true` 時回 `null`。

設計意圖（README 寫的）是「基準要排除校正期的不可信數字」。但因為兩處共用同一個函式，**WHOOP 校正期間（換新錶的前幾天）今天的恢復 / HRV / RHR / 血氧 / 皮膚溫度全部會顯示「無資料」**，而 `cold` stage 的設計本意是「顯示數據、只是不給燈」。

**修法：** `metricValueFromRecord` 增加 `allowCalibrating` 選項（預設 `false`，維持排除）。只有 `evaluateMetric` 傳 `true`，所以今天的數值會顯示；同時 `calibrating: true` 讓 `lightsAllowed` 變 false（不給燈），訊息裡多一行「ℹ️ WHOOP 恢復數據還在校正中…」說明為什麼沒有燈，餵給 AI 的內容也會註明「請不要評論這幾項的好壞」。baseline / 趨勢 / 週平均**維持排除**。詳見 7.3。

### B. Telegram 已發送但 `recordRun` 失敗 → 下一輪重複發送 ✅ 已修

`daily.js` 的順序是「先 `telegram.send()`，成功後才 `db.recordRun(SENT)`」。而 `recordRun` **吞掉所有錯誤只回 `false`**（為了讓 unique 衝突變成安全行為）。

所以如果訊息發出去了、但 `recordRun` 因為 Turso 短暫故障而失敗 → 沒有 SENT 紀錄 → 下一輪 `isSent` 回 false → **重複發一則簡報**。

unique index 只保護「紀錄」，不保護「已經送出的訊息」。

**修法：** 兩部分。(1) `recordRun` 用 `isDuplicateSentError` 區分 unique 衝突（安全，回 false）與其他 DB 錯誤（重試 3 次後拋錯）；(2) `daily.js` / `weekly.js` 把「發送」與「記錄」拆成兩個 try —— 發送成功後紀錄寫入失敗**不再被當成發送失敗**，而是 `log.error` + 發一則「下一輪可能重複發送」的 Telegram 警告，回傳 `{ status:'sent', recorded:false }`。重複發送的**根本競態無法完全消除**（訊息送出後才能記錄，中間必然有窗口），但現在至少會大聲喊，不再靜默。

### C. 「連續 3 天偏離基準」的文案與實作不符 ✅ 已修

`detectTrends` 取的是「最近 3 個**有值的資料點**」，不是「最近 3 天」。缺資料的日子（沒戴錶、recovery 未 SCORED、校正期）會被跳過，所以 3 個點可能橫跨 5 天甚至更久。

但 `format.js` 的文案寫的是「連續 3 天偏離基準」。

**修法：** 兩邊都動。(1) 實作加上跨度上限 `TREND.MAX_SPAN_DAYS = 5` —— 3 個資料點橫跨超過 5 個日曆天就不算趨勢（不採用「必須完全連續」，因為漏戴一天不該讓預警永久失效）；(2) 文案依 `spanDays` 決定講法：真的連續才說「連續 3 天偏離基準」，有缺日就說「近 N 天內 3 次偏離基準」。

### D. `weekOverWeek` 前週平均為 0 時 direction 誤判為 `flat`（低）

```js
pct = b > 0 ? (delta / b) * 100 : null
direction = Math.abs(pct ?? 0) < 2 ? 'flat' : ...
```

前週平均恰好為 0 時 `pct` 是 null → `pct ?? 0` = 0 → 判定 `flat`，即使 `delta` 很大。

實務影響很小：recovery / hrv / rhr 不可能為 0；`sleep_debt` 有可能是 0，但它在 `wowSuffix` 走「用分鐘講」的分支，用的是 `delta` 不是 `direction`。

→ 是否該讓 `pct === null && delta !== 0` 時 direction 走 `up`/`down`？

### E. 字串截斷可能切斷 emoji 的 surrogate pair（低）

`format.js` 的 `clamp` 和 `telegram.js` 的長度保護都用 `text.slice(0, max - 3)`。JS 字串是 UTF-16，emoji 是 surrogate pair，切在中間會產生半個無效字元。

訊息尾端剛好是 emoji 且剛好爆 4096 的機率很低，但不是零。

### F. `buildRecords` 用嚴格 `s.nap === false`（低）

如果 WHOOP 某些紀錄的 `nap` 欄位缺失（`undefined`）或是 `null`，那筆睡眠會被**整筆丟掉**，不只是不當主睡眠。

→ 是否該改成 `s.nap !== true`？取決於 WHOOP v2 是否保證每筆都有 `nap`。

### G. 起床時間落在 cron 視窗外 → 當天不發（設計取捨，請確認）

視窗是台灣 05:00–15:45。如果某天 16:00 之後才起床，當天不會發簡報；隔天 05:00 的 run 會因為「最新睡眠的當地結束日期不是今天」（`sleep_not_today`）而跳過。

→ 這是刻意的（避免補發昨天的簡報）還是漏洞？

### H. `stage` 用「總筆數」決定，但每指標另有 7 筆門檻（請確認是否為意圖）

- `stage = stageFor(baseSet.length)` 用**總有效紀錄數**（>= 30 → full）
- 但單一指標給燈另外要求 `baselines[key].n >= 7`

所以可能出現「stage 是 full、趨勢預警啟用，但某個指標因為樣本不足而不給燈」的混合狀態。看起來是刻意設計（兩層保護），但值得確認。

### I. `strain` 的 baseline 取樣集合與其他指標不同（請確認）

其他指標從 `baseSet`（已排除今天、已排除被評估那筆、要求 sleep SCORED）取樣；`strain` 從 `cyclesDesc`（只排除 `excludeCycleId`）取樣。

兩個集合的過濾條件不對稱。`strain` 是 `dir: 'none'` 不給燈，所以影響僅限於顯示的基準值。

### J. `detectTrends` 的資料點含今天，baseline 不含今天（刻意，但請確認）

`buildBriefing` 傳給 `detectTrends` 的 `records` 是**含今天**的（註解明說「趨勢用含今天的連續資料點」），而 `baselines` 是**不含今天**算出來的。

所以今天的值會拿去跟「不含今天的基準」比 —— 這對「今天是否偏離」是正確的，但要確認這不會讓趨勢判定產生偏誤。

### K. `claimErrorNotify` 不是原子操作（低）

先 SELECT 再 UPSERT，中間有窗口。實務上排程器保證同時只有一個 run，所以不會撞。

### L. 註解殘留「Claude」（文件債）

`analyze.js`、`daily.js`、`format.js` 的註解還寫「Claude」，但系統已改走 OpenRouter。不影響行為。

### M. `engines` 的 Node 下限寫錯（文件債）

`package.json` 寫 `node >= 20.6.0`，但 `config.js` 用的 `process.loadEnvFile()` 需要 **Node 20.12+ / 21.7+**。在 20.6–20.11 上 `.env` 會被靜默忽略（try/catch 吃掉），然後噴一個看起來莫名的「缺少環境變數」。實務上碰不到（開發機 v24、CI 用 22），但下限該改成 `>= 20.12.0`。

---

## 19. 測試覆蓋

`npm test`（`node --test test/*.test.js`），共 **99** 個測試。

| 檔案 | 覆蓋 |
|---|---|
| `unit.test.js` | baseline、嚴重度、趨勢（嚴格連續性）、校正期、health_date 補發、多筆睡眠、Strain 單向選取、週統計口徑、訊息組裝 |
| `whoop.test.js` | token 重用 / refresh 順序 / DB 寫入失敗中止 / mutex / 分頁 / 429 backoff / 401 refresh |
| `db.test.js` | schema、去重 unique index、錯誤冷卻、`isDuplicateSentError`、非 unique 錯誤會拋出 |
| `coach.test.js` | request body 形狀、Bearer header、參數階梯退階、429 重試、200-包-error、weekly max_tokens、不洩漏原始 payload |
| `flow.test.js` | daily / weekly 流程分支（含 AI 掛掉走 fallback、已送出但紀錄失敗） |
| `e2e.test.js` | 跑真的 `main()`，攔截 WHOOP / OpenRouter / Telegram 三個外部呼叫，驗證「發一次、第二次不重複發」 |
| `maintenance.test.js` | 60 天排程停用提醒：門檻、冷卻、文案、失敗不影響簡報 |
| `fixtures.js` / `fakes.js` | 45 天假資料產生器、退化情境、假 DB / 假 Telegram / 假教練 |

`npm run dry-run` 用假資料把整條流程跑一遍，把「真的會發到 Telegram 的訊息」印出來（完全離線）。加 `--live` 會真的呼叫 OpenRouter。

---

## 19a. 運維：60 天排程停用提醒（`maintenance.js`）

GitHub 的既有行為：**repo 連續 60 天沒有任何 commit，scheduled workflow 會被自動停用**。
這個失效模式特別惡劣 —— 沒有 run 被觸發，所以不會有任何錯誤通知，系統裡沒有任何東西
知道自己死了，簡報就安靜地停掉。

`checkRepoFreshness({ db, telegram, now, lastCommitAt })`：

```
lastCommitAt 為空（本機 / Render）      → skipped（它們沒有這個問題）
時間字串無法解析                        → skipped + warn log
距今 < 55 天（REPO_FRESHNESS.WARN_AFTER_DAYS）  → fresh，什麼都不做
>= 55 天 → claimErrorNotify('repo_stale', 24h)
             不允許（同一天已提醒過）→ suppressed
             允許 → telegram.send(提醒文字) → notified
任何錯誤（Telegram / DB 掛掉）→ 內部吞掉，回 failed + error log
```

- 天數來源：workflow 用 `git log -1 --format=%cI` 取得，透過 `REPO_LAST_COMMIT_AT` 注入
  （`actions/checkout@v4` 預設 depth=1，取最後一次 commit 的時間就夠）
- 呼叫位置：`main()` 裡 `db.migrate()` 之後、**due 判斷之前** —— 所以「沒事做」的那些 run
  也會檢查
- 冷卻 24 小時（借用 `error_notifications` 表的 `repo_stale` 這個 key）
- **絕不影響簡報**：函式自己不拋錯

---

## 20. 所有寫死的常數（速查）

```js
BASELINE = {
  TARGET_SAMPLES: 30,      // 基準取最近 30 筆有效紀錄
  LOOKBACK_DAYS: 45,       // 抓 45 天再挑 30 筆
  MIN_FOR_LIGHTS: 7,       // < 7 筆不給燈（cold）
  MIN_PER_METRIC: 7,       // 單一指標樣本 < 7 也不給該指標的燈
}

WAKE = {
  MIN_MINUTES_AFTER_SLEEP_END: 30,   // 起床後 30 分鐘才發
  MAX_AGE_HOURS: 24,                 // sleep.end 超過 24 小時就不補發
  POLL_LOOKBACK_DAYS: 5,
}

STRAIN = { MAX_CYCLE_AGE_MS: 48h }   // 昨日 Strain 往「前」最多找多久的 cycle

TREND = {
  WINDOW: 3,                                              // 3 個「逐日相鄰」的健康日
  MIN_STAGE: 'full',                                      // 只有正式基準才做趨勢
  STRONG_PAIRS: [['hrv','rhr'], ['hrv','respiratory_rate']],
  METRICS: ['hrv','rhr','respiratory_rate','recovery_score'],
}

WEEKLY = {
  WEEKDAY: 1,                        // 週一
  FALLBACK_SEND_AFTER_HOUR: 12,      // 過中午就補發
}

COACH = {
  DAILY_MAX_TOKENS: 1200,
  WEEKLY_MAX_TOKENS: 1800,
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
  BASE_URL: 'https://openrouter.ai/api/v1',
  TIMEOUT_MS: 60_000,
  MAX_RETRIES: 3,
  MAX_BACKOFF_MS: 30_000,
}

WHOOP = {
  SCOPES: 'offline read:recovery read:sleep read:cycles',
  PAGE_LIMIT: 25,
  MAX_PAGES: 12,
  TOKEN_REFRESH_SKEW_MS: 5 * 60 * 1000,   // 還有 >5 分鐘就重用
  MAX_RETRIES: 4,
  MAX_BACKOFF_MS: 60_000,
}

ERROR_NOTIFY_COOLDOWN_HOURS = 2

REPO_FRESHNESS = {
  WARN_AFTER_DAYS: 55,        // 幾天沒 commit 就開始提醒
  DISABLE_AFTER_DAYS: 60,     // GitHub 停用排程的門檻（文案用）
  NOTIFY_COOLDOWN_HOURS: 24,  // 一天最多提醒一則
}
TELEGRAM_MAX_CHARS = 4096
COACH_MAX_CHARS = { daily: 900, weekly: 1400 }   // format.js
STALE_CYCLE_MS = 48h                              // daily.js
MAX_TREND_LINES = 3                               // format.js
```
