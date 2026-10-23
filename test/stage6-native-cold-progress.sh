#!/bin/sh
# SOURCE ONLY. Diagnostic writes never authorize work or settle an unknown owner.
set -eu
umask 077
shell_progress() {
 case "$1:$2" in
  SHELL_ENTERED:01|BOOTSTRAP_REFUSED:02|SQLD_STARTED:03|SQLD_READY:04|SQLD_READINESS_FAILED_WAIT_UNKNOWN:05|A_STARTED:06|A_FAILED_WAIT_UNKNOWN:07|A_RETURNED:08|B_STARTED:09|B_FAILED_WAIT_UNKNOWN:10|B_RETURNED:11|GRACEFUL_OWNER_STOP_REQUESTED:12|SQLD_PROCESS_EXIT_OBSERVED:13|OWNER_EXIT_UNCONFIRMED:14|A_FAILED_TRANSPORT_SETTLED:15|B_FAILED_TRANSPORT_SETTLED:16) ;;
  *) return 0 ;;
 esac
 # Exclusive finite diagnostic only. Failure cannot abandon an unsettled owner.
 (set -C; printf '{"contract":"stage6-native-cold-diagnostic-record-v1","phase":"SHELL","stage":"%s","callIntents":null,"elapsedMs":null,"failureCode":null,"errorMessageSha256":null,"terminalComplete":null,"activeFetches":null,"unresolvedStreams":null,"unknownProtocolReplies":null}\n' "$1" > "/qualification/shell-progress-$2.private.json") 2>/dev/null || :
}
if test "$(uname -s)" = Linux && test -f /.dockerenv && test "$(node --version)" = v22.23.2 && test -f /native-cold-source-activation.json && test -f /native-host-proof.json && test -f /ca01-application-source-manifest.json; then :
else shell_progress BOOTSTRAP_REFUSED 02; exit 2; fi
if node test/stage8-live-linux-preflight.test.js --check initial; then :
else shell_progress BOOTSTRAP_REFUSED 02; exit 2; fi
shell_progress SHELL_ENTERED 01
isolated-sqld -d /qualification/physical --http-listen-addr 127.0.0.1:18080 --no-welcome > /qualification/owned-sqld.private.log 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > /qualification/owned-server-pid.private.txt
shell_progress SQLD_STARTED 03
retain_unknown() {
 shell_progress "$1" "$2"
 printf '%s\n' NATIVE_COLD_UNKNOWN_OWNED_RUNTIME_RETAINED > /qualification/cleanup-unknown.private.txt
 # There is no finite settlement guarantee. Host must publish diagnostics now,
 # retain unresolved ownership and refuse qualification at the original300s.
 wait "$server_pid" || :
 exit 2
}
node --input-type=module -e 'for(let n=0;n<30;n++){try{const r=await fetch("http://127.0.0.1:18080/v2/pipeline",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[{type:"execute",stmt:{sql:"SELECT 1",want_rows:false}},{type:"close"}]}),signal:AbortSignal.timeout(250)});if(r.ok&&(await r.json()).results?.[0]?.type==="ok")process.exit(0);}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("FRESH_SQLD_NOT_READY");' || retain_unknown SQLD_READINESS_FAILED_WAIT_UNKNOWN 05
shell_progress SQLD_READY 04
failed_leg=0
for leg in A B; do
 case "$leg" in
  A) shell_progress A_STARTED 06 ;;
  B) shell_progress B_STARTED 09 ;;
 esac
 if node --max-old-space-size=96 --max-semi-space-size=2 test/stage6-native-cold-entry.proposal.mjs "$leg"; then
  case "$leg" in A) shell_progress A_RETURNED 08 ;; B) shell_progress B_RETURNED 11 ;; esac
 else
  leg_status=$?
  # Only the original child's reserved NONZERO status carries the owned
  # transport proof. Reports/counts/progress/absence are never this authority.
  if test "$leg_status" -eq 3; then
   case "$leg" in A) shell_progress A_FAILED_TRANSPORT_SETTLED 15 ;; B) shell_progress B_FAILED_TRANSPORT_SETTLED 16 ;; esac
   failed_leg=1
   break
  fi
  case "$leg" in A) retain_unknown A_FAILED_WAIT_UNKNOWN 07 ;; B) retain_unknown B_FAILED_WAIT_UNKNOWN 10 ;; esac
 fi
done
# Both normal legs or a positively proved failed-child transport settlement may
# request graceful owner shutdown. An unknown child still retains ownership.
shell_progress GRACEFUL_OWNER_STOP_REQUESTED 12
kill -TERM "$server_pid"
if wait "$server_pid"; then :
else settled_status=$?; if test "$settled_status" -eq 143; then :
 else shell_progress OWNER_EXIT_UNCONFIRMED 14; exit 2; fi
fi
shell_progress SQLD_PROCESS_EXIT_OBSERVED 13
if test "$failed_leg" -eq 1; then exit 2; fi
