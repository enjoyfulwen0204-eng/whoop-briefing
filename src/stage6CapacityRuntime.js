import {getHeapStatistics} from 'node:v8';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {runtimePublicationClient,prepareRuntimeUnit,publishRuntimeUnit,disposeRuntimePlan} from './stage6ShortPublication.js';
let active=false,lastFailure,lastPublication;
export function stage6CapacityStatus(){return {active,lastFailure,lastPublication,heapLimit:getHeapStatistics().heap_size_limit,rss:process.memoryUsage.rss()};}
export function createStage6CapacityWorker({db,keys,admission,pilotGrant}){
 const client=runtimePublicationClient(db,{keys,admission,pilotGrant});
 return Object.freeze({async drain({triggerSource='manual',userId,budget={},onProgress=async()=>{}}={}){
  if(active)throw Object.assign(Error('STAGE6_CAPACITY_BUSY'),{code:'STAGE6_CAPACITY_BUSY'});
  if(getHeapStatistics().heap_size_limit>192*1024*1024||process.memoryUsage.rss()>384*1024*1024)
   throw Object.assign(Error('STAGE6_MEMORY_PROFILE_REQUIRED'),{code:'STAGE6_MEMORY_PROFILE_REQUIRED'});
  const parent=currentExecutionBudget();if(!parent)throw Error('STAGE6_BUDGET_REQUIRED');
  parent.assert();active=true;let plan,task,worker;
  try{
   worker=createExecutionBudget({budgetMs:Math.min(30000,parent.remainingMs()),signal:parent.signal});
   for(const event of ['discovery_start','discovery_complete','drain_start'])await onProgress({event});
   const maxItems=Math.min(1,budget.maxItems??1,budget.maxItemsPerTenant??1);
   if(!Number.isSafeInteger(maxItems)||maxItems<1)throw Error('STAGE6_ITEM_BUDGET_INVALID');
   task=withExecutionBudget(worker,async()=>{plan=await prepareRuntimeUnit({client,userId,triggerSource,maxItems});const published=await publishRuntimeUnit(client,plan);lastPublication={preparationMs:published.preparationMs,transactionMs:published.transactionMs,statements:published.statements,snapshotGroups:published.snapshotGroups,snapshotBytes:published.snapshotBytes,workUsage:published.workUsage};return published.result;});
   return await worker.run(()=>task);
  }catch(error){lastFailure={code:error.code??error.name,stage:plan?'PUBLICATION':'PREPARATION',workUsage:error.workUsage,calculationFailures:error.calculationFailures};throw error;}
  finally{try{if(task)await task.catch(()=>{});if(plan)await disposeRuntimePlan(plan);}finally{worker?.close();active=false;}}
 }});
}
