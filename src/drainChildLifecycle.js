import {createDrainParentControl} from './drainProcessAuthority.js';
// One admitted payload per process. Business authority is reconstructed by
// execute through runExecutionPhase; an IPC frame never issues a DB grant.
export function installDrainChildLifecycle({execute,shutdownMs=5000}){
 if(process.platform!=='linux'||!process.connected||typeof execute!=='function'||!Number.isInteger(shutdownMs)||shutdownMs<100||shutdownMs>5000)throw Error('DRAIN_CHILD_ENTRY_REQUIRED');
 const parentPid=process.ppid,control=createDrainParentControl({parentPid});let started=false,nonce,shutdownTimer;
 const send=packet=>{if(!process.connected)return;try{process.send({...packet,nonce,pid:process.pid,parentPid},error=>{if(error)stop();});}catch{stop();}};
 const stop=()=>{control.stop();shutdownTimer??=setTimeout(()=>process.exit(2),shutdownMs);shutdownTimer.unref();};
 process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
 process.on('message',async packet=>{
  if(packet?.type==='cancel'&&packet.nonce===nonce){stop();return;}
  if(started||packet?.type!=='start'||packet.parentPid!==parentPid||typeof packet.nonce!=='string'||!/^[a-f0-9]{64}$/.test(packet.nonce)){stop();return;}
  started=true;nonce=packet.nonce;
  try{control.assert();const output=await execute({...packet,control,notify:stage=>send({type:'progress',stage})});send({type:'result',...output,controlStopped:control.signal.aborted});}
  catch(error){send({type:'error',code:error.code??error.name});}
  finally{clearTimeout(shutdownTimer);control.close();if(process.connected)process.disconnect();}
 });
 send({type:'ready'});
}
