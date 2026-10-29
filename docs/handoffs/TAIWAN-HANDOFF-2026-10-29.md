# WHOOP Kelvin Health OS：越南 → 台灣開發交接

日期：2026-10-29。這是原始碼保存與開發交接，沒有部署、資料庫 migration、sync、功能啟用或 Telegram 發送授權。

## 從這裡開始

- Repository：<https://github.com/enjoyfulwen0204-eng/whoop-briefing.git>（PUBLIC）。
- 台灣開發入口：`handoff/tw-transfer-20261029`。
- R22 主線 HEAD：`b5027adaf9f860c28e0e02ecf3bdf754834adcbc`，原分支 `repair/stage6-shadow-publication-20261026`。
- 最新完成的獨立開發分支：`fix/stage7-journal-ux-v33-20261029`，HEAD `29ee2aef00fde3ec20919bbb4561bef33eb84bec`。
- 交接整合提交：`af9112fdbcce63eac69c1c06bfb08f51801b3780`，以 R22 為第一 parent，合併上述 Stage 7 分支，無衝突。最終交接提交另加本文件與 refs 清單；以 `git rev-parse HEAD` 讀取實際 SHA，勿把文件內的 source SHA 當成最終文件提交。
- 共保留交接前未公開的 **15 筆**工程提交：原受保護 12 筆、checkpoint 303 決策 1 筆、Stage 7 修正 2 筆。遠端原 R22 為 `75ff618c07e58028e827ca3fa37b5003b8c394c2`。
- Production：`9a8c951deee42ad9f6fd9c5828edad44f246d5f7`；schema **33**。2026-10-29 交接期間唯讀 Render metadata 確認 live SHA，schema 33 的既有認證見 checkpoint 303。沒有為交接查詢或修改 Production DB。
- Render 追蹤 `main`、`autoDeploy=no`；本分支不能當成 release。`main`、既有 release refs 及 Production 都不由本交接更新。

較早的 README、ADR、freeze tags、closure reports 保留歷史狀態，部分仍寫「Stage 7 未開始」或舊 schema 配置。現況以本文件、checkpoint 303 和下述明確範圍為準，不把歷史 PASS 擴張到最新 HEAD。

## 目的與架構

Node.js ESM 應用將 WHOOP OAuth/v2 資料同步至 Turso/libSQL，以程式計算個人基準、品質、趨勢與健康事實，再由 OpenRouter 教練文字層表達核准的內容，透過 Telegram 互動。語系包含繁中、英文與越南文；個人資料讀取必須保留 actor、tenant、privacy、generation、lease、原始 receipt 與 send-time authority。

Cloudflare Cron 以簽章呼叫 Render canonical runner；Render 同時接收 Telegram/WHOOP webhook。GitHub Actions 有既有備援與隔離 qualification 工作流程。Turso 保存授權、同步、Journal、投遞、receipt 與其他 durable 狀態。共享入口不表示各分析或投遞功能已取得上線認證。

## Stage 1–8 現況

| Stage | 已有工程與現況 | 尚未成立的結論 |
|---|---|---|
| 1 架構 | ADR、權限與不可變 authority 規則已建立；Foundation aggregate review 有歷史 PASS | 不授權新部署 |
| 2 儲存 | additive、tenant-scoped Foundation v21–v24 與資料來源／privacy contracts 已實作 | 不可重建、改寫舊 authority |
| 3 Body Energy 基礎 | calculator、品質、currentness、來源與 publication guard 已有實作 | 真實資料品質與完整 publication 尚未合格 |
| 4 Journal | 結構化 fact、context、correction/deletion、lineage 與 invalidation 已實作 | topic selection 不等於確認健康 fact |
| 5 Intelligence | v25 episode history、v26 evidence authority、v27 operation receipts；metric/association/evidence/insight 引擎與測試存在 | 沒有新的合格 Production intelligence 結果；合成與 reader component PASS 不能代替真實全流程 |
| 6 執行與復原 | v28–v30 routing/directory/SHADOW continuation、v32 execution settlement；R22 publication、original receipt、HTTP ownership 等修正已保存 | terminal Hrana gate **FAIL**、hold recovery gate **FAIL**；future-sync/orphan disposal 與完整 runtime 未認證 |
| 7 互動投遞 | v33 runtime、Coach/Journal/Settings、語系、偏好／quiet-hour／quota、callback guards；最新兩筆修正已合併 | 自然 Strain → 同一則真實 Telegram Emoji inline keyboard → 真實 callback 仍 **OPEN** |
| 8 Morning/Q&A | v34 schema/code、scoped Q&A、Evidence reader、Morning plan、Owner Monitoring、SELF-QA 與受控 producer 機制存在 | 真實 Telegram prepared-ticket/full-preimage receipt 整合、通知、完整 producer/runtime 尚未認證；不可啟用 |

