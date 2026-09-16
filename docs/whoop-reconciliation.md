# WHOOP 對帳 + 增量同步（V1.2 Phase 2）

> 狀態：**已實作、有測試、未接進正式排程器。** 正式環境目前仍由 V1.1 的
> `createSync`（`src/sync.js`）同步。Phase 2 的引擎只能透過本機腳本執行。

## 它解決什麼

Phase 1 讓 webhook 事件成為「WHOOP 資料變了」的即時訊號，但 webhook 有三個
天生的缺口：可能漏送、沒有 cycle / body measurement 事件、而且刪除只有
webhook 這一個來源。對帳的工作是**定期用 API 把真相拉回來**，補上漏掉的
更新，並把說不清的差異**記下來**（而不是猜）。

每個 (使用者 × 資源) 它回答七個問題：

| # | 問題 | 答法 |
|---|------|------|
| A | WHOOP 現在回得出哪些資源？ | 抓窗 → 走既有 canonical 儲存層寫入 |
| B | 哪些本地資源在遠端有更新版本？ | 同上：M-03 新鮮度讓新版蓋舊版 |
| C | 哪些本地資源在遠端看不到了？ | **只記 `MISSING_REMOTE` 差異，不刪** |
| D | 哪些 ACTIVE 墓碑仍未解決？ | 診斷判定寫進墓碑的 `reconcile_*` 欄位，**不改 state** |
| E | 哪些 webhook 漏了但現在補得回來？ | 重疊窗自然補回 |
| F | 哪些資源沒有 webhook？ | cycle、body_measurement 走同一套引擎 |
| G | 下一次該用什麼窗？ | 水位 − 重疊 … now |

## 三條不可違反的規則

1. **水位只在整個窗完整成功之後才前進。** 任何一頁失敗、頁數預算用完、寫入
   失敗 → 不前進。失敗永遠不會跳過資料。
2. **失敗不是零。** API 失敗只改變對帳狀態（退避、錯誤分類），絕不寫出空結果。
3. **不捏造來源時序。** 本地執行順序、抓取時間、run id、webhook 帳本 id 都不是
   WHOOP 的時序。ACTIVE 墓碑在 Phase 2 仍然是權威（Phase 1 P1-R01 不變）。

## 資料模型（schema v11，純新增）

| 表 / 欄位 | 用途 |
|-----------|------|
| `whoop_reconciliation_state` (PK user_id, resource) | 每個 (使用者, 資源, 路徑) 一列：`sleep` = 快路徑、`sleep/deep` = 深度路徑。水位 / 游標、未完成窗、續傳 token、owner + lease、退避、錯誤分類 |
| `whoop_reconciliation_runs` | 每一次嘗試一列：窗、頁數、抓/寫/擋、結果、錯誤 |
| `whoop_reconciliation_discrepancies` (PK user_id, resource, resource_id, kind) | `MISSING_REMOTE` 差異；seen_count 累加 |
| `whoop_resource_tombstones.reconcile_checked_at / reconcile_verdict / reconcile_remote_updated_at` | 墓碑的對帳診斷；**只寫這三欄** |

v10 → v11 是 `CREATE TABLE IF NOT EXISTS` × 3 + `ALTER TABLE ADD COLUMN` × 3
（全 nullable、無回填）。零重建。新表不在 `RESHAPED_TABLES`。

### 狀態列的每一欄各是什麼意思（不重疊）

| 欄位 | 快路徑列（`sleep`） | 深度路徑列（`sleep/deep`） |
|------|------|------|
| `window_watermark` | **最近水位**：到此為止完整抓過，單調不減（`MAX`） | **深度游標**：上一片完整掃完的下緣；下一片從這裡往更早；走完水平線從 now 重來（可倒退，用 `set`） |
| `continuation_from/to` | **未完成的邏輯窗**：一輪開始就寫下，只有 SUCCESS 能清 | 同：未完成的深度切片 |
| `continuation_token` | 續傳 token（PARTIAL 存、FAILED 清、SUCCESS 清） | 同 |
| `last_success_at` | 快路徑節流依據（60 分鐘） | 深度節奏依據（24 小時） |
| `next_attempt_at` | 失敗退避 | 失敗退避 |
| `owner` / `lease_expires_at` | 快路徑租約 | 深度租約（各自獨立，可並行） |

