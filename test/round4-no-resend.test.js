import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryFixture} from './round4Fixture.js';
import {deliverReport} from '../src/reportDelivery.js';
const at=new Date('2026-10-29T00:00:00Z');
async function setup(t){const f=await recoveryFixture(t);await f.db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'UTC',status:'ACTIVE'},{now:at});return f;}
async function flip(db){
 await db.transitionUserLifecycle({userId:'synthetic',targetStatus:'PAUSED',now:at});
 await db.transitionUserLifecycle({userId:'synthetic',targetStatus:'ACTIVE',now:at});
 return (await db.getUser('synthetic')).lifecycleGeneration;
}
for(const state of ['DELIVERY_STARTED','AMBIGUOUS','DELIVERED'])test('cross-lifecycle '+state+' preserves original claim and never resends',async t=>{
 const {db}=await setup(t),key={userId:'synthetic',reportType:'daily',localDateKey:'2026-10-29'};
 const claim=await db.claimReport({...key,ttlMs:1000,expectedLifecycleGeneration:1,now:at});
 assert.equal(claim.granted,true);assert.equal(await db.authorizeReportDelivery({...key,owner:claim.owner,expectedLifecycleGeneration:1,now:at}),true);
 if(state==='AMBIGUOUS')await db.markClaimAmbiguous({...key,owner:claim.owner,now:at});
 if(state==='DELIVERED')await db.markClaimSent({...key,owner:claim.owner,messageId:123,now:at});
 const before=(await db.raw.execute('SELECT * FROM report_claims')).rows;
 const life=await flip(db),again=await db.claimReport({...key,ttlMs:1000,expectedLifecycleGeneration:life,now:new Date(at.getTime()+5000)});
 assert.equal(again.granted,false);assert.deepEqual((await db.raw.execute('SELECT * FROM report_claims')).rows,before);
 let sends=0;const result=await deliverReport({db,claimKey:key,claim,telegram:{send(){sends++;}},text:'SYNTHETIC',now:()=>new Date(at.getTime()+5000)});
 assert.equal(result.authorized,false);assert.equal(sends,0);
});
test('lost ACK is terminal across lifecycle; pre-send CLAIMED takeover remains fenced and safe',async t=>{
 const {db}=await setup(t),key={userId:'synthetic',reportType:'weekly',localDateKey:'2026-W44'};
 const claim=await db.claimReport({...key,ttlMs:60000,expectedLifecycleGeneration:1,now:at});let accepted=0;
 const result=await deliverReport({db,claimKey:key,claim,text:'SYNTHETIC',now:()=>at,telegram:{send(){accepted++;throw Error('SYNTHETIC_LOST_ACK');}}});
 assert.equal(result.result,'ambiguous');const original=(await db.raw.execute('SELECT * FROM report_claims')).rows;
 const life=await flip(db);
 assert.equal((await db.claimReport({...key,ttlMs:60000,expectedLifecycleGeneration:life,now:at})).granted,false);
 assert.equal(accepted,1);assert.deepEqual((await db.raw.execute('SELECT * FROM report_claims')).rows,original);
 const fresh={...key,localDateKey:'2026-W45'};
 const first=await db.claimReport({...fresh,ttlMs:60000,expectedLifecycleGeneration:life,now:at});
 const nextLife=await flip(db),next=await db.claimReport({...fresh,ttlMs:60000,expectedLifecycleGeneration:nextLife,now:at});
 assert.equal(next.granted,true);
 assert.equal(await db.authorizeReportDelivery({...fresh,owner:first.owner,expectedLifecycleGeneration:life,now:at}),false);
 assert.equal(await db.authorizeReportDelivery({...fresh,owner:next.owner,expectedLifecycleGeneration:nextLife,now:at}),true);
});
