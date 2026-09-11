# Telegram 入站 webhook（正式環境）

## 正式環境架構

```
GitHub Actions（每 30 分鐘）  → WHOOP 同步 / 每日・每週簡報      ← 唯一的排程器
Render 靜態站（免費）          → /privacy 隱私政策
Render Web Service（免費）     → Telegram 入站 webhook
Turso                         → 所有耐久狀態（唯一的真相來源）
OpenRouter                    → 需要時的 Q&A 理解
WHOOP API                     → 個人生理資料（只有排程器會打）
```

**每月經常性基礎建設成本：$0。** 沒有付費的 Background Worker。

## 入站流程

```
Telegram
  → POST https://<service>.onrender.com/telegram/webhook
  → 驗 X-Telegram-Bot-Api-Secret-Token（在任何業務處理之前）
  → 體積上限 / JSON 解析 / Update 結構檢查
  → processUpdate()            ← 與 long polling 共用同一份
      原子認領（telegram_processed_updates）
      → CLAIMED → PROCESSING 圍欄
      → 動作與收據同一個交易（telegram_operations）
      → 送出前重新確認綁定（HRD-R03）
      → 標記 COMPLETED
  → 回 200 / 503
```

## 這次只換了傳輸

「收到一則 update 之後要做什麼」完全沒有改：使用者綁定、多使用者隔離、
耐久去重、所有權租約、自然語言 Q&A、澄清狀態、Journal、WHOOP 脈絡取得、
OpenRouter 呼叫、送出守衛 —— 全部沿用，實作在
[`src/bot/updateProcessor.js`](../src/bot/updateProcessor.js)。

`npm run bot`（getUpdates 長輪詢）保留給本機除錯。**沒有任何 Render 服務會啟動它。**

## 送達保證（精確措辭）

這個系統提供的是：

- **update 處理的耐久去重** —— 同一則 update 的動作（Journal、狀態轉換、
  OpenRouter 呼叫）最多執行一次，由 `telegram_operations` 的收據保證。
- **抗重複的送達** —— 正常情況下一則訊息得到一則回覆。
- **明確失敗後的確定性重試** —— Telegram 親口說「沒收下」時會重送。
- **模糊送達後的 at-most-once** —— 網路層結果不明時**不自動重送**。

**不是 exactly-once。** Telegram 的 `sendMessage` 沒有通用的呼叫端冪等鍵，
所以在「請求送出去了但拿不到回應」的情況下，沒有任何辦法能證明遠端收到了
沒有。宣稱 exactly-once 是不誠實的。

### 三種送出結果，三種處置

| 分類 | 判準 | 處置 |
|---|---|---|
| **確定失敗** | 收到 Telegram 的 HTTP 回應（4xx/5xx 或 `ok:false`），或連線根本沒建立（DNS 查不到、連線被拒） | 退回 `ACTION_READY`，**可以重送**。動作不會重做。 |
| **確定成功** | Telegram 回傳成功，帶 `message_id` | 存下 `message_id` → `DELIVERED` → 完成 |
| **模糊** | 連線已建立但拿不到答案：逾時、`ECONNRESET`、socket 中斷 | 記成 `AMBIGUOUS`，**不自動重送**，這一則就此終局 |

刻意**不**把所有網路錯誤都當成「確定失敗」—— 那正是會產生重複訊息的誤判。
反過來也刻意不把 DNS/連線被拒當成模糊，否則一次 DNS 抽風就會吃掉回覆。

### 這個取捨的代價

在真正模糊的網路失敗下，**有可能漏掉一則回覆**（使用者沒收到，而系統以為
可能送出去了）。對一個私人健康 bot 來說，這比讓使用者收到兩則一樣的健康
建議安全。發生時：

- 狀態留在 `AMBIGUOUS`，`npm run phase0` 看得到，不會靜靜消失
- 使用者再問一次就會被正常處理（那是一則新的 update）

這是**罕見**的情況：一般的 Telegram 5xx、429、連線被拒都算確定失敗，會正常重試。

## 各種情況的行為

| 情況 | 行為 | HTTP |
|---|---|---|
| 第一次投遞 | 認領 → 動作 → 標記要送 → 送出 → 存 message_id → 完成 | 200 |
| 重複投遞（已完成） | 認領回 `completed`，**什麼都不做** | 200 |
| 同一實例併發重複 | 每次執行有自己的 attemptId → 只有一個拿到執行權 | 200 / 503 |
| 跨實例併發重複 | 同上，由 DB 的條件式寫入決定 | 200 / 503 |
| 已完成之後重播 | 收據回傳已存結果，動作不重跑、AI 不重打、不重送 | 200 |
| 明確的送出失敗 | 狀態退回可重送 | 503 |
| 模糊的送出結果 | 記成 `AMBIGUOUS`，不自動重送 | 200 |
| 拿不到執行權 / 要讓路 | 不處理、不 ack | 503 |
| 認領機制壞掉 | 不處理、不 ack | 503 |

## 入站併發：刻意序列化

註冊 webhook 時送 `max_connections: 1`，也就是請 Telegram 一次只投遞一則。

為什麼需要：應用層的耐久順序控制，是從「這一則已經被耐久地認領」那一刻才
開始生效的。在那之前還有一段極短的窗口 —— Telegram 若用多條 HTTPS 連線同時
投遞，N+1 有機會比 N 更早抵達 claim，而那時資料庫裡還沒有任何 N 的紀錄可以
拿來擋。對這個低流量的私人健康 bot 來說，對話順序的正確性比傳輸層的平行度
重要得多。

