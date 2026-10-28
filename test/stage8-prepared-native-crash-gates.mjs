import assert from 'node:assert/strict';

// Negative cold probes legitimately ROLLBACK their rejected admission. Accept
// exactly that observed shape, never a missing or unknown terminal.
export function assertCrashTransport(observer,{pending,requestErrors,responseErrors,cold=false,joined=false}){
 assert.equal(pending,joined?0:1,'EXACT_OWNED_REQUEST_LIFETIME');
 assert.equal(requestErrors,0,'NO_RECOVERED_REQUEST_FAILURE');
 assert.equal(responseErrors,0,'NO_SQL_RESPONSE_FAILURE');
 if(joined)assert.equal(observer.streams.size,0,'ALL_STREAMS_PHYSICALLY_JOINED');
 const tx=observer.assertComplete('WORK');
 assert.ok(tx.every(t=>t.upperBoundMs<5000),'EVERY_WORK_TRANSACTION_BELOW_5S');
 if(cold)assert.deepEqual(tx.map(t=>t.outcome),['COMMIT','ROLLBACK'],'EXACT_COLD_REJECTION_ROOTS');
 else assert.ok(tx.every(t=>t.outcome==='COMMIT'),'PUBLICATION_ACK_REQUIRED');
 return tx;
}

export function assertCrashSnapshotPreserved(original,current){
 for(const key of ['graphDigest','execution','receiptsDigest','receiptCount','holds','witness','operationReceiptCount'])
  assert.deepEqual(current[key],original[key],'ORIGINAL_'+key+'_PRESERVED');
}

export function coldRejectionCode(execution,mode,observedAt){
 assert.ok(Number.isSafeInteger(observedAt));
 assert.equal(execution.deadline_at-execution.created_at,45000);
 assert.equal(execution.lease_until-execution.created_at,60000);
 if(mode==='COLD_REPLAY'){
  assert.ok(observedAt<Math.min(execution.deadline_at,execution.lease_until),'ORIGINAL_PENDING_WINDOW_REQUIRED');
  return 'STAGE8_LIVE_REQUEST_PENDING';
 }
 assert.equal(mode,'COLD_EXPIRED');
 assert.ok(observedAt>=execution.deadline_at,'REAL_ORIGINAL_DEADLINE_MUST_HAVE_PASSED');
 return 'STAGE8_LIVE_REQUEST_EXPIRED';
}