## 一輪怎麼跑（`createReconciler(...).reconcileResource(resource)`）

```
到期？(isReconcileDue)  ─否→ SKIPPED(not_due)
  │ 是
認領 (claimReconciliation: INSERT … ON CONFLICT DO UPDATE WHERE owner IS NULL OR lease 過期)
  │ 拿不到 → SKIPPED(claim_busy)
算窗 (nextWindow)：有未完成窗 → 沿用 exact [from,to]（有 token 就續、沒有就第一頁）；
                  有水位 → [水位−重疊, now]；無 → [now−45d, now]
開 run 帳本列
耐久化未完成窗 (openPendingWindow，owner 圍欄)                                    ← P2-R02
抓 (fetchWindow)：apiGet(path, {start,end,limit:25,nextToken}) 逐頁，最多 MAX_PAGES_PER_RUN=8 頁
  每頁先過 validateCollectionPage：非 null 物件、records 存在且是陣列、
  next_token 缺席/null/"" = 終端頁、否則必須是字串；不合 → SyntaxError → 整輪 FAILED   ← P2-R01
  │ 任一頁失敗 / 畸形 → FAILED：**一筆都不寫**（整輪緩衝）；settle FAILED
  │   （只清 token、保留未完成窗、consecutive_failures+1、next_attempt_at 退避）
寫 (mutateForReconciliation → db.upsert*)：所有權交易（before/after 都驗 owner+lease），
  內含 Phase 1 墓碑判定 + M-03 新鮮度（同一交易）
  │ 頁數用完還有下一頁 → PARTIAL：存 token/from/to，水位不動
窗完整 → 差異偵測 **只在這一輪從第一頁抓完整個窗時**（續傳完成的窗不做）      ← P2-R04
       → 墓碑診斷（快路徑；每輪 ≤ 5 個、24h 內不重查；sleep/workout 走單筆端點 404/200，recovery 只看窗）
settle SUCCESS：快路徑 window_watermark = MAX(舊, 窗 end)；深度 游標 = 這一片的下緣；
                清未完成窗與續傳、歸零失敗
關 run 帳本列
```

### 為什麼 `{}` 不是「空的成功」（P2-R01）

WHOOP 一頁合法的空回應是 `{ records: [] }`。`{}`、`null`、`{ records: null }`、
`{ records: {} }`、`{ records: "…" }` 都不是 —— 它們是 proxy 錯誤頁、截斷的 JSON、
或版本改了的 API。把它們當成「遠端什麼都沒有」會讓水位跨過一段真的有資料的
時間，並且產生假的缺席證據。所以每一頁都先驗形狀，任何一頁不合，整輪作廢、
一筆都不寫。

### 為什麼失敗要保留邏輯窗（P2-R02）

初始窗是 [now−45d, now]。如果 PARTIAL 之後續傳失敗、又把窗清掉，下一輪會用
**往前走的時鐘**重算一個新的 45 天窗 —— 原本窗的下緣那幾天就永遠掉出去了。
所以窗在一輪開始時就耐久化，失敗只清 token；下一輪用 exact 同一個窗從第一頁
重來。只有 SUCCESS 能清窗、前進水位。

### 為什麼續傳完成的窗不做缺席偵測（P2-R04）

續傳那一輪只看到最後幾頁；`remoteById` 不是整個窗的觀察集合。拿它去比本地
會把前幾頁的資源全部記成 MISSING_REMOTE —— 假證據。缺席證據只在
「這一輪從第一頁把整個窗抓完」時才成立；續傳完成的窗延後到下一次完整的窗。
假缺席比晚一點的缺席更糟。