現有 Coach 提供個人／一般問題分流，保留第三人與假設問題邊界；Journal 支援記錄、修訂、確認與撤回；Settings 保留 locale、偏好與既有投遞控制。Morning Brief 有 canonical sleep/recovery 判斷、報告去重、baseline、週報與 readiness/status。這些程式碼的存在不表示所有自然事件與 UI 均已完成真實使用者驗收。

## checkpoint 303：Option C 是目前決策

選擇 **C：advanced analytics fail-closed，只交付各自符合資格的既有 v33 功能**。理由是現有客戶端觀測不能證明 Turso server session/orphan 的終止與所有健康副本處置，繼續堆疊 A 的 client tracker/debugging 沒有可信的完整 acceptance closure。

- A 的歷史 narrow component 可證明 authorized preparation、跨連線可見的 durable commit、原 receipt/generation 保存；原 interrupted RID 仍是 PENDING → EXPIRED，沒有完成 recovery finalization。
- B 是具體但 **NOT_QUALIFIED** 的 server-owned durable atomic publication/reconciliation 替代方向。需要不可變 attempt/session、original-authority transaction、durable terminal journal、同一原身份的 lost-ACK reconciliation，以及肯定的 server terminal 與本機副本處置證明。現有 Turso 證據不提供所需 orphan finality；更換 topology 另需 owner 決策。
- 不得把 PENDING/EXPIRED 改稱成功或合法 completed-empty；不得更新舊 RID/deadline、重設 permit/quota，或用 TTL、idle、SDK close、EOF、cancel、epoch 當成 permanent hold disposal 證明。
- 保留 F02 與現有 Turso Token；不輪替、不替換、不為交接測試。原 signed holds、歷史 RIDs、權限、偏好與 quota 不變。
- `PHASE4_STAGE8_RUNTIME`、`STAGE8_LIVE_ANALYSIS`、`STAGE8_POST_SYNC`、`STAGE8_SUBJECT_ALERTS`、`STAGE8_MORNING_BRIEF` 保持既有未啟用政策；`BODY_ENERGY_PUBLICATION`、`BODY_ENERGY_ALERTS` 保持關閉。不要從本機 `.env` 自動重建 Production 設定。

完整技術決策見 `docs/r22-architecture-delivery-gate-303.json`；原私有 reviews/evidence 僅在越南備份，文件內私有路徑不是 GitHub 可讀附件。

## Stage 7 最新進度與驗收限制

`d1040ccf8e798e3058fb9fdbf28c8106f356bd3a` 修正未回答的 Journal card 阻擋明確 metric query 的路由。
`29ee2aef00fde3ec20919bbb4561bef33eb84bec` 補齊 durable SYNC 中四個 Stage 7 roots 的 semantic work receipt，保留 prepare/start replay、fresh actor/profile/privacy、final provider fence、原始 settlement 與不重送規則。

私有 checkpoint 304 只記錄較早的 `d1040cc`；較新的 r3 independent source review 與 final supplement 涵蓋最終六個檔案，結論為 source GO、deployment execution GO **false**。此交接未重新取得 release review，也不繼承部署授權。

下一個產品驗收是自然且原本 eligible 的 Strain 事件。必須把原 event/decision、interaction、typed Bot API message_id、**同一實際訊息**的 inline_keyboard 證據與真實 callback 串起來。只有 message_id、本機 request payload、mock send 或測試 PASS 均不足。NOT_SURE/SKIPPED 不得建立 fact 或負向 exposure；只有明確 confirm 才可產生原 Journal fact。保留 expired/foreign/duplicate callback 抑制與撤回語意。不製造事件、點擊、quota reset 或歷史 replay。

## Stage 5/6、Stage 8 與 Body Energy 剩餘工作

