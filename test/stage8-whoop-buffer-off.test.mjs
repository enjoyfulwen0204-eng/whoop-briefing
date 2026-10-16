import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/briefing-scheduler/worker.js';
import {APPROVED_WHOOP_BUFFER_PIN} from '../cloudflare/briefing-scheduler/whoop-buffer-approval.js';

test('unapproved WHOOP ingress never ACKs, including flag-only attempts and empty probes',async()=>{
 assert.equal(APPROVED_WHOOP_BUFFER_PIN,null);let queued=0;
 for(const path of ['/whoop/encrypted-buffer/v1','/whoop/encrypted-buffer/probe/v1'])for(const method of ['GET','POST']){
  const env={WHOOP_BUFFER_ENABLED:'on',WHOOP_BUFFER_BINDING:'{}',WHOOP_EVENT_BUFFER:{send(){queued++;}}};
  const response=await worker.fetch(new Request('https://example.workers.dev'+path,{method,...(method==='POST'?{body:'{}'}:{})}),env);
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{ok:false});
 }
 assert.equal(queued,0);
});
test('wrong WHOOP paths fail closed while existing scheduler health stays available',async()=>{
 for(const path of ['/whoop/webhook','/whoop/encrypted-buffer/typo']){
  const response=await worker.fetch(new Request('https://example.workers.dev'+path,{method:'POST',body:'{}'}));assert.equal(response.status,404);assert.deepEqual(await response.json(),{ok:false});
 }
 const health=await worker.fetch(new Request('https://example.workers.dev/'));assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,service:'briefing-scheduler'});
});
