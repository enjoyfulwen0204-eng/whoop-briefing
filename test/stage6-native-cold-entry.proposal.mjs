/** Same-process diagnostic entry. Importing never imports the application.
 * Bootstrap failure has UNKNOWN calls/transport/SQLD state, never invented0.
 */
import assert from 'node:assert/strict';
import {createHash}from 'node:crypto';
import {openSync,writeSync,fsyncSync,closeSync}from 'node:fs';
import {resolve}from 'node:path';import {pathToFileURL}from 'node:url';
import {diagnosticRecord}from './stage6-cold-diagnostic-metadata.proposal.mjs';
import {safeFailureCode}from './stage6-cold-progress-contract.proposal.mjs';
export async function runDiagnosticEntry({phase,writeRecord,importApplication}){
 assert.ok(['A','B'].includes(phase));assert.equal(typeof writeRecord,'function');assert.equal(typeof importApplication,'function');
 const record=(stage,error=null)=>diagnosticRecord({phase,stage,callIntents:null,elapsedMs:null,failureCode:error?safeFailureCode(error):null,errorMessageSha256:error?createHash('sha256').update(String(error.message??error)).digest('hex'):null,terminalComplete:null,activeFetches:null,unresolvedStreams:null,unknownProtocolReplies:null});
 try{writeRecord(0,record('APP_IMPORT_ENTER'));}catch{/* diagnostics cannot abandon an unresolved owner */}
 try{await importApplication();return 'MODULE_EVALUATED';}
 catch(error){try{writeRecord(24,record('APP_BOOTSTRAP_FAILURE',error));}catch{}return 'MODULE_REJECTED';}
}
const direct=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(direct){
 const phase=process.argv[2];assert.ok(['A','B'].includes(phase)&&process.argv.length===3);
 const state=await runDiagnosticEntry({phase,importApplication:()=>import('./stage6-native-cold-progress.mjs'),writeRecord:(ordinal,value)=>{
  const bytes=Buffer.from(JSON.stringify(value)+'\n');assert.ok(bytes.length<=4096);const fd=openSync(`/qualification/${phase}-progress-${String(ordinal).padStart(2,'0')}.private.json`,'wx',0o600);
  try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}const directory=openSync('/qualification','r');try{fsyncSync(directory);}finally{closeSync(directory);}
 }});
 if(state==='MODULE_REJECTED')process.exitCode=2;
 // MODULE_EVALUATED does not overwrite a failure exitCode set by the module.
}
