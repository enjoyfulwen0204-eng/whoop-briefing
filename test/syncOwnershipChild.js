import {createDb} from './localDb.js';
import {withSyncOwnership} from '../src/syncOwnership.js';
import {createExecutionBudget} from '../src/executionBudget.js';
const [url,budgetMs,delayMs,value,leaseMs]=process.argv.slice(2),db=createDb({url});
const budget=createExecutionBudget({budgetMs:Number(budgetMs)});let inner;
try{
 await withSyncOwnership({db,userId:'synthetic',budget,leaseMs:Number(leaseMs)},async()=>{
  process.send?.({event:'entered'});
  inner=(async()=>{await new Promise(r=>setTimeout(r,Number(delayMs)));
   try{await db.raw.execute({sql:"UPDATE users SET display_name=? WHERE id='synthetic'",args:[value]});process.send?.({event:'wrote',value});}
   catch(e){process.send?.({event:'late_rejected',code:e.code});throw e;}
  })();return inner;
 });process.send?.({event:'settled',ok:true});
}catch(e){process.send?.({event:'settled',ok:false,code:e.code});}
finally{try{await inner;}catch{}budget.close();db.close();process.disconnect?.();}
