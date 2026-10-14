import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readdirSync,readFileSync} from 'node:fs';
import {acquireDrainParentSlot,releaseDrainParentSlot} from './drainProcessAuthority.js';
import {runExecutionPhase,phaseResponse,DRAIN_SOURCE_BUDGETS,ADMISSION_BUDGET_MS,PHASE_SETTLEMENT_MS} from './phase4Execution.js';
import {validatePhaseRequest,validatePhaseBody,requestIdentity,reconcileExecution,configurationProof} from './phase4ExecutionStore.js';
import {runningReleaseSha} from './phase4Release.js';
import {publicBetaConfiguration} from './publicBetaConfig.js';
const error=code=>Object.assign(Error(code),{code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function within(work,ms,code){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error(code)),ms);})]);}finally{clearTimeout(timer);}}
export function liveDrainGroupMembers(group){
 if(process.platform!=='linux'||!Number.isInteger(group)||group<2)throw Error('LINUX_DRAIN_GROUP_REQUIRED');
 return readdirSync('/proc').filter(x=>/^\d+$/.test(x)).flatMap(pid=>{try{const fields=readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');return Number(fields[2])===group&&fields[0]!=='Z'?[Number(pid)]:[];}catch{return [];}});
}
async function reapGroup(child){
 if(!child?.pid)return;
 if(liveDrainGroupMembers(child.pid).length){try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
 const at=Date.now();while(liveDrainGroupMembers(child.pid).length&&Date.now()-at<2000)await pause(20);
 if(liveDrainGroupMembers(child.pid).length)throw error('DRAIN_GROUP_REAP_UNCONFIRMED');
}
export function createDrainChildSupervisor({db,keys,userId,environment=process.env,env,childUrl=new URL('./drainChild.js',import.meta.url),runOtherPhase=runExecutionPhase,onBoundary=()=>{},spawn=fork,childPayload=()=>({}),shutdownMs=5000}){
 if(!db?.raw||typeof userId!=='string'||!Number.isInteger(shutdownMs)||shutdownMs<100||shutdownMs>5000)throw Error('DRAIN_SUPERVISOR_REQUIRED');
 let active,closing=false;
 const stop=state=>{if(!state||state.stopping)return;state.stopping=true;if(!state.child)return;state.child.stdio?.[4]?.destroy();
  if(state.child?.connected)try{state.child.send({type:'cancel',nonce:state.nonce});}catch{}
  state.child?.kill('SIGTERM');state.killTimer=setTimeout(()=>{if(!state.exited)try{process.kill(-state.child.pid,'SIGKILL');}catch{state.child.kill('SIGKILL');}},shutdownMs);
 };
 const runPhase=async args=>{
  if(args.request?.phase!=='STAGE6_DRAIN'||args.request.executionMode!=='SHADOW')return runOtherPhase({...args,db,keys,environment,env});
  if(closing||active)return {status:409,body:{ok:false,error:'DRAIN_CHILD_BUSY'}};
  validatePhaseRequest(args.request);const body=args.body??JSON.stringify(args.request);validatePhaseBody(args.request,body);
  const releaseSha=runningReleaseSha(environment),config=publicBetaConfiguration(environment);
  if(args.request.releaseSha!==releaseSha)throw error('RELEASE_CHECKOUT_MISMATCH');
  if(config.runtime!=='on'||args.request.configProof!==configurationProof(keys,config,environment,releaseSha))throw error('EXECUTION_CONFIG_CHANGED');
  let resolveDone;const state=active={nonce:randomBytes(32).toString('hex'),exited:false,done:new Promise(resolve=>{resolveDone=resolve;})};let slot,reply,spawnFailure;
  const bound=ADMISSION_BUDGET_MS+DRAIN_SOURCE_BUDGETS[args.request.triggerSource]+PHASE_SETTLEMENT_MS;
  const aborted=()=>stop(state);args.signal?.addEventListener('abort',aborted,{once:true});
  try{
   slot=await acquireDrainParentSlot({db,keys,userId,ttlMs:bound});
   if(closing||args.signal?.aborted)throw error('SYNC_CANCELLED');
   const child=state.child=spawn(childUrl,[],{detached:true,execArgv:[],env:{...process.env,NODE_OPTIONS:'--max-old-space-size=96 --max-semi-space-size=2'},stdio:['ignore','ignore','ignore','ipc','pipe']});
   // Kernel exit is the process boundary. Node's close event also waits for
   // stdio accounting, including the extra ownership fd after IPC disconnect.
   const exit=new Promise(resolve=>{child.once('exit',(code,signal)=>{state.exited=true;child.stdio?.[4]?.destroy();resolve({code,signal});});child.on('error',e=>{spawnFailure=e;if(!child.pid){state.exited=true;resolve({error:e.code??e.name});}});});state.exit=exit;
   let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
   child.on('message',packet=>{
    if(packet?.pid!==child.pid||packet.parentPid!==process.pid){stop(state);rejectReady(error('DRAIN_CHILD_IDENTITY_REJECTED'));return;}
    if(packet.type==='ready'){resolveReady();return;}
    if(packet.nonce!==state.nonce){stop(state);return;}
    if(packet.type==='progress'){try{onBoundary(packet.stage,{child,stop:()=>stop(state),slot,request:args.request});}catch{stop(state);}return;}
    if(packet.type==='result')reply=packet;else if(packet.type==='error')state.error=packet.code;
   });
   child.once('error',rejectReady);
   child.on('disconnect',()=>{if(!reply&&!state.exited)stop(state);});
   await within(Promise.race([ready,exit.then(()=>{throw error('DRAIN_CHILD_PREMATURE_EXIT');})]),5000,'DRAIN_CHILD_READY_TIMEOUT');
   if(state.stopping||args.signal?.aborted)throw error('SYNC_CANCELLED');
   child.send({...childPayload(args),type:'start',nonce:state.nonce,parentPid:process.pid,request:args.request,body,slot},e=>{if(e)stop(state);});
   state.boundTimer=setTimeout(()=>stop(state),bound);
   const termination=await within(exit,bound+shutdownMs+2000,'DRAIN_CHILD_REAP_TIMEOUT');
   await reapGroup(child);
   if(spawnFailure)throw spawnFailure;
   const observed=await reconcileExecution(db,args.request,requestIdentity(body));
   if(observed.state==='FINALIZED_SUCCESS'&&reply?.result?.status===200&&!state.stopping&&!reply.controlStopped&&!state.error&&termination.code===0){
    // Reuse the original replay path, including fresh release, configuration
    // and runtime admission. A durable row or IPC reply alone is insufficient.
    const response=await runOtherPhase({...args,body,db,keys,environment,env});
    if(!isDeepStrictEqual(reply.result,response))throw error('DRAIN_CHILD_RESULT_MISMATCH');return response;
   }
   if(observed.state==='FINALIZED_SUCCESS')return {status:503,body:{ok:false,error:'DRAIN_COMMIT_REQUIRES_RECONCILIATION',resumable:true}};
   if(observed.state==='WORK_COMMITTED_UNFINALIZED'||reply?.result?.status===503)return {status:503,body:{ok:false,error:'DRAIN_COMMIT_REQUIRES_RECONCILIATION',resumable:true}};
   if(observed.state==='FINALIZED_FAILURE')return phaseResponse({...observed.result,settlementState:observed.row.state,executionSeq:observed.row.execution_seq,finalizedAt:observed.row.finalized_at});
   return {status:202,body:{ok:false,error:state.error??'DRAIN_CONTROL_RETIRED',resumable:true}};
  }catch(e){if(e.code==='DRAIN_CHILD_BUSY')return {status:409,body:{ok:false,error:e.code}};return {status:503,body:{ok:false,error:e.code??'DRAIN_CHILD_FAILED'}};}
  finally{
   try{if(state.child&&!state.exited){stop(state);await within(state.exit??Promise.resolve(),shutdownMs+2000,'DRAIN_CHILD_REAP_UNCONFIRMED');if(!state.exited)throw error('DRAIN_CHILD_REAP_UNCONFIRMED');}
    await reapGroup(state.child);
    clearTimeout(state.boundTimer);clearTimeout(state.killTimer);args.signal?.removeEventListener('abort',aborted);
    if(slot)try{await releaseDrainParentSlot(db,slot);}catch{active=null;return {status:503,body:{ok:false,error:'DRAIN_PARENT_RELEASE_PENDING',resumable:true}};}active=null;
   }finally{resolveDone();}
  }
 };
 return Object.freeze({runPhase,async close(){closing=true;const state=active;if(state){stop(state);await within(state.done,shutdownMs+2000,'DRAIN_CHILD_REAP_UNCONFIRMED');if(state.child&&!state.exited)throw error('DRAIN_CHILD_REAP_UNCONFIRMED');}},status:()=>({active:Boolean(active),closing})});
}
