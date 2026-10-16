export const STAGE8_CONTINUATION_TICK_MS=2000;
/** Long-lived server scheduling only. Authority stays in resume/afterSync.
 * Shutdown joins the one in-flight call before its owning DB can close. */
export function createStage8ContinuationLoop({resume,onError=()=>{},timers={set:setTimeout,clear:clearTimeout}}){
 if(typeof resume!=='function'||typeof onError!=='function'||typeof timers.set!=='function'||typeof timers.clear!=='function')throw Error('STAGE8_CONTINUATION_LOOP_REQUIRED');
 let active=false,started=false,timer=null,pending=Promise.resolve();
 const schedule=()=>{if(active){timer=timers.set(tick,STAGE8_CONTINUATION_TICK_MS);timer?.unref?.();}};
 const tick=()=>{timer=null;if(!active)return;
  pending=Promise.resolve().then(()=>active?resume():undefined).catch(error=>{try{onError(error);}catch{}}).then(()=>{schedule();});
 };
 return Object.freeze({
  start(){if(!started){started=true;active=true;schedule();}},
  async stop(){active=false;if(timer!==null){timers.clear(timer);timer=null;}await pending;},
 });
}
