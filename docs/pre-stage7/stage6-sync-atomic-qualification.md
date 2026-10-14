# Stage 6 Short Atomic Commit — local qualification

2026-10-14。**SYNC 窄修復 GO；完整 runtime／Production NO-GO。** 本輪只有 LOCAL／ISOLATED／SYNTHETIC，未做 Production operation、paid execution、public push、deploy、migration、resource purchase 或 credential access/change。

基線 `7ded16c1ada45e8eec9d8c4b2ff26ee3bcc38355`／tree `c32c1b27b662cf1eacc7bf6c13c4a35c582b84c5`。凍結 runtime code `1a7c7b0e11bbe30c6921361166e9e794323b8363`／tree `706914bbc817ff0859953768e57b7d71f498806f`。後續變更只有 qualification tests／本文件／evidence；`src` bytes 不變。`9770553` 與基線 ancestry 均驗證保留。測試 release identity 為 `1a7c7b0e`；不能將後續 documentation SHA 冒充已跑過全部 Linux tests 的 release identity。相鄰 JSON 保存 exact source/test SHA256、TAP hashes、durable keys 與 sole independent review。

## Confirmed timeout and minimal correction

原 `sync.commitWindow` 將 canonical、provenance、invalidation、source/input generation、jobs/family tips、sync cursor、兩個 named effect/count receipts 與最後 ownership/input fences 放在同一個 write transaction。WHOOP fetch 原本已在外面；瓶頸是同一 locked transaction 重複 tenant/privacy/lifecycle/input metadata observations。

115ms fixture 重現第一個七筆 sleep window：**43 HTTP／62 SQL，5.035s，modeled timeout 真正 rollback**；native wait 38ms、BEGIN wait0、其他 active writers0。43×115ms 已4.945s；不是 measured writer-lock contention。SDK／phase 保守返回503／required-resource failure，不能推論一般 remote indeterminate COMMIT 必定 rollback。

新程式只把純 JSON validation／clone／raw serialization 移到外面；不準備 DB authority 或 canonical write decisions。**十個固定 metadata projections 與 BEGIN／SELECT1 以 installed driver ordered batch，在原交易中取得真正 ACK。** 不跨 transaction、receiver、tenant、execution、budget、ownership 或 logical work-step 重用；opaque single-use token 亦由實際 private receiver closure 驗證。原 JS validations 照常執行。

每一個 eligible business-write packet 後，在同一 SQL batch 重新觀察完整五組 immutable authority projections；不符則 SQL assertion poison 原 root 並 rollback。trigger-side lifecycle/auth/timezone/purge/pending-purge／initialized-row deletion 也被涵蓋。未知 DML／DDL 立即失效；clock、lease、execution owner、receipts、source/input generation、健康資料完全沒有被此 pool 快取。terminal receipts、COMMIT 與 COMMIT retry 前清 pool，執行原 fresh fences。所有相依 writes 仍一起 commit，沒有分拆 publication、增加期限或 schema objects。

## Measured capacity

| 情境 | BEGIN→settlement | HTTP | SQL | durable result |
|---|---:|---:|---:|---|
|exact baseline：sleep七筆|5035ms|43|62|rollback；window新增0|
|exact frozen：sleep七筆|3448ms|30|64|COMMITTED|
|exact frozen：recovery七筆|3465ms|30|65|COMMITTED|
|exact frozen：cycle七筆|3336ms|28|62|COMMITTED|
|Linux1CPU／2GiB fresh：實際 SYNC windows15個|最大3845ms|28–30|56／58／62／63／65|全部 COMMITTED|

SQL 沒有一律下降：保留原必需 checks，另有寫入後 SQL authority assertions。改善證據是 completed publication／durable readback，而非少 SQL。

frozen 最後 cycle 的 client phases：authenticated batch141ms、callback2701ms、terminal validation／receipt366ms、COMMIT ACK125ms、完整 transaction3457ms。基線只保留總交易 trace，未捏造沒有量到的 per-phase breakdown。完整三來源 SYNC20.102s、21筆／source generation+3／canonical+provenance+cursor+named receipts，200 COMPLETE_SUCCESS；同 request replay 不再呼叫 provider。基線整 request8.870s是提前失敗，不能拿來當完成速度比較。