checkpoint 293 的 `65ecd2a` 是 committed progress/lost-ACK 原 authority 保存的歷史 component PASS。checkpoint 294/295 的 `02e9dcd` 證明 expired Body exclusion 與 Evidence reader；checkpoint 298 才接受 exact `7ec52f6` 的 fresh synthetic native Body LIMITED/Evidence reader component。這些不是 genuine health、Production、最新 HEAD terminal PASS，也不是整合 producer/reader 全流程。

checkpoint 299–302 的 root terminal metadata、original Telegram operation identity、UNKNOWN ACK cleanup 與 owned HTTP lifetime 是有界基礎修正。provider completion 仍 UNKNOWN，`healthDisposalAuthorized` 仍 false。Telegram Evidence 真實路徑的 `STAGE8_PREPARED_READ_ROOT_REQUIRED` 未解；private prepare/consume/dispose ticket、original-root full-preimage admission、profile/audit 寫入順序與 original receipt 原子性尚未完成。保留完整 send-time guard，不能先移動 dispatcher 或放寬原權限來繞過。

Body Energy 真實資料品質、完整 runtime/capacity、orphan disposal、production publication/alerts 均未完成。來源頁與 qualification-pending 顯示應保留；不得從合成 LIMITED 範例推得真實可發布數值。Option C 不授權再開放無界 A debugging/native campaign。

## Morning Brief／來源資料問題

現有 `9a8c951` 包含 expired delivered wake evaluation refresh 修正。後續私有唯讀調查仍顯示受影響路徑等待新的主睡眠；當時 provider 在受限查詢窗沒有回傳新的 sleep/recovery。沒有證據支持偽造今日數據、重送舊 health_date，或宣稱整體來源缺口已修好。

台灣後續先用合成資料重現 readiness／health_date／去重語意；若需新的 Production/provider 調查，另定唯讀範圍與授權，不重播舊 claims、不 refresh OAuth 或手動 sync。原診斷含個人狀態，未放入 GitHub，本文件只保留工程結論。

## 本機結構與保存

原主目錄：`/Users/kelvin/Desktop/whoop-briefing`，HEAD `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b`，不是最新開發版本。
R22：`tmp/session-recovery-20261026/candidate`。Stage 7：`tmp/stage7-ux-20261029.private/candidate`。交接工作區：`tmp/taiwan-transfer-20261029`。

盤點時有 **93 個 worktree（82 branch、11 detached）**、7 個非乾淨 worktree、沒有 stash。完整 paths、HEADs、branches/tags 與 ancestry 分類見 [保存清單](TAIWAN-PRESERVED-REFS-2026-10-29.md)。新增交接 worktree 不計入原 93 個。

兩個舊 source worktree 共 54 個變更／未追蹤 source/test 檔：53 個精確 blob 已在交接 ancestry；餘下 `terminal-control-worktree/test/body-energy-source-page-routing.test.js` 是舊測試版本，已被歷史中的修正版取代（Stage8 reply 使用 `text`、`stage8BodyEnergyGuard` 與受控 sendReply，非舊 `reply/bodyEnergyReplyGuard` API）。不以舊版本覆蓋新測試；原件及 binary diffs 完整存於私有快照。其餘未追蹤項為 dependencies／診斷輸出，非缺少的現行程式碼。

越南私人備份在 repository 外的 `~/Desktop/WHOOP-PRIVATE-HANDOFF-20261029/`：完整 Git object database/reflogs/index、all-ref bundle、所有 worktree/ignored 檔（排除可重建的 node_modules）、私有 checkpoints/DB/診斷與兩個桌面歷史備份目錄。bundle 已驗證，並加入 595 個 backup-only recovery refs；沒有推送這些私有 recovery refs。加密副本採 AES-256-GCM、驗證解密後 SHA-256，金鑰只存越南登入鑰匙圈，不隨 archive 儲存。

GitHub 可獨立接續現行工程；原私有 DB、帳號憑證、session history 和完整舊實驗環境需要分開安全移轉或重新登入。不要把整個快照解壓後公開 push。

## 主要程式入口

