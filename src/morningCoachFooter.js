import {buildFragmentCatalogue,fragmentsArePublishable} from './narrativePlan.js';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {latestMemory,memoryEvidence} from './associationMemory.js';
import {renderAssociations} from './onDemandAssociations.js';

// Keep the accepted closed-vocabulary publishing boundary: MODEL_DAILY may
// choose and order verified sentences, never invent physiological assertions.
export async function morningCoachFooter({text,briefing,locale,coach,db,userId,timeoutMs=20000}){
 if(typeof coach?.footerPlan!=='function'||(currentExecutionBudget()?.remainingMs()??Infinity)<timeoutMs+5000)return '';
 const budget=createExecutionBudget({budgetMs:Math.min(20000,timeoutMs),signal:currentExecutionBudget()?.signal});
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  const fragments=buildFragmentCatalogue(briefing,{locale}).fragments.filter(f=>text.includes(f.text)).map(f=>({...f,required:false}));
  const supported=(await latestMemory(db,userId)).filter(row=>row.status==='SUPPORTED');
  for(const row of supported){const e=memoryEvidence(row),sentence=renderAssociations(e.view,locale).split('\n').slice(1).join(' ');
   fragments.push({id:`memory_${row.id}_${row.version}`,text:sentence,required:false});}
  if(fragments.length<2)return '';
  const plan=await coach.footerPlan(fragments,{locale});
  if(!plan||Object.keys(plan).join(',')!=='order'||!Array.isArray(plan.order)||plan.order.length<2||plan.order.length>3||new Set(plan.order).size!==plan.order.length)return '';
  const selected=plan.order.map(id=>fragments.find(f=>f.id===id));if(selected.some(f=>!f))return '';
  const result=selected.map(f=>f.text).join(' ');
  if((locale==='zh-TW'&&[...result].length>120)||result.length>650||!fragmentsArePublishable(result))return '';
  // Do not publish a supported assertion that was revoked during the AI wait.
  for(const row of supported.filter(r=>plan.order.includes(`memory_${r.id}_${r.version}`))){
   const current=await db.getInsight(userId,row.id);if(current?.status!=='SUPPORTED'||current.version!==row.version||current.evidence_json!==row.evidence_json)return '';
  }
  await coach.assertSnapshot?.();budget.assert();
  const heading=({'zh-TW':'💬 教練的話',en:'💬 Coach’s note',vi:'💬 Lời nhắn của huấn luyện viên'})[locale]??'💬 Coach’s note';
  return `\n\n${heading}\n${result}`;
 }));}catch{return '';}finally{budget.close();}
}
