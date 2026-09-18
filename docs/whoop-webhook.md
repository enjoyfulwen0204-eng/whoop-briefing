# WHOOP Webhook 攝取（V1.2 Phase 1）

> **正式環境目前是關閉的。** 這份文件描述已經實作好的架構，
> 不代表 production 已經在接收 WHOOP webhook。啟用步驟見最後一節。

## 生產 ownership

Cloudflare 主排程（每 10 分鐘）與 GitHub 備援（每小時）都進入同一支
`runBriefing` canonical runner。每輪先用既有 claim/lease/state machine 排空至多
`WHOOP_WEBHOOK.DRAIN_BATCH`（25）則，再繼續 onboarding 與使用者排程。

Ingress 仍由 `WHOOP_WEBHOOK_ENABLED` 明確控制，程式不會自行開啟。即使 ingress
關閉，已經寫入 ledger 的 backlog 仍會繼續排空，避免事件被永久擱置。單一事件
失敗會進 retry/backoff 或終局狀態，不會阻斷後續事件與正常簡報工作。

Phase 2 FAST reconciliation 也由 canonical runner 低頻執行；DEEP reconciliation
保持管理者手動觸發。Phase 3 async analytics worker 仍未接進正式排程。

## 為什麼 webhook 不是生理事實的來源

官方 payload 只有四個欄位：

```json
{ "user_id": 10129, "id": 10235, "type": "workout.updated",
  "trace_id": "d3709ee7-104e-4f70-a928-2932964b017b" }
```

裡面**一個生理數值都沒有**。官方文件也明說這些是「變更的通知，不是變更
本身，你需要呼叫 API 才能拿到最新資料」。

所以 UPDATED 事件一律重新去 WHOOP 取 canonical 資料，webhook 的欄位永遠
不會直接進到 canonical 表。

## 認證

官方機制（developer.whoop.com）：

| 標頭 | 內容 |
|---|---|
| `X-WHOOP-Signature` | `base64(HMAC_SHA256(timestamp + rawBody, CLIENT_SECRET))` |
| `X-WHOOP-Signature-Timestamp` | 毫秒 epoch |

實作重點（`src/whoopWebhookAuth.js`）：

- 驗證發生在 **parse 之前**，簽的是**原始位元組**。先 parse 再序列化回去會
  改變鍵順序與空白，簽章就對不上。
- 時間戳一起進 HMAC，而且**雙向**檢查新鮮度（預設 ±5 分鐘）。只擋「太舊」
  的話，一個偽造的未來時間戳可以把重放窗口拉到任意遠。
- 定長比較（`timingSafeEqual`）。
- 沒有 client secret ⇒ **拒絕**，不是放行。

與 Telegram 完全分離：不同路徑、不同標頭、不同祕密、不同演算法，
而且兩邊的認證互不接受。

## 路由

`POST /whoop/webhook`（與 `/telegram/webhook`、`/health`、
`/internal/briefing/run` 並存於同一個 Render 免費 Web Service）。

關閉時回 **404**，不是 401 —— 不對外宣告這裡有東西。

HTTP 邊界刻意只做到「耐久寫下」就回 200：

```
驗簽 → 解析 → 寫進事件帳本（去重）→ 200
```

**不在請求裡打 WHOOP API。** 官方對失敗的投遞會在一小時內重試五次；
如果同步等 WHOOP 回應，一次慢回應就會讓我們超時 → 對方重送 → 兩個請求
同時處理同一則事件。把「外部 API 慢」變成併發正確性問題是不必要的耦合。

## 去重身分

```
(whoop_user_id, event_type, resource_id, trace_id)
```

官方說 trace_id 的用途是「偵測重複的 webhook」，但**沒有**定義它的唯一性
範圍。不確定時選保守的那一邊：複合鍵不會把兩則**不同**的事件誤認成同一則
（那會造成永久遺失，比重複處理更糟）。

第一段用 `whoop_user_id` 而不是內部 user_id：去重必須在「還沒解析出本地
使用者」時就成立，否則未知使用者的事件會被無限重新插入。

權威是 DB 的唯一索引，不是「先查再插入」。

## 事件狀態機

```
RECEIVED ──claim──► PROCESSING ──┬─► PROCESSED   （canonical 已依來源真相更新）
   ▲                             ├─► IGNORED     （刻意不做事，不是失敗）
   │                             ├─► RETRY ──────┘（退避後可再認領，有次數上限）
   │                             └─► FAILED      （不可重試，留著給人查）
   └── 租約過期的 PROCESSING 可以被接手（崩潰復原）
```

