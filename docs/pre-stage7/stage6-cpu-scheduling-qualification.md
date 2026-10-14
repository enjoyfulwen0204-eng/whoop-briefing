# Stage 6 CPU scheduling qualification — PARTIAL / NO-GO

2026-10-14。本輪僅本機 synthetic／isolated 測試。基線 `bec7c21516ba9baf705a492aa3ceb269ad332beb`；保留 `9770553` ancestry、RAW subunits、原計算、HMAC、收據、cursor、短原子發布與 5.5 秒 reserve。唯一 runtime 修正為 `9c042c5bc3cdfa71d4f6d748752037908cd34809` 的交易外 cooperative yield。最終實際執行測試 checkpoint 為 `12656c7920cd6eb217f099c59234736e1a531b18`／tree `3d54cb8802f356711b2bc9bccca2e6e1eea7b190`；後續僅保存報告與 review。

**結論：至少 1 CPU 與獨立 DRAIN event loop 通過本輪晚期單位的期限、持久提交、health 與記憶體門檻；完整服務、monitored 六作業及 Production 仍 NO-GO。** 單次 cooperative 排程改善不足，停止該方向微調。不以提高 RAM、放寬期限或隱藏失敗取得 PASS。

**Production 唯讀確認。** 既有 Render 登入可用，原 CLI 未選 active workspace；僅在任務私有設定副本選 workspace，讀取既有 service metadata。`srv-dahs71qd0e5s738n94c0` 是 Oregon、單一 Node Web Service、`0.5c-512mb`，`npm ci`／`npm run bot:webhook`，autoDeploy=`no`，資源更新時間仍為 Oct13。先前同一部署日誌已確認 Node22.23.2；本輪未進入 Production 程序重讀 Node/kernel，也未查 Production DB。512MB plan metadata 不能冒充已讀到 Production `memory.max`／`cpu.max`。Node start script 為 `node src/bot/webhook.js`；96/2MiB 是候選測試設定，沒有改 Production env。

**Linux 模型。** Debian12/aarch64、Node22.23.2、鎖定 libSQL client0.15.15、cgroupv2；`memory.max=536870912`、swap=0、CPU period100000µs，quota50000／100000／200000。V8 96/2MiB，無手動 GC。npm＋shell＋service Node；隔離比較再加一個 DRAIN Node，全部共用同一 cgroup 配額。115ms Hrana provider 在 app cgroup 外，以已保留的第78單位 checkpoint 開始；未重跑前180次提交。Docker `--internal` 封閉網路；只掛 synthetic 資料，不掛 Production 憑證。這不是 Production 硬體等效證書。

**確認的瓶頸。** 原 RAM association root transaction 包含約23,000次 query trace 與大量 native SQLite prepare／columns／iterate、ALS propagation、Promise/microtask、GC。原子交易不應任意插 yield；安全交易外的 seed／driver yield 無法拆開該主要阻塞。在0.5 CPU，原計算14.10s，process CPU7.02s；cgroup 整腿實際 CPU11.89s、175個 throttled periods／24.98s throttled_usec。quota 等待與同步原子計算耗盡最短 lease／worker／grant 的 temporal headroom，保留的原子5.5s guard 拒絕發布，零 source progress。cgroup throttled_usec、GC sampled wall 與 CPU time 不是可相加的獨立 wall-time 區段。

先前32.69s DRAIN／22.09s health 的因果與本輪相符：共享 event loop 在 RAM 原子運算期間不處理 socket/timer；未改演算法的 matched 控制重現31.89s DRAIN failure。本輪0.5 CPU併發仍32.80s／health15.55s。1／2 CPU仍有5.73／3.72s health 停頓；單加CPU不能保證前景 event loop 的2秒響應門檻。HMAC＋JSON約0.25–0.75s、約27,500次，並非主要CPU根因；所有驗證保留。

Matched profiling 是 diagnostics，loader／CPU profiler會擾動執行，不能當 release capacity PASS。失敗 publication span 標記 incomplete，包含後續 cleanup。

| CPU | 原排程 DRAIN | 單次排程修正 DRAIN | HTTP／remote SQL 前→後 | 修正後結果／event loop最大 |
|---|---:|---:|---|---|
|0.5|31.891s|31.543s|108／511→108／511|headroom拒絕／8.200s|
|1|22.428s|22.177s|111／4306→111／4306|真實partial一單位／3.269s|
|2|19.966s|20.238s|111／4306→111／4306|真實partial一單位／2.315s|

