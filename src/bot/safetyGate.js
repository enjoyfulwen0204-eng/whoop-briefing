// A bounded safety reduction, independent of the parser's exclusion decision.
// Missing positive syntax proof is never an exclusion certificate. This module
// neither clones symptoms nor changes predicate/operator ownership or evidence.
export const SAFETY_GATE_VERSION='conservative-evidence-v1';
const CURRENT='CURRENT_URGENT',POSSIBLE='POSSIBLE_CURRENT_URGENT',CLEAR='CLEARLY_NONURGENT';
const active=m=>['CURRENT','AMBIGUOUS'].includes(m.state);
const word=/[\p{L}\p{N}]/u;
// Only these complete descriptive complements prove continuing presence.
// Unknown complements retain plausible lineage with POSSIBLE, never absence.
const continuingPresence=new Set(['present','仍然存在','vẫn còn']);
function residual(text,start,end,events){
 let at=start,result='';
 for(const e of events.slice().sort((a,b)=>a.start-b.start||b.end-a.end)){
  if(e.end<=start||e.start>=end)continue;
  if(e.start>at)result+=text.slice(at,Math.min(e.start,end));at=Math.max(at,e.end);
 }
 return (result+text.slice(Math.min(at,end),end)).trim().replace(/\s+/gu,' ').toLocaleLowerCase('en');
}
export function reduceSafetyEvidence(text,graph,mentions){
 const predicates=new Map(graph.predicates.map(p=>[p.id,p]));
 const operators=new Map(graph.predicates.map(p=>[p.id,[]]));
 for(const o of graph.operators)operators.get(o.ownerPredicateId).push(o);
 const compatible=(m,n)=>n!==m&&!n.strong&&n.kind!==m.kind&&active(n)&&(m.predicateId===n.predicateId||m.evidence.actorId&&m.evidence.actorId===n.evidence.actorId)&&Math.abs(n.index-m.index)<=80;
 const supported=mentions.filter(m=>m.strong||active(m)&&mentions.some(n=>compatible(m,n)));
 const frameProof=p=>{
  const visited=new Set();
  for(let depth=0;p&&depth<16&&!visited.has(p.id);depth++){
   visited.add(p.id);
   if(operators.get(p.id).some(o=>o.type==='conditionalFrame'))return true;
   const report=graph.links.find(l=>l.type==='REPORT'&&l.toPredicateId===p.id);
   const source=predicates.get(p.frameSourceId??report?.fromPredicateId);
   p=source?.frame==='HYPOTHETICAL'?source:null;
  }
  return false;
 };
 const closureProven=p=>{
  const ops=operators.get(p.id),outcome=ops.find(o=>o.type==='resolution');
  if(!outcome)return false;
  const targets=graph.symptoms.filter(s=>s.ownerPredicateId===p.id);
  if(!targets.length)return false;
  const lastTarget=Math.max(...targets.map(s=>s.span.end)),firstTarget=Math.min(...targets.map(s=>s.span.start));
  // Only the target-to-outcome interval participates in this certificate.
  // Unparsed material inside it cannot prove compatible resolution; material
  // after the outcome cannot invalidate an already bounded certificate.
  return !word.test(firstTarget>=outcome.end?residual(text,outcome.end,firstTarget,ops):residual(text,lastTarget,outcome.end,ops));
 };
 const certificates=[],unresolved=[],current=[];
 for(const m of supported){
  const p=predicates.get(m.predicateId),ops=operators.get(p.id),e=m.evidence;
  const basis={symptomId:m.id,predicateId:p.id,actorId:e.actorId,state:m.state,operatorIds:ops.map(o=>o.id)};
  if(active(m)){(m.state==='CURRENT'&&(m.strong||mentions.some(n=>compatible(m,n)&&n.state==='CURRENT'))?current:unresolved).push({...basis,text:m.text});continue;}
  // Derived retirement must have its bounded, compatible OUTCOME relationship.
  // Original evidence remains intact and a historical outcome cannot close it.
  const outcome=m.retiredBy&&graph.links.find(l=>l.type==='OUTCOME'&&l.fromPredicateId===m.retiredBy&&l.toPredicateId===p.id);
  let proof=null;
  if(outcome&&predicates.get(m.retiredBy)?.actorId===e.actorId&&(closureProven(predicates.get(m.retiredBy))||operators.get(m.retiredBy).some(o=>o.type==='negative')))proof='COMPATIBLE_OUTCOME';
  else if(m.state==='NEGATED'&&!p.epistemic&&ops.some(o=>o.type==='negative'))proof='OWNED_NEGATION';
  else if(m.state==='RESOLVED'&&!p.epistemic&&closureProven(p)&&ops.some(o=>o.type==='resolution'))proof='OWNED_RESOLUTION';
  else if(m.state==='HISTORICAL'&&ops.some(o=>['pastTime','pastPredicate'].includes(o.type)))proof='OWNED_COMPLETED_HISTORY';
  else if(m.state==='HYPOTHETICAL'&&frameProof(p))proof='LOCAL_HYPOTHETICAL';
  else if(m.state==='EDUCATIONAL'&&p.education)proof='LOCAL_EDUCATION';
  else if(m.state==='INFORMATIONAL'&&p.information)proof='LOCAL_INFORMATION';
  else if(m.state==='QUOTED'&&e.quotation==='MENTIONED')proof='QUOTED_MENTION';
  else if(m.state==='FIGURATIVE'&&ops.some(o=>o.type==='figurative'))proof='OWNED_FIGURATIVE';
  if(proof)certificates.push({...basis,proof,...(outcome?{outcomePredicateId:m.retiredBy,linkId:outcome.id}:{})});
  else unresolved.push({...basis,text:m.text,reason:'EXCLUSION_NOT_PROVEN'});
 }
 const continuations=[];
 for(const p of graph.predicates){
  if(p.symptomIds.length||p.frame!=='ACTUAL'||p.education||p.epistemic||p.quote||!p.actorId||p.actorId.includes(':UNPROVEN:'))continue;
  const ops=operators.get(p.id),inherit=graph.links.find(l=>l.toPredicateId===p.id&&['SUBJECT_INHERIT','REFERENCE'].includes(l.type));
  if(!inherit||ops.some(o=>['actor','pastTime','pastPredicate','negative','resolution','education','information','assertionHead','report'].includes(o.type)))continue;
  const head=ops.find(o=>o.type==='present'),now=ops.find(o=>o.type==='currentTime'),recurrence=ops.find(o=>o.type==='recurrence');
  if(!now&&!head&&!recurrence&&p.argumentProof!=='EXPLICIT_UNMATCHED_ARGUMENT')continue;
  // A separate argument before the head is a barrier, even if its vocabulary
  // is not medical. No subject, quotation or metric relationship is invented.
  if(head&&word.test(residual(text,p.ownedSpan.start,head.start,ops)))continue;
  const parent=predicates.get(inherit.fromPredicateId);
  if(parent?.actorId!==p.actorId||parent.frame!=='ACTUAL'||parent.education||parent.epistemic||parent.quote)continue;
  const ancestors=supported.filter(m=>m.predicateId===parent.id&&(['CURRENT','AMBIGUOUS','HISTORICAL'].includes(m.state)||(head||now||recurrence)&&['RESOLVED','NEGATED'].includes(m.state)));
  for(const m of ancestors){
   const complement=residual(text,head?.end??p.ownedSpan.start,p.ownedSpan.end,ops);
   const proven=Boolean(recurrence)||Boolean(now)&&continuingPresence.has(complement);
   const row={symptomId:m.id,sourcePredicateId:parent.id,predicateId:p.id,actorId:p.actorId,linkId:inherit.id,operatorIds:[...(head?[head.id]:[]),...(now?[now.id]:[]),...(recurrence?[recurrence.id]:[])],proof:recurrence?'OWNED_RECURRENCE':proven?'OWNED_CONTINUING_PRESENCE':'UNRESOLVED_CURRENT_CONTINUATION',decision:proven?CURRENT:POSSIBLE,text:m.text};
   continuations.push(row);(proven?current:unresolved).push(row);
  }
 }
 const selected=current[0]??unresolved[0];
 return {decision:current.length?CURRENT:unresolved.length?POSSIBLE:CLEAR,matched:selected?.text??null,
  safetyGate:{version:SAFETY_GATE_VERSION,candidateIds:supported.map(m=>m.id),exclusions:certificates,unresolved,continuations}};
}
