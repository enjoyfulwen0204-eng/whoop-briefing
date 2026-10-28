import test from 'node:test';
import assert from 'node:assert/strict';
import {processingTransactions} from '../src/processingTransaction.js';
import {createStage6OwnedMemoryDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createClient as httpClient} from '@libsql/client';
import {createClient as sqliteClient} from '@libsql/client/sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hranaTransport} from './hranaTransport.js';

function connection({commit,rollback,close,protocol='http'}={}){
 const calls={begins:0,commits:0,rollbacks:0,closes:0},transactions=[];
 const base={protocol,execute:async()=>({rows:[]}),transaction:async()=>{
  calls.begins++;const tx={closed:false,execute:async()=>({rows:[]}),
   commit:async()=>{calls.commits++;if(commit)return commit(tx,calls);tx.closed=true;},
   rollback:async()=>{calls.rollbacks++;if(rollback)return rollback(tx,calls);tx.closed=true;},
   close:()=>{calls.closes++;if(close)return close(tx,calls);tx.closed=true;}};
  transactions.push(tx);return tx;
 }};
 return {p:processingTransactions(base),calls,transactions};
}
function expected(outcome,attempt=1){return {contract:'processing-root-terminal-observation-v1',outcome,attempt,physicalCompletion:'UNKNOWN'};}

test('nested completion observers see one frozen original-root COMMIT observation after close',async()=>{
 const {p,calls}=connection(),seen=[];
 assert.equal(await p.transaction(async()=>{
  p.afterCompletion(value=>{assert.ok(calls.closes>0);assert.equal(p.active(),false);seen.push(value);});
  await p.transaction(()=>p.afterCompletion(value=>seen.push(value)));return 17;
 }),17);
 assert.deepEqual(seen,[expected('ACKNOWLEDGED_COMMIT'),expected('ACKNOWLEDGED_COMMIT')]);
 assert.equal(seen[0],seen[1]);assert.ok(Object.isFrozen(seen[0]));assert.throws(()=>{seen[0].outcome='UNKNOWN';});
 assert.deepEqual(calls,{begins:1,commits:1,rollbacks:0,closes:1});
});
test('application and final-fence failures retain their original error and acknowledged rollback',async()=>{
 for(const finalFence of [false,true]){
  const {p,calls}=connection(),seen=[],failure=Error('ORIGINAL_FAILURE');
  await assert.rejects(p.transaction(()=>{
   p.afterCompletion(value=>seen.push(value));if(!finalFence)throw failure;
  },{beforeCommit:()=>{throw failure;}}),error=>error===failure);
  assert.deepEqual(seen,[expected('ACKNOWLEDGED_ROLLBACK')]);assert.equal(calls.commits,0);assert.equal(calls.rollbacks,1);
 }
});
for(const applied of [false,true])test('lost COMMIT acknowledgement stays UNKNOWN after resolved cleanup rollback: applied='+applied,async()=>{
 const {p,calls}=connection({commit:async tx=>{if(applied)tx.closed=true;throw Error('LOST_ACK');}}),seen=[];
 await assert.rejects(p.transaction(()=>p.afterCompletion(value=>seen.push(value))),error=>error.code==='COMMIT_INDETERMINATE');
 assert.deepEqual(seen,[expected('UNKNOWN')]);assert.equal(calls.begins,1);assert.equal(calls.commits,1);assert.equal(calls.rollbacks,1);
});
test('resolved rollback on an already closed SDK transaction is never an acknowledged rollback',async()=>{
 const {p,transactions}=connection(),seen=[],failure=Error('EARLIER_STREAM_CLOSED');
 await assert.rejects(p.transaction(()=>{p.afterCompletion(value=>seen.push(value));transactions[0].closed=true;throw failure;}),error=>error===failure);
 assert.deepEqual(seen,[expected('UNKNOWN')]);
});
test('rollback transport failure is UNKNOWN and does not replace the application error',async()=>{
 const {p}=connection({rollback:async()=>{throw Error('ROLLBACK_ACK_LOST');}}),seen=[],failure=Error('APPLICATION_FAILURE');
 await assert.rejects(p.transaction(()=>{p.afterCompletion(value=>seen.push(value));throw failure;}),error=>error===failure);
 assert.deepEqual(seen,[expected('UNKNOWN')]);
});
test('definite SQLite COMMIT rejection can report only the subsequent real rollback',async()=>{
 const {p,calls}=connection({commit:async()=>{throw Object.assign(Error('CONSTRAINT'),{code:'SQLITE_CONSTRAINT'});}}),seen=[];
 await assert.rejects(p.transaction(()=>p.afterCompletion(value=>seen.push(value))),error=>error.definiteCommitRejection===true);
 assert.deepEqual(seen,[expected('ACKNOWLEDGED_ROLLBACK')]);assert.equal(calls.commits,1);
});
test('a definite BUSY retry preserves one callback and observes only the final COMMIT',async()=>{
 const {p,calls}=connection({commit:async(tx,c)=>{if(c.commits===1)throw Object.assign(Error('BUSY'),{code:'SQLITE_BUSY'});tx.closed=true;}}),seen=[];let callbacks=0;
 await p.transaction(()=>{callbacks++;p.afterCompletion(value=>seen.push(value));});
 assert.equal(callbacks,1);assert.equal(calls.commits,2);assert.deepEqual(seen,[expected('ACKNOWLEDGED_COMMIT')]);
});
test('known COMMIT survives a later close exception without claiming physical completion',async()=>{
 const failure=Error('CLOSE_FAILURE'),{p}=connection({close:(_tx,c)=>{if(c.closes===1)throw failure;}}),seen=[];
 await assert.rejects(p.transaction(()=>p.afterCompletion(value=>seen.push(value))),error=>error===failure);
 assert.deepEqual(seen,[expected('ACKNOWLEDGED_COMMIT')]);assert.equal(seen[0].physicalCompletion,'UNKNOWN');
});
test('an unsupported transport cannot supply terminal acknowledgement authority',async()=>{
 const {p}=connection({protocol:'custom'}),seen=[];await p.transaction(()=>p.afterCompletion(value=>seen.push(value)));
 assert.deepEqual(seen,[expected('UNKNOWN')]);
});
test('outside a root the callback gets NO_ROOT and creates no transaction',()=>{
 const {p,calls}=connection();let observed;
 assert.equal(p.afterCompletion(value=>{observed=value;return 12;}),12);
 assert.deepEqual(observed,expected('NO_ROOT',null));assert.equal(calls.begins,0);assert.ok(Object.isFrozen(observed));
});
test('real SQLite outside replay rolls back speculative writes, caches input once and commits one audit',async t=>{
 const db=await createStage6OwnedMemoryDb(async client=>client.execute('CREATE TABLE synthetic_audit(n INTEGER)'),fixtureKeys);t.after(()=>db.close());
 const seen=[];let outsideCalls=0,callbacks=0;
 assert.equal(await db.transaction(async()=>{
  callbacks++;db.afterProcessingCompletion(value=>seen.push(value));
  await db.raw.execute('INSERT INTO synthetic_audit VALUES(1)');
  return db.outsideProcessingTransaction('original-input',async()=>{outsideCalls++;assert.deepEqual(seen,[expected('ACKNOWLEDGED_ROLLBACK')]);return 23;});
 }),23);
 assert.deepEqual(seen,[expected('ACKNOWLEDGED_ROLLBACK'),expected('ACKNOWLEDGED_COMMIT',2)]);
 assert.equal(callbacks,2);assert.equal(outsideCalls,1);assert.equal((await db.raw.execute('SELECT count(*) n FROM synthetic_audit')).rows[0].n,1);
});

