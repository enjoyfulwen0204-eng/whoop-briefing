import http from 'node:http';
import {createDb} from './localDb.js';
import {withSyncOwnership} from '../src/syncOwnership.js';
import {createExecutionBudget} from '../src/executionBudget.js';
const [url,raw]=process.argv.slice(2),options=JSON.parse(raw),db=createDb({url});
await db.admitRuntime();
const server=http.createServer(async(_req,res)=>{
 const budget=createExecutionBudget({budgetMs:options.budget});
 try{
  await withSyncOwnership({db,userId:'synthetic',budget,leaseMs:options.lease},async()=>{
   process.send?.({event:'entered'});await new Promise(r=>setTimeout(r,options.delay));
   try{await db.raw.execute({sql:"UPDATE users SET display_name=? WHERE id='synthetic'",args:[options.value]});}
   catch(e){process.send?.({event:'late_rejected',code:e.code});throw e;}
  });res.writeHead(200).end('{}');process.send?.({event:'settled',ok:true});
 }catch(e){res.writeHead(e.code==='SYNC_SCOPE_BUSY'?409:504).end(JSON.stringify({code:e.code}));process.send?.({event:'settled',ok:false,code:e.code});}
 finally{budget.close();}
});
server.listen(0,'127.0.0.1',()=>process.send?.({event:'listening',port:server.address().port}));
process.on('message',m=>{if(m==='stop')server.close(()=>{db.close();process.disconnect?.();});});
