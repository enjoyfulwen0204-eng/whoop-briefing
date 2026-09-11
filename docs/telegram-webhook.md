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

## 重送與去重

Telegram 在收不到 2xx 時會重送。各種情況的行為：

| 情況 | 行為 | 回應 |
|---|---|---|
| 第一次投遞 | 認領 → 動作 → 送出 → 完成 | 200 |
| 重複投遞（同一 update_id，已完成） | **什麼都不做**（認領回 completed） | 200 |
| 同一實例併發重複 | 合流成一次，只回覆一次 | 200 / 200 |
| 跨實例併發重複 | DB 原子認領只讓一個進去 | 200 / 503 |
| 已完成之後重播 | 收據回傳已存結果，動作不重跑、AI 不重打 | 200 |
| 暫時性失敗（拿不到所有權 / 租約壞掉） | 不處理、不 ack | 503 |
| Telegram 送出失敗 | 不標記完成，可以重送 | 503 |

**不會重複的東西**：Journal 動作、狀態轉換、OpenRouter 呼叫（重播走收據）、
使用者看到的回覆。

**已知的保守行為**：如果某個實例死在「已 dispatch、還沒標記完成」之間，那一則
會停在 `stale_processing`，webhook 一律回 503 而不會自動重做 —— 因為副作用做到
哪裡不確定，而重做的代價是第二筆 journal。這是刻意的取捨（「絕不因為某個
worker 死了就承認未提交的工作」），需要人來看。用 `npm run phase0` 看得到。

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
