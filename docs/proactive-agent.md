# Proactive Physiological Agent

這份文件說明 Proactive Agent 是什麼、不是什麼，以及它的完整管線、安全邊界、
啟用流程。程式碼是唯一的事實來源；這份文件描述的是設計意圖與邊界，如果
兩者不一致，以程式碼與測試為準。

## 這不是什麼

- **不是即時監測系統**：WHOOP 官方 Developer API 沒有連續心率 / 即時生理訊號的
  endpoint。系統唯一的資料來源是 cron 每 30 分鐘一次的 WHOOP 同步，分析的對象
  永遠是「已經同步進來的 daily_metrics」，不是這一刻的身體狀態。**系統絕不能、
  也從未宣稱看得到即時心率。**
- **不是診斷系統**：所有輸出都經過 `guardNarrative`/`guardProactiveMessage`
  的因果語言與診斷措辭黑名單。NOTIFY 訊息只會用「建議考慮休息、就醫或諮詢醫療
  專業人員」這種保守措辭，絕不宣稱偵測到急症、絕不給病名。
- **不是 LLM 輪詢迴圈**：LLM 在這條管線裡完全不參與「要不要行動」的決定。
  Readiness、訊號偵測、Attention Engine、Information-Gain 問題排序全部是
  Node 裡的確定性函式。LLM 目前也還沒有被接進主動訊息的措辭（見「LLM 的角色」）。

## 核心設計原則

```
新 WHOOP 資料
  → 確定性 readiness（src/readiness.js）
  → 確定性分析／訊號（src/signals.js）
  → Attention Engine（src/attention.js）：IGNORE / LOG_ONLY / ASK_CONTEXT / NOTIFY
  → （ASK_CONTEXT）Information-Gain 問題引擎（src/questionEngine.js）
  → 認領冪等鍵、寫入稽核軌跡（src/proactiveStore.js：proactive_events）
  → Telegram（src/proactiveAgent.js，掛在 src/index.js 的 runForUser）
  → 開 pending question（複用既有 pending_questions 機制）
  → 使用者回答（src/bot/router.js 的 handleProactiveAnswer）
  → 寫入 journal（source=proactive_agent）
  → 重新分析（src/proactiveReanalysis.js，誠實允許 STILL_UNEXPLAINED）
  → Insight Memory belief revision（src/healthMemory.js，既有的狀態機，不繞過）
  → 只有真的變化才發 follow-up
```

**資料不足時，管線在最早的一步就自然停下**：`assessDeviation()` /
`assessChangeDetection()` 沒有 READY，`src/signals.js` 就不會產生任何訊號——
不是靠後面的 Attention Engine 濾掉，而是訊號從一開始就不存在。這是「主動監測
在資料不足時不解讀正常生理波動」的實際實作方式，不是一句口號。

## 模組地圖

| 模組 | 責任 |
|---|---|
| `src/readiness.js` | 17 個分析能力的確定性 readiness（PA1）|
| `src/signals.js` | readiness READY 的指標才可能產生訊號（DEVIATION / BASELINE_SHIFT）|
| `src/attention.js` | 決定 IGNORE/LOG_ONLY/ASK_CONTEXT/NOTIFY，決策附完整 factors |
| `src/proactivePolicy.js` | 所有反騷擾／注意力／資訊增益的產品啟發式常數（集中、可測試）|
| `src/questionEngine.js` | 從候選 journal 類別中排序、選出恰好一題 |
| `src/proactiveMessages.js` | NOTIFY 樣板、冷啟動階段判斷、送出前的敘述守門 |
| `src/proactiveStore.js` | `proactive_agent_state`／`proactive_events` 的存取 |
| `src/proactiveAgent.js` | 整條管線的協調者，掛進 cron 的 `runForUser` |
| `src/proactiveReanalysis.js` | 回答之後重新分析、更新 Insight Memory、決定 follow-up |
| `src/bot/router.js` (`handleProactiveAnswer`) | 使用者回答的解析與收尾 |
| `src/healthMemory.js` | Insight 的信念修正狀態機（既有模組，直接重用）|

## 冷啟動階段

由 `src/proactiveMessages.js` 的 `deriveColdStartStage()` 決定，**輸入是
readiness 狀態，不是日曆天數**：