for(const loss of [null,'BEFORE_COMMIT','AFTER_COMMIT'])test('installed Hrana driver terminal observation agrees with separate native SQLite data: '+loss,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'r22-terminal-protocol-')),url='file:'+join(dir,'fixture.sqlite');
 const seed=sqliteClient({url}),transport=hranaTransport(url,{traceTransactions:true});
 const client=httpClient({url:'https://isolated.invalid',fetch:request=>transport.fetch(request)}),p=processingTransactions(client),seen=[];
 t.after(async()=>{client.close();transport.close();seed.close();await rm(dir,{recursive:true,force:true});});
 await seed.execute('CREATE TABLE synthetic_terminal(n INTEGER)');
 if(loss)transport.arm(loss==='BEFORE_COMMIT'?{before:()=>{throw Error('SYNTHETIC_COMMIT_ACK_LOST');}}:{loseAcknowledgement:true});
 let callbacks=0;const run=()=>p.transaction(async()=>{
  callbacks++;p.afterCompletion(value=>seen.push(value));await p.client.execute('INSERT INTO synthetic_terminal VALUES(1)');
 });
 if(loss)await assert.rejects(run(),error=>error.code==='COMMIT_INDETERMINATE');else await run();
 assert.equal(callbacks,1);assert.deepEqual(seen,[expected(loss?'UNKNOWN':'ACKNOWLEDGED_COMMIT')]);
 assert.equal((await seed.execute('SELECT count(*) n FROM synthetic_terminal')).rows[0].n,loss==='BEFORE_COMMIT'?0:1);
 assert.equal(transport.transactions.filter(value=>value.outcome==='COMMITTED').length,loss==='BEFORE_COMMIT'?0:1);
});
