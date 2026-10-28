import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedNativeFailure,preparedNativeErrorSummary} from './stage8-prepared-native-outcome.mjs';
for(const [label,hasPrimary,hasCleanup]of [['none',false,false],['primary only',true,false],['cleanup only',false,true],['both',true,true]])test('native prepared outcome retains '+label,()=>{
 const primary=hasPrimary?Object.assign(Error('ORIGINAL_READER_FAILURE'),{code:'READER_FAILED'}):undefined,cleanup=hasCleanup?Object.assign(Error('ORIGINAL_CLOSE_FAILURE'),{code:'CLOSE_FAILED'}):undefined,
  failure=preparedNativeFailure(primary,cleanup),packet={primaryError:preparedNativeErrorSummary(primary),cleanupError:preparedNativeErrorSummary(cleanup),failure:preparedNativeErrorSummary(failure)};
 assert.equal(!failure,!hasPrimary&&!hasCleanup,'ONLY_A_COMPLETELY_JOINED_SUCCESS_CAN_WRITE_ACK');
 assert.equal(packet.primaryError?.code,hasPrimary?'READER_FAILED':undefined);assert.equal(packet.cleanupError?.code,hasCleanup?'CLOSE_FAILED':undefined);
 if(primary&&cleanup){assert.ok(failure instanceof AggregateError);assert.equal(failure.cause,primary);assert.deepEqual(failure.errors,[primary,cleanup]);assert.deepEqual(packet.failure.errors.map(e=>e.code),['READER_FAILED','CLOSE_FAILED']);assert.equal(packet.failure.cause.code,'READER_FAILED');}
 else assert.equal(failure,primary??cleanup);
});
