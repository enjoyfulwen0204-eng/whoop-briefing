import test from 'node:test';import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';
import {createPreparationScheduling} from '../src/stage6PreparationScheduling.js';
test('fairness point preserves tenant context and rechecks authority after event-loop handoff',async()=>{
 const context=new AsyncLocalStorage();let checks=0;
 const scheduler=createPreparationScheduling(()=>{assert.equal(context.getStore(),'tenant-a');checks++;});
 await context.run('tenant-a',async()=>{await new Promise(r=>setTimeout(r,10));const pause=scheduler.checkpoint();assert.ok(pause);await pause;assert.equal(context.getStore(),'tenant-a');});
 assert.equal(checks,2);assert.equal(scheduler.statistics().yields,1);context.disable();
});
test('revoked authority during a queued fairness point cannot resume preparation',async()=>{
 let revoked=false;const scheduler=createPreparationScheduling(()=>{if(revoked)throw Error('AUTHORITY_REVOKED');});
 await new Promise(r=>setTimeout(r,10));const pause=scheduler.checkpoint();revoked=true;await assert.rejects(pause,/AUTHORITY_REVOKED/);assert.equal(scheduler.statistics().yields,0);
});
