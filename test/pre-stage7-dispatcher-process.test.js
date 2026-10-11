import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';
// The previous OFF/unfinished-SYNC kill/restart trial belongs to historical
// general-continuation evidence. The owner-approved scope rejects it now.
test('fresh OS Worker process cannot start OFF-mode continuation or emit an HTTP request',async t=>{
 const env={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-worker-restart-only-secret-32bytes',
  BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'stage6-shadow'};
 const child=fork(new URL('./continuationWorkerChild.js',import.meta.url),[JSON.stringify(env)],{execArgv:[],silent:true});let requests=0,failed;
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 child.on('message',message=>{if(message.type==='request')requests++;if(message.type==='failed')failed=message.category;});
 const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,1);assert.equal(failed,'configuration');assert.equal(requests,0);
});
