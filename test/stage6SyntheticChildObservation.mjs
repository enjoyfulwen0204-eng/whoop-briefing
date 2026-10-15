// Test-controller diagnostics only. Never issues authority, changes a response,
// retries work or keeps raw child output. Every retained field is bounded.
import {createHash} from 'node:crypto';
const stages=new Set(['PREPARATION','CALCULATION','PUBLICATION','COMMIT_ACK']);
const classes=['TypeError','RangeError','SyntaxError','ReferenceError','AssertionError','Error'];
const safeCode=value=>typeof value==='string'&&(/^[A-Z][A-Z0-9_]{0,95}$/.test(value)||classes.includes(value))?value:null;
export function syntheticResponseObservation(response){
 return Object.freeze({status:response.status,ok:response.body?.ok===true,error:safeCode(response.body?.error),resumable:response.body?.resumable===true});
}
export function observeSyntheticChild(child,{now=()=>performance.now()}={}){
 const started=now(),events=[],hash=createHash('sha256');let stderrBytes=0,stderrObservedBytes=0,stderrFlags=[],stderrStreamClosed=false,exit=null,spawnError=null,readyMs=null;
 const at=()=>Math.max(0,now()-started),remember=event=>{if(events.length<32)events.push({...event,elapsedMs:at()});};
 child.on('message',packet=>{
  if(packet?.type==='ready'){readyMs??=at();remember({type:'ready'});}
  else if(packet?.type==='progress'&&stages.has(packet.stage))remember({type:'progress',stage:packet.stage});
  else if(packet?.type==='error')remember({type:'error',code:safeCode(packet.code)});
  else if(packet?.type==='result')remember({type:'result'});
 });
 child.on('error',error=>{spawnError=safeCode(error?.code)??safeCode(error?.name);remember({type:'spawnError',code:spawnError});});
 child.on('exit',(code,signal)=>{exit={code:Number.isInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT'].includes(signal)?signal:null,elapsedMs:at()};});
 child.stderr?.on('data',chunk=>{
  stderrBytes+=chunk.length;hash.update(chunk);const observed=Buffer.from(chunk).subarray(0,Math.max(0,8192-stderrObservedBytes));stderrObservedBytes+=observed.length;
  const text=observed.toString();for(const name of classes)if(text.includes(name+':')&&!stderrFlags.includes(name))stderrFlags.push(name);
  if(/heap out of memory|Reached heap limit|Allocation failed/i.test(text)&&!stderrFlags.includes('V8_HEAP_FAILURE'))stderrFlags.push('V8_HEAP_FAILURE');
 });
 child.stderr?.on('close',()=>{stderrStreamClosed=true;});
 return Object.freeze({snapshot:()=>({readyMs,spawnError,exit,events:structuredClone(events),stderrBytes,stderrObservedBytes,stderrStreamClosed,stderrClassificationTruncated:stderrBytes>stderrObservedBytes,stderrHashCoverage:'OBSERVED_BYTES_ONLY',stderrSha256:hash.copy().digest('hex'),stderrFlags:[...stderrFlags]})});
}
