# 攝取 / 分析解耦（V1.2 Phase 3）

> 狀態：**已實作、有測試、未接進正式排程器。** index.js 每一輪仍然直接跑預測與
> Healthspan（V1.1 行為不變）。Phase 3 的工作者只能透過本機腳本與測試執行。

## 目標

Phase 4 需要「WHOOP 資料一變，很快就能回應」，但不能每一個 webhook 事件都同步
重算整套分析（預測訓練、Healthspan、相關 / 迴歸）。所以：

```
WHOOP 事件 / 對帳 / 排程同步
  → 權威抓取
  → canonical 交易（墓碑判定 + M-03 + 寫入 + **分析失效**）   ← 同一個 commit
  → 輕量分析（便宜、有界）                                    ← 另一個程序 / 稍後
  → 重量分析（昂貴、延後、有節奏）                              ← 另一個程序 / 30～60 分鐘
```

攝取先把真相存好；分析是**可延後、可重算、可辨識新舊**的衍生工作。

## 攝取端：同交易失效（[src/analyticsInvalidation.js](../src/analyticsInvalidation.js)）

db.js 把 canonical 寫入器 —— `upsertSleeps / upsertRecoveries / upsertWorkouts /
upsertCycles / upsertBodyMeasurement / deleteWhoopResource` —— 各包一層。
**所有寫入者**（V1.1 `createSync`、Phase 1 webhook 處理器、Phase 2 對帳、腳本、
測試）都經過這一層；它呼叫的仍是原本的儲存層函式，M-03 與 ACTIVE 墓碑判定
原封不動。它不是另一個 WHOOP 寫入者。

```
processing.transaction（已在 mutateForWhoopEvent / mutateForReconciliation 交易裡就沿用）
  之前快照  id → (updated_at, health_date)
  原本的 canonical 寫入
  之後快照
  分類每一筆：
    CHANGED    之前沒有 / updated_at 嚴格更新            → markAnalyticsDirty
    UNCHANGED  同版本重放（M-03「相等冪等」）             → 不失效
    BLOCKED    較舊版本被 M-03 擋 / ACTIVE 墓碑擋下復活   → 不失效
    DELETED    權威 DELETE 真的移走一列                    → markAnalyticsDirty(reason=delete)
COMMIT
```

### 崩潰一致性（Phase 3 主要閘門）

canonical 寫入與 `analytics_invalidation` 的更新在**同一個 BEGIN IMMEDIATE 交易**裡。
崩潰在 commit 之前 → 兩者都不在；之後 → 兩者都在。沒有「canonical 提交了、失效
沒提交」這個狀態，所以不需要任何「稍後補記」機制去發現漏掉的失效。
測試用真的子行程：commit 回來後立刻 `SIGKILL` 自己，重開 DB 驗證兩者都在
（P3-ATTACK-01 更新、P3-ATTACK-04 刪除）；交易 rollback 時兩者都不在。

### 語義變化，不是傳輸活動

`updated_at` 是 WHOOP 的來源版本（M-03 已以它為權威）；Phase 3 不引入任何本地時序。
同步重疊窗每小時把同一批資料重放 → generation 不動（P3-ATTACK-13）。
body_measurement 沒有 `updated_at` → 比對當日快照的數值。

### recovery 的日期關聯（P3-AUDIT-F02）

recovery 的 `health_date` 不是它自己的欄位，而是從對應的 sleep **關聯**過來的
（store 的 `relinkRecoveryDates` 在 `upsertRecoveries` 之後改寫整個使用者的列）。
同版本的 recovery 重放因此可能在 `updated_at` 不變的情況下換了日期 —— 那是語義
變化：舊的一天少了一筆、新的一天多了一筆。所以：

- recovery 的快照看**原始的** `health_date`（NULL 就是 NULL）與整個使用者的所有列；
- 關聯改變（NULL→D、D1→D2）→ CHANGED，新舊兩天都進受影響範圍；D→D → 不失效；
- 公開的 `db.relinkRecoveryDates` 也被包起來：真的改了才失效，同一交易；
- `upsertRecoveries` 內部的 relink 已被同一次分類涵蓋，不會重複 +1。

## 失效模型（schema v13，純新增：v12 四張表 + v13 三欄）

| 表 | 用途 |
|----|------|
| `analytics_invalidation` (PK user_id) | `generation` 單調計數；這一代累積的受影響 health_date 範圍（聯集）、資源、原因；`dirty_since`、`last_invalidated_at` |
| `analytics_work_state` (PK user_id, class) | 每個類別成功算到的 `done_generation`、`claimed_generation`、owner + lease、status、退避、失敗來源、`summary_json`；v13：輕量的剩餘範圍 `range_generation / range_from / range_to` |
| `analytics_daily_state` (PK user_id, health_date) | 輕量物化：daily metrics + 當日就緒狀態 + 算它時的 `generation` |
| `analytics_runs` | 執行帳本 |