5s 是 fixture 的 explicit absolute transaction limit，**非本輪已驗證 Production Turso setting**。代表115ms亦不是 observed Production RTT。SYNC Cloudflare仍120s／原30s yield reserve；DRAIN manual仍45s configured／約30s effective worker／5.5s publication reserve。沒有將45s視為45s usable worker。

## Linux service, continuation and resource evidence

真 Debian12/aarch64、Node22.23.2、libSQL client0.15.15、cgroupv2；`cpu.max=100000 100000`、`memory.max=2147483648`、swap0、V8 96/2MiB、無 manual GC。npm、shell、web Node 與一個 DRAIN child 共用同一 CPU/memory quota；外部 synthetic Hrana provider115ms、Docker internal network、無外部 provider egress。

**Fresh1CPU／2GiB 合併 gate PASS1/1**，400.55s完整測試／377.47s SYNC四個原有限期 invocation：202→202→202→200 FINALIZED_SUCCESS。每次沿同 canonical request 正常 continuation；最後 immutable replay 相等。三位 users 各1次 model／1次 send／1個 DELIVERED claim，delivery_attempts=1。並行舊 help snapshot 可合法 NOT_REQUIRED；settlement 後 fresh update200／retry200，真正1次 reply send。不是普遍 Telegram ACK-loss exactly-once 證書。

15個實際 seeded `sync.commitWindow` 都≤3.845s；全部30個 canonical transactions最大4.073s、零5s timeout。較長的 reconciliation windows不冒充 SYNC4s PASS；harness 用沒有 args／health 的實際 authority assertion SQL label 區分，並要求 fresh至少15個 traced SYNC windows，不能以空集合宣稱 timing PASS。

peak **387891200B＝369.92MiB**；2GiB headroom **81.94%**、OOM0。不能將這個2GiB run宣稱512MiB全 fresh workload PASS。parent sampled peakRSS143036416B／heap35570880B／external7456213B；child sampled peakRSS326631424B、heap約87MiB，完整數值在JSON。cgroup peak不是兩個各自 RSS peak相加。整體CPU37.10s、throttled4.080s、parent event-loop max119.34ms、health max57.964ms；child同步 preparation10.916s、publication1.711s，實際DRAIN23.175s包含外層 admission／settlement。

起點為已簽署第78單位 durable fixture，沒有重播前180個提交。新 DRAIN `b15d8005-409f-4d8e-a2a6-d66a0d6146ee` 有新 `analyzeAssociationFamily` operation `65e8e3761439dfdd5f22931e103d123ea3478034074be48e008358a41fc3f24a`、本次 generation1 producer與 exact `stage6.associations` ACK，cursor `RECOMPUTE_DERIVED`→`["sleep","sleep-00"]` 有本次 named ACK。重新開 receiver驗證19 signed operations／79 producer HMACs／376 work receipts／no duplicate runs。當中舊 cycle DOMAIN receipt是保留證據，沒有冒充本輪新 DOMAIN。

512MiB初始測試：21個 canonical windows全 commit≤3.859s、zero timeout、三份 Morning已送；舊 harness把合法202當 immutable replay，故overall FAIL。保留 fixture／original request／original pilot start／unreset counters重啟，三次 durable202後原15分鐘 work-age自然過期→410；此舊 request仍FAIL，沒有放寬 age。original manual handoff bytes重排曾造成 REQUEST_ID_CONFLICT，已以 stored identity_digest核對原 bytes，未改 DB states。

**512MiB retained successor PASS1/1**：先真的拒絕舊 stale request，再以新 work-cycle在同原 authority／ledger上完成200 NO_NEW_DATA_SUCCESS；cursor續到sleep-01、有本次 ACK。peak247779328B，cleanup live0。它沒有新 Morning sends/models或SYNC windows，僅 restart／合法新請求 continuity證據，不能替代 fresh combined gate。

## Safety, independent review and remaining lifecycle failure

