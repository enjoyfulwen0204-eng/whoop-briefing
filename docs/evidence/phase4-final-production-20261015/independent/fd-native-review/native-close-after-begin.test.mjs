import test from 'node:test';import assert from 'node:assert/strict';
import {createStage6OwnedMemoryDb} from './checkout/src/db.js';import {fixtureKeys} from './checkout/test/localDb.js';import{receiverScopeStatistics}from'./checkout/src/receiverScopeLifetime.js';
test('native receiver close during acknowledged BEGIN fairness rejects before business callback and retires owned scopes',async()=>{
 const before=receiverScopeStatistics(),db=await createStage6OwnedMemoryDb(c=>c.execute('CREATE TABLE independent_close(n INTEGER)'),fixtureKeys);
 const start=performance.now();while(performance.now()-start<12){}let entered=false;
 const timer=setImmediate(()=>db.close());let observed;
 try{await db.transaction(async()=>{entered=true;await db.raw.execute('INSERT INTO independent_close VALUES(1)');});assert.fail('closed native root must not enter business');}catch(e){observed={code:e.code,message:e.message};assert.equal(entered,false);assert.match(e.message,/RECEIVER_OWNER_CLOSED|CLIENT_CLOSED|closed/i);}finally{clearImmediate(timer);db.close();}
 const after=receiverScopeStatistics();assert.equal(after.activeCallbacks,0);assert.equal(after.liveReceivers,before.liveReceivers);assert.equal(after.retired,before.retired+1);console.log('NATIVE_CLOSE_BOUNDARY',JSON.stringify(observed));
});
