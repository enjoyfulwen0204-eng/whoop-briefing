#!/bin/sh
# Local network-none container only. All user-facing/database sockets loopback.
set -eu
case "${1:-}" in
 admission) target=test/stage6-synthetic-admission-http.mjs ;;
 focused) target=test/stage6-synthetic-runner.mjs; export STAGE6_SYNTHETIC_FOCUSED=1 ;;
 full) target=test/stage6-synthetic-runner.mjs ;;
 *) exit 64 ;;
esac
isolated-sqld -d /qualification/physical --http-listen-addr 127.0.0.1:18080 --no-welcome > /qualification/sqld.log 2>&1 &
sql_pid=$!
node test/stage6SyntheticProxy.mjs > /qualification/proxy.log 2>&1 &
proxy_pid=$!
cleanup(){ kill -TERM "$proxy_pid" "$sql_pid" 2>/dev/null || true; wait "$proxy_pid" "$sql_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
node --input-type=module -e 'for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:18081/counts")).ok)break;}catch{}if(i===99)throw Error("LOCAL_FIXTURE_NOT_READY");await new Promise(r=>setTimeout(r,100));}'
node --import ./test/stage6SyntheticProfile.mjs "$target"
