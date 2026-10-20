#!/bin/sh
# UNACTIVATED PROPOSAL. Future separately reviewed controller supplies immutable
# source/host/Root activation files and one owned 512MiB/.5CPU offline container.
set -eu
umask 077
test "$(uname -s)" = Linux
test -f /.dockerenv
test "$(node --version)" = v22.23.2
test -f /native-cold-source-activation.json
test -f /native-host-proof.json
test -f /ca01-application-source-manifest.json
node test/stage8-live-linux-preflight.test.js --check initial
# Start ONE persistent SQLite owner/server. Do not restart/reset it between legs.
isolated-sqld -d /qualification/physical --http-listen-addr 127.0.0.1:18080 --no-welcome > /qualification/owned-sqld.private.log 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > /qualification/owned-server-pid.private.txt
# Failure is not permission to terminate a possibly unsettled SQLite owner.
retain_unknown() {
 printf '%s\n' NATIVE_COLD_UNKNOWN_OWNED_RUNTIME_RETAINED > /qualification/cleanup-unknown.private.txt
 wait "$server_pid" || :
 exit 2
}
node --input-type=module -e 'for(let n=0;n<30;n++){try{const r=await fetch("http://127.0.0.1:18080/v2/pipeline",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[{type:"execute",stmt:{sql:"SELECT 1",want_rows:false}},{type:"close"}]}),signal:AbortSignal.timeout(250)});if(r.ok&&(await r.json()).results?.[0]?.type==="ok")process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("FRESH_SQLD_NOT_READY");' || retain_unknown
# Direct sequential OS children. No convergence loop, per-leg deadline reset,
# same-request replay, injected clock, timeout/force-kill or automatic retries.
node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-native-cold-progress.mjs A || retain_unknown
node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-native-cold-progress.mjs B || retain_unknown
# Graceful owned server settlement only; failure/unknown is retained by controller.
kill -TERM "$server_pid"
if wait "$server_pid"; then
 :
else
 settled_status=$?
 # POSIX wait commonly reports 128+SIGTERM for the deliberately stopped owner.
 test "$settled_status" -eq 143
fi
