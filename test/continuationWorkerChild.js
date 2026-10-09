import {invoke} from '../cloudflare/briefing-scheduler/worker.js';
const env=JSON.parse(process.argv[2]),pending=new Map();let id=0;
process.on('message',message=>{
 if(message.type==='response'){const resolve=pending.get(message.id);pending.delete(message.id);resolve?.(new Response(JSON.stringify(message.result.body),{status:message.result.status}));}
});
try{
 const result=await invoke(env,{fetchImpl:(url,init)=>new Promise(resolve=>{
  const key=++id;pending.set(key,resolve);process.send({type:'request',id:key,url,body:init.body,headers:init.headers});
 })});
 process.send({type:'finished',result});process.disconnect();
}catch(error){process.send({type:'failed',category:error.category??error.code});process.disconnect();process.exitCode=1;}
