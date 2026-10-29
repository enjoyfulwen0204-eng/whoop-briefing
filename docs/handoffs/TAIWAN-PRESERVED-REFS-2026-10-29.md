# 越南開發保存清單 — 2026-10-29

本表列出交接前 93 個 worktree 與所有 local branch/tag refs。全數保存在 repository 外的 recovery bundle/機器快照；只有 reviewed transfer branch 推上 GitHub。`ancestor` 表示 commit 已在 transfer ancestry；`historical-local` 是保留於 private bundle 的舊實驗／替代分支，未宣稱合併至現行工程。

## Worktrees

| 位置 | Branch / detached | HEAD | 保存與狀態 |
|---|---|---|---|
| `.` | `codex/whoop-final-production-release-20261015` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; clean snapshot |
| `~/.codex/worktrees/body-reader-v35-20261020/whoop-briefing` | `repair/body-reader-v35-20261020` | `1f6095a9a6be98dd73455f7a559240dd66ba200c` | historical-local; clean snapshot |
| `~/.codex/worktrees/journal-stage6-integration-20261023/whoop-briefing` | `repair/journal-stage6-prod837-integration-20261026` | `bc2c3455dcdb042cdc4803e1ad96094dd92cfc84` | ancestor; clean snapshot |
| `~/.codex/worktrees/native-cold-continuation-20261020/whoop-briefing` | `diagnostic/native-cold-continuation-20261020` | `dae587879dac7eef0faced2587ded9dbe1b813a1` | historical-local; clean snapshot |
| `~/.codex/worktrees/native-cold-observation-20261020/whoop-briefing` | `diagnostic/native-cold-owned-delivery-20261023` | `237a21875ab07f5de8e556c36265a7e2061ad79a` | historical-local; clean snapshot |
| `~/.codex/worktrees/native-empty-attribution-20261020/whoop-briefing` | `diagnostic/native-empty-attribution-20261020` | `e93736ae13c2681322905f9eae1c3a4014c2eea8` | ancestor; clean snapshot |
| `~/.codex/worktrees/native-hrana-eof-20261023/whoop-briefing` | `diagnostic/stage6-file48-eof-failure-profile-20261026` | `1cdb0033ac24857d83be4e1d12b01adf88457b81` | historical-local; clean snapshot |
| `~/.codex/worktrees/phase4-final-integration/whoop-briefing` | `release/coach-journal-v33-20261016` | `1afe73e6600a5481b17c76759cbca5665218f2b0` | historical-local; clean snapshot |
| `~/.codex/worktrees/principal-snapshot-20261020/whoop-briefing` | `diagnostic/principal-snapshot-20261020` | `9e4909ce3a8330ba8ddf55e0fbef7a4ec85a65d1` | ancestor; clean snapshot |
| `~/.codex/worktrees/proactive-journal-20261023/whoop-briefing` | `fix/hrana-before-dispatch-close-v33-20261025` | `8372316deb595e53005b92b74e2dd0c848b7f50d` | ancestor; clean snapshot |
| `~/.codex/worktrees/readiness-integration-20261020/whoop-briefing` | `repair/readiness-integration-20261020` | `ca01f63d2bd948f24a3a0400decdaca898811f39` | ancestor; clean snapshot |
| `~/.codex/worktrees/schema-metadata-snapshot-20261020/whoop-briefing` | `diagnostic/schema-metadata-snapshot-20261020` | `d6b7010c95125af749194348f920e617011e8a44` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage6-finalization-20261023/whoop-briefing` | `repair/stage6-finalization-20261023` | `11a6e7c203614ff7f23cd13ee09b08ca8f75138a` | historical-local; clean snapshot |
| `~/.codex/worktrees/stage8-authenticated-live-producers/whoop-briefing` | `codex/stage8-authenticated-live-producers-20261015` | `649676e030aa8d25639985d397c5d3837462f484` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-conservative-safety-gate/whoop-briefing` | `codex/stage8-conservative-safety-gate-20261014` | `b69a9d64785a38de220da4ca36f48aa4180b4820` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-final-quotation-repair/whoop-briefing` | `codex/stage8-final-quotation-repair-20261015` | `d538b07e097fedb42481c305de0738761c512a4d` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing` | `codex/stage8-gate-adjudicated-repair-20261015` | `10b68fa5f4f9501c424ad4c16b4bab0eae500595` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-live-controlled-integration/whoop-briefing` | `codex/stage8-live-controlled-integration-20261015` | `98a6f80d2304479b61e1b2ffe83d2fa4a889ad72` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-live-final-functional/whoop-briefing` | `codex/stage8-live-final-functional-20261015` | `b0dd71cc305f829589272504e3bc89c96d5508d9` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-predicate-ownership/whoop-briefing` | `codex/stage8-predicate-scoped-repair-20261014` | `9dc287fc5d916409002caafe5b845012da476032` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-quotation-safety-fallback/whoop-briefing` | `codex/stage8-quotation-fallback-20261015` | `620033c57ea4813bfad1e031113f8c8cf15fa16c` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-triage-architecture-correction/whoop-briefing` | `codex/stage8-triage-architecture-correction-20261014` | `dbb89360315a1cf6f1d9291b5310a24204c2e7b1` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-triage-independent-review/whoop-briefing` | `detached` | `177bfbc9c7ff41b9d3021ded136598f871bcfcfd` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-triage-semantic-repair/whoop-briefing` | `codex/stage8-triage-semantic-repair-20261014` | `177bfbc9c7ff41b9d3021ded136598f871bcfcfd` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing` | `codex/stage8-two-false-warning-repair-20261015` | `0acd29f9c010e7f924736ec2c8054f5e44435f5d` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-two-warning-independent-review/whoop-briefing` | `detached` | `0acd29f9c010e7f924736ec2c8054f5e44435f5d` | ancestor; clean snapshot |
| `~/.codex/worktrees/stage8-v34-provider/whoop-briefing` | `codex/stage8-v34-provider-20261013` | `7c6af29b7d19857444001694a6aae86a59ddf4d9` | ancestor; clean snapshot |
| `~/.codex/worktrees/unattended-20261020/whoop-briefing` | `repair/unattended-20261020` | `b1a0f06e6f8070a7bb2f5ca2ace17f3ebaa4289c` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/body-provisional-release` | `detached` | `7d699f0d5c37028bd6ea03ada49f6748bed1a814` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/journal-continuation-repair` | `repair/stage6-journal-continuation-20261013` | `9770553caba6f4085f4799fb6088db5076433f8e` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/morning-release` | `detached` | `dd6f5f130d09bb1ec1dad9259b81b8bb4bca928d` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/stage7-integration-review` | `detached` | `adecd3e9879936858af727da091f507bef743b08` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/stage7-review-repairs` | `detached` | `828b3bad0f75d3b81d374e431872878af56f6c9a` | ancestor; clean snapshot |
| `tmp/finalization-v3-recovery-20261013/worktree` | `feature/phase4-stage6-8-finalization-v3-recovered-20261013` | `828b3bad0f75d3b81d374e431872878af56f6c9a` | ancestor; original WIP snapshot/diffs |
| `tmp/four-blocker-repair-20261011/body-candidate` | `repair/four-blocker-body-20261011` | `3bea29b1282571bb103b6e4f93384037cb52526f` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-core-integration-prep` | `repair/body-core-integration-prep-20261011` | `15c803aceb6187422a23809fb43b72341f727533` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-evidence-closure-candidate` | `repair/body-evidence-closure-20261012` | `c8b5dcf8df159106d8f35e23e740636595bdde1f` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-final-generation-successor` | `repair/body-final-generation-20261012` | `a57d2a9a21f5df0587a2ad83e9f5d8fdda8726da` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-final-integration-candidate` | `repair/body-final-integration-20261012` | `b2c7d52eded069b4f4f8c8b59556e245c91b99c6` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-metric-input-candidate` | `repair/body-metric-input-20261012` | `c8b5dcf8df159106d8f35e23e740636595bdde1f` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-morning-order-candidate` | `repair/body-morning-order-20261012` | `a34db70957e25312697ee28e0b74a0370d8877c8` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-private-evidence-prep` | `codex/body-private-evidence-prep` | `cf968360cbb00ddb53fa71c94ce373ec540b57fa` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-private-wrapper-prep` | `codex/body-private-wrapper-prep` | `e58b089a605f102524991fa4539c202bc0a3b6e8` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-root-packet-scheduling-candidate` | `repair/body-root-packet-scheduling-20261012` | `59f6e8048832bc0614ab3c5eb38e0f59b4c912ed` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-unit-publication-candidate` | `repair/body-unit-publication-20261012` | `bf2648db197430ea4efbbabd44feeab5d7fc0211` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/body-user-tail-repair-candidate` | `repair/body-user-tail-20261012` | `4d5aa829a1794944dfe670babe80ef52dd7bd034` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/core-tuple-fallback-candidate` | `repair/four-blocker-core-tuple-fallback-20261012` | `16dc09befc74b5668f5fb2747148ded2f4280ec6` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/observation-candidate` | `repair/four-blocker-diagnostic-operator-20261011` | `fc48451474375797bb77efb3861c9ae7baf1276e` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/operator-candidate` | `repair/four-blocker-release-control-20261011` | `3b7b0de5bd8a1de8c5d9481f06edafaa42ea3579` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/performance-candidate` | `repair/four-blocker-stage6-performance-20261011` | `48318a958b80bdf0653748ab8706354b0021475d` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/qualified-app-candidate` | `repair/four-blocker-qualified-app-20261011` | `1dcefafae8c5d033b36e0545c1078e081ffadb53` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/release-gate-candidate` | `repair/four-blocker-release-gate-20261011` | `a897981debff0464512e047ef279bd97383fa955` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/repair-observation-candidate` | `repair/signed-render-sync-repair-observation-20261011` | `b7805a11d066c819f90895045e2ab5ddcebbb79f` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/repair-observation-cohort-successor` | `repair/signed-render-sync-cohort-fence-20261012` | `a98e91c1ab1ccfb0a59ee336b9913adeda0e1ae7` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/settings-candidate` | `repair/four-blocker-settings-20261011` | `20724cf7d5f9d936a448e1be657fc204f91d311c` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-candidate` | `repair/four-blocker-sync-20261011` | `da444cd4e05e08e31872d876aaaa31e297a902e2` | historical-local; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-input-read-repair-candidate` | `repair/four-blocker-input-read-envelope-20261012` | `600143a29188b867b33a6207b2eb966e015808f5` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-metadata-open-candidate` | `repair/four-blocker-sync-metadata-open-20261012` | `e121ed4b62a01acd489689309735f7470b20ab77` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-monday-envelope-candidate` | `repair/four-blocker-sync-monday-envelope-20261012` | `d5af8d07435113400d1999ad98ed7572cf3e327f` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-morning-repair-candidate` | `repair/four-blocker-morning-envelope-20261012` | `4cb7812b5015853c368c7ed71e8be402e6a05dfd` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-opening-proof-candidate` | `repair/four-blocker-sync-opening-proof-20261012` | `f52b9a09fb151176c3e45d7bcf4277ac7bdbbd90` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-read-preparation-candidate` | `detached` | `d4e80d74e2dd8dea4ab7dabc18890de82d441e93` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-repair-review-successor` | `repair/four-blocker-sync-reviewed-20261011` | `8115fb37a4125947851e66851299f8d84b4837b7` | ancestor; clean snapshot |
| `tmp/four-blocker-repair-20261011/sync-repair-successor` | `repair/four-blocker-sync-measured-20261011` | `06e2542f4c42394caa2358c827a7db97f39d3e5e` | ancestor; clean snapshot |
| `tmp/last3-gaps-20261012/candidate` | `repair/last3-gaps-20261012` | `9de1d19b30cc18cd400d0eafcf9d4eee8e4b9314` | ancestor; clean snapshot |
| `tmp/last3-gaps-20261012/item-throughput-candidate` | `release/body-item-throughput-20261012` | `afc5c93bf6c6fdc656e9491041527b53fb4c72c5` | ancestor; clean snapshot |
| `tmp/last3-gaps-20261012/item-throughput-review` | `detached` | `afc5c93bf6c6fdc656e9491041527b53fb4c72c5` | ancestor; clean snapshot |
| `tmp/last3-gaps-20261012/owner-pilot-candidate` | `repair/owner-pilot-window2-20261012` | `8c778b4c8fe405da5b98a5c0534622cbf6820ba0` | ancestor; clean snapshot |
| `tmp/last3-gaps-20261012/owner-pilot-successor` | `repair/owner-pilot-window2-successor-20261012` | `1eca89c123a3a49a08d2512dc1f5592eee7b1212` | ancestor; clean snapshot |
| `tmp/pre-stage7/baseline-native` | `detached` | `dfffbfb73fe844cfddcab2f357a8f7b5a84d4e54` | ancestor; clean snapshot |
| `tmp/pre-stage7/core-c-contention` | `repair/pre-stage7-core-c-contention` | `ef57f3f85c0b471b891fe3a463c0faad308e8188` | ancestor; original WIP snapshot/diffs |
| `tmp/pre-stage7/core-c-final` | `repair/pre-stage7-core-c-fence-observation` | `78705107442b02daf7166eb104aa6ea5b1af1034` | ancestor; original WIP snapshot/diffs |
| `tmp/pre-stage7/core-c-latency` | `repair/pre-stage7-core-c-coordination-result` | `22f1e707dbec681c4e4492bf8e943d7571735588` | ancestor; original WIP snapshot/diffs |
| `tmp/pre-stage7/core-validation` | `repair/pre-stage7-core-c-final-ack` | `6b0ff4f5fddc35721328a53b1c8b3419918b763b` | ancestor; clean snapshot |
| `tmp/pre-stage7/settings-d-final` | `feature/pre-stage7-settings-d-final` | `4fd91d1fa78bb6f140ab4559ea41825768140c17` | ancestor; original WIP snapshot/diffs |
| `tmp/prestage7-production-recovery-20261011/shadow-scope-core` | `detached` | `7b7517837b41b8eeb4f9068e9b658675682523d1` | ancestor; original WIP snapshot/diffs |
| `tmp/prestage7-production-recovery-20261011/shadow-scope-settings` | `detached` | `42840cbeb4fdf3b9194431d497f41865f2d1ebc9` | ancestor; clean snapshot |
| `tmp/production-completion-20261016/qualification-worktree` | `release/linux-qualification-repair-20261016` | `236c261eab498ad78613428e1fcf6ba840b1acc4` | ancestor; clean snapshot |
| `tmp/production-completion-20261016/stage8-worktree` | `release/stage8-completion-20261016` | `7410b9039f77dc2860ac366e8c9f166a7870daaf` | ancestor; clean snapshot |
| `tmp/production-completion-20261016/terminal-control-worktree` | `release/stage8-terminal-control-20261016` | `f5f301b4346cc563128f127bd5ca44e39ec48c37` | ancestor; original WIP snapshot/diffs |
| `tmp/production-completion-20261016/weekly-worktree` | `release/stage7-weekly-20261016` | `ca4bff7b711737527ca6c4e306d4a3ef555c9f3b` | historical-local; clean snapshot |
| `tmp/production-completion-20261016/worktree` | `release/production-completion-20261016` | `632f31d4c0b2a4e391a3c4a379c062674b14273b` | historical-local; clean snapshot |
| `tmp/r21-20261026.private/morning-v33` | `fix/morning-expired-evaluation-v33-20261026` | `9a8c951deee42ad9f6fd9c5828edad44f246d5f7` | ancestor; clean snapshot |
| `tmp/session-recovery-20261026/candidate` | `repair/stage6-shadow-publication-20261026` | `b5027adaf9f860c28e0e02ecf3bdf754834adcbc` | ancestor; clean snapshot |
| `tmp/stage1-6-finalization-20261011/body-evaluation-candidate` | `repair/prestage7-body-evaluation-20261011` | `7499d7837743f91eccb2905b33e2af19f5b87845` | historical-local; clean snapshot |
| `tmp/stage1-6-finalization-20261011/handoff-candidate` | `repair/prestage7-handoff-v3-20261011` | `fcf99e6036c61e51723f76af4bc54d21387893ef` | historical-local; clean snapshot |
| `tmp/stage1-6-finalization-20261011/operator-candidate` | `repair/prestage7-operator-cycle-20261011` | `afe6485d427fd45b93791c982e89ba4acf0b5854` | historical-local; clean snapshot |
| `tmp/stage6-p0-20261013/worktree` | `repair/stage6-domain-production-20261013` | `2340e8bc305c6acde29bbfa540753e79dbd34408` | ancestor; clean snapshot |
| `tmp/stage6-raw-capacity-20261013/candidate` | `qualification/stage6-local-synthetic-http-20261015` | `a7bdbd591625cbd8c7ee0f42814f84bf55a8d6a9` | ancestor; clean snapshot |
| `tmp/stage7-progress/worktree` | `feature/phase4-stage7-v33-rc20261012` | `a1ec7317989d3a05c1b68198a2f9a6eebed73e2e` | ancestor; clean snapshot |
| `tmp/stage7-ux-20261029.private/candidate` | `fix/stage7-journal-ux-v33-20261029` | `29ee2aef00fde3ec20919bbb4561bef33eb84bec` | ancestor; clean snapshot |
| `tmp/stages1-6-ship-20261012/integration` | `release/stages1-6-integration-20261012` | `af2fb180431dff8c1641af8a5741a50d9cb61e23` | ancestor; clean snapshot |
| `tmp/stages1-6-ship-20261012/observer` | `repair/ship-sync-observer-16dc-20261012` | `f97bf67f05be5d89bd061b83c90b6b416e5c06d2` | historical-local; clean snapshot |

