import test from 'node:test';import assert from 'node:assert/strict';import {finiteBetaCapacity} from '../src/finiteBetaCapacity.js';
const measured={capacityBytes:1000,usedBytes:100,dailyBaseGrowthBytes:10,dailyShadowGrowthBytes:20,largestTransactionBytes:50,incidentResponseDays:2,approvedBetaDays:20,providerEvidence:'isolated-supplied-fixture',growthEvidence:'isolated-supplied-fixture'};
test('F06 unknown/malformed quota never proves finite or permanent capacity',()=>{
 for(const value of [{},{...measured,providerEvidence:null},{...measured,growthEvidence:null},{...measured,capacityBytes:0},{...measured,usedBytes:NaN},{...measured,dailyBaseGrowthBytes:-1}])assert.equal(finiteBetaCapacity(value).disposition,'F06_CAPACITY_ARCHITECTURE_APPROVAL_REQUIRED');
});
test('F06 measured input arithmetic reserves Morning Brief and a committed transaction before Beta growth',()=>{
 const plan=finiteBetaCapacity(measured);assert.equal(plan.reserveBytes,70);assert.equal(plan.stopShadowAtBytes,930);assert.equal(plan.maximumDays,27);assert.equal(plan.fitsSuppliedEnvelope,true);
 assert.equal(plan.permanentRetention,'NOT_PROVEN');assert.equal(plan.archival,'ARCHITECTURE_APPROVAL_REQUIRED');
 assert.equal(finiteBetaCapacity({...measured,approvedBetaDays:28}).fitsSuppliedEnvelope,false);
 assert.equal(finiteBetaCapacity({...measured,usedBytes:950}).fitsSuppliedEnvelope,false);
});