| 路徑 | 用途 |
|---|---|
| `src/index.js`, `src/daily.js`, `src/weekly.js` | canonical scheduler、每日／週報 |
| `src/whoop.js`, `src/dataSource.js`, `src/store.js` | OAuth、provider 與 canonical source |
| `src/analyze.js`, `src/config.js`, `src/time.js` | deterministic 指標、設定、health_date |
| `src/coach.js`, `src/narrative.js`, `src/format.js` | 教練文字、事實守門與呈現 |
| `src/bot/webhook-entry.js`, `src/bot/router.js`, `src/bot/updateProcessor.js` | webhook/supervisor、互動路由、原操作 |
| `src/bot/settings.js`, `src/stage7Companion.js` | Settings、Coach／Journal routing |
| `src/stage7Runtime.js`, `src/stage7Dispatcher.js`, `src/stage7ProactiveJournal.js`, `src/stage7InteractionStore.js` | Stage 7 keyboard、receipt 與投遞 |
| `src/proactiveAgent.js`, `src/proactiveReaper.js` | 自然事件、claim 與原 owner checks |
| `src/db.js`, `src/processingTransaction.js`, `src/ownedHttpLifetime.js`, `src/hranaCleanup.js` | libSQL composition、original root、transport lifetime |
| `src/phase4Core.js`, `src/phase4Intelligence.js`, `src/phase4IntelligenceStore.js`, `src/phase4Reanalysis.js` | Foundation、Stage 5/6 |
| `src/stage8LiveExecution.js`, `src/stage8LivePreparedWork.js`, `src/stage8PreparedDerivedRead.js`, `src/stage6PreparedDisposal.js` | advanced publication/reader 與永久 hold |
| `src/stage8Runtime.js`, `src/stage8SelfQa.js`, `src/scopedHealthContext.js`, `src/stage8MorningRuntime.js` | Stage 8 scoped 問答、QA 與晨報 |
| `src/bodyEnergyRuntime.js`, `src/bodyEnergyPresentation.js`, `src/bodyEnergyPublicationReader.js` | Body Energy runtime、頁面與發布守門 |
| `src/schema.js`, `src/phase4Schema.js`, `src/phase4V34Schema.js` | schema contracts；交接不執行 migration |
| `cloudflare/briefing-scheduler/`, `render.yaml`, `.github/workflows/` | 已有基礎設施與排程定義 |

## Runtime、設定與安全離線開發

Node **>=22**，本次 **22.23.2**；npm **10.9.8**；ES modules。使用 `package-lock.json` 與 npm；runtime 依賴為 `@libsql/client`（lockfile 固定實際版本與平台依賴）。台灣 Mac 應重新 `npm ci --ignore-scripts`，不要搬越南 node_modules，尤其跨 CPU/OS。

不需要任何真實環境值即可執行下面的合成測試。首次下載依賴需要網路；cache 已備妥時可用 `npm ci --offline --ignore-scripts`。不要為離線測試建立含 Production 憑證的 `.env`。

```sh
git clone --branch handoff/tw-transfer-20261029 --single-branch https://github.com/enjoyfulwen0204-eng/whoop-briefing.git
cd whoop-briefing
git rev-parse HEAD
git merge-base --is-ancestor b5027adaf9f860c28e0e02ecf3bdf754834adcbc HEAD
git merge-base --is-ancestor 29ee2aef00fde3ec20919bbb4561bef33eb84bec HEAD
npm ci --ignore-scripts
node --test test/stage7-proactive-journal.test.js test/body-energy-source-page-routing.test.js
node --test test/owned-http-lifetime.test.mjs test/telegram-original-operation.test.mjs test/telegram-operation-cleanup.test.mjs test/processing-terminal-observation.test.mjs
npm run beta:smoke
npm run dry-run
```

本次整合後已通過涵蓋 Stage7、Body source routing、R22 cleanup/original-operation/terminal/native harness 的 **136** 項 focused tests，另有 **3** 項 Stage7 enrollment/delivery 邊界測試通過。

**保留的既有失敗：** `npm run beta:smoke` 對應四檔共 18 項，16 PASS、2 FAIL。`test/public-beta-typed-read.test.js` 中兩個 owned-drain 案例在第 53、85 行預期 failed count 為 0，實際為 2。未合併的原 R22 `b5027ad` 重跑同一 test file 也得到相同兩項失敗（該檔 2 PASS、2 FAIL），所以不是交接合併新增的回歸。本交接不改寫這些分析規則或測試來製造成功；台灣應把它列為已知 Stage6 baseline 問題，符合 advanced runtime 尚未認證的現況。