### 為什麼是 generation 而不是 dirty 旗標

旗標會遺失更新。generation 是單調計數：工作者認領時記住 N，結案只寫
`done_generation = N`（不是「現在的」）。若期間 canonical 又變了（N+1），
`done < generation` 仍成立 → 仍然髒，下一輪再算。**結構上不可能把 N+1 清掉。**
（P3-ATTACK-06；輕量清受影響範圍另加 `generation = N` 的 CAS。）

### 合併

多次變動只是 generation +1 與範圍聯集，一列狀態、不是每個事件一列。
sleep / recovery / workout 同一天連續三次變動 → 一次輕量 + 一次重量（P3-ATTACK-05）。

### 輸出寫入的所有權圍欄（P3-AUDIT-F01）

結案有圍欄還不夠：**輸出本身**也要有。每一筆耐久的分析輸出都在
`mutateForAnalytics({ userId, class, owner, generation })` 的短交易裡寫：
交易開頭與結尾各證明一次「owner 相符、`lease_expires_at > now`（到期時刻算過期）、
`claimed_generation` 相符」，任一不成立 → `analytics_ownership_lost`，整段回滾。
證明與寫入在同一個 `BEGIN IMMEDIATE` 裡，沒有 check 與 write 之間的空隙。

- 輕量：`saveAnalyticsDailyState(uid, rows, { owner, generation, now, clock })` 必帶證明。
- **時間是兩個不同的東西（P3-RC1-F01）**：`now` 是**分析錨點**（health_date 判定、
  就緒狀態、`computed_at`），整輪穩定；`clock` 是**活的時鐘函式**，只給租約證明用，
  before 與 after 各呼叫一次。載入 daily metrics 可能比租約還久，所以持久化當下
  必須重新問「現在還握著嗎」——拿計算開始時捕捉的時刻去證明，等於讓已經過期的
  工作者寫得進去。`mutateForAnalytics` 因此**結構上拒絕** Date：不是函式就拋
  `analytics_live_clock_required`。
- 重量：工作者把 `fencedAnalyticsDb` 視圖交給預測 / Healthspan 模組 ——
  `savePredictionModel / savePrediction / recordPredictionActual /
  saveHealthspanMetrics / saveHealthspanSnapshot` 各自包進 `mutateForAnalytics`。
  計算（訓練、180 天回看）在交易外；只有持久化那一句在圍欄交易裡。
- 失去租約的工作者：0 列寫入，整輪 FENCED（不算失敗、不污染狀態）。
- 在租約有效時已寫入、結案前才過期：那些寫入是**合法的**（寫入當下有所有權），
  保留；結案 FENCED → `done_generation` 不前進 → 讀取端看到 `stale`，下一個
  工作者重算（冪等）。不把合法的圍欄寫入事後當成損壞。
- 輸出被擋下時，分片游標也不會前進（`advanceAnalyticsRange` 同樣帶活時鐘的
  owner / 租約 CAS）：剩餘範圍維持**整段**需要覆蓋的範圍，下一個 owner 從同一個
  上緣接續。**不做任何事後補償刪除。**

## 分析端：兩條邊界（[src/analyticsWorker.js](../src/analyticsWorker.js)）

| | 輕量 `runLightweightAnalysis` | 重量 `runHeavyAnalytics` |
|---|---|---|
| 做什麼 | 受影響日期 ±1 天的 daily metrics 物化（`computeDailyMetrics`）+ 當日就緒狀態（`assessDailyState`） | 預測生產迴圈（訓練 / 時序評估 / 記分卡，180 天）+ Healthspan 盤點（90 天） |
| 為什麼是這一類 | 純 DB 讀 + 確定性計算，不呼叫任何外部服務；每輪最多 `LIGHT_MAX_DAYS`=45 天**一片**，剩餘耐久保留 | 訓練 / 評估整段歷史，與變動範圍無關；V1.1 目前每輪都跑 |
| 失敗語義 | 整輪 all-or-nothing（讀取不完整 → FAILED，不把「讀不到」物化成「沒有」） | 模組各自錯誤邊界（F-02），成功模組輸出保留；**全部**成功才 SUCCESS |
| 節奏 | 髒就做 | 髒 **且** 距上次成功 ≥ 30 分鐘（`HEAVY_MIN_INTERVAL_MS`），`--force` 可忽略 |
| 租約 | 2 分鐘 | 10 分鐘 |

其他「便宜」的東西（基準、z-score、what-changed、趨勢）是讀取時從 daily metrics
現算，沒有耐久輸出可刷新；相關 / 迴歸 / 實驗分析是使用者觸發（Q&A、journal 回答）
或報告時現算 —— 都不在這一輪的處理迴圈裡。日報 / 週報 / Q&A 路徑一個字都沒改。

