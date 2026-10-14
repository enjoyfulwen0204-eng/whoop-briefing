// Synthetic process comparison only. Wait for both the actual runtime reply
// and process termination; every premature exit/error remains a finite failure.
export function superviseDrainChild(child,payload,{timeoutMs=90000}={}){
 return new Promise((resolve,reject)=>{
  let response,settled=false;
  const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);
   if(error){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');reject(error);}else resolve(response);
  };
  const timer=setTimeout(()=>finish(Error('ORIGINAL_OVERALL_BOUND_EXCEEDED')),timeoutMs);
  child.once('message',message=>{if(message?.error)finish(Error(message.error));
   else if(!message?.result||!message?.scopes)finish(Error('DRAIN_CHILD_INVALID_REPLY'));else response=message;
  });
  child.once('exit',(code,signal)=>{if(code===0&&!signal&&response)finish();else finish(Error('DRAIN_CHILD_PREMATURE_EXIT'));});
  child.once('error',finish);
  try{child.send(payload,error=>{if(error)finish(error);});}catch(error){finish(error);}
 });
}
