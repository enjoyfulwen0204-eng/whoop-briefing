# Stage 6 service isolation / transaction qualification

2026-10-14。本輪僅 LOCAL / SYNTHETIC / ISOLATED。基線 `3a9db6853c70b1e63f89f5f1c196be5208b91a74`／tree `535942998ed40864dcc2999be7e4dcfe23a11995`，保留 `9770553` ancestry、已接受演算法、RAW subunits、RAM preparation、短原子發布、HMAC、簽章收據、lease、generation 與 cursor。**完整 runtime 與 Production NO-GO。唯一容量修正後，SYNC 仍失敗，依 Owner stop condition 停止長測試與進一步容量優化。**

## Source / test identity

- 診斷測試：`8b6ed8e5d13faca5336a9f44738e536c9d4bf507`。首次診斷 guard 的相對路徑錯誤已修正；先前 guard exit7 不算執行證據。
- 唯一容量修正與 Linux 合併測試：`39bda091cf84f91479229b2ceb1fa7b0d82924b9`／tree `6ba4252873fcc8edc2a01f5deb7ae8df20051073`。
- Reviewer 安全／相容性修正：`9a3830d6abd6647f61b4de8cfbddbfc9822eb9f0`／tree `308e81a286823316afffab760cb4524afaada42b`；focused 37/37 PASS。這個最終安全 successor 未重跑已失敗的長容量測試，不宣稱 final-HEAD full-service PASS。
- 相鄰 `stage6-service-transaction-evidence.json` 保存三個測試的封閉 fixture、TAP SHA256、時間、交易、durable readbacks、focused tests 與界限；完整 TAP 留在 `/private/tmp/stage6-service-qualification/`。只保留 SQL verb/table/template hash，不新增健康值、SQL args 或 credentials 的記錄。

## Environment and real-limit distinction

真正 Debian12 Linux/aarch64、Node22.23.2、installed libSQL client0.15.15、cgroupv2。`memory.max=536870912` bytes、`memory.swap.max=0`、`cpu.max=100000 100000`，V8 96/2MiB；npm、shell、service Node 與唯一 DRAIN Node 共用此 quota。無 manual GC。以第78單位 durable SQLite checkpoint 開始，沒有重播前180次提交。Hrana provider 在 app cgroup 外，HTTP 115ms；Docker internal network，沒有 Production credentials / egress。

既有唯讀 Render metadata：Oregon 單實例 `srv-dahs71qd0e5s738n94c0`、`0.5c-512mb`、`npm ci`／`npm run bot:webhook` → `node src/bot/webhook.js`、autoDeploy=no；同部署日誌 Node22.23.2。重用先前證據，沒有本輪 Production DB 查詢。Production kernel/cgroup bytes、architecture 與 Turso server transaction limit **未查證**。

