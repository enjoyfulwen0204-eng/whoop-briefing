// A bounded safety reduction, independent of the parser's exclusion decision.
// Missing positive syntax proof is never an exclusion certificate. This module
// neither clones symptoms nor changes predicate/operator ownership or evidence.
export const SAFETY_GATE_VERSION='conservative-evidence-v1-quotation-ownership';
const CURRENT='CURRENT_URGENT',POSSIBLE='POSSIBLE_CURRENT_URGENT',CLEAR='CLEARLY_NONURGENT';
const active=m=>['CURRENT','AMBIGUOUS'].includes(m.state);
const word=/[\p{L}\p{N}]/u;
const conditional=/^(?:if|what if|suppose|hypothetically|nếu|giả sử|如果|假設|假如|若是|萬一)$/iu;
const validSpan=(text,span)=>Number.isInteger(span?.start)&&Number.isInteger(span?.end)&&span.start>=0&&span.end>span.start&&span.end<=text.length;
const containedInNegative=(head,ops)=>ops.some(o=>o.type==='negative'&&o.start<=head.start&&o.end>=head.end);
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
// Quote-only exclusion is incomplete when an adjacent personal experiential
// predicate has an unfilled argument. This ledger never changes parser nodes.
// Existing lexical heads, actor identities and clause boundaries own all proof.
function quotationEvidence(text,graph,operators){
 const rows=new Map(),frames=new Map();
 const experiential=/^(?:have|has|having|experience|experiencing|experienced|feel|feeling|felt|suffering from|感到|覺得|有|cảm thấy|bị|có)$/iu;
 // Modality here can only lower confidence; it never excludes a candidate.
 const modal=/\b(?:may|might|could|maybe|perhaps|possibly)\b|可能|也許|(?<!\p{L})có thể(?!\p{L})/iu;
 for(let i=0;i<graph.predicates.length;i++){
  const q=graph.predicates[i],unit=q.units[0];
  if(!q.quote)continue;
  const p=graph.predicates[i+1],span=unit.connectorSpan;
  // Connector text and span can originate on opposite sides of a quote.
  // Only source-validated OUTER antecedents can frame an outer complement.
  // An inner conditional stays inside its quotation, even when referenced.
  if(validSpan(text,span)&&conditional.test(text.slice(span.start,span.end))&&span.end<=q.quote.start&&!text.slice(span.end,q.quote.start).trim()){
   const frame={sourcePredicateId:q.id,span:{...span},quoteSpan:{...q.quote},origin:'OUTSIDE_QUOTATION',proof:'LOCAL_QUOTED_CONDITIONAL'};
   frames.set(q.id,frame);
   const link=graph.links.find(l=>l.type==='QUOTE_COMPLEMENT'&&l.fromPredicateId===q.id&&l.toPredicateId===p?.id);
   const next=p?.units[0];
   // A symptom reference alone is insufficient. Require the adjacent copular
   // antecedent, its bounded link and the same verified outer connector.
   if(link&&!p.quote&&p.edge==='quote-tail'&&next.start===q.quote.end&&next.connectorSpan.start===span.start&&next.connectorSpan.end===span.end&&link.span.start>=q.quote.end&&link.span.end<=p.ownedSpan.end)frames.set(p.id,{...frame,linkId:link.id});
  }
  if(!p||p.quote||p.edge!=='quote-tail'||p.symptomIds.length||!p.actorId||p.actor==='GENERIC'||p.information||p.hypothetical||frames.has(q.id))continue;
  const ops=operators.get(p.id),actor=ops.find(o=>o.type==='actor'&&o.role!=='POSSESSOR_OBJECT');
  const head=actor&&ops.find(o=>['present','pastPredicate'].includes(o.type)&&o.start>=actor.end&&experiential.test(o.word)&&!containedInNegative(o,ops));
  if(!head||ops.some(o=>['education','information','conditionalFrame'].includes(o.type)&&o.start<head.end))continue;
  // A different explicit argument is a barrier. Whitespace, owned operators
  // and the already supported Chinese symptom nominal exhaust this slot.
  const argument=residual(text,head.end,p.ownedSpan.end,ops).replace(/的症狀\s*$/u,'');
  if(word.test(argument))continue;
  const prefix=text.slice(p.ownedSpan.start,actor.start).trim();
  const relative=/\bwhat\s*$/iu.test(prefix)||/是\s*$/u.test(prefix)||/(?:triệu chứng|điều)\s*$/iu.test(prefix);
  const copula=/\bis\b|是|(?<!\p{L})là(?!\p{L})/iu.test(prefix);
  if(!relative&&/^(?:have|has|having|有|bị|có)$/iu.test(head.word))continue;
  const scope=ops.filter(o=>o.start>=actor.end),uncertain=p.epistemic||modal.test(prefix)||ops.some(o=>o.type==='negative'&&o.start<actor.start);
  const sameActor=!q.actorId||q.actorId===p.actorId;
  const precise=relative&&copula&&sameActor&&!q.education&&!q.information&&prefix.length<=96;
  const negative=scope.some(o=>o.type==='negative'&&o.end<=head.start)||scope.some(o=>o.type==='resolution'&&/^no longer$/iu.test(o.word)&&o.end<=head.start);
  const past=scope.some(o=>['pastTime','pastPredicate'].includes(o.type))&&!scope.some(o=>o.type==='currentTime');
  if(precise&&!uncertain&&(negative||past))continue;
  const decision=precise&&!uncertain&&!negative&&!past&&head.type==='present'?CURRENT:POSSIBLE;
  rows.set(q.id,{sourcePredicateId:q.id,predicateId:p.id,actorId:p.actorId,operatorIds:ops.map(o=>o.id),span:{start:q.quote.start,end:p.ownedSpan.end},proof:decision===CURRENT?'BOUNDED_QUOTE_ARGUMENT':'UNRESOLVED_QUOTE_REFERENCE',decision});
 }
 return {rows,frames};
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
   if(operators.get(p.id).some(o=>o.type==='conditionalFrame'&&validSpan(text,o.span)&&conditional.test(text.slice(o.start,o.end))&&text.slice(o.start,o.end).toLocaleLowerCase('en')===o.word.toLocaleLowerCase('en')))return true;
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
 const quotation=quotationEvidence(text,graph,operators),quotationRows=[];
 const certificates=[],unresolved=[],current=[];
 for(const m of supported){
  const p=predicates.get(m.predicateId),ops=operators.get(p.id),e=m.evidence;
  const basis={symptomId:m.id,predicateId:p.id,actorId:e.actorId,state:m.state,operatorIds:ops.map(o=>o.id)};
  const quotedFrame=quotation.frames.get(p.id);
  if(quotedFrame){certificates.push({...basis,...quotedFrame});continue;}
  const quotedReference=m.state==='QUOTED'&&quotation.rows.get(p.id);
  if(quotedReference){const row={...basis,...quotedReference,symptomId:m.id,text:m.text};quotationRows.push(row);(row.decision===CURRENT?current:unresolved).push(row);continue;}
  if(active(m)){
   const report=p.quote&&graph.links.find(l=>l.type==='REPORT'&&l.toPredicateId===p.id);
   // Reporting a bare term establishes a speaker, not clinical currentness.
   // Explicit quoted assertions (including supported zero-copula subjects)
   // keep their own evidence. Another actor's wellness is never an exclusion.
   const bareReport=report&&!ops.some(o=>o.type==='actor'&&o.role!=='POSSESSOR_OBJECT'||['present','pastPredicate','currentTime','assertionHead'].includes(o.type)&&!containedInNegative(o,ops));
   (m.state==='CURRENT'&&!bareReport&&(m.strong||mentions.some(n=>compatible(m,n)&&n.state==='CURRENT'))?current:unresolved).push({...basis,text:m.text,...(bareReport?{reason:'REPORTED_CURRENTNESS_UNPROVEN',linkId:report.id,sourcePredicateId:report.fromPredicateId}:{})});continue;
  }
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
  safetyGate:{version:SAFETY_GATE_VERSION,candidateIds:supported.map(m=>m.id),exclusions:certificates,unresolved,continuations,quotations:quotationRows}};
}
