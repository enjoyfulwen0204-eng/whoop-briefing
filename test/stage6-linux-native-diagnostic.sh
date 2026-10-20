#!/bin/sh
# Diagnostic-only entry. No old qualification loop, cold replay or hard-kill timeout.
set -eu
umask 077
test "$(uname -s)" = Linux
test -f /.dockerenv
test "$(node --version)" = v22.23.2
node test/stage8-live-linux-preflight.test.js --check initial
node --input-type=module -e 'import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{parseOfflineMountInfo}from"./test/stage8-live-linux-preflight.test.js";const mounts=parseOfflineMountInfo(readFileSync("/proc/self/mountinfo","utf8"));for(const path of [process.cwd()+"/scripts","/native-host-proof.json"]){const rows=mounts.filter(m=>m.path===path);assert.equal(rows.length,1);assert.ok(rows[0].options.includes("ro")&&!rows[0].options.includes("rw"));}assert.ok(!mounts.some(m=>m.path.startsWith(process.cwd()+"/scripts/")&&(!m.options.includes("ro")||m.options.includes("rw"))));'
isolated-sqld -d /qualification/physical --http-listen-addr 127.0.0.1:18080 --no-welcome > /qualification/sqld.log 2>&1 &
server_pid=$!
# No signal trap kills sqld while original work/COMMIT may still be unknown.
node --input-type=module -e 'for(let n=0;n<30;n++){try{const r=await fetch("http://127.0.0.1:18080/v2/pipeline",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[{type:"execute",stmt:{sql:"SELECT 1",want_rows:false}},{type:"close"}]}),signal:AbortSignal.timeout(250)});if(r.ok&&(await r.json()).results?.[0]?.type==="ok")process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("FRESH_SQLD_NOT_READY");' || { wait "$server_pid"; exit 2; }
set +e
node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-linux-native-diagnostic.mjs one-original-empty-120s > /qualification/diagnostic.tap 2>&1
native_exit=$?
set -e
if node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync("/qualification/diagnostic-report.json","utf8"));if(r.ownedCleanupEligible!==true||r.observationPoint!=="AFTER_AWAITED_CLEANUP")process.exit(2);';then
 # Only a settled, closed native client permits normal owned server shutdown.
 kill -TERM "$server_pid"
 wait "$server_pid" || true
 exit "$native_exit"
fi
# Retain the captured owned runtime for Root-directed disposition; do not manufacture terminal/cleanup evidence.
printf '%s\n' 'DIAGNOSTIC_UNKNOWN_OWNED_RUNTIME_RETAINED' > /qualification/cleanup-unknown.txt
wait "$server_pid"
exit 2
