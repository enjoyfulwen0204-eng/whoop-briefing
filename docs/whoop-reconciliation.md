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
| `whoop_reconciliation_state` (PK user_id, resource) | 水位、續傳 token/窗、owner + lease、退避、錯誤分類 |
| `whoop_reconciliation_runs` | 每一次嘗試一列：窗、頁數、抓/寫/擋、結果、錯誤 |
| `whoop_reconciliation_discrepancies` (PK user_id, resource, resource_id, kind) | `MISSING_REMOTE` 差異；seen_count 累加 |
| `whoop_resource_tombstones.reconcile_checked_at / reconcile_verdict / reconcile_remote_updated_at` | 墓碑的對帳診斷；**只寫這三欄** |

v10 → v11 是 `CREATE TABLE IF NOT EXISTS` × 3 + `ALTER TABLE ADD COLUMN` × 3
（全 nullable、無回填）。零重建。新表不在 `RESHAPED_TABLES`。

## 一輪怎麼跑（`createReconciler(...).reconcileResource(resource)`）

```
到期？(isReconcileDue)  ─否→ SKIPPED(not_due)
  │ 是
認領 (claimReconciliation: INSERT … ON CONFLICT DO UPDATE WHERE owner IS NULL OR lease 過期)
  │ 拿不到 → SKIPPED(claim_busy)
算窗 (nextWindow)：續傳 → 沿用存下的 [from,to]+token；有水位 → [水位−重疊, now]；無 → [now−45d, now]
開 run 帳本列
抓 (fetchWindow)：apiGet(path, {start,end,limit:25,nextToken}) 逐頁，最多 MAX_PAGES_PER_RUN=8 頁
  │ 任一頁失敗 → FAILED：settle FAILED（清續傳、consecutive_failures+1、next_attempt_at 退避）
寫 (mutateForReconciliation → db.upsert*)：所有權交易（before/after 都驗 owner+lease），
  內含 Phase 1 墓碑判定 + M-03 新鮮度（同一交易）
  │ 頁數用完還有下一頁 → PARTIAL：存 token/from/to，水位不動
窗完整 → 差異偵測（本地在縮邊窗內、遠端沒有 → MISSING_REMOTE）
       → 墓碑診斷（每輪 ≤ 5 個、24h 內不重查；sleep/workout 走單筆端點 404/200，recovery 只看窗）
settle SUCCESS：window_watermark = MAX(舊, 窗 end)，清續傳、歸零失敗
關 run 帳本列
```

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

## API 用量上限（每使用者每輪）

- 集合資源：≤ 8 頁（`MAX_PAGES_PER_RUN`）+ ≤ 5 個單筆 GET（墓碑診斷，只有 sleep/workout）
- body_measurement：1
- 節流：每資源每 60 分鐘最多一輪（有續傳時例外，為了盡快把窗做完）
- `reconcileAll` 最多 5 種資源 → 最壞情況 sleep 13 + recovery 8 + cycle 8 + workout 13 + body 1 = 43 次 GET / 使用者 / 小時

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
`RECONCILE_ALLOW_REMOTE=1`；`run` 不 migrate（版本不對就停）。
不註冊 webhook、不送 Telegram、不改排程。

## 尚未做（刻意留給下一階段）

- 接進正式排程器（`src/index.js` 的 `makeSync` 注入點是未來的切換位置）。
- `REMOTE_PRESENT_UNRESOLVED` 的自動解決 —— 需要 WHOOP 提供可信的來源時序。
- 差異的自動處置。
