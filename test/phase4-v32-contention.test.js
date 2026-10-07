import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {composeDb} from '../src/db.js';import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {fork} from 'node:child_process';
for(const expires of [false,true])test(`actual normal-driver COMMIT BUSY retains same transaction/callback; original deadline ${expires?'expires':'survives'}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-commit-busy-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.raw.execute('PRAGMA journal_mode=DELETE');
 await seed.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('isolated_counter','0','2026-10-08')");await seed.close();
 const base=createClient({url}),reader=createClient({url});let commits=0,busy=0,transactions=0,callbacks=0,notify;
 const firstBusy=new Promise(resolve=>notify=resolve),transaction=base.transaction.bind(base);
 base.transaction=async(...args)=>{transactions++;const tx=await transaction(...args),commit=tx.commit.bind(tx);
  tx.commit=async()=>{commits++;try{return await commit();}catch(error){if(error.code==='SQLITE_BUSY'){busy++;notify();}throw error;}};return tx;};
 const db=composeDb(base,{phase4Keys:fixtureKeys});t.after(async()=>{db.close();reader.close();await rm(dir,{recursive:true,force:true});});
 await db.admitRuntime();const snapshot=await reader.transaction('read');await snapshot.execute('SELECT * FROM telegram_state');
 const budget=createExecutionBudget({budgetMs:expires?500:5000});
 const pending=withExecutionBudget(budget,()=>db.transaction(async()=>{callbacks++;await db.raw.execute("UPDATE telegram_state SET value=CAST(value AS INTEGER)+1 WHERE key='isolated_counter'");}));
 // Attach rejection handling immediately while the independent reader holds it.
 const outcome=pending.then(()=>({ok:true}),error=>({error}));await firstBusy;
 if(!expires)await snapshot.rollback();const result=await outcome;budget.close();
 if(expires){assert.equal(result.error?.code,'SYNC_TIMEOUT');await snapshot.rollback();}else assert.equal(result.ok,true);
 snapshot.close();assert.equal(callbacks,1);assert.equal(transactions,1);assert.ok(busy>=1);if(!expires)assert.ok(commits>=2);
 assert.equal((await db.raw.execute("SELECT value FROM telegram_state WHERE key='isolated_counter'")).rows[0].value,expires?'0':'1');
 console.log(JSON.stringify({measurement:'v32_native_commit_busy',expires,transactions,callbacks,commits,busy}));
});
test('two stock-driver OS processes: kill writer during contention; contender fresh-admits and commits once',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-death-busy-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.raw.execute('PRAGMA journal_mode=DELETE');
 await seed.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('isolated_counter','0','2026-10-08')");await seed.close();
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const launch=role=>{
  const child=fork(new URL('./v32ContentionChild.js',import.meta.url),[url,role],{execArgv:['--expose-gc'],silent:true}),messages=[],waiters=[],output=[];let exit;
  child.stdout.on('data',c=>output.push(c));child.stderr.on('data',c=>output.push(c));
  child.on('message',m=>{messages.push(m);for(const notify of waiters)notify();});
  const closed=new Promise(resolve=>child.on('close',(code,signal)=>{exit={code,signal};for(const notify of waiters)notify();resolve(exit);}));
  t.after(()=>{if(!exit)child.kill('SIGKILL');});
  const wait=event=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CONTENTION_BARRIER_TIMEOUT')),15000);
   const check=()=>{const found=messages.find(m=>m.event===event),error=messages.find(m=>m.event==='error');if(found||error||exit){clearTimeout(timer);found?resolve(found):reject(Error(JSON.stringify(error??exit)+Buffer.concat(output).toString()));}};waiters.push(check);check();});
  return {child,wait,closed};
 };
 const holder=launch('holder'),contender=launch('contender');await Promise.all([holder.wait('ready'),contender.wait('ready')]);
 holder.child.send('go');await holder.wait('work_pending');contender.child.send('go');await contender.wait('busy');
 holder.child.kill('SIGKILL');assert.equal((await holder.closed).signal,'SIGKILL');
 const result=await contender.wait('complete');assert.equal(result.callbacks,1);assert.ok(result.busy>=1);assert.ok(result.reconnects>=1);assert.equal(result.oldRejected,true);
 assert.deepEqual(await contender.closed,{code:0,signal:null});
 const check=createClient({url});try{assert.equal((await check.execute("SELECT value FROM telegram_state WHERE key='isolated_counter'")).rows[0].value,'1');}finally{check.close();}
 console.log(JSON.stringify({measurement:'v32_process_death_contention',...result}));
});
