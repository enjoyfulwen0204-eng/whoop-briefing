import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'libsql';
import {observeOwnedFileTransactions} from './stage6-owned-file-observer.mjs';
for(const terminal of ['COMMIT','ROLLBACK'])test('native observer preserves original SQL values and joins '+terminal,()=>{
 const db=new Database(':memory:'),observer=observeOwnedFileTransactions();
 try{db.exec('CREATE TABLE sample(value)');observer.arm();db.prepare('BEGIN IMMEDIATE').run();db.prepare('INSERT INTO sample VALUES(?)').run(7);assert.equal(db.prepare('SELECT value FROM sample').get().value,7);db.prepare(terminal).run();const s=observer.assertComplete();assert.equal(s.committed,terminal==='COMMIT'?1:0);assert.equal(s.rolledBack,terminal==='ROLLBACK'?1:0);}finally{db.close();observer.close();}
});
test('observer rejects a five-second boundary, missing terminal and direct unobserved exec',()=>{
 for(const mode of ['SLOW','OPEN','EXEC']){
  const db=new Database(':memory:');let time=100;const observer=observeOwnedFileTransactions({now:()=>time});
  try{observer.arm();db.prepare('BEGIN IMMEDIATE').run();if(mode==='SLOW'){time=5100;db.prepare('COMMIT').run();}else if(mode==='EXEC'){assert.throws(()=>db.exec('SELECT 1'),/UNOBSERVED_NATIVE_EXEC_PATH/);db.prepare('ROLLBACK').run();}
   assert.throws(()=>observer.assertComplete());
  }finally{if(db.inTransaction)db.prepare('ROLLBACK').run();db.close();observer.close();}
 }
});
test('observer never retries a rejected original boundary',()=>{
 const db=new Database(':memory:'),observer=observeOwnedFileTransactions();
 try{observer.arm();assert.throws(()=>db.prepare('COMMIT').run());assert.equal(observer.snapshot().rejected,1);assert.throws(()=>observer.assertComplete());}finally{db.close();observer.close();}
});
