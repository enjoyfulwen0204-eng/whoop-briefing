import {validateNarrative} from './llmValidation.js';
import {checkAiBudget} from './aiMonthlyBudget.js';
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
export function morningFooterRejection(answer,context,report,locale){
 if(typeof answer!=='string'||!answer.trim()||sentences(answer).length<2||sentences(answer).length>3)return 'FORMAT';
 if((locale==='zh-TW'&&[...answer].length>120)||answer.length>650)return 'LENGTH';
 if(repeatsMorning(answer,report))return 'REPEAT';
 const validation=validateNarrative(canonical(answer),canonical(context));
 if(!validation.ok){
  // Never log problem details: suffixes can contain generated health values.
  const rule=validation.problems[0]?.split(':')[0];
  const allowed=new Set(['empty_answer','causal_language','diagnosis_language','live_claim','proprietary_claim','treatment_advice','unsupported_number','unsupported_date','unsupported_metric_value','metric_value_mismatch','unsupported_metric']);
  return 'VALIDATION:'+(allowed.has(rule)?rule:'UNKNOWN');
 }
 const numbers=new Set(context.match(/\d+(?:\.\d+)?/g)??[]);
 if((answer.match(/\d+(?:\.\d+)?/g)??[]).some(n=>!numbers.has(n)))return 'FACT_CHECK';
 // Complement the existing guard's Chinese/English medical vocabulary for
 // this three-language surface. No advice about drugs, diagnosis or causality.
 if(/\byou (?:have|suffer from) (?:a |an )?(?:disease|infection|disorder)\b|\btreat(?:ment)?\b|\bcaus(?:es?|ed|ing)\b|chẩn đoán|điều trị|uống thuốc|bạn (?:bị|mắc) bệnh|gây ra|dẫn đến|chắc chắn/iu.test(answer))return 'VALIDATION:medical_language';
 return null;
}
export const validMorningFooter=(...args)=>morningFooterRejection(...args)===null;
export async function morningCoachFooter({text,briefing,locale,coach,db,userId,keys,timeoutMs=25000}){
 let reason=null,llmStart=null,llmEnd=null,contextStart=null,contextEnd=null,budget=null,phase='CONTEXT';
 const parent=currentExecutionBudget(),reserveMs=15000;
 try{
  if(typeof coach?.footerText!=='function'){reason='LLM_UNAVAILABLE';return '';}
  if((await checkAiBudget({db,userId})).limited){reason='AI_MONTHLY_CAP_REACHED';return '';}
  if((parent?.remainingMs()??Infinity)<timeoutMs+reserveMs){reason='BUDGET_TOO_LOW';return '';}
  contextStart=Date.now();
  const supported=(await latestMemory(db,userId)).filter(row=>row.status==='SUPPORTED');
  const memories=supported.map(row=>renderAssociations(memoryEvidence(row).view,locale)).join('\n');
  const context=text+(memories?'\n'+memories:'');contextEnd=Date.now();
  // Context preparation never consumes the LLM's own timeout. Recheck the
  // parent deadline immediately before the optional request; preserve room
  // for existing authority/insight validation and report delivery.
  if((parent?.remainingMs()??Infinity)<timeoutMs+reserveMs){reason='BUDGET_TOO_LOW';return '';}
  budget=createExecutionBudget({budgetMs:timeoutMs,signal:parent?.signal});
  phase='LLM';llmStart=Date.now();let raw;
  try{raw=await withExecutionBudget(budget,()=>budget.run(()=>coach.footerText({report:text,supported:memories},{locale})));}
  finally{llmEnd=Date.now();budget.close();}
  phase='VALIDATION';const answer=typeof raw==='string'?raw.trim():raw;
  reason=morningFooterRejection(answer,context,text,locale);if(reason)return '';
  phase='INSIGHT';
  for(const row of supported){const current=await db.getInsight(userId,row.id);
   if(current?.status!=='SUPPORTED'||current.version!==row.version||current.evidence_json!==row.evidence_json){reason='INSIGHT_CHANGED';return '';}}
  phase='SNAPSHOT';await coach.assertSnapshot?.();parent?.assert();
  const heading=({'zh-TW':'💬 教練的話',en:'💬 Coach’s note',vi:'💬 Lời nhắn của huấn luyện viên'})[locale]??'💬 Coach’s note';
  return `\n\n${heading}\n${answer}`;
 }catch(error){
  reason=error?.code==='SYNC_TIMEOUT'||error?.name==='TimeoutError'?'TIMEOUT':
   error?.code==='SYNC_CANCELLED'?'CANCELLED':({LLM:'LLM_ERROR',CONTEXT:'CONTEXT_ERROR',VALIDATION:'VALIDATION_ERROR',INSIGHT:'INSIGHT_CHECK_ERROR',SNAPSHOT:'SNAPSHOT_CHANGED'})[phase];
  return '';
 }finally{
  budget?.close();
  try{
   const hashed=keys?.lookup(['companion-diagnostic-user-v1',userId]);
   console.log(JSON.stringify({event:reason?'morning_coach_footer_omitted':'morning_coach_footer_completed',user:/^[a-f0-9]{64}$/.test(hashed??'')?hashed:'UNKNOWN',reason:reason??'OK',
    context_duration_ms:contextStart===null?0:Math.max(0,(contextEnd??Date.now())-contextStart),
    llm_duration_ms:llmStart===null?0:Math.max(0,(llmEnd??Date.now())-llmStart)}));
  }catch{/* Diagnostics cannot prevent the morning brief. */}
 }
}
