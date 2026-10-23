// Test-only settlement of already-issued SDK close/transport work.
// No SQL, reconnect, close, replay, retry, authority or timer extension.
export const MAX_PHYSICAL_JOIN_MS=5000;
export function transportIsJoined(snapshot){
 const a=snapshot?.adapter;
 return a?.terminalComplete===true&&a.activeFetches===0&&a.retainedStreams===0
  &&a.unresolvedStreams===0&&a.droppedObservations===0&&a.unknownProtocolReplies===0
  &&snapshot.physicalTerminalObservationComplete===true;
}
export async function joinIssuedTransport(transport,{startedAt,deadlineAt,now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(typeof transport?.snapshot!=='function'||!Number.isFinite(startedAt)||!Number.isFinite(deadlineAt)
  ||deadlineAt<startedAt||deadlineAt>startedAt+MAX_PHYSICAL_JOIN_MS)throw Error('PHYSICAL_JOIN_WINDOW_INVALID');
 let stable=0,probes=0,lastSnapshot=null;
 const result=(settled,checkedAt)=>{const ended=now();if(!Number.isFinite(ended)||ended<checkedAt)throw Error('PHYSICAL_JOIN_CLOCK_INVALID');return {settled:settled&&ended<deadlineAt,elapsedMs:ended-startedAt,probes,lastSnapshot};};
 for(;;){
  const before=now();if(!Number.isFinite(before)||before<startedAt)throw Error('PHYSICAL_JOIN_CLOCK_INVALID');
  if(before>=deadlineAt)return result(false,before);
  lastSnapshot=transport.snapshot();probes++;
  const after=now();if(!Number.isFinite(after)||after<before)throw Error('PHYSICAL_JOIN_CLOCK_INVALID');
  if(after>=deadlineAt)return result(false,after);
  stable=transportIsJoined(lastSnapshot)?stable+1:0;
  if(stable>=2)return result(true,after);
  await wait(Math.min(5,deadlineAt-after));
 }
}


// The initial legacy awaitIdle observations also share the same original
// window. A pending decoder/close cannot hold that observation indefinitely.
export async function waitIssuedIdleBefore(transport,{startedAt,deadlineAt,now=()=>performance.now()}={}){
 if(typeof transport?.awaitIdle!=='function'||!Number.isFinite(startedAt)||!Number.isFinite(deadlineAt)||deadlineAt<startedAt||deadlineAt>startedAt+MAX_PHYSICAL_JOIN_MS)throw Error('PHYSICAL_JOIN_WINDOW_INVALID');
 const at=now();if(!Number.isFinite(at)||at<startedAt)throw Error('PHYSICAL_JOIN_CLOCK_INVALID');
 if(at>=deadlineAt)return false;let timer;
 try{
  const idle=await Promise.race([Promise.resolve(transport.awaitIdle()).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),deadlineAt-at);})]);
  const ended=now();if(!Number.isFinite(ended)||ended<at)throw Error('PHYSICAL_JOIN_CLOCK_INVALID');
  return idle&&ended<deadlineAt;
 }finally{clearTimeout(timer);}
}
