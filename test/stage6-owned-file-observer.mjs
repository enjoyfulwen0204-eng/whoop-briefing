// Test-only observer of original installed native prepare/run boundaries.
// It cannot grant work, replace SQL/results, retry, or extend a deadline.
import assert from 'node:assert/strict';
import Database from 'libsql';
export function observeOwnedFileTransactions({now=()=>performance.now()}={}){
 const originalPrepare=Database.prototype.prepare,originalExec=Database.prototype.exec;
 const roots=new Map(),receivers=new Set();let armed=false,closed=false,prepared=0,committed=0,rolledBack=0,rejected=0,maxDurationMs=0,firstFailure=null;
 const fault=code=>{firstFailure??=code;};
 function prepare(sql){
  const at=now();let statement;try{statement=originalPrepare.call(this,sql);}catch(error){if(armed){rejected++;fault('NATIVE_PREPARE_REJECTED');}throw error;}
  if(!armed)return statement;
  receivers.add(this);prepared++;const receiver=this,verb=String(sql).trim();
  const boundary=/^(?:BEGIN(?: IMMEDIATE| DEFERRED| EXCLUSIVE)?|COMMIT|ROLLBACK)$/i.test(verb);
  for(const method of ['run','all','get']){const run=statement[method];
  statement[method]=function(...args){
   const begin=boundary&&/^BEGIN/i.test(verb),end=verb.toUpperCase();
   if(begin&&roots.has(receiver))fault('OVERLAPPING_NATIVE_BEGIN');
   try{
    const result=run.apply(this,args);
    if(boundary&&method!=='run')fault('UNEXPECTED_NATIVE_BOUNDARY_METHOD');
    if(begin)roots.set(receiver,at);
    else if(boundary){
     const started=roots.get(receiver);if(started===undefined)fault('UNMATCHED_NATIVE_TERMINAL');
     else{const duration=now()-started;maxDurationMs=Math.max(maxDurationMs,duration);if(!Number.isFinite(duration)||duration<0||duration>=5000)fault('OBSERVED_FILE_TRANSACTION_NOT_BELOW_5S');roots.delete(receiver);}
     if(end==='COMMIT')committed++;else rolledBack++;
    }
    return result;
   }catch(error){rejected++;fault('NATIVE_BOUNDARY_REJECTED');throw error;}
  };}
  return statement;
 }
 function exec(...args){if(armed){fault('UNOBSERVED_NATIVE_EXEC_PATH');throw Error('UNOBSERVED_NATIVE_EXEC_PATH');}return originalExec.apply(this,args);}
 Database.prototype.prepare=prepare;Database.prototype.exec=exec;
 return {
  arm(){assert.equal(closed,false);assert.equal(armed,false);armed=true;},
  snapshot(){return {contract:'original-owned-file-native-boundaries-v1',armed,prepared,receivers:receivers.size,
   committed,rolledBack,rejected,openTransactions:roots.size,maxDurationMs,firstFailure,productionEvidence:false,nativeHranaQualified:false};},
  assertComplete(){const s=this.snapshot();assert.equal(s.armed,true);assert.equal(s.firstFailure,null);assert.equal(s.openTransactions,0);assert.equal(s.rejected,0);assert.equal(s.receivers,1);assert.ok(s.prepared>0);assert.ok(s.committed+s.rolledBack>0);assert.ok(s.maxDurationMs<5000);return s;},
  close(){assert.equal(Database.prototype.prepare,prepare);assert.equal(Database.prototype.exec,exec);Database.prototype.prepare=originalPrepare;Database.prototype.exec=originalExec;armed=false;closed=true;},
 };
}
