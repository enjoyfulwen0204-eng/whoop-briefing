// Real process, installed HTTP driver, isolated Hrana SQL and fake send only.
import {openHttpFixture} from './deliveryDefaultFixture.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
const [url,idText,mode]=process.argv.slice(2),id=Number(idText);
if(!url?.startsWith('file:')||!Number.isSafeInteger(id)||!['before-send','after-send','retry'].includes(mode))throw Error('ISOLATED_PROCESS_ARGUMENTS_REQUIRED');
const {db,close}=openHttpFixture(url);await db.admitRuntime();let callbacks=0,sends=0;
const hold=checkpoint=>{process.send({checkpoint,callbacks,sends});return new Promise(()=>{setInterval(()=>{},1000);});};
if(mode==='before-send'){
 const operation=db.processTelegramOperation;
 db.processTelegramOperation=async(...args)=>{const result=await operation(...args);await hold('receipt_committed');return result;};
}
const processor=createUpdateProcessor({db,resolveUser:async()=>null,handleMessage:async()=>{throw Error('UNEXPECTED_HEALTH_HANDLER');},
 handleUnlinked:async()=>{callbacks++;return 'Synthetic reply';},sendReply:async()=>{sends++;
  if(mode==='after-send')await hold('fake_send_accepted');return {sent:true,messageId:123};},
 workerId:'isolated-process',sleepImpl:async()=>{}});
try{
 const result=await processor.processUpdate({update_id:id,message:{message_id:id,text:'/synthetic',chat:{id:5001,type:'private'},from:{id:5001,is_bot:false}}});
 process.send({done:true,callbacks,sends,outcome:result.outcome,state:(await db.getTelegramOperation(id))?.deliveryState});
}finally{close();process.disconnect();}
