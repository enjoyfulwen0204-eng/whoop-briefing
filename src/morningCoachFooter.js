import {validateNarrative} from './llmValidation.js';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {latestMemory,memoryEvidence} from './associationMemory.js';
import {renderAssociations} from './onDemandAssociations.js';
const sentences=text=>String(text).split(/(?<!\d)[.!?。！？]+\s*|\n+/u).map(s=>s.trim()).filter(Boolean);
const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const grams=s=>new Set([...s].slice(1).map((_,i)=>s.slice(i,i+2)));
/** Dice bigram similarity >= .72 (or an exact contained sentence) is a
 * near-copy. The check is locale-independent and ignores punctuation. */
export function repeatsMorning(answer,report){
 return sentences(answer).some(a=>sentences(report).some(b=>{
  a=normalize(a);b=normalize(b);if(Math.min(a.length,b.length)<8)return a===b;
  if(a.includes(b)||b.includes(a))return true;
  const x=grams(a),y=grams(b),shared=[...x].filter(g=>y.has(g)).length;
  return 2*shared/(x.size+y.size)>=.72;
 }));
}
const canonical=s=>s.replace(/\brecovery\b|phục hồi/giu,'恢復').replace(/\bresting heart rate\b|nhịp tim nghỉ/giu,'靜息心率')
 .replace(/\bsleep performance\b|hiệu suất giấc ngủ/giu,'睡眠表現').replace(/\bsleep debt\b|nợ ngủ/giu,'睡眠債').replace(/\bsleep\b|giấc ngủ/giu,'睡眠')
 .replace(/\bheart rate\b|nhịp tim/giu,'心率').replace(/\brespiratory rate\b|nhịp thở/giu,'呼吸率')
 .replace(/\bsteps\b|số bước/giu,'步數')
 .replace(/\bblood oxygen\b|oxy trong máu/giu,'血氧').replace(/\bskin temperature\b|nhiệt độ da/giu,'皮膚溫度')
 // Normalize only metric-adjacent linking words so the existing metric/value
 // guard cannot be bypassed by English or Vietnamese prose.
 .replace(/(恢復|靜息心率|睡眠表現|睡眠債|睡眠|心率|呼吸率|步數|血氧|皮膚溫度|HRV|RHR|Strain)\s*(?:(?:is|was|at|of|score|là|đạt|ở mức)\s*)+(?=\d)/giu,'$1 ');
export function validMorningFooter(answer,context,report,locale){
 if(typeof answer!=='string'||!answer.trim()||sentences(answer).length<2||sentences(answer).length>3
  ||(locale==='zh-TW'&&[...answer].length>120)||answer.length>650||repeatsMorning(answer,report))return false;
 if(!validateNarrative(canonical(answer),canonical(context)).ok)return false;
 const numbers=new Set(context.match(/\d+(?:\.\d+)?/g)??[]);
 if((answer.match(/\d+(?:\.\d+)?/g)??[]).some(n=>!numbers.has(n)))return false;
 // Complement the existing guard's Chinese/English medical vocabulary for
 // this three-language surface. No advice about drugs, diagnosis or causality.
 if(/\byou (?:have|suffer from) (?:a |an )?(?:disease|infection|disorder)\b|\btreat(?:ment)?\b|\bcaus(?:es?|ed|ing)\b|chẩn đoán|điều trị|uống thuốc|bạn (?:bị|mắc) bệnh|gây ra|dẫn đến|chắc chắn/iu.test(answer))return false;
 return true;
}
export async function morningCoachFooter({text,briefing,locale,coach,db,userId,timeoutMs=20000}){
 if(typeof coach?.footerText!=='function'||(currentExecutionBudget()?.remainingMs()??Infinity)<timeoutMs+5000)return '';
 const budget=createExecutionBudget({budgetMs:Math.min(20000,timeoutMs),signal:currentExecutionBudget()?.signal});
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  const supported=(await latestMemory(db,userId)).filter(row=>row.status==='SUPPORTED');
  const memories=supported.map(row=>renderAssociations(memoryEvidence(row).view,locale)).join('\n');
  const context=text+(memories?'\n'+memories:'');
  const answer=(await coach.footerText({report:text,supported:memories},{locale}))?.trim();
  if(!validMorningFooter(answer,context,text,locale))return '';
  for(const row of supported){const current=await db.getInsight(userId,row.id);
   if(current?.status!=='SUPPORTED'||current.version!==row.version||current.evidence_json!==row.evidence_json)return '';}
  await coach.assertSnapshot?.();budget.assert();
  const heading=({'zh-TW':'💬 教練的話',en:'💬 Coach’s note',vi:'💬 Lời nhắn của huấn luyện viên'})[locale]??'💬 Coach’s note';
  return `\n\n${heading}\n${answer}`;
 }));}catch{return '';}finally{budget.close();}
}