`npm test` 只 glob `test/*.test.js`，不涵蓋全部 `*.test.mjs`；不要把它單獨視為全套 R22 認證。完整 native/AMD64/provider/Production campaign 未在本次交接重跑。

以下 script 有外部效果或需要真實服務，不屬於離線驗證：`start`、`bot`、`bot:webhook`、`check`（會送 Telegram）、`sync`、`authorize`、`probe`、`migrate`、`migrate:phase4`、webhook set/delete/drain、reconcile/analytics run、任何 `--live`。不要直接執行私有 release operator。

需要連線開發時，先個別取得核准的非 Production 設定。環境變數名稱如下，**沒有值**：

- WHOOP：`WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`。
- OpenRouter：`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`；選配 `MODEL_DEFAULT`, `MODEL_DAILY`, `MODEL_WEEKLY`, `MODEL_ADVANCED`, `MODEL_PARSE`, `MODEL_QA`, `MODEL_PRICING_JSON`。
- Telegram：`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`。
- Turso：`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`。
- Foundation/部署：`PHASE4_LOOKUP_KEY`, `PHASE4_AUDIT_KEY`, `PHASE4_BETA_SHADOW_RUNTIME`, `PHASE4_PUBLIC_BETA_MODE`, `PHASE4_PUBLIC_BETA_USER_IDS`, `PHASE4_RELEASE_SHA`, `PHASE4_EXECUTION_PHASE`, `PHASE4_EXECUTION_PROFILE`, `BRIEFING_TRIGGER_SECRET`, `TIMEZONE`, `PORT`。
- 可選功能政策還包含 `STAGE7_COMPANION` 與前述 Stage8/Body flags；feature gate 名稱不是啟用授權。其他 infrastructure 設定依 `render.yaml`、Cloudflare 目錄與對應 config module 文件逐項核對。

不要產生新 audit/lookup keys 來替代既有資料所用 keys，否則舊 signed authority 無法驗證。不要從 `.env.example` 推定真實部署的完整設定。

## Checkpoints、review 與台灣接續順序

公開可讀：`docs/r22-recovery-checkpoint-291.json` 至 `302.json`、`docs/r22-architecture-delivery-gate-303.json`、`docs/r22-telegram-evidence-integration-contract.json`，以及歷史 `docs/phase4-*`、`docs/stage7/`、Stage8 handoffs。它們保存工程範圍、source pins 與私有 evidence hashes；不包含原私有 evidence。

私有可用：R22 checkpoints 290–302、architecture-gate 303 recovery/review、Stage7 checkpoint 304 與 r3 final supplement；較早 checkpoints 在 `tmp/production-completion-20261016/unattended-engineering-20261020.private/` 等目錄，均由機器快照保存。Codex sessions 仍留在越南 `~/.codex/sessions`，沒有公開，也不需要用它才能理解現行工程。

1. 依上方 clone 指令取得分支，與越南交付報告中的完整 remote SHA 比對。
2. 讀本文件、保存清單、checkpoint 303 與 Telegram integration contract；檢查兩個 source HEAD 的 ancestry。
3. 在無真實 `.env` 的 checkout 安裝依賴，先跑已列離線測試。
4. 若需要歷史私有證據，透過獨立驗證的加密傳輸取得 archive；鑰匙圈金鑰走另一條安全通道。尚未移轉前不假設私有 reviewer 附件在台灣可用。
5. 目前產品路線仍為 Option C。先釐清 Stage7 自然 Strain keyboard/callback 的缺證；任何 release 需新的 immutable target、獨立 source/operator review、fresh baseline、owner/root GO 及原 quiet-window 等既有條件。
6. 不 merge 到 `main`、不 force push、不 deploy、不 migration、不 reset claims/permits/quotas、不為搬機發訊息或重新授權 WHOOP。Production 的持續運作不依賴這台開發 Mac。

安全審查：交接前 15 筆新增提交與其完整 ancestry 已掃描本機既有 secret 比對、credential patterns、危險檔案類型及 gzip 證據；命中僅為既有明示 synthetic 測試字串。新增 checkpoint 僅含工程 metadata／sanitized conclusions，原健康紀錄、私人 logs、DB、Codex sessions、憑證與未加密私人 archive 均不加入分支。兩個 workflow 只有 schedule/workflow_dispatch，沒有 push/PR 觸發；本交接不 dispatch workflow。
