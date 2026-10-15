// Scheduling classification only, never work/admission/completion authority.
// A retry still re-enters the entire original supervisor and monitored runtime.
import {isDeepStrictEqual} from 'node:util';
export async function observeUnadmittedStartup(client,keys,userId,request){
 const slot='phase4:drain-parent:'+keys.lookup(['drain-parent-slot-v1','SHADOW',userId]);
 const observations=await client.batch([
  {sql:'SELECT count(*) n FROM phase4_executions WHERE execution_id=?',args:[request.requestId]},
  {sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[request.requestId]},
  {sql:'SELECT count(*) n FROM phase4_execution_producers WHERE producing_execution_id=?',args:[request.requestId]},
  {sql:'SELECT count(*) n FROM resource_locks WHERE name=?',args:[slot]},
 ],'read');
 return Object.fromEntries(['executions','workReceipts','producers','parentSlots'].map((name,i)=>[name,observations[i]?.rows[0]?.n]));
}
export function canRetryUnadmittedStartup({request,userId,codeSha,startupRetries,entry,observation,before,after}){
 if(startupRetries!==0||request?.phase!=='STAGE6_DRAIN'||request.executionMode!=='SHADOW'||request.triggerSource!=='manual'||request.releaseSha!==codeSha)return false;
 if(entry?.requestId!==request.requestId||entry.userId!==userId||entry.status!==503||entry.result!==undefined||entry.child!=null||entry.producerHmac===true)return false;
 const response=entry.response,child=entry.childLifecycle;
 if(response?.status!==503||response.ok!==false||response.error!=='DRAIN_CHILD_READY_TIMEOUT'||response.resumable!==false)return false;
 if(child?.readyMs!==null||child.spawnError!==null||!Array.isArray(child.events)||child.events.length!==0||child.stderrBytes!==0||child.stderrStreamClosed!==true)return false;
 if(child.exit?.code!==null||child.exit.signal!=='SIGTERM'||!Number.isFinite(child.exit.elapsedMs)||child.exit.elapsedMs<5000||child.exit.elapsedMs>=10000)return false;
 if(!observation||['executions','workReceipts','producers','parentSlots'].some(name=>observation[name]!==0))return false;
 if(!Array.isArray(before)||!Array.isArray(after))return false;
 const target=rows=>rows.filter(j=>j.user_id===userId),a=target(before),b=target(after);
 return a.length===2&&new Set(a.map(j=>j.job_kind)).size===2&&isDeepStrictEqual(a,b);
}