| 診斷 phase | 0.5 CPU wall／process CPU | 1 CPU wall／process CPU | 2 CPU wall／process CPU |
|---|---:|---:|---:|
|authenticated snapshot，原排程|4.725／0.820s|4.553／0.842s|4.482／0.765s|
|RAM import，原排程|0.967／0.468s|0.280／0.280s|0.260／0.286s|
|原 RAM 計算，原排程|14.102／7.019s|5.564／5.560s|3.491／5.061s|
|plan seal，原排程|0.806／0.149s|0.790／0.173s|0.728／0.129s|
|fresh fencing＋batch，原排程|4.545／1.210s incomplete|1.839／0.729s|1.691／0.662s|

111個 HTTP各含115ms transport delay；有批次／重疊，不將12.765s直接等同單一串行 network wall time。實際 CPU包括GC及程序背景工作，不只某一JS函式；2CPU多執行緒時 process CPU可高於phase wall。新程式不減 SQL 或安全檢查。整腿另包含原 admission、context registration、settlement及release。

**原程序併發測試。** .5／1／2 CPU全部FAIL。DRAIN分別32.801s FAILED、20.937s FAILED、21.766s genuine PARTIAL；health分別15.545／5.732／3.721s。1CPU另出現未定位的 PREPARATION `TypeError`，沒有stack，不能歸因於CPU、既有程式或本次排程。它是明確保留的 runtime blocker。三份 Morning Brief各一次 model、一次DELIVERED，完整SYNC仍424，webhook及retry503／零回覆。最初併發TAP在SYNC assertion中止，未走到current proof；不把那個TAP的commit當成已讀回驗證。

**最小隔離比較。** test-only child內呼叫原 `runExecutionPhase`，grant在child建立，沒有傳遞 opaque authority。parent與child共用同一1／2 CPU及512MiB，未增加CPU容量。原deadline、lease、generation、purge、HMAC、row CAS、named ACK、atomic publication與settlement全部保留。

| 隔離控制 | DRAIN整腿 | health最大 | whole-cgroup peak | 餘裕 | 完整服務 |
|---|---:|---:|---:|---:|---|
|1CPU第一次|23.129s|56.70ms|367.65MiB|28.19%|FAIL|
|2CPU控制|20.374s|66.07ms|366.32MiB|28.45%|FAIL|
|1CPU最終修正harness|22.644s|41.94ms，458 probes|377.55MiB|26.26%|FAIL|

最終child準備10.423s／原子發布1.625s，3793 publication statements，96 snapshot groups、3,652,475 bytes。原30s worker與5.5s reserve未改。child heap峰82.95MiB、external18.71MiB，kernel maxRSS337.67MiB；whole-cgroup peak395,890,688B包括npm、service、child與native/page accounting。0 OOM／OOM-kill；child自己的 event-loop stall4.622s保留，parent仍responsive。child GC1529次、累積1.222s、最大56.18ms；cgroup該child期間CPU8.028s、56 throttled periods／3.317s throttle。native allocator不能由 installed driver精確分拆。這是120秒合併晚期單位的記憶體證據，並非六個完整作業的長期記憶體資格。

完整服務FAIL仍為SYNC424／webhook503。provider具體記錄8次Morning DB absolute transaction timeout，5.025–5.118s。這是保持的synthetic5s cap，不是查證的Production Turso設定；不能單憑CPU改善或延長cap宣稱fullSYNC成功。兩個synthetic DB物理獨立，尚未qualify Production同DB contention。parent的provider counter0不包括child JS global；全組無外部egress另由internal network保證。

**持久與失敗證據。** 最終C1在完整服務FAIL之前執行 fresh receiver proof：19 signed operation receipts、79 finalized producer HMAC、376 work receipts、no duplicate runs。新 operation `65e8e3761439dfdd5f22931e103d123ea3478034074be48e008358a41fc3f24a` 是 `analyzeAssociationFamily`；當次 `stage6.associations` ACK與 `stage6.checkpoint` ACK正確，gen8／scopeRev7，cursor從 `recovery/synthetic-old-recovery`→`sleep/sleep-00`。既有cycle DOMAIN `bd56…`僅retained proof，不稱新DOMAIN。C1/C2各於全新Linux115ms程序再讀回HMAC/current ACK與精確manual-request replay，permitAttempts仍1。原raw-body identity拒絕錯誤欄位次序，沒有繞過該驗證。