處理迴圈：`processPendingAnalytics({ db, cls })` → 列出落後的使用者（有上限
`MAX_USERS_PER_RUN`=5、跳過退避中與租約有效者）→ 認領（原子）→ 算 → 結案。
兩個類別各自的租約，可並行。永遠不拋錯。

### 輕量的有界分片（P3-AUDIT-F03）

需要覆蓋的範圍 = 受影響範圍 ±1 天，**不截斷**。一輪只算最新的一片
（≤ `LIGHT_MAX_DAYS`=45 天），做完就把剩餘範圍的上緣往前縮（耐久：
`analytics_work_state.range_from/to`，圍欄：owner / 租約 / `range_generation` /
`range_to` 的 CAS），回 PARTIAL、釋放租約、仍在待處理清單。只有剩餘範圍清空
才結案：`done_generation` 前進、失效範圍清掉（CAS generation）。

- 120 天 → 45 + 45 + 30（三輪）；前兩輪 `PENDING`，第三輪才 `CURRENT`。
- 崩潰 / 失敗 / 接手：剩餘範圍在資料庫裡，下一個工作者從上緣接續；失敗不縮範圍。
- N+1 在分片之間到來：認領時發現 `range_generation ≠ generation` → 剩餘範圍 ∪
  這一代的失效範圍（失效範圍只在完成時清，所以任何一天都不會掉）。
- `getAnalyticsFreshness().light` 在有剩餘範圍時是 `PENDING`；
  `getAnalyticsDailyState()` 每列帶 `stale`（generation 舊、或這一代還沒做完）。

### 日期 / 依賴傳播

輕量：受影響範圍 ±1 天（昨日 Strain 單向對應、隔日預測目標），分片處理直到覆蓋完整範圍。
重量：與範圍無關，固定回看 180 / 90 天 —— 基準（最近 30 筆有效紀錄）、滾動統計、
週彙總都依賴任意較早的日期，整段重算是唯一誠實的做法，成本本來就有上限。

### 新鮮度

`getAnalyticsFreshness(userId)` → 每個類別：
`CURRENT`（done = generation）/ `PENDING`（落後）/ `FAILED`（最近失敗且落後）/ `NEVER`。
輕量物化的每一列帶 `generation`，讀取端比對即可知道是不是舊的。
重量的衍生表（prediction_*、healthspan_*）沒有改形狀；它們的新鮮度由
`analytics_work_state.heavy.done_generation` 對 `analytics_invalidation.generation` 判斷。
既有的發布閘門（預測品質、Healthspan 成熟度、readiness）完全不變 —— 延後 / 過期
的分析不會變成新的宣稱，它只是舊的、而且可辨識為舊。

## 刪除 / 墓碑

| 情況 | canonical | 分析 |
|------|-----------|------|
| 更新（較新版本） | 寫入 | 失效 |
| 同版本重放 | 冪等 | 不失效 |
| 較舊版本（M-03） | 擋下 | 不失效 |
| ACTIVE 墓碑擋下復活 | 擋下、墓碑 blocked_count+1 | 不失效（沒有 canonical 重現） |
| 權威 DELETE | 移走 + 墓碑 ACTIVE（Phase 1） | 失效（reason=delete，日期 = 被刪列的 health_date） |

Phase 3 不清墓碑、不退位、不推論復活、不改來源時序。

## 本機執行器

```
npm run analytics:status -- --user=<id>
npm run analytics:light  -- [--user=<id>] [--force]
npm run analytics:heavy  -- [--user=<id>] [--force]
```
閘：schema 版本用 `schema_version`（遷移系統的權威）比對、不 migrate；
light / heavy 只接受 `file:` 資料庫除非 `ANALYTICS_ALLOW_REMOTE=1`。
不呼叫 WHOOP、不呼叫 LLM、不送 Telegram、不改排程。

## 成本上限

- 每次執行每類別最多 5 個使用者；輕量每使用者最多 45 天 × 5 個查詢；重量每使用者
  一次 180 天載入 + 訓練（與 V1.1 現在每輪做的相同，但只在髒且 ≥ 30 分鐘時）。
- 合併：同一使用者任意多次變動 → 每類別最多一次工作。
- 退避：`min(2min·2^(n−1), 6h)`。

## 接進正式環境之前的必要條件（尚未做）

- 既有的讀取端（例如 `/predictions`、Healthspan 顯示、Q&A）目前不看 `getAnalyticsFreshness`：
  V1.1 正式環境仍是同步分析，所以不影響；但在把重量分析改成非同步之前，
  這些讀取端必須先接上新鮮度（否則會把舊的衍生輸出當成最新）。

## 尚未做（刻意留給之後）

- 把 index.js 的每輪預測 / Healthspan 換成 `processPendingAnalytics`（正式接線）。
- Phase 4：Body Energy、主動通知政策、Journal 回饋迴圈。