⚠️ **這不是唯一的正確性機制，也不可以被當成唯一的。** 下面每一項都仍然必要、
全部維持不變：

- 每次執行各自的 attemptId（執行權排他）
- 對話鍵與對話通道（同一對話一次一則、不可超車）
- 租約、圍欄、過期工作的原子終結
- 動作與收據同一交易的去重
- 送達狀態機（含模糊送達不自動重送）

`max_connections: 1` 只是把上面這些涵蓋不到的那一小段 pre-claim 窗口補起來。

## 順序（同一個使用者）

同一個人的訊息必須照順序處理 —— 否則澄清回覆可能在問題本身落地之前就被處理，
對話狀態就亂了。

**通道鍵**：內部 `user_id`（身分安全解析之後才取得）。刻意不用 chat id，
也刻意在**認領之後**才進通道 —— 未綁定或偽造的訊息拿不到任何人的通道，
不可能用它去鎖住一個合法使用者。

兩層缺一不可：

1. **互斥**：`resource_locks` 的 `telegram_lane:<user_id>` 租約，同一個人一次一則
2. **不可超車**：`telegram_processed_updates.user_id` + `update_id` 比對，
   只要有比自己早而且還沒結案的訊息，就讓路（回 503，Telegram 稍後重送）

只有互斥的話，N+1 先搶到通道就會超車 N。

**跨使用者完全併行**：鎖是 per-user 的，Alice 的通道被佔住不會擋到 Bob。

**崩潰恢復**：租約自帶到期時間與 owner 圍欄，崩潰的執行不會永久鎖住一個人；
租約過期後下一則訊息就能進來。

## 執行權（為什麼同一個 process 的重複請求不會都送出去）

| 概念 | 是什麼 | 用途 |
|---|---|---|
| process 身分 | `pid:uuid`，每次啟動一個 | **只用於日誌** |
| 嘗試身分 | `workerId#uuid`，**每次執行一個** | 所有權、租約、圍欄 |

舊版用 process 層級的 workerId 當 owner，於是同一個 process 的兩個併發請求
在耐久層「互相認得」（同一個 owner 可以續租），都拿得到所有權，排他性只好
靠記憶體裡的 Map。現在兩個併發請求永遠是兩個不同的 owner，條件式寫入只會
讓一個通過。

**記憶體裡沒有任何去重狀態。** 重啟、冷啟動、多實例都不影響正確性。

## 冷啟動

免費 Web Service 閒置會睡著。第一則訊息可能要等幾十秒到約一分鐘。

**正確性完全不依賴記憶體**：認領、動作收據、offset 全都在 Turso。睡著、重啟、
重新部署、醒來後兩個請求同時進來 —— 都由 DB 決定。process 內的併發合流只是
避免同一個實例重複回覆，不是正確性的來源。

## 環境變數

只要求這個服務**真的會用到**的：

| 變數 | 類型 | 必要性 | 用途 |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | SECRET | REQUIRED | 送出回覆 |
| `TELEGRAM_WEBHOOK_SECRET` | SECRET | REQUIRED | 驗證入站請求真的來自 Telegram |
| `TURSO_DATABASE_URL` | SECRET | REQUIRED | 耐久狀態 |
| `TURSO_AUTH_TOKEN` | SECRET | REQUIRED | 耐久狀態 |
| `OPENROUTER_API_KEY` | SECRET | REQUIRED | Q&A 理解 |
| `OPENROUTER_MODEL` | CONFIG | OPTIONAL | 預設在 config.js |
| `TIMEZONE` | CONFIG | OPTIONAL | 只是 bootstrap 預設；真正的時區在 `users.timezone` |
| `PORT` | CONFIG | Render 注入 | HTTP 監聽埠 |

**`WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` 刻意不需要**：入站只讀 Turso 裡
已經同步好的健康資料，不會自己去打 WHOOP API。唯一會寫健康資料的仍然只有排程器。

`TELEGRAM_CHAT_ID` 也不需要 —— 那只是排程器發系統層錯誤通知用的 bootstrap chat。

## 上線步驟

1. Render 建立免費 Web Service（或套用 `render.yaml`），填上面 5 個 secret
2. 等部署完成，確認 `GET /health` 回 `{"ok":true,"service":"telegram-webhook"}`
3. 設 `TELEGRAM_WEBHOOK_URL=https://<service>.onrender.com/telegram/webhook`
4. `npm run telegram:webhook:set`
5. `npm run telegram:webhook:status` 確認 `url` 已設定

⚠️ 目前正式環境有 **1 則真實的待處理訊息**。註冊腳本刻意不送
`drop_pending_updates`，所以它會被保留，並在 webhook 上線後被正常處理掉。

## 安全

- 認證在任何業務處理之前；secret 用定長比較（`timingSafeEqual`）
- 請求體積上限在**讀取過程中**檢查，不讓惡意的無限 body 吃掉免費實例的記憶體
- **不記錄訊息內容，也不記錄整包 Update JSON**
- 不記錄提供的 secret（那可能是猜測，也可能誤記到真的祕密）
- `/health` 不碰 DB，不吐任何使用者 id、chat id、token 或健康數值