## 深度掃描（P2-R03）

集合端點的 `start`/`end` 過濾的是**資源的發生時間**，不是 `updated_at`。
「水位 − 5d … now」永遠看不到 20 天前的睡眠今天被重新評分，也看不到漏掉的
webhook 更新；cycle 更是連 webhook 都沒有。所以在快路徑之外另有一條**有界的
深度路徑**（`reconcileDeep(resource)`，`reconcileAll` 會在到期時自動做）：

| 項目 | 值 |
|------|----|
| 資源 | sleep、recovery、cycle、workout（`DEEP.RESOURCES`；body_measurement 沒有歷史） |
| 水平線 | 365 天（`DEEP.HORIZON_DAYS`，= V1.1 backfill 的 `BACKFILL_DAYS`） |
| 切片 | 30 天（`DEEP.SLICE_DAYS`，= V1.1 backfill chunk；每天 1～2 筆 ≈ 1～3 頁） |
| 節奏 | 每種資源每 24h 一片（`DEEP.MIN_INTERVAL_MS`）；未完成的片不受節流，盡快做完 |
| 游標 | 深度列的 `window_watermark` = 上一片的下緣；下一片 = [max(游標−30d, now−365d), 游標] |
| 輪轉 | 13 片鋪滿 365 天，彼此相接；游標到水平線（或沒有游標）→ 從 now 重來 |
| 前進 | 只在整片完整成功後（同一條規則：PARTIAL 續傳同一片、FAILED 保留同一片重來） |
| 寫入 | 與快路徑同一條：`mutateForReconciliation` → `upsert*`（M-03 + ACTIVE 墓碑 + 同一交易） |
| 診斷 | 完整單輪的片做缺席偵測；**不做**墓碑單筆 GET（預算留給歷史） |
| 隔離 | 深度成功只動深度列；**永遠不碰**快路徑的水位。Alice / Bob 各自的列 |

一片一天、13 片一輪 → 每種資源每 ~13 天把 365 天全部重讀一次；一筆 20 天前
被重新評分的 cycle 最遲 13 天內被補回，通常第一天就會（最新的一片先掃）。


`reconcileAll()` 按 `WHOOP_RECONCILE.RESOURCES` 順序各跑一次，**永遠不拋錯**。

### 身體量測

`/user/measurement/body` 沒有 id、沒有時間戳。沿用 V1.1 的「本地日期 = 版本鍵」
快照規則（`upsertBodyMeasurement`），水位 = 這一輪的 now。

### 明確窗（backfill / 修復）

`reconcileResource(resource, { explicitWindow: { from, to } })`：抓、寫、診斷都一樣，
但 **不動常規水位、不動續傳**（`settleReconciliation({ advanceWatermark: false })`）。

## 為什麼「遠端看不到」不等於「被刪了」

WHOOP 集合端點只能用資源的 **start** 時間過濾，`end` 是「intersect」語義；沒有
`updated_at` 過濾、沒有 `deleted` 標記。一個資源不在窗裡可能是：真的刪了、使用者
改了時間、剛好壓在邊界、還在評分、或這一頁沒抓完。API 回應長得一模一樣。
所以 Phase 2 只記差異（縮邊 24h 避開邊界），刪除的唯一證據仍然是 webhook DELETE。

## 錯誤分類與退避

| 錯誤 | class | 可重試 |
|------|-------|--------|
| 401 refresh 後仍失敗 (`WhoopAuthError`) | `whoop_auth` | 是 |
| 403 | `whoop_scope_missing` | 否 |
| 404 | `whoop_not_found` | 否 |
| 429 | `whoop_rate_limit` | 是 |
| 5xx | `whoop_server` | 是 |
| 連線失敗 (status 0) | `whoop_network` | 是 |
| 其他 4xx | `whoop_client_error` | 否 |
| 非 JSON / 形狀不對 | `whoop_malformed_response` | 是 |
| SQLITE_* | `db` | 是 |
| `reconcile_ownership_lost` | `fenced` | —（不記失敗） |

