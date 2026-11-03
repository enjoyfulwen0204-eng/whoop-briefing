import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for(const collect of [false,true])test(`N: isolated native driver probe, collection=${collect}`,()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/stage5NativeProbe.mjs',...(collect?['--collect']:[])],
    {encoding:'utf8',timeout:60000,killSignal:'SIGKILL'});
  console.log(JSON.stringify({nativeProbe:true,collect,status:result.status,signal:result.signal,error:result.error?.code,
    stdout:result.stdout,stderr:result.stderr}));
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);
  assert.match(result.stdout,/"rows":500/);assert.match(result.stdout,/NATIVE_PROBE_BEFORE_EXIT/);
});