- 認領是**原子的**，而且鎖定單一 id（不靠排序猜「剛剛那一則是哪一則」）。
- 每一個副作用邊界之前都重新確認所有權；結案一律帶 owner + PROCESSING 圍欄。
- **終局狀態永遠不會被復活。**

## 多使用者路由

WHOOP 會員 id → 本地使用者，用 `user_whoop_tokens.whoop_user_id`。

| 情況 | 行為 |
|---|---|
| 恰好一個 | 正常處理 |
| 找不到 | `IGNORED`，**不動任何生理資料**，可診斷 |
| 多於一個 | `FAILED`（fail closed），**不猜** |
| 使用者非 ACTIVE | `IGNORED` |

解析發生在**處理當下**而不是收下當下：綁定可能在事件排隊期間改變，
唯一安全的答案是「處理的那一刻是誰」。

絕不依 Telegram 身分路由，也絕不因為「目前只有一個使用者」就假設是他。

## 刪除與墓碑

刪除**不能**只做實體刪除。刪除與更新會亂序抵達，而且 WHOOP 會重送：

```
t0  sleep.updated 送出但沒送達
t1  sleep.deleted 送達 → 刪掉那筆睡眠
t2  WHOOP 重送 t0 那一則 updated  → 若照做，資料就復活了
```

所以刪除會：

1. 寫墓碑（記下刪除當下那一版的 WHOOP `updated_at` 作為證據）
2. 移除 canonical 那一列

兩步在**同一個交易**裡（見下），所以中間崩潰不會留下任何半套狀態。

### 什麼時候可以復活：**Phase 1 永遠不會自動復活**

WHOOP 沒有提供任何能證明「這則更新是在刪除**之後**才產生」的東西：

| 候選證據 | 為什麼不夠 |
|---|---|
| webhook 投遞順序 | 官方沒有文件保證；網路延遲可以讓較早產生的更新較晚抵達 |
| 本地帳本 id / `received_at` | 只是**我們收下**的順序，不是 WHOOP 產生變更的順序 |
| 簽章時間戳 | 是「送出的時間」，重試會重新簽章 —— 官方沒有把它定義為變更時序 |
| 資源的 `updated_at` 較新 | 一則刪除**前**就在路上的更新，它取到的資料本來就可以比我們刪掉的那一版新 |

所以 Phase 1 分不出這兩種情況：

```
延遲抵達的刪除前更新         ← 必須擋
刪除後的真正重建（新資料）    ← 理想上該放行
```

**兩者一律維持墓碑。** 真正的重建會暫時看不到 —— 那比讓已刪除的生理資料
復活好得多，而且看得到（`blocked_count` 會累加）。

被擋下的 UPDATE 事件以 `PROCESSED` 結案，detail 為
`blocked_by_active_tombstone`：處理**成功地**判定不可以寫，這是保守政策的
正常結果，不是失敗，也不會重試。

墓碑上的 `last_known_updated_at` / `source_event_id` / `source_event_at` /
`source_trace_id` 只是**證據保存**，給診斷與未來有來源依據的對帳機制用。
Phase 1 不拿它們做任何自動判定；`SUPERSEDED` 狀態在 Phase 1 **沒有任何程式
路徑會寫入**，保留它只是讓未來不必再改 schema。

### 變更一律在所有權圍欄的交易裡

webhook 事件造成的每一次 canonical / 墓碑變更都走 `db.mutateForWhoopEvent`：

```
交易開始 → 驗（event id + owner + PROCESSING + 租約仍有效）
         → 變更（墓碑 upsert + 實體刪除；或 墓碑判定 + canonical 寫入）
         → commit 之前**再驗一次**
         → 任一次不成立 → 整個 rollback，一個位元組都不落地
```

「先用 JavaScript 檢查所有權、回 true、之後才變更」不算數：檢查與變更之間
租約可能過期、別人可能接手。所有權的證明就是交易的一部分。

結果：
- 墓碑 + 實體刪除是**原子的**。不存在「有墓碑但列還在」或「列沒了但沒有墓碑」
  的已提交狀態（除非資料庫被外部直接改壞）。
- 失去所有權的舊執行寫不進任何東西；接手者的結果不會被蓋掉。
- 交易**只包 DB 變更**。WHOOP API GET 一定在交易之前完成。
- commit 之後、結案之前崩潰：重播是冪等的（墓碑 upsert + DELETE 都是），
  結案本身另有 owner + PROCESSING 圍欄。

### 分析層看到什麼

