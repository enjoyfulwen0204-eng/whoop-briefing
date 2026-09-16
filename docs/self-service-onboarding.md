# 自助 Telegram 上線（V1.2 Phase 3.5）

> 狀態：**已實作、有測試、未部署。** 正式環境要真的用起來，還需要在
> WHOOP Developer Dashboard 註冊回呼網址、在 Render 設定 `WHOOP_REDIRECT_URI`
> 並部署 —— 那是另一次有意識的操作。

## 目標

一個全新的朋友只靠 Telegram 私訊就能把自己的 Health OS 開起來，
**Kelvin 完全不需要介入**：不建帳號、不發綁定碼、不跑授權腳本、不複製 token、
不手動同步、不手動 probe。

## 使用者看到的流程

| | 之前（人工） | 現在（自助） |
|---|---|---|
| 建帳號 | Kelvin 跑 `npm run admin user:create` | 朋友送 `/start` |
| 綁 Telegram | Kelvin 跑 `link:new` → 朋友 `/link <碼>` | `/start` 自動綁這個私訊 |
| 時區 | 寫死 `Asia/Taipei` | 朋友自己選（任何合法 IANA） |
| WHOOP 授權 | Kelvin 跑 `npm run authorize -- --user=<id>` | 朋友點 Connect WHOOP 連結 |
| 回呼 | `http://localhost:8788/callback`（只有 Kelvin 的電腦） | 公開 HTTPS `/whoop/oauth/callback` |
| 初次同步 | Kelvin 跑 `npm run sync -- --until-done` | 授權完成後自動 |
| capability | Kelvin 跑 `npm run probe` | 自動 |
| 開始可用 | Kelvin 說「好了」 | 系統自己通知「準備好了」 |

```
朋友：/start
Bot ：👋 歡迎…　第 1 步：你的時區是？（Asia/Taipei / Asia/Ho_Chi_Minh / …）

朋友：Asia/Ho_Chi_Minh
Bot ：✅ 時區設定為 Asia/Ho_Chi_Minh。
      第 2 步：連接你的 WHOOP 帳號
      https://api.prod.whoop.com/oauth/oauth2/auth?...（10 分鐘內有效）

（朋友在 WHOOP 官方頁面登入並授權 → 導回公開 HTTPS 回呼 → 網頁顯示「✅ WHOOP 已連接」）

Bot ：✅ WHOOP 連接完成。正在把你的資料同步進來…
Bot ：🎉 你的 Health OS 準備好了。（可以開始問問題、收日報）
```

其他入口：`/connect` 重新取得授權連結、`/timezone <值>` 改時區。

## 狀態機（[src/onboarding.js](../src/onboarding.js)）

```
                     ┌──────────────── /connect（新的一次性 state）────────────┐
                     ▼                                                        │
STARTED ──► TIMEZONE_PENDING ──► WHOOP_AUTH_PENDING ──► WHOOP_AUTHORIZED ──► SYNCING ──► READY
  /start        時區驗證通過            OAuth 成功           bootstrap 開始     初次同步 +
                                                                              capability 完成
        任何一步失敗 ──► ACTION_REQUIRED ──（/connect）──► WHOOP_AUTH_PENDING
```

權威是 `user_onboarding` 這一列（[src/onboardingStore.js](../src/onboardingStore.js)），
**不是** Telegram 對話狀態：webhook 可能換機器、可能睡著，OAuth 回呼是完全不同的
請求，bootstrap 又是另一個程序。每一則訊息都重新讀這一列。

`/start` 的行為依狀態而定：未知 → 建立身分並歡迎；等時區 → 提示；等授權 → 給連結；
同步中 → 顯示進度；ACTION_REQUIRED → 說明原因 + 新連結；READY → 交回既有的 `/start`。

## 身分與綁定（原子、冪等、併發安全）

`/start` 只在**私訊**動作（updateProcessor 的 H-01 閘門 + 這一層再擋一次 +
儲存層的 `isSafePrivateChatId`）。建立流程：

