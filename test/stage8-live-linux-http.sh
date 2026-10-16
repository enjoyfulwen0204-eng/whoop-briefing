#!/bin/sh
# Opt-in only. Must be the explicit command of an offline Docker container with
# current readonly src/test, package.json and authentic checkout Git mounts.
# No image build/pull, credential mounting or Docker execution occurs here.
set -eu
umask 077
test "$(uname -s)" = Linux
test -f /.dockerenv
test -d /qualification
test "$(readlink -f /qualification)" = /qualification
test -z "$(ls -A /qualification)"
test -e .git
git rev-parse --verify 'HEAD^{commit}' >/dev/null
command -v isolated-sqld >/dev/null
command -v timeout >/dev/null
node --input-type=module -e 'import assert from "node:assert/strict";import{readdirSync}from"node:fs";assert.deepEqual(readdirSync("/sys/class/net").sort(),["lo"]);'
node test/stage8-live-linux-preflight.test.js --check initial
mkdir /qualification/empty /qualification/dense
server_pid=
stop_server(){
 if test -n "$server_pid";then
  kill -TERM "$server_pid" 2>/dev/null || true
  server_wait=50
  while kill -0 "$server_pid" 2>/dev/null && test "$server_wait" -gt 0;do sleep 0.1;server_wait=$((server_wait-1));done
  if kill -0 "$server_pid" 2>/dev/null;then kill -KILL "$server_pid" 2>/dev/null || true;fi
  wait "$server_pid" 2>/dev/null || true
  server_pid=
 fi
}
trap stop_server EXIT
trap 'exit 143' TERM INT
run_profile(){
 profile_name=$1
 profile_limit=$2
 node test/stage8-live-linux-preflight.test.js --check profile "$profile_name"
 isolated-sqld -d "/qualification/$profile_name/physical" --http-listen-addr 127.0.0.1:18080 --no-welcome > "/qualification/$profile_name/sqld.log" 2>&1 &
 server_pid=$!
 node --input-type=module -e 'for(let n=0;n<50;n++){try{const r=await fetch("http://127.0.0.1:18080/v2/pipeline",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[{type:"execute",stmt:{sql:"SELECT 1",want_rows:false}},{type:"close"}]}),signal:AbortSignal.timeout(250)});if(r.ok&&(await r.json()).results?.[0]?.type==="ok")process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("FRESH_SQLD_NOT_READY");'
 # Ninety-second per-call supervision is additional containment; the original
 # LIVE45s, worker30s and six-unit boundaries are never enlarged. The external
 # fifteen-minute cutoff also bounds setup/readback and preserves partial data.
 result_code=0
 timeout --signal=TERM --kill-after=5s 900s node --max-old-space-size=96 --max-semi-space-size=2 test/stage8-live-linux-http.mjs "$profile_name" "$profile_limit" > "/qualification/$profile_name/run.tap" 2>&1 || result_code=$?
 printf '%s\n' "$result_code" > "/qualification/$profile_name/exit-code"
 stop_server
}
# Both profiles combined may start at most64 producer calls, including replays.
run_profile empty 16
empty_calls=$(node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync("/qualification/empty/report.json"));if(!Number.isSafeInteger(r.callsStarted)||r.callsStarted<0||r.callsStarted>16)throw Error("ATTEMPT_ACCOUNTING_INVALID");process.stdout.write(String(r.callsStarted));')
dense_limit=$((64-empty_calls))
run_profile dense "$dense_limit"
node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const reports=["empty","dense"].map(p=>JSON.parse(readFileSync(`/qualification/${p}/report.json`)));const calls=reports.reduce((n,r)=>n+r.callsStarted,0);if(calls>64)throw Error("GLOBAL_CALL_LIMIT_EXCEEDED");const summary={productionEvidence:false,totalCalls:calls,maximumCalls:64,profiles:reports.map(r=>({profile:r.profile,status:r.status,calls:r.callsStarted,releaseSha:r.releaseSha,failures:r.failures})),status:reports.every(r=>r.status==="LOCAL_LIVE_HTTP_VERIFIED")?"LOCAL_LIVE_HTTP_VERIFIED":"LOCAL_LIVE_HTTP_PARTIAL"};writeFileSync("/qualification/summary.json",JSON.stringify(summary,null,2)+"\n",{mode:0o600});console.log(JSON.stringify(summary));process.exitCode=summary.status==="LOCAL_LIVE_HTTP_VERIFIED"?0:2;'