退避 = `min(2min × 2^(n−1), 6h)`。**可重試與不可重試都排退避**：scope 缺失要等
人重新授權，但也不該每個 tick 都撞一次 403。成功歸零。

## API 用量上限（每使用者）

| 路徑 | 每輪上限 | 節奏 |
|------|---------|------|
| 快路徑，每種集合資源 | ≤ 8 頁 + ≤ 5 個單筆 GET（墓碑診斷，只有 sleep/workout） | 每 60 分鐘 |
| body_measurement | 1 | 每 60 分鐘 |
| 深度路徑，每種集合資源 | ≤ 8 頁 | 每 24 小時一片（未完成的片每個 tick 續，直到做完） |

- 快路徑最壞：sleep 13 + recovery 8 + cycle 8 + workout 13 + body 1 = **43**
- 深度最壞：4 × 8 = **32**
- 兩者同時到期的那一個 tick：**75**；其餘 tick 上限 43
- 重試倍數：失敗退避 2min·2^(n−1)（上限 6h），所以一個持續故障的資源每小時
  最多再加 ~1 輪；沒有重試風暴
- 長期期望：正常密度下快路徑每小時每資源 1～2 頁、深度每天每資源 1～3 頁 →
  每使用者每天約 100～200 次 GET，每 13 天完整重讀 365 天一次

## 併發與多使用者

- 認領是單一原子 SQL；同一 (user, resource) 任何時刻最多一個持有者；認領**不是**續租。
- 租約過期後可被接手；原持有者之後的寫入被 `mutateForReconciliation` 的交易前/後
  檢查擋下（`reconcile_ownership_lost` → FENCED，零寫入，不污染狀態）。
- 狀態、帳本、差異全部 per-user；不同使用者互不阻塞。

## 本機執行器

```
npm run reconcile:status -- --user=<id>                      # 唯讀
npm run reconcile:run    -- --user=<id> [--resource=x] [--force]
npm run reconcile:run    -- --user=<id> --resource=sleep --from=2026-06-01 --to=2026-07-01
```

三道閘：`--user` 必填（不自動挑）；`run` 拒絕非 `file:` 資料庫除非
`RECONCILE_ALLOW_REMOTE=1`；`run` 不 migrate —— 版本用**遷移系統自己的讀法**
（`schema_version` 表的 `MAX(version)`，`migrations.currentVersion`）比對，不等於
程式碼的版本、沒有表、表壞掉，都在載入 WHOOP 憑證 / 讀 token / 任何網路工作
**之前**停下（P2-R05；`PRAGMA user_version` 在這個專案永遠是 0，不是權威）。
不註冊 webhook、不送 Telegram、不改排程。

`run` 的旗標：`--force`（忽略節流）、`--no-deep`（只跑快路徑）、
`--deep-only --resource=<x>`（只跑一片深度切片）。

## 已知、刻意不在修復週期 1 處理的觀察（Codex NB-01 ～ NB-03）

- NB-01 差異 / 墓碑判定這兩種**診斷**寫入在圍欄交易之外，失去所有權的執行
  仍可能寫（canonical、墓碑 state、水位都不受影響）。
- NB-02 5 分鐘租約在極端慢的 API 下可能過期；圍欄讓它 fail closed（FENCED、零寫入）。
- NB-03 重複 / 循環的續傳 token 沒有明確的異常偵測；頁數預算綁住單輪成本。

## 尚未做（刻意留給下一階段）

- 接進正式排程器（`src/index.js` 的 `makeSync` 注入點是未來的切換位置）。
- `REMOTE_PRESENT_UNRESOLVED` 的自動解決 —— 需要 WHOOP 提供可信的來源時序。
- 差異的自動處置。
