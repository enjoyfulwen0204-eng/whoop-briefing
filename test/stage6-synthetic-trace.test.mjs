import test from 'node:test';import assert from 'node:assert/strict';import {createTraceHistory,sqlLabel} from './stage6SyntheticTrace.mjs';
test('long proxy history bounds labels and preserves every transaction timing including old failures',()=>{
 const h=createTraceHistory({maxStatements:40,maxTransactions:10,maxDurations:1001});
 for(let n=1;n<=1000;n++)h.add({id:String(n),startedAt:0,finishedAt:n,durationMs:n,outcome:n===1?'ROLLED_BACK':'COMMITTED',statements:Array.from({length:7},()=>sqlLabel('SELECT 1'))});
 const s=h.snapshot();assert.equal(s.totalTransactions,1000);assert.equal(s.traceHistoryComplete,false);assert.ok(s.retainedStatementCount<=40);assert.ok(s.transactions.length<=10);assert.equal(s.transactions.at(-1).sequence,1000);assert.deepEqual(s.transactionStatistics.ROLLED_BACK,{count:1,p50Ms:1,p95Ms:1,maxMs:1});assert.equal(s.transactionStatistics.COMMITTED.count,999);assert.equal(s.transactionStatistics.COMMITTED.maxMs,1000);assert.equal(s.transactionStatistics.COMMITTED.p95Ms,951);
});
test('one oversized trace declares missing detail rather than manufacturing a complete history',()=>{
 const h=createTraceHistory({maxStatements:3,maxTransactions:2,maxDurations:2});h.add({startedAt:0,finishedAt:7,outcome:'COMMITTED',statements:Array.from({length:8},()=>sqlLabel('SELECT 1'))});const s=h.snapshot();assert.equal(s.traceHistoryComplete,false);assert.equal(s.transactions[0].statementCount,8);assert.equal(s.transactions[0].statements.length,3);assert.equal(s.transactions[0].statementsTruncated,true);h.add({startedAt:0,finishedAt:9,outcome:'COMMITTED',statements:[]});assert.throws(()=>h.add({}),/DURATION_BOUND/);
});
test('stored SQL labels match repeated inline observation without retaining SQL text or values',()=>{
 const sql="SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'SYNC_IMMUTABLE_AUTHORITY_CHANGED' END)",stored=sqlLabel(sql);assert.equal(stored.operation,'SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION');assert.deepEqual(stored,sqlLabel(sql));assert.equal(stored.sql,undefined);assert.equal(stored.args,undefined);
});
