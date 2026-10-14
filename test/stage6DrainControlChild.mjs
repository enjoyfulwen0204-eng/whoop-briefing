// Process-only Linux negative controls. No DB, keys, grants or calculations.
import {spawn} from 'node:child_process';
import {installDrainChildLifecycle} from '../src/drainChildLifecycle.js';
installDrainChildLifecycle({execute:async({mode,control,notify})=>{
 if(mode==='blocked'){
  const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  notify('DESCENDANT_'+descendant.pid);while(true){}
 }
 if(mode!=='graceful')throw Error('PROCESS_CONTROL_ONLY');
 notify('READY_TO_CANCEL');
 await new Promise(resolve=>{if(control.signal.aborted)resolve();else control.signal.addEventListener('abort',resolve,{once:true});});
 control.assert();throw Error('CANCEL_MUST_REJECT');
}});