最終1CPU genuine COMMIT後、ACK withheld窗口SIGKILL整組app：exit137／OOM=false，計算cgroup peak325,873,664B。新程序等待原execution期限約68.24s，RECONCILIATION_ONLY→FINALIZED_SUCCESS，19／79／376、current ACK、replay／permitAttempts1 PASS1/1；未調clock、lease、queue或counter。recovery記憶體另算，不冒充計算peak。實際CANCEL_RAM regression PASS1，RAM丟棄／cursor不推進。最終child 2/2 receivers退休、16 scopes disabled、live callbacks／scopes／receivers0；主程序teardown也清理完。

focused scheduler＋receiver lifecycle7/7、真實child supervisor失敗邊界4/4、actual RAM cancellation1/1；獨立scheduler/authority7/7、supervisor re-review7/7。複用不變的security/SIGKILL18/18、permit17/17、lifecycle5/5及之前128MiB admission拒絕negative；不宣稱新Linux128MiB成功。Reviewer發現test-only P1：exit0或signal且無IPC可令Promise掛住。修正後任何提前退出／IPC error有限失敗，reply未退出也保留原90s overall bound；producer與security source未改。Final完整服務TAP仍0/1 FAIL，不能加總成全PASS。

**資源決策。**

| 選項 | 本輪證據 | 最小變動／成本 |
|---|---|---|
|A 原服務＋cooperative yield|0.5CPU deadline、所有CPU foreground responsiveness仍失敗|不作release修復；停止micro-optimization|
|B 原程序升CPU|1/2CPU單單位可提交，但共享loop不responsive|1c-2g $25/月；2c-4g $85/月，單升級未qualify|
|C 獨立bounded DRAIN event loop|共用1CPU/512MiB已證明late-unit持久／deadline／health；fullSYNC仍阻塞|優先下一步：同一升級1c-2g服務的一個managed child，compute $25/月，比現有$7增加$18；獨立1c-2g worker＋現有web共$32/月|

成本是2026-10-14 [Render官方 compute價格](https://render.com/pricing)，不含既有workspace、DB、網路、稅及按用量費；不是實際購買或per-run帳單。1CPU是本輪最小測得晚期單位配置，不是full six最低需求證明。無schema／migration必要，無新增基礎設施；目前child只接test fixture，沒有Production IPC／supervisor接線。

下一步限定：將一個managed child接入既有監控DRAIN，單一global slot，可信IPC與完整原授權重建、取消／shutdown／orphan處理與wait-for-exit；不能每個HTTP request任意fork。另以read-only provider metadata確認實際Turso交易限制，定位同程序TypeError及SYNC／webhook交易邊界，保留全部checks；先通過完整服務focused gates，再做真正monitored six／完整multi-job記憶體與同DB tenant/concurrency/restart驗證。本輪不再調算法、DB或ledger。

**Monitored six：NOT QUALIFIED。** 原隔離演算法6/6兩次保持；本輪零個最終job新增完成，只有真實晚期單位／cursor。focused全服務gate失敗，所以不再進行昂貴six-job長測試。Journal原6-item TENANT_LIMIT與已耗盡Production12/12 permit另列、不改。F02 Owner Accepted Risk及Turso Token不變。

獨立delta review：無保留security P0/P1；test P1修復並re-review PASS。**完整Stage6 runtime code NO-GO；Production NO-GO。** Stage7v33／Stage8v34 source/contracts不變、無migration，不宣稱新跨版本資格。Stage8 worktree仍clean於 `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b`／tree `5a2d81942d7133f0a0a1a4fbb8f1431d17c92936`。

沒有Production mutation、public push、部署、付費執行、permit reset或SHADOW→LIVE。尚無ready deployment manifest。釋出前還需上述本機資格完成與獨立acceptance、exact-SHA publication/deploy授權、明確resource-change授權、有效獨立LIVE producer/execution admission及release-safety controls；保持原12/12 ledger，不增加Owner pilot／Public Beta rollout gate。

完整原始profiling／TAP／retained SQLite留在本機 `/private/tmp/stage6-cpu-qualification`；repo僅保存約58KiB [compact evidence](stage6-cpu-scheduling-qualification-evidence.json) 與focused review。
