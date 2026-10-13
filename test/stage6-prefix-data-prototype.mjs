// Independent reviewer fixtures; prototype is loaded only through explicit test preloader.
import test from 'node:test';import assert from 'node:assert/strict';
const base=new URL('../',import.meta.url).href.replace(/\/$/,'');
const {processingTransactions,processingPrefixReadData,coalescibleControlProcessingCheck}=await import(base+'/src/processingTransaction.js');
const {withDurableExecution,withExecutionReceiptTransaction}=await import(base+'/src/phase4ExecutionContext.js');
const {createReadSnapshotMemo,READ_SNAPSHOT_LIMITS}=await import(base+'/src/processingReadSnapshot.js');
const {readPilotSourceLinkRows}=await import(base+'/src/betaPilotBoundedReads.js');
const context=Object.freeze({userId:'a',executionMode:'SHADOW'});
function fixture(){let value=1,commits=0,rollbacks=0,resolve,delay=false;
 const db={protocol:'file',execute:async()=>({rows:[]}),transaction:async()=>({
  execute:async statement=>{if(statement.sql.startsWith('SELECT')){const result={rows:[{value}]};if(delay)await new Promise(r=>{resolve=r;});return result;}value=statement.args[0];return {rows:[],rowsAffected:1};},
  batch:async()=>[],commit:async()=>{commits++;},rollback:async()=>{rollbacks++;},close(){}})};
 const p=processingTransactions(db,{privateRuntime:true}),execution={claim:{request:{phase:'STAGE6_DRAIN',executionMode:'SHADOW'}},receipts:false,pending:new Set(),authority:{assert(){}}};
 const run=fn=>withDurableExecution(execution,()=>p.withReadSnapshot(context,()=>p.transaction(fn)));
 const read=async()=>({bounds:{candidate_count:1,serialized_bytes:1,invalid_types:0},rows:(await p.client.execute({sql:'SELECT value FROM synthetic WHERE user_id=?',args:['a']})).rows});
 return {p,run,read,setDelay(){delay=true;},get resolve(){return resolve;},get commits(){return commits;},get rollbacks(){return rollbacks;}};
}
test('ordinary LIVE no-pilot path preserves original SQL payload',async()=>{let calls=0;const expected=[{source_type:'USER'}],client={execute:async()=>{calls++;return {rows:expected};}};
 assert.equal(await readPilotSourceLinkRows(client,{userId:'a',executionMode:'LIVE'},'evidence_items','x',false),expected);assert.equal(calls,1);
});
test('prefix complete DATA cache clones rows and reruns fresh fences',async()=>{const f=fixture();let checks=0,reads=0;
 await f.p.withFence(()=>{checks++;},()=>f.run(async()=>{const read=async()=>{reads++;return f.read();};const a=await processingPrefixReadData(f.p.client,context,'k',read);a.rows[0].value=99;
  const before=checks,b=await processingPrefixReadData(f.p.client,context,'k',read);assert.equal(b.rows[0].value,1);assert.equal(checks-before,2);assert.equal(reads,1);
 }));assert.equal(f.commits,1);
});
test('read-only callback mutation rejection poisons original transaction after caught error',async()=>{const f=fixture();
 await assert.rejects(f.run(async()=>{await assert.rejects(processingPrefixReadData(f.p.client,context,'mutation',()=>f.p.client.execute({sql:'UPDATE synthetic SET value=?',args:[2]})),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);}),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(f.commits,0);assert.equal(f.rollbacks,1);
});
test('cached consumer revocation poisons original transaction after caught error',async()=>{const f=fixture();let revoked=false;
 await assert.rejects(f.p.withFence(()=>{if(revoked)throw Error('INDEPENDENT_REVOKED');},()=>f.run(async()=>{
  await processingPrefixReadData(f.p.client,context,'k',f.read);revoked=true;
  await assert.rejects(processingPrefixReadData(f.p.client,context,'k',f.read),/INDEPENDENT_REVOKED/);
 })),/INDEPENDENT_REVOKED/);assert.equal(f.commits,0);
});
test('late complete prefix miss rejects DATA after concurrent business-write epoch',async()=>{const f=fixture();f.setDelay();
 await assert.rejects(f.run(async()=>{
  const pending=processingPrefixReadData(f.p.client,context,'late',f.read);while(!f.resolve)await Promise.resolve();
  await f.p.client.execute({sql:'UPDATE synthetic SET value=?',args:[2]});f.resolve();
  await pending;
 }),/PROCESSING_READ_OBSERVATION_CHANGED/);assert.equal(f.commits,0);
});
test('distinct receipt markers never share complete prefix DATA',async()=>{const f=fixture();let reads=0;
 await f.run(async()=>{const read=async()=>{reads++;return f.read();};await processingPrefixReadData(f.p.client,context,'k',read);
  await withExecutionReceiptTransaction(()=>processingPrefixReadData(f.p.client,context,'k',read));
 });assert.equal(reads,2);
});
test('prefix DATA has the existing row, per-entry, total entry and write-epoch bounds',()=>{const memo=createReadSnapshotMemo(),data={bounds:{candidate_count:1},rows:[{value:'a'}]};
 memo.putData(context,'one',data,memo.epoch());memo.getData(context,'one').rows[0].value='mutated';assert.equal(memo.getData(context,'one').rows[0].value,'a');
 memo.putData(context,'rows',{rows:Array.from({length:129},()=>({value:'a'}))},memo.epoch());assert.equal(memo.getData(context,'rows'),undefined);
 memo.putData(context,'bytes',{rows:[{value:'x'.repeat(READ_SNAPSHOT_LIMITS.resultBytes)}]},memo.epoch());assert.equal(memo.getData(context,'bytes'),undefined);
 const old=memo.epoch();memo.clear();memo.putData(context,'late',data,old);assert.equal(memo.getData(context,'late'),undefined);
 for(let i=0;i<READ_SNAPSHOT_LIMITS.entries+1;i++)memo.putData(context,String(i),data,memo.epoch());assert.equal(memo.getData(context,String(READ_SNAPSHOT_LIMITS.entries)),undefined);
 memo.close();assert.equal(memo.getData(context,'0'),undefined);
});
test('coalescing must preserve repeated control placement across a different after callback',async()=>{const f=fixture();let revoked=false;
 const check=coalescibleControlProcessingCheck(()=>{if(revoked)throw Error('ORIGINAL_EARLIER_CONTROL_REJECTED');});
 await assert.rejects(f.run(async()=>{
  await f.p.transaction(async()=>{}, {after:check});
  await f.p.transaction(async()=>{}, {after:()=>{revoked=true;}});
  await f.p.transaction(async()=>{}, {after:check});
  await f.p.transaction(async()=>{}, {after:()=>{throw Error('OTHER_LATER_FAILURE');}});
 }),/ORIGINAL_EARLIER_CONTROL_REJECTED/);
});
test('coalescing retains every before, separate final checks and a fresh COMMIT fence',async()=>{const f=fixture();let controls=0,finals=0;
 const check=coalescibleControlProcessingCheck(()=>{controls++;}),final=()=>{finals++;};
 await f.run(async()=>{for(let i=0;i<3;i++)await f.p.transaction(async()=>{}, {before:check,after:check,beforeCommit:final,commitFence:check});assert.equal(controls,3);});
 assert.equal(controls,5);assert.equal(finals,3);assert.equal(f.commits,1);
});
test('complete prefix DATA is isolated by opaque grant identity',async()=>{const f=fixture();let reads=0;const a={},b={};
 await f.run(async()=>{const read=async()=>{reads++;return f.read();};
  await processingPrefixReadData(f.p.client,context,'k',read,a);await processingPrefixReadData(f.p.client,context,'k',read,b);
  await processingPrefixReadData(f.p.client,context,'k',read,a);
 });assert.equal(reads,2);
});
