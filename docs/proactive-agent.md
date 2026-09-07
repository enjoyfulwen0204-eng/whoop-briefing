# Proactive Physiological Agent

這份文件說明 Proactive Agent 是什麼、不是什麼，以及它的完整管線、安全邊界、
啟用流程。程式碼是唯一的事實來源；這份文件描述的是設計意圖與邊界，如果
兩者不一致，以程式碼與測試為準。

> **稽核狀態**：2026-09-07 由獨立稽核重跑並修正過一輪（見文末「稽核修正紀錄」）。
> 這份文件描述的是**修正後**的行為。

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

### 觸發條件：新資料 **或** 被修正過的資料

判斷依據是 `(health_date, fingerprint)`，不是只有日期：

- `fingerprint` = 錨點那天所有被監看指標的值 + 監看清單 + 政策版本的 SHA-256。
- 位元組／語意完全相同的重複 sync → 指紋相同 → **完全不做事**（0.8 ms 就返回）。
- WHOOP 事後把 recovery 從 `PENDING_SCORE` 改成 `SCORED`（同一天、同一筆 sleep）
  → 指紋改變 → **重新分析**。

只比對 health_date 的舊做法會漏掉後者，而那正是 WHOOP 的正常流程——
稽核時把它列為 CRITICAL 並修掉了。

**資料不足時，管線在最早的一步就自然停下**：`assessDeviation()` /
`assessChangeDetection()` 沒有 READY，`src/signals.js` 就不會產生任何訊號——
不是靠後面的 Attention Engine 濾掉，而是訊號從一開始就不存在。這是「主動監測
在資料不足時不解讀正常生理波動」的實際實作方式，不是一句口號。

## 模組地圖

| 模組 | 責任 |
|---|---|
| `src/readiness.js` | 17 個分析能力的確定性 readiness（PA1）|
| `src/signals.js` | readiness READY **且往「值得擔心」的方向**偏離才產生訊號 |
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

## 監看哪些指標、哪個方向才算訊號

`SIGNAL_POLICY.MONITORED_METRICS`：recovery / hrv / rhr / respiratory_rate /
sleep_performance / sleep_debt / previous_day_strain。
（成熟度門檻仍然只看核心三項 recovery/hrv/rhr，見冷啟動階段。）

`SIGNAL_POLICY.CONCERNING_DIRECTION` 決定**哪一邊**才算訊號：
恢復/HRV/睡眠表現偏低、靜息心率/呼吸率/睡眠債/前一天 Strain 偏高。
往「好」的方向偏離**永遠不會**產生訊號——稽核時實際抓到系統對著
「呼吸更平穩 + 昨天比較沒操」兩個好消息跑去問使用者是不是喝酒了。

`SIGNAL_POLICY.METRIC_DOMAIN` 把指標分成 autonomic / respiratory / sleep /
load 四個領域。「多重訊號佐證」算的是**不同領域的數量**，不是訊號筆數——
recovery 本來就是 WHOOP 用 hrv 與 rhr 算出來的，把它們當三個獨立證據
等於同一件事數三次。

## 反騷擾政策

集中在 `src/proactivePolicy.js` 的 `ANTI_SPAM_POLICY`／`ATTENTION_POLICY`：

- 同一個訊號代碼（如 `HRV_LOW`）24 小時內只能觸發一次 ASK_CONTEXT/NOTIFY。
- 一天最多 `DAILY_PROACTIVE_CAP`（預設 2）則主動訊息。
- 同時最多一個 OPEN 的主動問題（`MAX_OPEN_QUESTIONS = 1`）。
- 單日、非持續、非多重佐證的訊號一律 `LOG_ONLY`（記錄但不打擾）——
  「不是每個異常都要通知使用者」是 `decide()` 的預設行為，不是例外。
- **冷卻不會連坐**：某個主題在冷卻中時，引擎會改用當天第一個「不在冷卻中」
  的訊號來判斷，而不是整天靜音。否則「昨天問過 HRV」會把今天新出現、
  屬於不同生理領域的呼吸率升高一起悶掉 24 小時。

## 使用者可以關掉

`proactive_agent_state.enabled`（per-user，預設開）。關掉之後：
資料照同步、分析照跑、稽核軌跡照記，但**不會再收到任何未經請求的訊息**；
手動問答完全不受影響。Alice 關掉不影響 Bob。

## 冪等與重啟安全

`proactive_events` 的 `UNIQUE(user_id, idempotency_key)`
（`idempotency_key = health_date::fingerprint::policy_version`）是唯一的持久化
保證。指紋在 key 裡面，所以**被修正過的那一天可以產生新事件、一模一樣的資料
不行**：

