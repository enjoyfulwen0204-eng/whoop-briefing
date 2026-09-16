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
整個人的「今天」算錯。

### 「時區的值」與「時區已確認」是兩件事（RC1 / F01）

第一版把 `timezone === 'UTC'` 當成「還沒設定」的哨兵值。那是錯的：**UTC 是一個
真實存在的時區**，住在那裡（或就是想用它）的人選了 UTC 之後會永遠卡在上線中。

現在確認是**明確記錄下來的證據**：`user_onboarding.timezone_confirmed_at`。

| 情況 | `users.timezone` | 已確認 | 可以 READY |
|------|------------------|--------|-----------|
| 剛 `/start` 的新使用者 | `UTC`（預設值） | 否 | 否 |
| 使用者選了 `UTC` | `UTC` | **是** | 是 |
| 使用者選了 `Asia/Taipei` | `Asia/Taipei` | 是 | 是 |
| 輸入不合法（`+08:00`） | 不變 | 否 | 否 |

READY 判定與原子轉移看的都是 `timezone_confirmed_at`，**不是**字串長什麼樣。

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

使用者 ACTIVE、**時區已確認**、Telegram 綁定有效、WHOOP token 存在、
WHOOP 身分已驗證、同步狀態存在、capability 盤點跑過、
而且**核心 WHOOP 權限齊全**（見下）。

**刻意不包含**「分析已經成熟」——一個剛買手錶的人本來就沒有 30 天基準，
那不是上線沒完成。既有的 `NO_DATA / WARMING_UP / LIMITED / UNAVAILABLE / DEGRADED`
語義完全不變。

### 轉成 READY 是**原子**的（RC1 / F04）

第一版的順序是「讀完前提 → 之後再寫 READY」。中間那段空隙足以讓 Telegram 綁定
被退役、token 被撤銷、狀態被改成需要處理，而 bootstrap 仍然把 READY 寫下去。

現在 `setReadyIfEligible()` 是**一句** UPDATE：所有關鍵前提都寫在它的 WHERE 裡
（`EXISTS` 子查詢 + `timezone_confirmed_at IS NOT NULL` + 來源狀態白名單），
SQLite 對單一語句的求值與寫入是原子的，所以：

- 讀與寫之間被撤銷的綁定／token／身分／capability → 轉移失敗，維持待處理。
- 期間狀態被改成 `ACTION_REQUIRED` → 過期的 bootstrap **不可能**覆蓋回 READY。

### 最低 WHOOP 權限（RC1 / F05）

**必要**：`sleep`、`recovery`。理由是實際的下游相依：

- `sleep` —— daily metrics 唯一的必要來源；沒有它連 health_date 都建立不起來。
- `recovery` —— 起床觸發（`detectWake`）要求對應的 recovery 已評分；沒有它日報
  永遠不會發出，紅黃綠燈也沒有依據。

`cycle`（昨日 Strain）、`workout`、`body_measurement` 是加值：缺了它們對應的指標
會誠實地標成拿不到，系統仍然可用，所以**不**列入必要條件。

⚠️ **「沒有資料」不是「沒有權限」。** 端點成功回傳空集合的人是正常的新使用者
（READY 的正常起點）；只有 WHOOP 回 401/403（`syncAll` 的 `scope_missing`、
`probeCapabilities` 的 `scopeErrors`）才算沒有權限。一般的失敗（429／5xx／逾時）
一律當成暫時性 → 重試，**絕不**寫下「這個帳號沒有這個能力」的永久結論。

核心權限缺失 → `ACTION_REQUIRED`（`WHOOP_SCOPE_INCOMPLETE`）+ 一條新的授權連結，
訊息明確說「請把要求的健康權限全部勾選」。

## 排程器

`listSchedulableUsers()` = ACTIVE **且**上線狀態是 `READY`（JOIN，不是 LEFT JOIN）。

| 上線狀態 | 收日報／週報 | bootstrap 接手 |
|---|---|---|
| STARTED / TIMEZONE_PENDING / WHOOP_AUTH_PENDING | ✗ | ✗ |
| WHOOP_AUTHORIZED / SYNCING | ✗ | ✓ |
| ACTION_REQUIRED | ✗ | ✗ |
| READY | ✓ | ✗ |
| 帳號非 ACTIVE（DISABLED / PAUSED） | ✗ | ✗ |
| **沒有上線列** | ✗ | ✗ |

