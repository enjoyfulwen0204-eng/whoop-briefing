import {spawn} from 'node:child_process';
import {dirname,isAbsolute,resolve} from 'node:path';
import {open} from 'node:fs/promises';
import {stage8ProtectedFile,stage8ProtectedDirectory} from './stage8-migration-safety.mjs';
import {assertStage8Maintenance,stage8MaintenanceOperation} from './stage8-maintenance-context.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
/** Authenticated SQL goes only to a fixed local SQLite child's stdin. Neither
 * SQL nor diagnostics are persisted/logged. Cancellation waits for actual child
 * close; a rejected promise cannot leave a native restore running in-process. */
export async function restoreStage8Sqlite({sourcePath,sql,maintenance}){
 if(!Buffer.isBuffer(sql)||typeof sourcePath!=='string'||!isAbsolute(sourcePath)||resolve(sourcePath)!==sourcePath)fail('STAGE8_RESTORE_AUTHENTICATED_BUFFER_REQUIRED');
 assertStage8Maintenance(maintenance);await stage8ProtectedDirectory(dirname(sourcePath));
 const file=await open(sourcePath,'wx',0o600);await file.close();await stage8ProtectedFile(sourcePath);
 const {signal,remainingMs}=stage8MaintenanceOperation(maintenance,90_000);
 await new Promise((resolve,reject)=>{
  let fault=false,child;
  try{child=spawn('/usr/bin/sqlite3',['-safe','-init','/dev/null','-batch','-bail',sourcePath],{env:{SQLITE_TMPDIR:dirname(sourcePath)},stdio:['pipe','ignore','ignore'],signal,timeout:remainingMs,killSignal:'SIGKILL'});}catch{reject(Object.assign(Error('STAGE8_LOCAL_RESTORE_FAILED'),{code:'STAGE8_LOCAL_RESTORE_FAILED'}));return;}
  child.on('error',()=>{fault=true;});child.stdin.on('error',()=>{fault=true;});
  child.on('close',code=>{
   if(signal.aborted){reject(Object.assign(Error('STAGE8_LOCAL_RESTORE_ABORTED'),{code:'STAGE8_LOCAL_RESTORE_ABORTED'}));return;}
   if(fault||code!==0){reject(Object.assign(Error('STAGE8_LOCAL_RESTORE_FAILED'),{code:'STAGE8_LOCAL_RESTORE_FAILED'}));return;}
   resolve();
  });
  child.stdin.end(sql);
 });
 assertStage8Maintenance(maintenance);
}
