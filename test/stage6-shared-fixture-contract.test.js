import test from 'node:test';import assert from 'node:assert/strict';
import {runForUser} from '../src/index.js';import {summarizeSync,syncAuthorizesDrain,aggregateSyncOutcome} from '../src/syncResult.js';

test('an ACTIVE READY fixture tenant without Telegram cannot authorize whole-service SYNC completion',async()=>{
 let providerCalls=0;
 const value=await runForUser({db:{getActiveChatIdForUser:async()=>null},env:{dryRun:true},user:{id:'synthetic-unlinked',lifecycleGeneration:1,timezone:'Asia/Taipei'},now:new Date('2026-10-11T00:00:00Z'),deps:{reap:async()=>0,makeWhoop:()=>{providerCalls++;throw Error('PROVIDER_MUST_NOT_RUN');}}});
 assert.equal(value.skipped,'no_active_telegram_link');assert.equal(value.sync,null);assert.equal(providerCalls,0);
 const sync=summarizeSync(value.sync);assert.equal(syncAuthorizesDrain(sync),false);
 assert.equal(aggregateSyncOutcome([{outcome:'NO_NEW_DATA_SUCCESS',complete:true},sync],{failed:1}),'PARTIAL');
});