實體刪除之後，那一天在分析層是「**沒有資料**」—— 也就是既有架構已經正確
處理的「缺值」，不是被偽造出來的 0。刻意不用軟刪除：那需要每一個讀取
查詢都記得過濾，漏一個就等於刪除沒有發生。

## Canonical 取得

| 資源 | 端點 |
|---|---|
| sleep | `GET /activity/sleep/{sleepId}` |
| workout | `GET /activity/workout/{workoutId}` |
| recovery | 見下 |

### recovery 的非對稱（重要）

v2 的 recovery webhook 給的 `id` 是**該筆睡眠的 UUID**（官方：「The id of
the associated sleep (UUID)」），但單筆 recovery 的端點是用 **cycle** 定址的
（`/cycle/{cycleId}/recovery`）。兩者對不起來。

**不能**拿 webhook 的 id 去組 recovery 路徑 —— 那會打到一個剛好同號的
cycle，拿回別人（或別天）的資料。

實際作法：

1. `GET /activity/sleep/{sleepId}` 取得那筆睡眠（同時確認它存在、取得時間窗）
2. 以起訖時間 ±1 天列出 `/recovery`，挑 `sleep_id` **完全相符**的那一筆

比對 `sleep_id` 全等是關鍵，不靠「窗裡只有一筆」這種假設。
找不到就什麼都不寫（recovery 可能還沒算出來）。

## API 失敗語義

| 狀況 | 事件狀態 | canonical |
|---|---|---|
| 429 / 5xx / 網路 | `RETRY`（退避，有上限） | 不動 |
| 401（refresh 後仍失敗） | `RETRY` → 用完次數 `FAILED` | 不動 |
| 403（scope 不足） | `FAILED` | 不動 |
| 404（資源不存在） | `IGNORED` | 不動，**也不自己推論成刪除** |
| 回應壞掉 / id 對不上 | `RETRY` → 用完次數 `FAILED` | 不動 |

**任何失敗都不會變成生理上的 0。** 缺資料在這個系統裡永遠是「缺」。

Token refresh 完全重用既有的 `createWhoopClient`（V1.1 修好的租約 +
compare-and-swap 圍欄），沒有第二份實作。

## Canonical 寫入

一律走既有的 `upsertSleeps / upsertRecoveries / upsertWorkouts`。
V1.1 修好的新鮮度規則對 webhook 與排程同步是**同一套**：

- 已知較舊 → 不覆蓋已知較新
- 相同版本 → 冪等
- 來源版本不明 → 不覆蓋已知版本

不另外開一條「webhook 專用」的寫入路徑。

## 維運

```bash
npm run whoop:webhook:status   # 唯讀：帳本與墓碑統計
npm run whoop:webhook:drain    # 管理者手動排空（與正式排程重用同一處理器）
```

正式排空由 canonical scheduler 持有；每輪有 25 則上限，剩餘 backlog 下一輪
續作。summary 提供 claimed / processed / ignored / retryable / failed / remaining，
足以在啟用 smoke test 確認 backlog 是否回到 0。手動指令保留給管理者診斷。

## 觀測

結構化日誌事件（都不含祕密、不含生理數值）：

`whoop_webhook_received` / `_duplicate` / `_unauthorized` / `_unprocessable` /
`_unsupported_event` / `_unknown_user` / `_ambiguous_user` / `_resource_gone` /
`_fetch_failed` / `_processed` / `_blocked_by_tombstone` /
`_fenced_before_persist` / `_fenced_delete` / `_fenced_at_settle` /
`_delete_failed` / `whoop_resource_deleted` / `whoop_tombstone_blocked_write`

事件帳本上的 `last_error_detail` 也會區分 `deleted` / `delete_idempotent_replay` /
`blocked_by_active_tombstone`，Phase 2 對帳可以直接據此統計。

## 正式環境啟用（尚未執行）

需要**兩個**條件同時成立，缺一路由就不存在：

1. `WHOOP_WEBHOOK_ENABLED=true`（只認 `1` / `true` / `yes` / `on`）
2. `WHOOP_CLIENT_SECRET` 存在（沒有它不可能驗證官方簽章）

啟用還需要由 rollout change window 明確完成：

- 先部署含 durable drain owner 的 reviewed SHA
- 在 WHOOP Developer Dashboard 設定 webhook URL
- 準備 signed-ingress → ledger → drain → backlog=0 的 smoke plan

freeze/patch 本身不會改 `WHOOP_WEBHOOK_ENABLED`、Developer Dashboard 或 production。