| 階段 | 對應 readiness | 行為 |
|---|---|---|
| STAGE_0 | `PROACTIVE_MONITORING` = NO_DATA（或 DEGRADED/UNAVAILABLE）| 完全不主動 |
| STAGE_1 | WARMING_UP | 完全不主動（也不可能有訊號，見上）|
| STAGE_2 | LIMITED | 完全不主動 |
| STAGE_3 | READY | 完整管線啟用 |
| STAGE_4 | READY 且已有非 HYPOTHESIS 的 insight | 完整管線啟用（可引用既有規律）|

## 反騷擾政策

集中在 `src/proactivePolicy.js` 的 `ANTI_SPAM_POLICY`／`ATTENTION_POLICY`：

- 同一個訊號代碼（如 `HRV_LOW`）24 小時內只能觸發一次 ASK_CONTEXT/NOTIFY。
- 一天最多 `DAILY_PROACTIVE_CAP`（預設 2）則主動訊息。
- 同時最多一個 OPEN 的主動問題（`MAX_OPEN_QUESTIONS = 1`）。
- 單日、非持續、非多重佐證的訊號一律 `LOG_ONLY`（記錄但不打擾）——
  「不是每個異常都要通知使用者」是 `decide()` 的預設行為，不是例外。

## 冪等與重啟安全

`proactive_events` 的 `UNIQUE(user_id, idempotency_key)`（`idempotency_key = 
health_date::policy_version`）是唯一的持久化保證：

- 游標 (`proactive_agent_state.last_checked_health_date`) **只在事件成功
  claim 之後才前進**，不是函式一開始就前進——crash 在 claim 與送出訊息之間，
  下次重跑會拿到同一把 idempotency key、claim 失敗、視為已處理，不重送。
- 這是刻意選擇的 **at-most-once** 語意：寧可極端情況下漏發一次，也不要對
  同一件事重複打擾使用者。沒有做到嚴格 exactly-once。

## Multi-user 隔離

所有函式一律要求明確的 `userId`（`requireUserId`），沒有任何全域狀態。
`test/proactive-agent.test.js` 的 PA19 測試用完全獨立的 Alice/Bob 帳號證明：
一個人的訊號、pending question、每日上限、proactive_events 完全不會出現在
另一個人名下。

## LLM 的角色（目前）

主動訊息（問題與 NOTIFY 文字）目前**全部是確定性樣板**（`buildNotifyMessage`、
`questionEngine.buildQuestionText`），LLM 完全不參與生成。所有樣板送出前都會
再跑一次 `guardProactiveMessage()`（沿用既有 `llmValidation.js` 的因果/診斷
語言黑名單）——這是深度防禦，不是因為樣板本身不可信，而是確保未來如果改用
LLM 生成措辭，同一套安全檢查已經就位、不需要重新設計。

如果未來要讓 LLM 參與措辭：LLM 只能潤飾語氣，不能新增數字、日期、指標名稱、
因果宣稱，也不能繞過 Attention Engine 的決定或自己決定要不要發送——這條界線
現在就要先寫清楚，之後才不會被無意間破壞。

## 未來延伸點：LiveSensorGateway（尚未實作）

WHOOP 官方 Developer API v2 沒有連續/即時生理訊號的 endpoint，所以現在完全
沒有「即時」這個概念。如果未來要支援其他有即時串流能力的資料源（例如某些
胸帶或手環的 SDK），設計上應該新增一個**獨立的 gateway 層**，而不是把即時邏輯
硬塞進現有的 30 分鐘 cron 管線：

```
// 純粹是設計草圖，不是已經實作的介面。
interface LiveSensorGateway {
  // 訂閱某個使用者的即時訊號流（實作細節由個別廠商 SDK 決定）。
  subscribe(userId: string, onSample: (sample) => void): () => void; // 回傳取消訂閱函式
}
```

這個 gateway 產生的訊號應該還是要先經過**同一套 readiness 與 Attention
Engine**，不能繞過——「有即時資料」不代表「有資格產生確定性以外的結論」。
在真的有這樣的資料源之前，這裡只留下設計意圖，不寫任何程式碼。

## 已知限制

