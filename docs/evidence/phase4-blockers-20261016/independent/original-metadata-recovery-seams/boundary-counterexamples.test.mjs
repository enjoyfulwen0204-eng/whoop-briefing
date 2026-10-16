// Read-only control-flow counterexamples. No DB connection or phase authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dispatchSyntheticRequest} from './original/test/stage6SyntheticDispatch.mjs';
import {createBriefingEndpoint} from './integrated/src/briefingEndpoint.js';
import {signTriggerRequest} from './integrated/src/briefingTriggerAuth.js';
const rows=JSON.parse(readFileSync('/private/tmp/phase4-final-independent-review/retained-metadata/journal-and-ledger.json','utf8'));
const retained=rows.map(r=>JSON.parse(r.last_detail)).find(r=>r.kind==='REQUEST');
test('original RESPONSE503 restart returns retained failure without invoking reconciliation or reserving',async()=>{
 const before=JSON.stringify(retained);let reserved=0,sent=0,reconciled=0;
 const out=await dispatchSyntheticRequest({journal:{current:async()=>structuredClone(retained),reserve:async()=>{reserved++;throw Error('UNEXPECTED_RESERVATION');}},userId:retained.userId,request:retained.request,beforeJobs:[],send:async()=>{sent++;throw Error('UNEXPECTED_SEND');},reconcile:async()=>{reconciled++;throw Error('UNEXPECTED_RECONCILE');}});
 assert.equal(out.response.status,503);assert.equal(out.metadataReconciliation,false);assert.equal(out.transport,'DURABLE_RESPONSE_RECONCILIATION');assert.deepEqual([reserved,sent,reconciled],[0,0,0]);assert.equal(JSON.stringify(retained),before);
});
test('fresh authenticated duplicate SYNC HTTP delivery is cached and does not advance a second post-sync hook',async()=>{
 const secret='REVIEW_ONLY_FAKE_TRANSPORT_SECRET_0123456789',at=Date.now();let now=at,calls=0;
 const request={requestId:'review-sync-cache-0000000000001',releaseSha:'d85835ef8618a1d891de2fb9260d1c20caece432',phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)},body=JSON.stringify(request);
 const endpoint=createBriefingEndpoint({secret,now:()=>now,runPhase:async()=>{calls++;return {status:200,body:{ok:true,syncComplete:true,drainAuthorized:false}};}});
 const req=()=>{const timestamp=String(now);return {url:'/internal/briefing/run',method:'POST',headers:{'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':request.requestId,'x-briefing-signature':signTriggerRequest({timestamp,requestId:request.requestId,method:'POST',path:'/internal/briefing/run',body},secret)}};};
 assert.equal((await endpoint(req(),body)).status,200);now+=60000;assert.equal((await endpoint(req(),body)).status,200);assert.equal(calls,1);
 now=at+5*60000;await endpoint(req(),body);assert.equal(calls,1,'cache entry survives exact five-minute boundary');
 now++;await endpoint(req(),body);assert.equal(calls,2,'only after cache expires can original runner/hook be called again');
});