★ RC1 / F02：「沒有上線列」**不再**被當成 READY。那是一個繞過整個狀態機的
後門 —— 一個剛被 CLI 建出來、什麼都還沒設定的 ACTIVE 使用者會立刻開始收日報。
遷移保證每個既有使用者都有一列（依證據推導），讀取時若真的查不到列也是**推導**
而不是假設 READY。

## 濫用控制（有界、而且**會自己恢復**）

公開的 bot 會收到隨機流量，但攻擊面很窄：一個私訊只能綁一個使用者（儲存層擋），
授權連結本身不洩漏任何東西。所以只需要：私訊限定、原子的一 chat 一使用者、
授權連結的兩道閘門、bootstrap 重試上限。全部在既有的 DB，沒有 Redis 或外部佇列。

### 授權連結（RC1 / F03）

| 閘門 | 值 | 為什麼會自己恢復 |
|------|----|-----------------|
| 冷卻 | 20 秒 | 純時間條件 |
| 同時有效的連結數 | 5 | 過期／用掉的 state 不再計入 |

第一版用的是「這一輪總共發過幾條」的累積計數，十次之後就**永久**鎖死 ——
自助復原因此失效。現在的上限是「**未完成**數量」：舊連結一過期或被用掉就釋出
名額，所以不可能有永久鎖定。而且它由一句條件式 `INSERT … SELECT … WHERE
(SELECT COUNT(*) …) < ?` 決定 —— 條件與寫入在同一個語句裡，所以並發的多個
`/connect` 不可能一起穿過去（兩條執行緒各試 11 次，最後仍然恰好 5 條）。

非 `/start` 的陌生訊息**不建立任何身分**，只回一句上線指引 ——
未知的人問「我的恢復怎樣」永遠拿不到任何人的資料。

## schema v15（純新增一張表 + 一次資料修正）

`user_onboarding`（PK user_id）：state、各階段時間戳（含 `timezone_confirmed_at`）、
失敗代碼與細節、授權連結計數、bootstrap 嘗試次數。**不存任何祕密**
（state 原文只以 hash 存在 `oauth_states`，token 在 `user_whoop_tokens`）。

`DATA_MIGRATIONS` 是「版本閘門資料遷移」機制：只在 `from < version` 時跑一次，
語句本身也冪等。

### 既有使用者的狀態是**推導**出來的（RC1 / F02）

第一版的 v14 把**每一個**既有使用者都寫成 READY。那對完整設定好的 Kelvin 是對的，
對其他形狀全是捏造：被停用的帳號、沒有 Telegram 綁定的、沒有 WHOOP token 的，
全部會被宣告成上線完成然後被排程。

現在 v14 依**證據**推導（`ONBOARDING_DERIVED_STATE_SQL`，與讀取端共用同一段 SQL）：

| 證據 | 推導狀態 | 可排程 |
|------|---------|--------|
| 帳號不是 ACTIVE | `ACTION_REQUIRED`（`ACCOUNT_INACTIVE`） | ✗ |
| 沒有 ACTIVE 的 Telegram 綁定 | `STARTED` | ✗ |
| 沒有 token 或沒有驗證過的 WHOOP 身分 | `TIMEZONE_PENDING` | ✗ |
| 沒有同步狀態 | `WHOOP_AUTHORIZED`（bootstrap 會接手） | ✗ |
| 沒有 capability 盤點 | `SYNCING`（bootstrap 會接手） | ✗ |
| 全部齊全 | `READY` | ✓ |

時區確認只給「已經有驗證過的 WHOOP 身分」的既有使用者 —— 那種列是管理者用 CLI
建的，建立時就必須給一個明確的時區。更早的階段無法證明時區是刻意選的，
所以留 NULL，讓他們走一次兩步驟流程。

v15 的資料遷移負責**修正**已經被第一版 v14 寫成假 READY 的列：只動「宣稱 READY
但證據不支持」的那些，真的走完流程的人不會被碰到。冪等。

## 舊的管理員路徑

`user:create` / `link:new` / `/link <碼>` / `npm run authorize` **全部保留**，
作為管理與復原路徑（例如綁定被退役、需要換綁）。自助流程是預設路徑，
但沒有移除任何既有功能。

## 尚未做

- Telegram inline URL 按鈕：目前的送訊層只送純文字（耐久回覆是字串），
  加 `reply_markup` 會動到送達冪等的資料形狀，不在這一階段的範圍。連結本身可點。
- token 仍以明文存在 DB（既有狀況，未改變）。多人正式上線前值得評估加密。
- Phase 3 的非同步分析仍然是 dormant：新使用者走的是現行的同步分析路徑。