- `src/analysisStore.js` 的 `recordPredictionActual()` 有一個既有（非本次
  新增）的 bug：函式內用了 `uid` 變數但從未從 `userId` 解構出來，會在被呼叫時
  拋出 `ReferenceError`。這個函式目前沒有生產呼叫路徑用到，PA1 review 過程中
  發現，記錄在此但刻意不在這次的 Proactive Agent 工作範圍內修改（避免無關
  變更）。
- Attention Engine 的持續性/冷卻判斷是以「當天最高嚴重度的訊號」為準；如果
  同一天有兩個不同指標的訊號、且較嚴重的那個剛好在冷卻中，目前不會退而評估
  次要訊號是否值得獨立行動。這是刻意的簡化（避免同一天發出多則主動訊息），
  但代表某些次要但持續的訊號可能會被暫時遮蔽一天。
- Information-Gain 問題引擎目前只覆蓋 `alcohol / sickness / travel /
  late_sleep / stress` 五個類別（沿用既有 `FOLLOW_UP_CATEGORIES`）。新增類別
  需要同時更新 `questionEngine.js` 的樣板文字。

## WHOOP 正式啟用檢查清單（文件化，本次未執行）

以下步驟描述「如何讓 Proactive Agent 對 Kelvin 的真實 WHOOP 帳號開始運作」，
**這次工作只記錄步驟，沒有執行任何一步**——沒有授權真的 WHOOP、沒有 probe
真的 WHOOP、沒有 backfill 真的 WHOOP。

1. **確認 `scripts/probe-fields.js` 已 user-scoped**（本次已修好，見
   `scripts/pickUser.js` 的引入）。在真的授權之前不需要再改。
2. `npm run authorize`（本機執行，需要真的 WHOOP_CLIENT_ID/SECRET；會開瀏覽器
   走 OAuth）——**本次工作沒有執行這一步**。
3. `npm run sync -- --until-done`，把歷史資料 backfill 回來——**沒有執行**。
4. `npm run probe`，寫入 `whoop_capabilities`，讓 readiness 的
   `capabilityGate()` 能正確分辨 KNOWN_UNAVAILABLE 與 NOT_YET_VERIFIED
   ——**沒有執行**。
5. 資料開始累積後，`/status` 的 Proactive Agent 區塊會誠實顯示目前的冷啟動
   階段（STAGE_0 → STAGE_3 需要 `ANALYTICS.DEFAULT_BASELINE_WINDOW`＝30 天
   內每個核心指標（recovery/hrv/rhr）都有 `ANALYTICS.MIN_SAMPLES`＝5 筆有效
   樣本）。在到達 STAGE_3 之前，系統不會產生任何訊號或訊息——這是 readiness
   gating 的直接結果，不需要另外做任何事去「等待」。
6. 建議：到達 STAGE_3 之後，**先人工觀察至少一次真實的訊號偵測結果**
   （查看 log 的 `proactive_decision` 事件、`proactive_events` 表的內容），
   確認訊號與決策合理，再放心讓它主動發送 Telegram 訊息。
7. 全程遵守：`user_calibrating` 期間的 recovery 值一律視為 null（既有規則，
   `isCalibrating()`），不會被 readiness 誤判成有效樣本。

## 測試覆蓋

- `test/readiness.test.js`：PA1 readiness engine + PA1 review 的 UNKNOWN/
  UNAVAILABLE 區分 + 完全無副作用的黑盒證明。
- `test/proactive-agent.test.js`：端到端管線（PA3-PA9）、回答迴圈
  （PA10-PA14）、multi-user 隔離（PA19）、重啟/冪等安全（PA20）。
- `test/proactive-insight-lifecycle.test.js`：Insight Memory 累積門檻
  （一次回答不能直接變 SUPPORTED）。
- `test/proactive-notify-and-guard.test.js`：NOTIFY 安全語言、敘述守門的
  blocked/allowed 例句、冷啟動階段對應表。
- `test/proactive-readiness-ux.test.js`：`/status`、`/predictions` 的
  readiness UX，含一個既有 bug 的修正驗證。

執行 `npm test` 涵蓋以上全部，全程不呼叫真的 WHOOP／Telegram／OpenRouter
（一律用 `fakeTelegram`／假 coach／真的本機 libSQL 檔案）。