exact frozen runtime：SYNC/input/canonical **26/26 PASS**＋receiver lifecycle **5/5 PASS**，共31（兩個命令）。包含 trigger authority revocation、failed receipt rollback、original zero-row blocked semantics、fresh competing input before admission、lossy/accessor JSON拒絕、真300ms source lease expiry＋400ms delay、unknown same-root mutation失效。

Lost COMMIT ACK先回503 COMMIT_INDETERMINATE／立即retry REQUEST_PENDING；source／cursor真正durable。只在原 shorter supported test budget與resource lease自然到期（約46s）後，新 receiver沿同 body恢復；只補recovery/cycle、不再 fetch已提交sleep、不duplicate receipts。未修改clock／lease／queue／reserve。這是新SYNC receiver restart，**不是本輪新 process-SIGKILL test**；未改Stage6核心的security/SIGKILL18/18、permit17/17、native algorithm6/6兩次沿用原accepted evidence。

normal Linux teardown：4/4 receivers retired、29 scopes disabled，liveReceivers／activeCallbacks／liveScopes全部0。sole independent Sol6.1 reviewer以自己的controls **4/4 PASS**；找出的非enumerable provider id經structuredClone丟失P1已修正：原bytes無法無損clone的shape，在任何write/cursor前拒絕。最終review scoped safety GO、targeted fresh1CPU2GiB service PASS；完整runtime／Production NO-GO。

新Linux child-control **1/2**：real admission後SIGTERM6.67ms終止並reap；IPC disconnect後1502ms仍存活，test forced SIGKILL/reap。沒有 uncontrolled background留在機器上。這是既有test-only child無disconnect/cancellation manager，不是本輪SYNC源碼回歸。SIGTERM PASS只證明kernel process termination，不證明graceful grant/receipt settlement。

reviewer亦指出 test controller spawn-error可能永等exit；已只修 test error/close settlement、2s bounded reap、finally DB/metrics cleanup。獨立短 negative controls2/2驗證ENOENT與unacknowledged reap；原已測得的runtime child1/2結果保留，不改成PASS。沒有修Production child或放寬lifecycle標準。optional rerun碰到Docker subnet pool exhaustion；只清本輪已停止containers/internal networks，未做global prune或動其他workload。

## Six-job and release boundary

**Full monitored six NOT QUALIFIED，未重跑昂貴測試。** actual HTTP gate仍原reviewed12 attempts，conservative runtime maxItems1；representative dataset144sources×2job kinds需至少288 source units，尚未計額外RAW subunits。file-only fixture certificate48不能授權HTTP。未假造protocol、未加remote financial bypass、未reset任何ledger。native6/6與本輪DRAIN1item不是full monitored6/6。不得以此聲稱STAGE6_PRODUCTION_COMPLETE。

最窄後續工作：把一個受控DRAIN slot接入實際service，trusted IPC與獨立authority重建，disconnect/revocation/cancel→original AbortSignal、bounded wait/kill/reap、restart named-ACK reconciliation；在合法isolated test authorization下完成monitored六，保留原remote admission與原exhausted ledger；再補共用同physical DB writer/currentness qualification。當前stage與morning fixture DB物理分開，未稱共用DB contention PASS。

Production metadata僅重用既有唯讀證據：Oregon `0.5c-512mb`、Node22.23.2、單web service，尚未購買Owner偏好的1CPU／2GiB。實際Production architecture／cgroup／Turso absolute transaction cap及 payload代表性仍未查證；本機2GiB profile不是Render provider equivalence證書。

本輪Owner只授權窄SYNC prototype，故保存child failure與窄manager修正計畫，不擴大成新Production架構。後續需要相應本機integration／合法synthetic grant seam範圍，通過剩餘gates後另給**最終精確SHA public push／deploy／resource-change authorization與獨立LIVE producer/admission**。不新增Owner pilot／Public Beta release gate，不把SHADOW receipts升LIVE。

無schema／migration；Stage7v33、Stage8v34與計算演算法未改。Stage8主worktree仍clean於`899dff0ae61474bb2b9ec0a0743cdbf11a999d3b`／tree `5a2d81942d7133f0a0a1a4fbb8f1431d17c92936`。Journal TENANT_LIMIT另列未解；real Production12/12仍exhausted；F02 Owner Accepted Risk與Turso Token不變。