## Local branches and tags

HEADs 依盤點時 SHA 保存；tag objects 保留原 SHA。Backup-only recovery refs 保護 detached/reflog commits，未加入公用 repository。

| Ref | Object SHA | Transfer coverage |
|---|---|---|
| `refs/heads/codex/body-private-evidence-prep` | `cf968360cbb00ddb53fa71c94ce373ec540b57fa` | historical-local; private bundle |
| `refs/heads/codex/body-private-wrapper-prep` | `e58b089a605f102524991fa4539c202bc0a3b6e8` | historical-local; private bundle |
| `refs/heads/codex/phase4-final-integration-20261015` | `26c864c2afb876c24eb66cfd330f61e5e32cf439` | ancestor |
| `refs/heads/codex/stage8-authenticated-live-producers-20261015` | `649676e030aa8d25639985d397c5d3837462f484` | ancestor |
| `refs/heads/codex/stage8-conservative-safety-gate-20261014` | `b69a9d64785a38de220da4ca36f48aa4180b4820` | ancestor |
| `refs/heads/codex/stage8-final-evidence-ownership-repair-20261014` | `c0520010fc8b643a15bc0caf35245f8aeb299f53` | historical-local; private bundle |
| `refs/heads/codex/stage8-final-quotation-repair-20261015` | `d538b07e097fedb42481c305de0738761c512a4d` | ancestor |
| `refs/heads/codex/stage8-gate-adjudicated-repair-20261015` | `10b68fa5f4f9501c424ad4c16b4bab0eae500595` | ancestor |
| `refs/heads/codex/stage8-live-controlled-integration-20261015` | `98a6f80d2304479b61e1b2ffe83d2fa4a889ad72` | ancestor |
| `refs/heads/codex/stage8-live-final-functional-20261015` | `b0dd71cc305f829589272504e3bc89c96d5508d9` | ancestor |
| `refs/heads/codex/stage8-predicate-ownership-20261014` | `a2dd62ae7be4cf4058952f3d6471e85f5b15fbd1` | ancestor |
| `refs/heads/codex/stage8-predicate-scoped-repair-20261014` | `9dc287fc5d916409002caafe5b845012da476032` | ancestor |
| `refs/heads/codex/stage8-quotation-fallback-20261015` | `620033c57ea4813bfad1e031113f8c8cf15fa16c` | ancestor |
| `refs/heads/codex/stage8-three-blocker-repair-20261014` | `5a6e0a5764a75ec303acfaf52f356694f717b750` | ancestor |
| `refs/heads/codex/stage8-triage-architecture-correction-20261014` | `dbb89360315a1cf6f1d9291b5310a24204c2e7b1` | ancestor |
| `refs/heads/codex/stage8-triage-semantic-repair-20261014` | `177bfbc9c7ff41b9d3021ded136598f871bcfcfd` | ancestor |
| `refs/heads/codex/stage8-two-false-warning-repair-20261015` | `0acd29f9c010e7f924736ec2c8054f5e44435f5d` | ancestor |
| `refs/heads/codex/stage8-v34-parallel` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/codex/stage8-v34-provider-20261013` | `7c6af29b7d19857444001694a6aae86a59ddf4d9` | ancestor |
| `refs/heads/codex/whoop-final-production-release-20261015` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-budget-attribution-20261020` | `416a1c6d840d4b5b35b97c848fd8b40d847889e3` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-continuation-20261020` | `dae587879dac7eef0faced2587ded9dbe1b813a1` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-first-failure-20261020` | `ea770a250b4f87c97198737c0915b587e87932ec` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-integer-timeout-20261020` | `40a5db6b764430509a3591352aad930914adcd92` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-observation-20261020` | `7be87974a9ccd424212ae06871a662f3ac415b1f` | historical-local; private bundle |
| `refs/heads/diagnostic/native-cold-owned-delivery-20261023` | `237a21875ab07f5de8e556c36265a7e2061ad79a` | historical-local; private bundle |
| `refs/heads/diagnostic/native-empty-attribution-20261020` | `e93736ae13c2681322905f9eae1c3a4014c2eea8` | ancestor |
| `refs/heads/diagnostic/principal-snapshot-20261020` | `9e4909ce3a8330ba8ddf55e0fbef7a4ec85a65d1` | ancestor |
| `refs/heads/diagnostic/schema-metadata-snapshot-20261020` | `d6b7010c95125af749194348f920e617011e8a44` | ancestor |
| `refs/heads/diagnostic/stage6-cpu-sensor-20261025` | `77989b24599ee20926c7834a26f672d4d336467e` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-expected-ddl-first17-20261025` | `decfb2ee3fc1d81a57756b19926c315d4c56b0f6` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-expected-literal-first17-20261025` | `d055e2ef377ba8ec6f409451e52edba8e19fab36` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file-bootstrap-memory-20261026` | `0a2926a3ba399448484671a6def771a08bc08571` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-adaptive-eof-20261026` | `4de4cf9547c5237184f49fa5ebe7128058536f49` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-eof-failure-profile-20261026` | `1cdb0033ac24857d83be4e1d12b01adf88457b81` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-parent-verify-eof-20261026` | `077a53aee08eef05451b7b9ef83d967aa39171f6` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-physical-batch-eof-20261026` | `05de651ac88122aeedd3377f8fc1e64db505ee4c` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-prepared-eof-20261026` | `cf7e543dce74706ac3f276ec7f13e7800336b87c` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-file48-single-call-eof-20261026` | `34daee77d5b8f6cf515d2e121cfa8c05644c3856` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-live12-semi4-positive-eof-20261025` | `8a3bdcb87ffc4cd2601bf0c80804b5d8928a91be` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-appcause-20261023` | `eb6bf4f1b13aa03d6598e2bfbf96ac163699f044` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-context-eof-20261024` | `bade475dbcccc8de3729b45ab43a218b05649fae` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-eof-hrana-20261023` | `d75fae8534e2601a6f8cb2fa6a6c0cae4aedd5af` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-family-phases-20261024` | `b887d4b2ee614baa279eb8b65dfa303baeb87805` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-first17-cpu-20261024` | `31e330e1af9bf7c7b2074fe6fa363ae82e5cfac7` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-first20-20261023` | `fc8a843689eec7e9ba71237c0bc6c3c43ee9c359` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-heap128-20261024` | `70e73c6475583791c97f68b1657e4150aee399db` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-inflight-control-20261024` | `2fb2ae23b89c84d71d6c4926728d137ca071c4b1` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-joined-close-20261024` | `6daf9f0e8985b40954eb875b7f905dd2d5534383` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-lease-data-eof-20261024` | `4a211ac1cc24f4de7964938770b4eb015b00c5ba` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-memo-admission-20261024` | `bc39133ae5b8ca4a5e886791778f47eaadb05df6` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-memo-duplicate-20261024` | `d9de8a906f40168c6e2524ddb06c3891247be3be` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-observer-cpu-20261024` | `d30d041066bf257326015ddb076c6fd49aa653b6` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-ownership-eof-20261024` | `009e2538cca7d982b656e3060ae2403a413f43e8` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-positive-eof-20261023` | `3f4c8e11c860fed7cf284054baa6090e33954c2a` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-positive-hybrid-20261023` | `5cffc99cf2ed47e1d23bc17cf5cd2c50b3a130b0` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-recovery-cpu-20261024` | `3a3e747ca45f3837e492aad2a5eb643375265a5e` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-slow-root-20261024` | `e56df9b4f5f0f5d0bbe175c0e0e7702ef3d53e35` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-source-control-20261024` | `4a4243a6d571a48329016e34748b5c2e1faf6ad2` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-sql-shape-eof-20261024` | `785680820984697d6db66ec08af30d12ef2edb86` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-tenant-data-20261024` | `d617750fad1e67e18ee9de0096d8484dde02ae15` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-native-work-join-20261024` | `a95bb2170f781b35832a6117d1a9a6bdb6dc28d1` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-owned-file-prepared-eof-20261025` | `65a44ecddbd5355ffbf937cdc7f04dbf3151fec6` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-private-scalar-first17-20261025` | `957ebb8bbb696f84982a392adf88c5b9ec25a62d` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-raw-data-first17-20261025` | `6c12fd898575061e88ef36ae4616a7bc617ce116` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-raw-syntax-plan-first17-20261025` | `46a17452f2403648711a82aa2e4513dc389e9cbd` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-receiver-scope-first17-20261025` | `c92c13804ce8007a644069a89bb01ae93f90d267` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-recovery17-cost-parser-20261025` | `b9cdb61ab8dfb4e7530e76fce63e6a9a4b1ee736` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-recovery17-cpu-cost-20261025` | `1b730f1c1e0dd17f62c633d2a35680fd80eb8f38` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-recovery17-target-profile-20261025` | `a305ccd8e53ce1744a06871a870de2182985b859` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-semi4-first17-20261025` | `a3edb99c5547bec58549532a8def195e608e007e` | historical-local; private bundle |
| `refs/heads/diagnostic/stage6-semi4-positive-eof-20261025` | `808f6b3dc8fe8c1382f6c085dfb062da0da8de4a` | historical-local; private bundle |
| `refs/heads/feature/phase4-stage6-8-finalization-v3` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/feature/phase4-stage6-8-finalization-v3-recovered-20261013` | `828b3bad0f75d3b81d374e431872878af56f6c9a` | ancestor |
| `refs/heads/feature/phase4-stage7-v33` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/feature/phase4-stage7-v33-rc20261012` | `a1ec7317989d3a05c1b68198a2f9a6eebed73e2e` | ancestor |
| `refs/heads/feature/pre-stage7-final-integration-20261013` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/feature/pre-stage7-settings-d` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/feature/pre-stage7-settings-d-final` | `4fd91d1fa78bb6f140ab4559ea41825768140c17` | ancestor |
| `refs/heads/feature/pre-stage7-settings-v1` | `e2f4314ef6551918f5bb64e2e713e8e10088b2f3` | ancestor |
| `refs/heads/feature/pre-stage7-settings-v1-continuation` | `8bdd054b044b649ee887688cfe8db0ae1b9fb1c5` | ancestor |
| `refs/heads/fix/hrana-before-dispatch-close-v33-20261025` | `8372316deb595e53005b92b74e2dd0c848b7f50d` | ancestor |
| `refs/heads/fix/morning-expired-evaluation-v33-20261026` | `9a8c951deee42ad9f6fd9c5828edad44f246d5f7` | ancestor |
| `refs/heads/fix/stage6-context-lease-inflight-20261024` | `785eae80135e1bd00d4c9eacbc6be1e2dd4e38e6` | historical-local; private bundle |
| `refs/heads/fix/stage6-context-lease-row-data-20261024` | `de262df36aea6199db41405963fb7cf45a0453f4` | historical-local; private bundle |
| `refs/heads/fix/stage6-control-sql-shapes-20261024` | `8cb10488209db3745e913ef0f1c615e0735ee44b` | historical-local; private bundle |
| `refs/heads/fix/stage6-inflight-control-20261024` | `d9dbd5bbda7522cc4bc6a1356777c71fe9c8daaa` | historical-local; private bundle |
| `refs/heads/fix/stage6-live-exact-real-20261024` | `ed4399c5f1567d03bc2353d9969e0f2518d96c01` | historical-local; private bundle |
| `refs/heads/fix/stage6-live-observation-key-20261024` | `a22fd560877c015baef0bc20b9310732ca2baf47` | historical-local; private bundle |
| `refs/heads/fix/stage6-owned-row-data-20261024` | `866d916ab5f2081b8f2f6fd73288571a926bed56` | historical-local; private bundle |
| `refs/heads/fix/stage6-principal-inflight-20261024` | `8a32f73b2793d5026a79029663d6b56d5ab6902c` | historical-local; private bundle |
| `refs/heads/fix/stage6-pure-sql-cpu-20261024` | `703ba2140972e794656f76297a86200a46401198` | historical-local; private bundle |
| `refs/heads/fix/stage6-raw-disjoint-syntax-plan-20261025` | `700cc848298c3ed1bab5a6ddfcbff5f39182e952` | historical-local; private bundle |
| `refs/heads/fix/stage6-raw-root-prefetch-20261024` | `a22fd560877c015baef0bc20b9310732ca2baf47` | historical-local; private bundle |
| `refs/heads/fix/stage6-read-memo-duplicate-20261024` | `8a4d3765a55c52ffd160431395c066d9564e35bd` | historical-local; private bundle |
| `refs/heads/fix/stage6-source-control-inflight-20261024` | `a46104fdda1e5652aa2566edf6fb2c9760e551f4` | historical-local; private bundle |
| `refs/heads/fix/stage6-tenant-lease-data-20261024` | `d1c0f5f7b0b8b9ea6e4b392f832a8a7507dc59b7` | historical-local; private bundle |
| `refs/heads/fix/stage7-journal-ux-v33-20261029` | `29ee2aef00fde3ec20919bbb4561bef33eb84bec` | ancestor |
| `refs/heads/handoff/tw-transfer-20261029` | `af9112fdbcce63eac69c1c06bfb08f51801b3780` | new transfer integration; final document commit follows |
| `refs/heads/main` | `18530a6705744ef435be2b58c310d5cb59eec058` | ancestor |
| `refs/heads/ops/v33-runtime-heap-observation-20261024` | `c743cbec5d1587cee6b344570e7bc24fb9f5f4fb` | ancestor |
| `refs/heads/prototype/stage6-short-transaction-20261014` | `1a78d9b1b3b69b1874cda3c2b000422b97209cdf` | ancestor |
| `refs/heads/qualification/stage6-local-synthetic-http-20261015` | `a7bdbd591625cbd8c7ee0f42814f84bf55a8d6a9` | ancestor |
| `refs/heads/recovery/vietnam-stage2-rc3` | `ce8e4fd76baab494d32de11e4d022311e303a066` | ancestor |
| `refs/heads/release/body-item-throughput-20261012` | `afc5c93bf6c6fdc656e9491041527b53fb4c72c5` | ancestor |
| `refs/heads/release/coach-journal-v33-20261016` | `1afe73e6600a5481b17c76759cbca5665218f2b0` | historical-local; private bundle |
| `refs/heads/release/linux-qualification-20261016` | `8f0b822b93d658af6084afa65e647b9f250d8f00` | ancestor |
| `refs/heads/release/linux-qualification-repair-20261016` | `236c261eab498ad78613428e1fcf6ba840b1acc4` | ancestor |
| `refs/heads/release/owner-pilot-window2-20261012` | `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b` | historical-local; private bundle |
| `refs/heads/release/production-completion-20261016` | `632f31d4c0b2a4e391a3c4a379c062674b14273b` | historical-local; private bundle |
| `refs/heads/release/stage6-transport-20261013` | `afc5c93bf6c6fdc656e9491041527b53fb4c72c5` | ancestor |
| `refs/heads/release/stage7-weekly-20261016` | `ca4bff7b711737527ca6c4e306d4a3ef555c9f3b` | historical-local; private bundle |
| `refs/heads/release/stage8-completion-20261016` | `7410b9039f77dc2860ac366e8c9f166a7870daaf` | ancestor |
| `refs/heads/release/stage8-terminal-control-20261016` | `f5f301b4346cc563128f127bd5ca44e39ec48c37` | ancestor |
| `refs/heads/release/stages1-6-integration-20261012` | `af2fb180431dff8c1641af8a5741a50d9cb61e23` | ancestor |
| `refs/heads/repair/body-core-integration-prep-20261011` | `15c803aceb6187422a23809fb43b72341f727533` | ancestor |
| `refs/heads/repair/body-evidence-closure-20261012` | `c8b5dcf8df159106d8f35e23e740636595bdde1f` | ancestor |
| `refs/heads/repair/body-final-generation-20261012` | `a57d2a9a21f5df0587a2ad83e9f5d8fdda8726da` | ancestor |
| `refs/heads/repair/body-final-integration-20261012` | `b2c7d52eded069b4f4f8c8b59556e245c91b99c6` | ancestor |
| `refs/heads/repair/body-metric-input-20261012` | `c8b5dcf8df159106d8f35e23e740636595bdde1f` | ancestor |
| `refs/heads/repair/body-morning-order-20261012` | `a34db70957e25312697ee28e0b74a0370d8877c8` | historical-local; private bundle |
| `refs/heads/repair/body-reader-v35-20261020` | `1f6095a9a6be98dd73455f7a559240dd66ba200c` | historical-local; private bundle |
| `refs/heads/repair/body-root-packet-scheduling-20261012` | `59f6e8048832bc0614ab3c5eb38e0f59b4c912ed` | ancestor |
| `refs/heads/repair/body-unit-publication-20261012` | `bf2648db197430ea4efbbabd44feeab5d7fc0211` | historical-local; private bundle |
| `refs/heads/repair/body-user-tail-20261012` | `4d5aa829a1794944dfe670babe80ef52dd7bd034` | ancestor |
| `refs/heads/repair/four-blocker-body-20261011` | `3bea29b1282571bb103b6e4f93384037cb52526f` | ancestor |
| `refs/heads/repair/four-blocker-core-tuple-fallback-20261012` | `16dc09befc74b5668f5fb2747148ded2f4280ec6` | ancestor |
| `refs/heads/repair/four-blocker-diagnostic-operator-20261011` | `fc48451474375797bb77efb3861c9ae7baf1276e` | historical-local; private bundle |
| `refs/heads/repair/four-blocker-input-read-envelope-20261012` | `600143a29188b867b33a6207b2eb966e015808f5` | ancestor |
| `refs/heads/repair/four-blocker-morning-envelope-20261012` | `4cb7812b5015853c368c7ed71e8be402e6a05dfd` | ancestor |
| `refs/heads/repair/four-blocker-qualified-app-20261011` | `1dcefafae8c5d033b36e0545c1078e081ffadb53` | ancestor |
| `refs/heads/repair/four-blocker-release-control-20261011` | `3b7b0de5bd8a1de8c5d9481f06edafaa42ea3579` | historical-local; private bundle |
| `refs/heads/repair/four-blocker-release-gate-20261011` | `a897981debff0464512e047ef279bd97383fa955` | historical-local; private bundle |
| `refs/heads/repair/four-blocker-settings-20261011` | `20724cf7d5f9d936a448e1be657fc204f91d311c` | ancestor |
| `refs/heads/repair/four-blocker-stage6-performance-20261011` | `48318a958b80bdf0653748ab8706354b0021475d` | historical-local; private bundle |
| `refs/heads/repair/four-blocker-sync-20261011` | `da444cd4e05e08e31872d876aaaa31e297a902e2` | historical-local; private bundle |
| `refs/heads/repair/four-blocker-sync-measured-20261011` | `06e2542f4c42394caa2358c827a7db97f39d3e5e` | ancestor |
| `refs/heads/repair/four-blocker-sync-metadata-open-20261012` | `e121ed4b62a01acd489689309735f7470b20ab77` | ancestor |
| `refs/heads/repair/four-blocker-sync-monday-envelope-20261012` | `d5af8d07435113400d1999ad98ed7572cf3e327f` | ancestor |
| `refs/heads/repair/four-blocker-sync-opening-proof-20261012` | `f52b9a09fb151176c3e45d7bcf4277ac7bdbbd90` | ancestor |
| `refs/heads/repair/four-blocker-sync-reviewed-20261011` | `8115fb37a4125947851e66851299f8d84b4837b7` | ancestor |
| `refs/heads/repair/journal-stage6-integration-20261023` | `c423bb1abc993b28bd5736cd2c024351226d8032` | ancestor |
| `refs/heads/repair/journal-stage6-prod837-integration-20261026` | `bc2c3455dcdb042cdc4803e1ad96094dd92cfc84` | ancestor |
| `refs/heads/repair/last3-gaps-20261012` | `9de1d19b30cc18cd400d0eafcf9d4eee8e4b9314` | ancestor |
| `refs/heads/repair/owner-pilot-window2-20261012` | `8c778b4c8fe405da5b98a5c0534622cbf6820ba0` | ancestor |
| `refs/heads/repair/owner-pilot-window2-successor-20261012` | `1eca89c123a3a49a08d2512dc1f5592eee7b1212` | ancestor |
| `refs/heads/repair/pre-stage7-budget-continuation` | `c4c35e0ad8f98165d23ffc1383546779fee10d81` | ancestor |
| `refs/heads/repair/pre-stage7-consolidated-core-c` | `de5764b455daaa93529d9288b8ce909dcc191fe0` | ancestor |
| `refs/heads/repair/pre-stage7-consolidated-core-c-final` | `174a2be09475fcda53f6ff6cd7bb59d249ffa86d` | ancestor |
| `refs/heads/repair/pre-stage7-core` | `641c8f6258577c25bacde7ff68301cbf07b97d50` | ancestor |
| `refs/heads/repair/pre-stage7-core-c-contention` | `ef57f3f85c0b471b891fe3a463c0faad308e8188` | ancestor |
| `refs/heads/repair/pre-stage7-core-c-coordination-result` | `22f1e707dbec681c4e4492bf8e943d7571735588` | ancestor |
| `refs/heads/repair/pre-stage7-core-c-fence-observation` | `78705107442b02daf7166eb104aa6ea5b1af1034` | ancestor |
| `refs/heads/repair/pre-stage7-core-c-final-ack` | `6b0ff4f5fddc35721328a53b1c8b3419918b763b` | ancestor |
| `refs/heads/repair/pre-stage7-core-c-provider-budget` | `d668e800bd4aa1a04955b6df585ad5f281a4190b` | ancestor |
| `refs/heads/repair/prestage7-body-evaluation-20261011` | `7499d7837743f91eccb2905b33e2af19f5b87845` | historical-local; private bundle |
| `refs/heads/repair/prestage7-handoff-v3-20261011` | `fcf99e6036c61e51723f76af4bc54d21387893ef` | historical-local; private bundle |
| `refs/heads/repair/prestage7-operator-cycle-20261011` | `afe6485d427fd45b93791c982e89ba4acf0b5854` | historical-local; private bundle |
| `refs/heads/repair/proactive-journal-20261023` | `35cbff25b6a5e2f22993e99655b14e0011904417` | ancestor |
| `refs/heads/repair/readiness-integration-20261020` | `ca01f63d2bd948f24a3a0400decdaca898811f39` | ancestor |
| `refs/heads/repair/ship-sync-observer-16dc-20261012` | `f97bf67f05be5d89bd061b83c90b6b416e5c06d2` | historical-local; private bundle |
| `refs/heads/repair/signed-render-sync-cohort-fence-20261012` | `a98e91c1ab1ccfb0a59ee336b9913adeda0e1ae7` | historical-local; private bundle |
| `refs/heads/repair/signed-render-sync-repair-observation-20261011` | `b7805a11d066c819f90895045e2ab5ddcebbb79f` | historical-local; private bundle |
| `refs/heads/repair/stage6-architecture-decision-20261014` | `75db69fe77d2380206df25509187b79c68d05fd7` | ancestor |
| `refs/heads/repair/stage6-child-monitored-20261014` | `2055244a352c826df5216bf5b80b3684770b96f6` | ancestor |
| `refs/heads/repair/stage6-cpu-scheduling-20261014` | `3a9db6853c70b1e63f89f5f1c196be5208b91a74` | ancestor |
| `refs/heads/repair/stage6-domain-capacity-20261013` | `88cc17e41c3a30cb2723ca37c19adf42a23cb08d` | ancestor |
| `refs/heads/repair/stage6-domain-production-20261013` | `2340e8bc305c6acde29bbfa540753e79dbd34408` | ancestor |
| `refs/heads/repair/stage6-exact-real-20261015` | `c296756b7ee8ceeab7b00d40ae52c922cedd42af` | ancestor |
| `refs/heads/repair/stage6-final-runtime-qualification-20261014` | `bec7c21516ba9baf705a492aa3ceb269ad332beb` | ancestor |
| `refs/heads/repair/stage6-finalization-20261023` | `11a6e7c203614ff7f23cd13ee09b08ca8f75138a` | historical-local; private bundle |
| `refs/heads/repair/stage6-journal-continuation-20261013` | `9770553caba6f4085f4799fb6088db5076433f8e` | ancestor |
| `refs/heads/repair/stage6-late-unit-20261014` | `b1e0d193b2eac17de309da8ae424ad7a66b05a42` | ancestor |
| `refs/heads/repair/stage6-raw-capacity-20261013` | `caf08fc6e5a6af38988aae97ebf834a80bfcfea7` | ancestor |
| `refs/heads/repair/stage6-runtime-memory-20261014` | `5b0f9e1f3e06b50a3cc6e6ffe14cd8dc28995b78` | ancestor |
| `refs/heads/repair/stage6-service-isolation-20261014` | `7ded16c1ada45e8eec9d8c4b2ff26ee3bcc38355` | ancestor |
| `refs/heads/repair/stage6-service-ready-20261015` | `b8d69a38405a711824aa5946813ce720911a079f` | ancestor |
| `refs/heads/repair/stage6-shadow-publication-20261026` | `b5027adaf9f860c28e0e02ecf3bdf754834adcbc` | ancestor |
| `refs/heads/repair/stage6-sync-atomic-20261014` | `a32210819c160a7bfcd8187315aaba713f7cf5b6` | ancestor |
| `refs/heads/repair/unattended-20261020` | `b1a0f06e6f8070a7bb2f5ca2ace17f3ebaa4289c` | ancestor |
| `refs/heads/v1.1-functional-completion` | `fee0448d7c52e2e98fe2607026f840b78dc024b7` | ancestor |
| `refs/heads/v1.2-phase4` | `dfffbfb73fe844cfddcab2f357a8f7b5a84d4e54` | ancestor |
| `refs/tags/multiuser-v1-2026-09-07` | `f026ecde995d63e13a3b6ba77015d39e3b02bb6a` | ancestor |
| `refs/tags/personal-physiology-v1-2026-09-07` | `b104672534474f69305b2fc2c3ace31a75eb86d8` | ancestor |
| `refs/tags/pre-multiuser-2026-09-06` | `3cca2834b0dce60b92372086b5b4b3319216c329` | ancestor |
| `refs/tags/v1.1.0` | `9795accb9719841e007d52305ed97c72a8faa51c` | ancestor |
| `refs/tags/v1.2-phase1-freeze` | `6bdb9846ef6b7069409a00b54a70834b76487a1f` | ancestor |
| `refs/tags/v1.2-phase2-freeze` | `a3d1f728453803a346b30664e243dfc090164e95` | ancestor |
| `refs/tags/v1.2-phase3-freeze` | `26efa04f88c087c599128d701870b3ad945fa0cb` | ancestor |
| `refs/tags/v1.2-phase3.5-freeze` | `dc41d64fb9a188f78930eb2a798fbb4442c9b7a3` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc1` | `748e6b51e274c49c6a419cebbb954325ea0b2414` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc2` | `e64f1b697d4b5aa1e5beba3920a6a6024ee7e9cf` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc3` | `80fb12c408a2824f1bf3058de54dda1aedee7353` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc4` | `75c5156d2832512d514aa857ed76ea2c160e0596` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc4-health-http` | `f8be29127270d5149eab2375d5d59aac5425db95` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc4-sync-http` | `410c57e552a4ead48e8a8c5862467f0048b7d928` | ancestor |
| `refs/tags/v1.2-phase4-public-beta-rc4-turso-compat` | `709acb4a9bacfe06f305c87e263c1ffaef732698` | ancestor |
| `refs/tags/v1.2-phase4-stage5-freeze` | `c8c63a848fc642da01e11137b6077d17ec92f0c2` | ancestor |
| `refs/tags/v1.2-phase4-stage6-freeze` | `11fbc0b4e91a9e6465ca7c751adf6d22eee0df0a` | ancestor |
| `refs/tags/v1.2-production-release-freeze` | `4be66e4eba256622f73e204e9d43350dd7f16cff` | ancestor |
| `refs/tags/whoop-core-c-reviewed-20261011` | `ef57f3f85c0b471b891fe3a463c0faad308e8188` | ancestor |
| `refs/tags/whoop-settings-d-reviewed-20261011` | `4fd91d1fa78bb6f140ab4559ea41825768140c17` | ancestor |

## 未提交內容與 refs 的處理

- 82 個 branch worktrees、11 個 detached worktrees；盤點時沒有 stash。
- 7 個 dirty worktrees 均完整保留，沒有 reset/clean/checkout 覆寫或刪除。
- 兩個 source WIP 共 54 檔：53 個 exact blobs 在 transfer ancestry；唯一舊 Body source-page test 已由 tracked 修正版取代。原版保存在 private archive，沒有覆蓋新 API 測試。
- 其餘 5 個 dirty worktrees 為 node_modules／診斷 artifacts；不當作必須公開的 source changes。
- 全部 refs、worktree HEAD/index/reflogs、595 個 recovery refs、完整未提交 binary diffs 及 ignored 私有檔都保存在越南私人備份。
- 所有 remote refs 的前後 snapshot 和 remote clone verification 另存在私人交接報告；沒有推送既有 release/main 或 private recovery refs。
