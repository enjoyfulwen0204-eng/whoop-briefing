import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCrashTransport,assertCrashSnapshotPreserved,coldRejectionCode} from './stage8-prepared-native-crash-gates.mjs';
const execution={created_at:1000,deadline_at:46000,lease_until:61000};
test('expired gate requires real original deadline and never requires changing lease',()=>{
 assert.equal(coldRejectionCode(execution,'COLD_REPLAY',45999),'STAGE8_LIVE_REQUEST_PENDING');
 assert.equal(coldRejectionCode(execution,'COLD_EXPIRED',46000),'STAGE8_LIVE_REQUEST_EXPIRED');
 assert.throws(()=>coldRejectionCode(execution,'COLD_EXPIRED',45999));
 assert.throws(()=>coldRejectionCode(execution,'COLD_REPLAY',46000));
 assert.throws(()=>coldRejectionCode({...execution,deadline_at:47000},'COLD_EXPIRED',47000));
});
test('every original durable field and named witness must survive cold replay',()=>{
 const original={graphDigest:'graph',execution,receiptsDigest:'receipt',receiptCount:17,holds:[{owner:'original'}],witness:{key:'named'},operationReceiptCount:2};
 assertCrashSnapshotPreserved(original,structuredClone(original));
 for(const key of Object.keys(original))assert.throws(()=>assertCrashSnapshotPreserved(original,{...original,[key]:null}));
});
test('cold gate accepts only acknowledged expected rejection and latches late failures',()=>{
 const tx=[{outcome:'COMMIT',upperBoundMs:10},{outcome:'ROLLBACK',upperBoundMs:10}],observer={streams:new Map(),assertComplete:()=>tx};
 const state={pending:0,requestErrors:0,responseErrors:0,cold:true,joined:true};
 assertCrashTransport(observer,state);
 for(const key of ['pending','requestErrors','responseErrors'])assert.throws(()=>assertCrashTransport(observer,{...state,[key]:1}));
 tx[1].upperBoundMs=5000;assert.throws(()=>assertCrashTransport(observer,state));tx[1].upperBoundMs=10;
 tx[1].outcome='COMMIT';assert.throws(()=>assertCrashTransport(observer,state));
});
