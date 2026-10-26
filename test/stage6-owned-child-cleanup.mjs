// Lifecycle for a ChildProcess just spawned by the closed qualification harness.
// Capture its original PID once. Never signal a reaped/reused group identity.
export function createOwnedChildCleanup(child,{send=(pid,signal)=>process.kill(pid,signal),after=setTimeout,cancel=clearTimeout,
 now=()=>performance.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
 groupAlive=pid=>{try{process.kill(-pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}}}={}){
 const pid=child.pid;let stopping=false,leaderExited=child.exitCode!==null||child.signalCode!==null,closed=false,disposed=false,
  termRequested=false,killRequested=false,killTimer,expiryTimer,resolveClose,resolveExpired;
 const closePromise=new Promise(resolve=>{resolveClose=resolve;}),expiryPromise=new Promise(resolve=>{resolveExpired=resolve;});
 const clearKill=()=>{if(killTimer!==undefined){cancel(killTimer);killTimer=undefined;}};
 const onExit=()=>{leaderExited=true;clearKill();};
 const onClose=()=>{closed=true;onExit();if(expiryTimer!==undefined){cancel(expiryTimer);expiryTimer=undefined;}resolveClose(true);};
 child.once('exit',onExit);child.once('close',onClose);
 const signal=value=>{if(disposed||leaderExited||closed||!Number.isSafeInteger(pid)||pid<2)return;
  try{send(-pid,value);}catch{/* A failed signal never establishes close. */}};
 return {
  stop(){if(stopping||closed||disposed)return;stopping=true;
   if(!leaderExited){termRequested=true;signal('SIGTERM');
    killTimer=after(()=>{killTimer=undefined;if(leaderExited||closed||disposed)return;killRequested=true;signal('SIGKILL');},5000);}
   expiryTimer=after(()=>{expiryTimer=undefined;resolveExpired(false);},15000);
  },
  waitClosed:()=>Promise.race([closePromise,expiryPromise]),
  async waitGroupAbsent(){if(!Number.isSafeInteger(pid)||pid<2)return closed;
   const deadline=now()+5000;do{if(groupAlive(pid)===false)return true;await pause(50);}while(now()<deadline);return false;
  },
  status:()=>({pid,stopping,leaderExited,closed,termRequested,killRequested}),
  dispose(){disposed=true;clearKill();if(expiryTimer!==undefined)cancel(expiryTimer);child.removeListener('exit',onExit);child.removeListener('close',onClose);},
 };
}
