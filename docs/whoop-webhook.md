# WHOOP Webhook 攝取（V1.2 Phase 1）

> **正式環境目前是關閉的。** 這份文件描述已經實作好的架構，
> 不代表 production 已經在接收 WHOOP webhook。啟用步驟見最後一節。

## 這一期做了什麼、沒做什麼

做了：一條**耐久的攝取管線** —— 收下事件、去重、認領、向 WHOOP 取
canonical 資料、走既有的儲存層寫入、把結果記下來。

沒做（屬於後續 Phase）：把排空接進排程器、對帳（reconciliation）、
增量同步重設計、攝取與分析解耦、Body Energy。
**排程同步完全沒有被移除或改變。**

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

1. **先**寫墓碑（記下刪除當下那一版的 WHOOP `updated_at`，以及造成刪除的
   事件帳本 id）
2. 再移除 canonical 那一列

順序不可以反：先刪列再立墓碑的話，中間崩潰會留下「資料沒了、但沒有東西
擋住它被寫回來」。先寫墓碑的失敗模式相反而且可以自己收斂。

### 什麼時候可以復活

**兩個證據同時成立**才讓墓碑退位：

1. 進來那一版的 `updated_at` **嚴格大於**刪除時記下的那一版
   （WHOOP 自己的時鐘、同一個欄位語意，所以這個比較成立）
2. 這則更新通知的事件帳本 id **大於**造成刪除的那一則
   （＝ WHOOP 是在刪除**之後**才告訴我們這次更新）

第 2 條不可省略。只看版本的話，一則在刪除**之前**就已經在路上的更新
（它取到的資料本來就比較新）會把剛刪掉的資料復活。

刻意**不用**簽章時間戳做這個判斷：重試會重新簽章，一則很舊的更新在重試時
會帶著很新的時間戳。

### 排程同步永遠不能復活

`store.js` 那一層的墓碑守衛**只會擋、不會放行** —— 它看不到事件順序。
退位的決定只在 webhook 處理路徑上，因為只有那裡同時看得到版本與通知順序。

結果：排程同步**永遠**不可能復活已刪除的資源。

### 已知限制（保守失敗）

- 刪除時本地根本沒有那一列 ⇒ `last_known_updated_at` 是 NULL ⇒
  **之後任何更新都不會復活它**。證明不了就擋。
- 舊墓碑（沒有 `source_event_id`）同樣不可能退位。

擋錯的代價是一筆資料暫時看不到，而且**看得到**
（`npm run whoop:webhook:status` 會顯示 blocked 次數）；放行錯的代價是
使用者以為刪掉的健康資料復活，而且沒有人會發現。

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
npm run whoop:webhook:drain    # 排空：處理待處理的事件
```

排空**刻意沒有接進排程器**：那會改變排程器每一輪要做的事，值得它自己的
一次審查（Phase 2）。在那之前這是明確、可觀測、人為觸發的入口。

> ⚠️ 啟用端點但不排空的話，事件會累積在 `RECEIVED`。
> 這是已知且刻意的狀態 —— 正式環境本來就還沒啟用。

## 觀測

結構化日誌事件（都不含祕密、不含生理數值）：

`whoop_webhook_received` / `_duplicate` / `_unauthorized` / `_unprocessable` /
`_unsupported_event` / `_unknown_user` / `_ambiguous_user` / `_resource_gone` /
`_fetch_failed` / `_processed` / `_fenced_before_persist` / `_fenced_at_settle` /
`whoop_resource_deleted` / `whoop_tombstone_superseded` /
`whoop_tombstone_blocked_write`

## 正式環境啟用（尚未執行）

需要**兩個**條件同時成立，缺一路由就不存在：

1. `WHOOP_WEBHOOK_ENABLED=true`（只認 `1` / `true` / `yes` / `on`）
2. `WHOOP_CLIENT_SECRET` 存在（沒有它不可能驗證官方簽章）

啟用還需要（這一期**都沒有做**）：

- 在 WHOOP Developer Dashboard 設定 webhook URL
- 決定排空由誰驅動（Phase 2）
- 一次 production schema 遷移到 v10

目前狀態：**以上皆未執行，production 仍是 v9 且沒有 WHOOP webhook。**
