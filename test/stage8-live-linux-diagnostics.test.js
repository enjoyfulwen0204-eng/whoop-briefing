import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLinuxHttpDiagnostics,linuxSqlLabel,linuxRuntimeStage,linuxDurableCounts} from './stage8LiveLinuxDiagnostics.js';
test('SQL diagnostics retain only normalized template/category/enums; values, comments and stack text are discarded',()=>{
 const a=linuxSqlLabel("SELECT * FROM users WHERE id='PRIVATE_USER' AND score=72 -- PRIVATE_HEALTH\n"),b=linuxSqlLabel("SELECT * FROM users WHERE id='other' AND score=11");
 assert.deepEqual(a,b);assert.deepEqual(Object.keys(a).sort(),['category','template','verb']);assert.match(a.template,/^[a-f0-9]{64}$/);
 assert.equal(linuxSqlLabel('SELECT u.status FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id').category,'PRINCIPAL_READY_METADATA');
 const stack='Error: PRIVATE_VALUE\n at async Object.drain (/private/path/src/phase4Reanalysis.js:100:2)';assert.equal(linuxRuntimeStage(stack),'WORKER_DRAIN');assert.equal(linuxRuntimeStage('PRIVATE_VALUE'),'UNCLASSIFIED');
});
test('phase attribution is captured before request completion, bounded groups count overflow, envelope timing stays explicit',()=>{
 let now=0;const d=createLinuxHttpDiagnostics({nowMs:()=>now,maximumGroups:1}),label=linuxSqlLabel('SELECT 1');
 const first=d.start([label,label],'WORKER_DRAIN');now=100;d.switchPhase('PRODUCER_LEG');now=120;d.end(first,{failed:true});
 const second=d.start([label,label]);now=130;d.end(second);
 const third=d.start([linuxSqlLabel('UPDATE phase4_jobs SET state=?')]);now=140;d.end(third);
 const r=d.snapshot();assert.equal(r.phases[0].phase,'SETUP');assert.equal(r.phases[0].requests,1);assert.equal(r.phases[0].elapsedMs,100);assert.equal(r.phases[0].requestErrors,1);assert.equal(r.phases[1].elapsedMs,40);
 assert.equal(r.sqlGroups.length,1);assert.equal(r.sqlGroups[0].statements,2);assert.equal(r.sqlGroups[0].envelopes,1);assert.equal(r.sqlGroups[0].maximumEnvelopeMs,10);assert.equal(r.overflowStatements,1);assert.equal(r.openRequests,0);
 assert.ok(!JSON.stringify(r).includes('SELECT 1'));assert.match(r.timing,/overlap/);assert.throws(()=>d.switchPhase('PRIVATE_PHASE'),/PHASE_INVALID/);
});
test('durable progress keeps actual committed receipt/state counts after timeout without identities, cursors or health',()=>{
 const source={jobs:[{state:'RUNNING',requested_generation:2,completed_generation:0,scope_kind:'FULL_TENANT_RECOMPUTE',cursorSha256:'PRIVATE_CURSOR',user_id:'PRIVATE_USER'}],computation:[{input_generation:2,last_completed_generation:0}],completionProofs:0,publications:0,workReceipts:4,operationReceipts:1,executions:[{state:'ESTABLISHED',n:1}]};
 const r=linuxDurableCounts(source);assert.equal(r.fullScopes,1);assert.equal(linuxDurableCounts({...source,jobs:[{scope_kind:'FULL'},{scope_kind:'NONE'},{scope_kind:'FULL_TENANT_RECOMPUTE'}]}).fullScopes,1);assert.equal(r.workReceipts,4);assert.equal(r.ESTABLISHED,1);assert.equal(r.runningJobs,1);assert.equal(r.completedJobs,0);assert.equal(linuxDurableCounts(null),null);assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
});
test('one-empty-one-call mode cannot execute dense/replay or qualify; original budgets/campaign branch remain unchanged',()=>{
 const script=readFileSync(new URL('./stage8-live-linux-http.mjs',import.meta.url),'utf8'),shell=readFileSync(new URL('./stage8-live-linux-http.sh',import.meta.url),'utf8');
 assert.match(script,/if\(diagnostic\)\{assert.equal\(profile,'empty'\);assert.equal\(maxLegs,1\)/);
 assert.match(script,/const users=diagnostic\?OFFLINE_LIVE_USERS.slice\(0,1\):OFFLINE_LIVE_USERS/);
 assert.match(script,/const complete=!diagnostic&&users.every/);assert.match(script,/status==='CURRENT'&&!diagnostic/);
 assert.match(script,/LATENCY_MS=115,LEG_SUPERVISION_MS=90000/);assert.match(script,/liveExecutionDeadlineMs:45000,workerWallMs:45000,workerSafetyMarginMs:15000,workerEffectiveMs:30000,maxItemsPerTenant:6/);
 assert.match(script,/leg.failedPhase=phase/);assert.match(script,/leg.afterCounts=linuxDurableCounts\(leg.persisted\)/);
 assert.match(shell,/run_profile empty 1[\s\S]*?exit 2[\s\S]*?run_profile empty 16/);assert.match(shell,/dense_limit=\$\(\(64-empty_calls\)\)/);
});

test('more than128 setup templates cannot crowd out producer-leg readiness SQL; all phase counters remain complete',()=>{
 let now=0;const d=createLinuxHttpDiagnostics({nowMs:()=>now}),templates=new Set();
 for(const phase of ['MIGRATION','SEED']){
  d.switchPhase(phase);for(let n=0;n<129;n++){const label=linuxSqlLabel('SELECT setup_column_'+phase+'_'+n);templates.add(label.template);const token=d.start([label]);now++;d.end(token);}
 }
 assert.equal(templates.size,258);assert.equal(d.snapshot().sqlGroups.length,0);assert.equal(d.snapshot().overflowStatements,0);
 d.switchPhase('PRODUCER_LEG');const ready=linuxSqlLabel('SELECT u.status FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id');
 for(let n=0;n<3;n++){const token=d.start([ready],'WORKER_DRAIN');now+=115;d.end(token);}
 const result=d.snapshot();assert.equal(result.sqlDetailPhase,'PRODUCER_LEG');assert.equal(result.sqlGroups.length,1);assert.equal(result.sqlGroups[0].category,'PRINCIPAL_READY_METADATA');assert.equal(result.sqlGroups[0].phase,'PRODUCER_LEG');assert.equal(result.sqlGroups[0].statements,3);assert.equal(result.sqlGroups[0].envelopeUpperBoundMsSum,345);assert.equal(result.overflowStatements,0);
 assert.equal(result.phases.find(row=>row.phase==='MIGRATION').requests,129);assert.equal(result.phases.find(row=>row.phase==='SEED').requests,129);assert.equal(result.phases.find(row=>row.phase==='PRODUCER_LEG').requests,3);
});

test('comment markers inside quoted literals never affect template identity; comments outside literals are ignored',()=>{
 const baseline=linuxSqlLabel("SELECT * FROM users WHERE id='plain' AND score=1");
 for(const value of ["'SYNTHETIC_ALPHA--suffix'","'SYNTHETIC_BETA--suffix'","'value/*inside*/--still-data'","'escaped''--suffix'",'"double--quoted"'])assert.deepEqual(linuxSqlLabel('SELECT * FROM users WHERE id='+value+' AND score=42'),baseline);
 assert.deepEqual(linuxSqlLabel("SELECT * /* comment with 'quote-- */ FROM users WHERE id='one' AND score=12 -- another 'quote\n"),baseline);
});