1. 已經有綁定 → 直接用（並補一列 READY 的上線狀態，代表舊使用者）。
2. 綁定被撤銷／退役 → **不自動重綁**，請聯絡管理者。
3. 否則建立使用者 → **原子認領**這個 chat（`claimTelegramChat`：
   `INSERT … ON CONFLICT(telegram_chat_id) DO NOTHING` 再讀回主人）。

併發時每個請求都會先建一個 users 列，但只有一個能認領成功；輸的那些立刻被
標成 DISABLED（沒有綁定、沒有 token、不會出現在任何清單裡）。
**最終永遠是一個 ACTIVE 使用者、一個綁定、一份上線狀態。**
刻意不真的刪除落選的列：留著才看得出發生過什麼。

## 時區

只接受合法的 IANA 名稱，驗證交給執行環境的 `Intl`（不自己維護白名單 ——
白名單一定會過期，而且會讓住在沒被列到的地方的人完全無法上線）。
ICU 會把合法別名正規化（`Asia/Ho_Chi_Minh` → `Asia/Saigon`），我們**保留使用者
打的名字**，只有大小寫不同時才採用正規化寫法。

不從 Telegram 推測、不用 IP 定位：兩者都給不出可靠的 IANA 時區，猜錯等於把
整個人的「今天」算錯。時區沒設定之前，使用者的 `timezone` 是 `UTC` 這個標記值，
而且 READY 判定會擋下來 —— 日期敏感的功能不會對他生效。

## WHOOP OAuth

- 連結由既有的 `prepareAuthorization()` 產生：32 bytes 隨機 state，**DB 只存
  SHA-256 hash**，原文只出現在授權 URL 裡。state 在產生的那一刻就綁死一個
  內部 userId。
- 使用者永遠看不到 client secret、token、內部 user_id ——
  連結只有 `client_id / redirect_uri / response_type / scope / state`。
- 回呼**完全不信任**任何 query 參數決定身分：用 Alice 的連結在 Bob 的瀏覽器
  完成授權，綁到的仍然是 Alice。
- 一次性 + 有期限：replay 與並發雙擊都只有一個能過。
- 同一個 WHOOP 帳號不可能綁到兩個內部使用者（DB partial unique index 是
  race-safe 的最後一道，`completeAuthorization` 先給人看得懂的錯誤）。
- 同一個人重新連接**同一個**帳號是安全的，而且不會把 READY 打回上線中。

### 公開回呼

`GET /whoop/oauth/callback`（[src/whoopOAuthCallback.js](../src/whoopOAuthCallback.js)），
掛在既有的 Telegram webhook web service 上，不影響
`/health`、`/telegram/webhook`、`/whoop/webhook`、`/internal/briefing/run`。

- 回的是給人看的 HTML；每一句文字都是**應用程式自己的常數**。
  WHOOP 可能在 query 帶 `error_description`，那是外部可控字串 ——
  只用來選一個畫面，內容既不顯示也不進 log（Codex 先前在本機腳本抓到的
  反射問題在這條新路上不存在）。
- 回應標頭：`no-store`、`nosniff`、`no-referrer`、
  `default-src 'none'` 的 CSP。沒有任何 token / state / 內部 id。
- **有界**：只做「驗 state → 換 token → 驗身分 → 存 → 改狀態 → 回 HTML」。
  365 天 backfill 不在這裡（見下）。

### ⚠️ 回呼網址（部署前必須註冊）

```
https://<Render web service 網域>/whoop/oauth/callback
```

這個值必須同時出現在三個地方而且**完全一樣**：WHOOP Developer Dashboard 的
Redirect URI、Render 的 `WHOOP_REDIRECT_URI` 環境變數、以及這個服務實際掛的路徑。
本機開發仍可用 `http://localhost:8788/callback` 搭配 `scripts/authorize.js`。

## 授權之後：自動 bootstrap

[src/onboardingBootstrap.js](../src/onboardingBootstrap.js)：

