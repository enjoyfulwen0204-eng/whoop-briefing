import test from 'node:test';
import assert from 'node:assert/strict';
import {rethrowNativeSetupFailure} from './stage6ShadowNativeFixture.mjs';
test('native setup failure survives successful owned-resource cleanup unchanged',async()=>{
 const original=Error('synthetic typed clone rejection');let cleaned=false;
 await assert.rejects(rethrowNativeSetupFailure(original,async()=>{cleaned=true;}),error=>error===original);assert.equal(cleaned,true);
});
test('native setup and cleanup failures retain both errors and the original cause',async()=>{
 const original=Error('synthetic source mismatch'),cleanup=Error('synthetic server termination failure');
 await assert.rejects(rethrowNativeSetupFailure(original,async()=>{throw cleanup;}),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.cause,original);assert.deepEqual(error.errors,[original,cleanup]);return true;
 });
});
