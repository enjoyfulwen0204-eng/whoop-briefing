# Stage 6 Child / Monitored Qualification — LOCAL PARTIAL

Runtime 與 Production 均 **NO-GO**。P0 child 安全 delta 經獨立驗收；共享服務、真正 monitored 六-job、持續資源 qualification 尚未通過。沒有部署、push、付費操作、Production permit／credential／schema 變更。

## 凍結身份與範圍

- Baseline `a32210819c160a7bfcd8187315aaba713f7cf5b6` / tree `824e67e704837224352474607249dd762148705b`。
- 已驗證 runtime source `d1421ea8d5652fd30c550f251c205f13fd2bccab` / tree `6ad8fd5b89b009d63cb29a34d1e4047ee808e057`。後續只加入證據、fixture fail-fast 與其負向測試；runtime source 不變。
- `9770553`、既有 RAW／DOMAIN／SYNC atomic commit／webhook／RAM／ALS／receipt 演算法保留。
- 全部操作位於既有隔離 candidate。Stage 8 主工作樹 `899dff0…` / tree `5a2d819…` 仍乾淨，Stage 7/8 合約與分支未修改。

## P0 已完成的最小 prototype

既有 `resource_locks` 以 DB clock／CAS 授予有限 parent slot；固定 Linux child entry、單一 START／PID／nonce、獨立非阻塞 ownership fd、原 execution budget 的負向 local-authority guard。發布 atomic batch 前後重新驗證同一 parent slot；原 tenant／generation／producer／pilot／lease／HMAC 檢查保留。SIGTERM 結算上限 5s，之後 SIGKILL 自有 process group，確認沒有活程序才釋放 slot。不存在 IPC-only success；正常 child reply 必須與原 runtime 新鮮 admission／replay 相符。slot release 不確定回 503，slot 自然到期，無 reset。

第一個 measured defect 是 Linux Node22 IPC disconnect 後已 `exit`，卻沒有 `close`；小型控制觀察 exit=179ms。改等待核心 exit、關 ownership fd、檢查 process group。獨立 review 另找出 IPC-only success、新鮮 replay gate 與未清除 race timer；全部修正。

凍結 source 的真實 monitored checkpoint 測試在 Debian12 arm64、Node22.23.2、1 CPU、2GiB、swap=0、V8 96/2MiB、115ms 外部 Hrana 下通過：

| 邊界／指標 | 結果 |
|---|---|
| 正常 work | 1 item、具名 cursor ACK、FINALIZED_SUCCESS；worker work 15.969s |
| PREPARATION disconnect | 613.10ms 回收；cursor 不變 |
| CALCULATION disconnect | 597.90ms 回收；cursor 不變 |
| PUBLICATION disconnect | 627.13ms 回收；cursor 不變 |
| COMMIT_ACK 後 disconnect | 600.78ms 回收；真實 cursor commit 保留 |
| ACK 後重啟 settlement | 原 runtime RECONCILIATION_ONLY、4 receipts、0 items，之後 immutable replay 一致 |
| 完整 cgroup peak | 270,524,416 B = 258.00MiB，對 2GiB headroom 87.40%；0 OOM |
| cgroup CPU／throttle | 13.172s／1.595s；parent event-loop max 104.33ms，GC max 10.07ms |
| ALS | retired=2，live receivers／callbacks／scopes 全為 0 |
| 有限 synthetic permit | 保留既有 6 attempts，最後 11/12；reconciliation 沒有新增 calculation attempt |

Cursor proof：execution `5379ec33-1ff6-4b1c-b019-473b98ff862e`、REPAIR_CURRENTNESS `['sleep','sleep-01']`、receipt `a9932e0891739f1b3a698ea48946e0740e9c43e161196e02169fbda434373142`。19 operation receipts authenticate，tampering／跨 tenant 均拒絕。正常與 ACK 後 settlement 的 producer HMAC／result digest 另以固定 synthetic key 對唯讀 checkpoint 驗證。沒有宣稱新的 DOMAIN 計算：此 retained unit `newOperations=[]`，完成的是必要的真實 cursor continuation。

Network-free Linux 控制 3/3：before-start disconnect 64.19ms、SIGTERM 77.22ms、SIGKILL child＋descendant group 594.64ms。真正 parent SIGKILL 在阻塞 JS 期間及 production main entry 的完整 shutdown wiring 尚未資格化；不能把這三個小型控制當作全部服務 crash qualification。Production webhook main 尚未接上 prototype。

## 共享實體 DB 的實際失敗證據

只執行一個初始 focused run 與一次 user concurrency=1 correction；沒有六-job／sustained run。這兩次是帶 baseline `a322108` release label 的 working-source run，不能算凍結 `d1421ea` 的完整接受。

