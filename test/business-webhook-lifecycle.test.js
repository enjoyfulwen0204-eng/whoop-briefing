import test from 'node:test';
import assert from 'node:assert/strict';
import {createBusinessWebhookLifecycle} from '../src/businessWebhookLifecycle.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const windowId='synthetic_window_0001';
const signal=()=>new AbortController().signal;

test('one accepted HTTP lifetime; admission closes before parsing; disposal joins response and closes once',async()=>{
 const pending=deferred();let close=0,handled=0,rejected=0,answered=false;
 const scope=createBusinessWebhookLifecycle({closeDatabase:()=>{close++;}});
 const handler=scope.trackedHandler(async()=>{handled++;await pending.promise;answered=true;},()=>{rejected++;});
 const request=handler({},{});assert.equal(scope.status().requests,1);await turn();
 scope.closeAdmission(windowId);await handler({},{});assert.equal(handled,1);assert.equal(rejected,1);
 const disposing=scope.dispose({signal:signal()});await turn();assert.equal(close,0);assert.equal(answered,false);
 pending.resolve();await request;await disposing;await scope.dispose({signal:signal()});
 assert.equal(close,1);assert.equal(scope.status().disposed,true);assert.equal(scope.status().provesRemoteSqlCancellation,false);
});

test('detached bootstrap remains tracked after HTTP completes and may spawn descendants during closing',async()=>{
 const pending=deferred(),spawned=deferred();let close=0,child;
 const scope=createBusinessWebhookLifecycle({closeDatabase:()=>{close++;}});
 const handler=scope.trackedHandler(async()=>{child=scope.fork(async()=>{await pending.promise;await scope.fork(()=>spawned.promise);});},()=>{});
 await handler({},{});assert.equal(scope.status().requests,0);assert.equal(scope.status().background,1);
 scope.closeAdmission(windowId);const disposing=scope.dispose({signal:signal()});pending.resolve();await turn();
 assert.equal(scope.status().background,2);assert.equal(close,0);spawned.resolve();await child;await disposing;assert.equal(close,1);
 assert.throws(()=>scope.fork(()=>{}),{code:'TRANSITION_ACTIVE_PARENT_REQUIRED'});
});

test('deadline bounds local background join; does not cancel pending work or close DB; retry can finish disposal',async()=>{
 const pending=deferred();let close=0,stop=0;
 const scope=createBusinessWebhookLifecycle({closeDatabase:()=>{close++;},stopBackground:()=>{stop++;return pending.promise;}});
 scope.closeAdmission(windowId);const controller=new AbortController(),reason=Error('LOCAL_DEADLINE');
 const disposing=scope.dispose({signal:controller.signal});controller.abort(reason);await assert.rejects(disposing,error=>error===reason);
 assert.equal(close,0);assert.equal(scope.status().backgroundStopped,false);assert.equal(scope.status().provesRemoteSqlCancellation,false);
 pending.resolve();await scope.dispose({signal:signal()});assert.equal(close,1);assert.equal(stop,1);
});

test('a task rejection and failed close retain closed admission; cleanup can be retried without reopening',async()=>{
 let closes=0;const scope=createBusinessWebhookLifecycle({closeDatabase:()=>{if(++closes===1)throw Error('CLOSE_FAILED');}});
 const handler=scope.trackedHandler(()=>{throw Error('HTTP_FAILED');},()=>{});await assert.rejects(handler({},{}),/HTTP_FAILED/);
 assert.equal(scope.status().activeTasks,0);scope.closeAdmission(windowId);
 await assert.rejects(scope.dispose({signal:signal()}),/CLOSE_FAILED/);assert.equal(scope.status().databaseClosed,false);
 await scope.dispose({signal:signal()});assert.equal(scope.status().disposed,true);assert.equal(closes,2);
});

test('drain and dispose require prior close plus explicit signal; a failed loop join prevents DB close',async()=>{
 let closed=0;const scope=createBusinessWebhookLifecycle({closeDatabase:()=>closed++,stopBackground:()=>{throw Error('LOOP_STOP_FAILED');}});
 await assert.rejects(scope.waitForDrained({signal:signal()}),{code:'TRANSITION_CLOSED_ADMISSION_AND_SIGNAL_REQUIRED'});
 scope.closeAdmission(windowId);await assert.rejects(scope.waitForDrained(),{code:'TRANSITION_CLOSED_ADMISSION_AND_SIGNAL_REQUIRED'});
 await assert.rejects(scope.dispose({signal:signal()}),/LOOP_STOP_FAILED/);assert.equal(closed,0);
 assert.throws(()=>scope.closeAdmission('synthetic_window_0002'),{code:'TRANSITION_ORIGINAL_WINDOW_CHANGED'});
});