```
WHOOP_AUTHORIZED
  → 初次同步   createSync(...).syncAll({force:true})   ← 重用 V1.1，不另建攝取堆疊
  → capability probeCapabilities()                      ← 重用既有語義
  → READY 判定 → 通知使用者
```

兩個觸發點，同一把鎖（`resource_locks`），所以不會有兩個同時在跑：

1. 回呼之後**不 await** 踢一次（使用者很快收到通知）；
2. 排程器每一輪 `resumeOnboardingBootstraps()` 接手還卡著的（有上限）。

程序在任何一點死掉，狀態機都停在 `WHOOP_AUTHORIZED` / `SYNCING`，下一輪自然接回去。
失敗**不會**標成 READY、**不會**寫任何「這個人沒有這個能力」的結論
（`probeCapabilities` 只在成功時才寫）；重試 5 次之後轉 `ACTION_REQUIRED`。

歷史 backfill 沿用既有的 chunk 機制：初次同步抓第一批，其餘在之後的排程輪次
繼續 —— READY 不等待 365 天抓完。

## READY 的確定性條件

`evaluateReadiness()` 全部成立才算：使用者 ACTIVE、時區已設定（不是 `UTC` 標記值）、
Telegram 綁定有效、WHOOP token 存在、WHOOP 身分已驗證、同步狀態存在、
capability 盤點跑過。

**刻意不包含**「分析已經成熟」——一個剛買手錶的人本來就沒有 30 天基準，
那不是上線沒完成。既有的 `NO_DATA / WARMING_UP / LIMITED / UNAVAILABLE / DEGRADED`
語義完全不變。

## 排程器

`listSchedulableUsers()` = ACTIVE **且**（上線 READY 或沒有上線列）。

- 還在上線的人不會收到「今天沒有資料」的日報（那不是服務，是雜訊）。
- Phase 3.5 之前的使用者沒有上線列 → 一律視為 READY → Kelvin 完全不受影響。
  v13 → v14 的資料遷移另外把當下存在的使用者明確補成 READY，讓狀態看得見。

## 濫用控制（有界，不是一整套平台）

公開的 bot 會收到隨機流量，但攻擊面很窄：一個私訊只能綁一個使用者（儲存層擋），
授權連結本身不洩漏任何東西。所以只需要：私訊限定、原子的一 chat 一使用者、
授權連結冷卻（20 秒）與每輪上限（10 條，授權成功後歸零）、
bootstrap 重試上限。全部在既有的 DB，沒有引入 Redis 或任何外部佇列。

非 `/start` 的陌生訊息**不建立任何身分**，只回一句上線指引 ——
未知的人問「我的恢復怎樣」永遠拿不到任何人的資料。

## schema v14（純新增一張表）

`user_onboarding`（PK user_id）：state、各階段時間戳、失敗代碼與細節、
授權連結配額、bootstrap 嘗試次數。**不存任何祕密**（state 原文只以 hash 存在
`oauth_states`，token 在 `user_whoop_tokens`）。

`DATA_MIGRATIONS` 是新的「版本閘門資料遷移」機制：只在 `from < version` 時跑一次，
而且語句本身冪等（`WHERE NOT EXISTS`）。v14 用它把遷移當下存在的使用者補成 READY。

## 舊的管理員路徑

`user:create` / `link:new` / `/link <碼>` / `npm run authorize` **全部保留**，
作為管理與復原路徑（例如綁定被退役、需要換綁）。自助流程是預設路徑，
但沒有移除任何既有功能。

## 尚未做

- Telegram inline URL 按鈕：目前的送訊層只送純文字（耐久回覆是字串），
  加 `reply_markup` 會動到送達冪等的資料形狀，不在這一階段的範圍。連結本身可點。
- token 仍以明文存在 DB（既有狀況，未改變）。多人正式上線前值得評估加密。
- Phase 3 的非同步分析仍然是 dormant：新使用者走的是現行的同步分析路徑。