初始並行 SYNC／webhook／DRAIN 有 SQLITE_BUSY，parent-slot release CAS 也失敗。correction 沒有模型 5s transaction timeout，但 SYNC 多次 202，在外層 360s fixture 上限停止。資料庫未強制完成，隊列／lease／receipt 未改造。

| correction 指標 | 實測 |
|---|---|
| physical DB | 1，全部 synthetic identities／keys／資料 |
| HTTP／SQL | 2,724／4,157 |
| transactions | 262 COMMITTED，29 ROLLED_BACK，20 BEGIN_REJECTED |
| 已開始 TX p50／p95／max | 659／3,447／4,071ms |
| 15 SYNC commit windows | 全部 COMMITTED，28–30 HTTP、56–65 SQL／window |
| SYNC window min／p50／p95／max | 3,285／3,579／3,833／3,855ms |
| max 與模型 5s 的 margin | 1,145ms；actual account Turso absolute limit 未確認 |
| SQL errors | 24 SQLITE_BUSY；1 SQLITE_ERROR（ROLLBACK template）；無 transaction_timeout |
| health | 1,380 次 200，max 58.41ms |
| Morning durable ledger | alice／bob／lan 各 DELIVERED、attempts=1；整體 exactly-once 仍未資格化 |
| shared peak memory／最終 HTTP | outer cutoff 前未輸出完整終局證據，NOT QUALIFIED |

唯讀證據及快速負向控制另外證明：合併的 retained Stage 6 tenant `a` 為 ACTIVE/READY 卻未綁 Telegram。`listSchedulableUsers` 選入它，原 `runForUser` 回 `no_active_telegram_link`、`sync=null`，原 aggregator 計入失敗，所以即使三份 Morning 已送出，整輪也不可能 COMPLETE。這是 **invalid service fixture** 的確定阻塞，並非更多 CPU 或 durable ledger 的證明；測試 provider 現在會先 fail-fast。BEGIN contention 為獨立觀察，尚不能由此判斷 Production Turso 同樣失敗。

## 測試與獨立 review

Frozen P0 1/1（涵蓋上述四邊界）PASS；process 3/3 PASS；receiver／RAM lifetime 7/7 PASS；原 permit 17/17 PASS；unlinked fixture 負向控制 1/1 PASS。唯一 reviewer 自行控制 8/8 PASS，P0 safety **GO scoped**、無 retained P0/P1。shared／P2／six-job／sustained／Production 仍 NO-GO。既有未變動演算法／security review 沿用。

證據：[compact JSON](stage6-child-monitored-evidence.json)、[凍結 review](stage6-child-monitored-review.json)、[fixture review clarification](stage6-child-monitored-fixture-review.json)。原始 TAP／SQL 無值時間線保留在 `/private/tmp/stage6-child-monitored`，此 repo 不加入大型 archive。

## 最小後續修正與 release prerequisites

1. 建立真正 service-ready 的純 synthetic fixture：Stage 6 tenant 與 Morning tenants 的 Telegram／synthetic WHOOP 授權須經現有 API，在 authoritative checkpoint 之前建立。保留既有 checkpoint；若其 authority 改變，使用原 generation invalidation／reconciliation，不重寫舊 HMAC、不假造完成。先短測原 SYNC aggregator 可完成，再重試共享 DB focused gate。
2. 若有效 fixture 仍有 writer contention，最小待驗方案是 parent-owned、有限 IPC writer admission：只排程 physical write transaction，RAM／read preparation 保持獨立，fresh fences／COMMIT／rollback／indeterminate reconciliation 全保留。不是現在已證明需要的新架構；暫無 schema／新 DB／新 paid service 的需求證據。
3. P1 通過後，才實作私有、DB/keys/fixture 绑定、固定 synthetic keys／signed manifest／明確 attempt 上限的 isolated HTTP admission fixture。原 Production 12/48 policy 不變，每個 bounded attempt 獨立計數，不以無限 internal subrun 假装一個 permit。
4. 再做真正 monitored 六-job、共享服務 sustained 1CPU/2GiB、完整 parent-death／SIGKILL／default entry wiring 與獨立 delta acceptance。現階段不凍結可部署候選。
5. 全部 local gates 完成後，才需要 exact-SHA publication/deployment authorization、Render 1CPU/2GiB resource authorization、實際 Turso limit／release controls 的唯讀確認，以及獨立 authenticated LIVE producer／execution authority。不可把 SHADOW 轉為 LIVE，不新增 Owner pilot 或 Public Beta rollout gate。

Journal TENANT_LIMIT 與 real Production 12/12 exhausted 是兩個分開、未修改的限制。F02 Owner Accepted Risk 與 Turso Token 不變。沒有新的 Production permission 被使用。
