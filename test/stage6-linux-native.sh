#!/bin/sh
# Explicit offline command only. Fresh output and readonly authentic checkout.
set -eu
umask 077
test "$(uname -s)" = Linux
test -f /.dockerenv
test "$(node --version)" = v22.23.2
node test/stage8-live-linux-preflight.test.js --check initial
node --input-type=module -e 'import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{parseOfflineMountInfo}from"./test/stage8-live-linux-preflight.test.js";const root=process.cwd()+"/scripts",mounts=parseOfflineMountInfo(readFileSync("/proc/self/mountinfo","utf8")),own=mounts.filter(m=>m.path===root);assert.equal(own.length,1,"EXACT_READONLY_SCRIPTS_MOUNT_REQUIRED");assert.ok(own[0].options.includes("ro")&&!own[0].options.includes("rw"),"READONLY_SCRIPTS_REQUIRED");assert.ok(!mounts.some(m=>m.path.startsWith(root+"/")&&(!m.options.includes("ro")||m.options.includes("rw"))),"NO_WRITABLE_NESTED_SCRIPTS");'
node --test test/stage6-linux-native-contract.test.mjs > /qualification/contract.tap 2>&1
server_pid=
stop_server(){
 if test -n "$server_pid";then
  kill -TERM "$server_pid" 2>/dev/null || true
  n=30
  while kill -0 "$server_pid" 2>/dev/null && test "$n" -gt 0;do sleep 0.1;n=$((n-1));done
  if kill -0 "$server_pid" 2>/dev/null;then kill -KILL "$server_pid" 2>/dev/null || true;fi
  wait "$server_pid" 2>/dev/null || true
  server_pid=
 fi
}
trap stop_server EXIT
trap 'exit 143' TERM INT
isolated-sqld -d /qualification/physical --http-listen-addr 127.0.0.1:18080 --no-welcome > /qualification/sqld.log 2>&1 &
server_pid=$!
node --input-type=module -e 'for(let n=0;n<30;n++){try{const r=await fetch("http://127.0.0.1:18080/v2/pipeline",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[{type:"execute",stmt:{sql:"SELECT 1",want_rows:false}},{type:"close"}]}),signal:AbortSignal.timeout(250)});if(r.ok&&(await r.json()).results?.[0]?.type==="ok")process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("FRESH_SQLD_NOT_READY");'
# Two distinct OS processes; identical original application identity on replay.
# The host's independent900s cutoff includes setup and both bounded phases.
timeout --signal=TERM --kill-after=3s 760s node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-linux-live-restart.mjs produce > /qualification/produce.tap 2>&1
timeout --signal=TERM --kill-after=3s 120s node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-linux-live-restart.mjs restart > /qualification/restart.tap 2>&1