本輪 5s 是 fixture 明確的 `transactionMaxMs:5000`。installed HTTP driver 沒有本輪新增 timeout 設定。歷史 [libSQL issue925](https://github.com/tursodatabase/libsql/issues/925) 描述可配置 transaction timeout，不能證明目前 Production 限制；interactive transaction absolute age 與 Hrana idle stream timeout 也不同。沒有延長 cap 取得 PASS。

## Confirmed causal sequence

**Webhook503：** 原 `/help` 路由先查 pending question，再執行原動態 help / readiness / data-quality reads。全部包在 receipt write transaction，累積37HTTP／42SQL；寫入 reply receipt 與兩個 provenance links 後，原 final owner check 遇到 modeled 5s limit。provider 先真正 ROLLBACK，SDK 收 TRANSACTION_TIMEOUT，路由回503 retry／0 sends。首次診斷 stack 到 `db.processTelegramOperation` 的 final check；不是 Telegram send、AI、writer lock 或 DRAIN 的 SQLite publication。

**SYNC424：** `sync.commitWindow` 已將 WHOOP provider fetch 放在交易外；剩下 canonical batch、analytics invalidation、legacy classification/provenance、source/input generation、jobs/family tips、sync-state cursor、兩個 named effect/count receipts 與 final ownership/input fences 全在原交易。七次窗口各40HTTP／56SQL，於 receipt append、final check 或提交前超過5s。provider 均 ROLLBACK，SDK aggregation 回 REQUIRED_RESOURCE_FAILED424。不能用「network 已在交易外」推論資料庫交易已足夠短。

**唯一修正後：** source-generation/mode 固定三個 SQL 同交易 ordered batch；保留分類 fresh reads，將原順序 metadata writes bounded batch；純 help 準備移到原 `processing.outside` 邊界，fresh generation、privacy、owner、lease 與原 receipt 提交仍保留。Webhook200 processed／retry200 replayed／1 send。SYNC 仍有六次38–41HTTP／56–60SQL，落到5.012–5.121s。部分提交請求未收到可證明的 ACK，原保守分類為 COMMIT_INDETERMINATE503；立即 replay409 REQUEST_PENDING。fixture 看得到六次 rollback，client 不能由非 SQLite ACK 錯誤假定真實 backend 必然 rollback；沒有返回假200或放寬 indeterminate protection。

移除的是外層長help receipt交易；原legacy唯讀helpers仍可能開各自的短owned transaction，不宣稱整段準備完全沒有BEGIN。

每個 failing transaction 的 BEGIN、首 SQL、末 SQL、settlement 絕對時間在 JSON；下表時間為2026-10-14 UTC，首 SQL 是 BEGIN 後的原 driver SELECT，末 SQL 欄是最後真正完成的資料語句（隨後 timeout 自動 ROLLBACK）。HTTP 計入該 transaction 內觀察到的 requests；SQL 計入 BEGIN／自動 ROLLBACK，不計未執行的 rejected statement。

| 原失敗 | BEGIN / 首 SQL | 末資料 SQL | ROLLBACK 完成 | HTTP / SQL | 交易 ms / native wait ms |
|---|---|---|---|---|---|
|Webhook|11:45:58.346 / .346|11:46:03.308|11:46:03.429|37 / 42|5083 / 36|
|SYNC1|11:46:49.128 / .128|11:46:54.075|11:46:54.204|40 / 56|5076 / 86|
|SYNC2|11:46:56.999 / 11:46:57.001|11:47:01.985|11:47:02.126|40 / 56|5126 / 93|
|SYNC3|11:47:04.405 / .406|11:47:09.387|11:47:09.528|40 / 56|5122 / 93|
|SYNC4|11:47:13.227 / .228|11:47:18.217|11:47:18.351|40 / 56|5123 / 98|
|SYNC5|11:47:21.091 / .091|11:47:26.011|11:47:26.146|40 / 56|5055 / 85|
|SYNC6|11:47:28.427 / .428|11:47:33.381|11:47:33.510|40 / 56|5082 / 85|
|SYNC7|11:47:37.002 / .003|11:47:41.969|11:47:42.100|40 / 56|5097 / 84|

| 修正後 SYNC | BEGIN / 首 SQL | 末資料 SQL | ROLLBACK 完成 | HTTP / SQL | 交易 ms / native wait ms |
|---|---|---|---|---|---|
|1|12:07:03.373 / .374|12:07:08.247|12:07:08.386|38 / 56|5012 / 127|
|2|12:07:11.911 / .913|12:07:16.797|12:07:16.935|39 / 57|5022 / 105|
|3|12:07:17.364 / .365|12:07:22.291|12:07:22.427|39 / 57|5062 / 105|
|4|12:07:28.450 / .451|12:07:33.361|12:07:33.488|40 / 58|5037 / 78|
|5|12:07:36.931 / .932|12:07:41.837|12:07:41.966|40 / 58|5034 / 65|
|6|12:07:42.368 / .368|12:07:47.363|12:07:47.489|41 / 60|5121 / 61|

所有 failing TX 的 BEGIN wait0–2ms、concurrent writers0、無 SQLITE_BUSY。native wait 是 driver 執行及排程上限觀察，不能分拆成純 lock wait。沒有觀察到寫鎖競爭；115ms ×38–41已4.37–4.72s，SDK/驗證/提交額外成本耗盡5s。這不是「八次 concurrent writer contention」。兩個 fixture databases 物理獨立，**Production 共用同DB cross-process contention 尚未 qualified**。

**同程序 TypeError：** 新診斷重跑未重現，DRAIN genuine PARTIAL，preparation11.473s／publication1.678s。sanitized catch 記錄只有七個 transaction timeout，沒有 TypeError。歷史缺message/stack，分類 UNKNOWN / NOT REPRODUCED，不能歸因 CPU 或宣稱已修復。

## Durable work, service result and memory

Linux 唯一修正後完整合併 gate **FAIL**：SYNC503、webhook200+200，Morning Brief三名 synthetic users各一次 model／一次 DELIVERED，重試沒有第二次 send。該 fixture 的 exactly-once 證據不等於真實 Telegram 在 ACK loss 下的普遍 exactly-once 保證。

DRAIN child 真正處理一個 association family／cursor，job新增完成0，PARTIAL FINALIZED_SUCCESS；response33.167s、phase30.323s、preparation19.167s、publication2.517s。parent admission / worker / settlement 使用不同原有 budget boundaries，不能單以總response大於30s判斷 worker breach，也不能把一次成功當成反覆 headroom qualification。原 deadline／5.5s reserve 沒有改。

重新開 receiver readback：19 signed operations、79 finalized producer HMACs、376 work receipts、noDuplicateRuns=true。**本輪新 operation** `analyzeAssociationFamily` 對應本輪 execution `1e68ae56-5a38-4374-bf21-729849681ee7`，producer generation1及 `stage6.associations` named ACK 正確，cursor `["sleep","sleep-00"]` 有本輪 exact ACK；JSON保存 keys。印出的 cycle DOMAIN generation8 proof 是保留的早期 receipt，不冒充本輪新 DOMAIN 或完整六作業。

cgroup peak `387211264` bytes = **369.27MiB**，512MiB 餘裕 **27.88%**，0 OOM / OOM-kill；parent RSS peak141737984B，heap33326568B，external6886825B；child sampled RSS329158656B、heap87313672B、external18902405B，kernel maxRSS342416KiB。獨立 RSS 峰值不可以直接相加代替 cgroup peak。

整組125.59s實際CPU28.236s、151 throttled periods／9.590s throttled_usec；這不是與wall相加的phase。parent event-loop max147.19ms、health max138.04ms。child自身 event-loop max12.004s、GC1524次／累積2.951s／最大68.76ms；隔離保護 foreground，沒有消除 child 同步CPU需求。

normal teardown：child2/2 receivers retired、18 scopes disabled、active callbacks/live scopes0；parent最終4/4 retired、29 scopes disabled、live0。**不是完整多作業／反覆取消記憶體資格。** SIGKILL-after-COMMIT/restart／CANCEL_RAM沿用基線已接受證據，沒有宣稱本輪新增SIGTERM、parent death、auth-revoked child orphan控制PASS。

## Focused fixes and independent delta review

Reviewer 找到兩個真實P1，均修正並 re-review：

1. structuredClone原先在唯讀scope外；enumerable getter可發出DML。clone現在在完整 readOnlyPreparation scope內，任何DML（即使catch）poison preparation、拒絕寫入／receipt。
2. 真實 help router的 `getOpenPendingQuestion` 會惰性expire過期或壞context列。每次fresh owned receipt TX（含outside replay）先查tenant任何OPEN question；有則用原dispatch／原TX，expiry與receipt一起原子提交。準備期間新OPEN question即使source_generation不變，下一個fresh TX也重新選路，丟棄prepared result；不可跳過原pending語意。

本機新邊界10/10 PASS（clone、actual expired/malformed router、concurrent OPEN、source generation、lifecycle revocation、owner lease、tenant、replay）；相關回歸27/27 PASS（receiver lifetime5、canonical batch、source snapshot、reply binding）。一個sole independent reviewer以凍結9a3830d6 source independently14/14 PASS，包含receipt INSERT failure令expiry rollback、auth/purge/owner與caught nested/batch/outside寫入拒絕。sealed review見相鄰JSON：scoped safety GO；full-service/runtime/Production NO-GO。原未改core安全18/18、permit17/17與先前SIGKILL證據重用，不冒充本輪新Linux測試。

## Stop decision and smallest next correction

**不再做第二輪微小 batching、不再跑 full monitored six 或2GiB。** 先解決測得的 `sync.commitWindow` 交易容量：

- 保持已在交易外的 WHOOP fetch。把canonical/window不可變資料正規化、privacy metadata／invalidation／receipt plan準備移到經驗證的tenant scope；不能將觀察後可能改變的authority當snapshot信任。
- 用最小original publication transaction重新驗證active lifecycle、WHOOP input/tombstone/resource authority、purge、source/input generation、writer ownership與lease；以actual libSQL conditional ordered batch將canonical rows、provenance、source/invalidation/job狀態、effect/count named receipts及cursor **一起原子提交**。
- 同一mutation若新generation／零row CAS／新tombstone／owner變更則拒絕或重做準備；保留原HMAC與COMMIT-indeterminate/reconciliation。不能直接套用Stage6 closed SHADOW grant到SYNC，也不能只把required fences搬出去。
- 目標在未放寬5s cap下給publication留≥1s headroom；以操作表證明而不是僅少SQL。先focused transport/fault/同DB併發 gate，再monitored六作業與2GiB profile。**此方案尚未實作／證明，未證明需要新schema。**

Formal production child仍需單一受控slot、可信IPC、original authority重建與獨立tenant contexts、revocation/cancel/SIGTERM/parent-disconnect停止、bounded wait-and-kill、restart exact named ACK reconciliation。現有synthetic child/supervisor只有finite response/exit與overall bound，沒有接到Production handler；不能把test-only fork當已完成managed production child。SYNC gate失敗是阻擋後續整合／六作業資格的窄原因。

## Resource / release decision

| 方案 | 成本與決定 |
|---|---|
|A 一個1c-2g web＋controlled child|compute US$25/月，較現有$7增加$18；Owner首選候選。1CPU/512MiB晚期單位／health／本輪有限memory有證據，但SYNC失敗、完整六與1c-2g profile未qualified，尚不能批准。|
|B 現有0.5CPU web＋獨立1c-2g DRAIN|compute合計US$32/月，增加$25；不同quota可隔離CPU，卻不會消除SYNC交易HTTP鏈／5s限制，另增加service/IPC/authority部署成本；本輪沒有支持改採B的證據。|

價格依2026-10-14 [Render官方 pricing](https://render.com/pricing?trk=article-ssr-frontend-pulse_little-text-block)與 [plan specs](https://render.com/docs/compute-plans)，不含既有workspace、DB、egress、稅／按用量費。沒有購買、升級或deploy。沒有完整通過的最低Render配置；1CPU是窄晚期單位／foreground隔離的最低既有證據，不是full六作業最低需求證書。

Stage7v33／Stage8v34與SHADOW/LIVE契約未改、無schema／migration、沒有新跨版本PASS聲稱。Stage8主worktree維持clean於 `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b`／tree `5a2d81942d7133f0a0a1a4fbb8f1431d17c92936`。Journal原TENANT_LIMIT與Production permit12/12另列，未reset；F02 Owner Accepted Risk／Turso Token不變。

**Runtime NO-GO；Production NO-GO。** 下一個最小owner決策是授權上述窄SYNC短publication本機prototype，非購買另一服務或再盲跑六作業。釋出仍需要本機完整service／managed-child生命周期／monitored六／同DB／1c-2g資源資格與獨立acceptance；之後exact-SHA public push與deploy approval、明確resource-change approval、release/configProof安全控制、有效獨立LIVE producer與execution admission。保留12/12ledger，不加Owner pilot／Public Beta gate、不把SHADOW artifact提升LIVE。