- 游標 (`proactive_agent_state.last_checked_health_date`) **只在事件成功
  claim 之後才前進**，不是函式一開始就前進——crash 在 claim 與送出訊息之間，
  下次重跑會拿到同一把 idempotency key、claim 失敗、視為已處理，不重送。
- 這是刻意選擇的 **AT_MOST_ONCE + best-effort dedup** 語意：寧可極端情況下
  漏發一次，也不要對同一件事重複打擾使用者。**沒有**做到 exactly-once。
- 具體的當機視窗行為（都有對應測試，見 `test/proactive-audit.test.js`）：
  - Telegram 送出成功、DB 標記前當機 → 重跑辨識為重複，**不重發**。
  - Telegram 逾時（送達結果未知）→ **不重試**，事件的 `sent_at` 保持空值，
    稽核軌跡誠實反映「決定送出，但沒能確認送達」。
  - 事件 claim 成功但游標沒前進 → 下一輪重算拿到同一把 key，安全前進。

## 可追溯性

`proactive_events` 一列可以串起完整因果鏈：
`signals_json`（當時偵測到什麼）→ `reason_json`（為什麼這樣決定）→
`pending_question_id`（問了哪一題）→ `journal_event_id`（使用者的回答變成哪筆
Journal）→ `outcome`（重新分析的誠實結論）。

## 重新分析怎麼判斷「解釋了沒有」

不是看「insight 狀態有沒有變動」（舊版這樣寫，結果**歷史越完整、答案越糟**：
一個已經 SUPPORTED 的規律被再次佐證時 `changed=false`，系統反而回
「資料還不足以確認」）。現在的判準是：

1. 這個 subject 的證據強度真的到 EMERGING/SUPPORTED，**而且**
2. 觀察到的關聯方向與這次異常的方向一致（曝露 → 指標下降 = 負相關，
   這次異常也要是「偏低」才說得通）。

兩者皆成立才算 `EXPLAINED`，否則誠實回 `STILL_UNEXPLAINED`。
`follow-up` 仍然只在**信念真的改變**時才發（避免「謝謝你的回覆」式騷擾），
這與「這次異常有沒有被解釋」是分開的兩件事。

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

## Schema

`SCHEMA_VERSION = 3`（v3 = 新增 Proactive Agent 兩張表）。兩張表都是純新增，
不動任何既有表；`migrations.js` 在版本推進時會檢查 `RESHAPED_TABLES`，
空的舊形狀表才重建、有資料一律中止。production 目前還沒有這兩張表，
所以會直接以最終形狀建立。

## 已知限制

- 送達語意是 AT_MOST_ONCE：Telegram 逾時或當機時訊息可能遺失，不會重試。
  這是刻意的取捨（不重複打擾 > 保證送達）。
- 反應式追問（使用者自己問完之後的追問）仍然會把下一句話當成回答；
  只有**主動代理**發起的問題才有「明顯是問句就不吃掉」的保護。
- `journalAssociation` 的對照組門檻（exposed/unexposed 各 ≥3 天）意味著
  很罕見的行為（例如一年只發生兩次）永遠不會形成 insight。這是誠實的，
  不是 bug，但也代表系統對稀有事件天生無感。
- 冷卻連坐已修掉，但同一天仍然最多只會送出一則訊息（每日上限預設 2、
  同時只允許一個未答問題）。

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


## 稽核修正紀錄（2026-09-07）

獨立稽核重跑並修正的問題（每一項都有對應的回歸測試，
集中在 `test/proactive-audit.test.js`）：

| 嚴重度 | 問題 |
|---|---|
| CRITICAL | 只比對 health_date → WHOOP 事後改分的同一天永遠不會被分析 |
| HIGH | 已成熟的 insight 被再次佐證時，反而回報「資料還不足」 |
| HIGH | 主動訊息的守門對捏造的即時生理數值完全無效（數字檢查被關掉，且拿訊息自己當出處）|
| HIGH | 「好消息」也會產生訊號並觸發追問（缺 metric direction 對應 + 'both' 方向被當成可打擾）|
| HIGH | 沒有 per-user 關閉主動訊息的機制 |
| HIGH | `recordPredictionActual()` 的 `uid` 未定義，任何呼叫都 ReferenceError |
| MEDIUM | insight 狀態不變時，新證據被靜默丟棄 |
| MEDIUM | 併發修正同一個 insight 會讓版本鏈分叉出兩條 active |
| MEDIUM | 主動問題開著時，使用者問別的問題會被當成答案吃掉 |
| MEDIUM | 冷卻中的主題會連坐悶掉其他領域的新訊號 |
| MEDIUM | 訊號覆蓋面過窄（缺呼吸率等既有可用欄位）|
| MEDIUM | 耦合指標（recovery/hrv/rhr）被當成獨立佐證 |
| MEDIUM | Journal 無法回溯到觸發它的 proactive event |
