import {t} from '../localization.js';

export const TRIAGE_LIMITS=Object.freeze({characters:8192,clauses:128,mentions:128,predicates:128,operators:256,links:512,depth:16});
export const TRIAGE_DECISION=Object.freeze({
 CURRENT_URGENT:'CURRENT_URGENT',
 POSSIBLE_CURRENT_URGENT:'POSSIBLE_CURRENT_URGENT',
 CLEARLY_NONURGENT:'CLEARLY_NONURGENT',
});
const SYMPTOMS=[
 ['chest',true,/胸(?:口|部)?(?:很|好|超)?(?:痛|悶|緊)|\bchest (?:pain|pressure|tightness)\b|\bchest (?:hurts|is tight)\b|(?<!\p{L})(?:đau ngực|tức ngực|nặng ngực)(?!\p{L})/iu],
 ['breathing',true,/喘不過氣|呼吸困難|吸不到空氣|無法呼吸|\b(?:cannot breathe|can't breathe|unable to breathe|difficulty breathing|trouble breathing|shortness of breath|short of breath|struggling to breathe)\b|(?<!\p{L})(?:khó thở|không thở được|không thể thở)(?!\p{L})/iu],
 ['consciousness',true,/快(?:要)?昏倒|要昏倒了|昏過去|失去意識|意識模糊|意識不清|失去知覺|暈倒|叫不醒|叫不起來|沒有反應|沒反應|\b(?:(?:feel|feeling|about to|going to) faint|pass(?:ing|ed)? out|los(?:e|ing|t) consciousness|unconscious|unresponsive|cannot wake up|can't wake up)\b|(?<!\p{L})(?:sắp ngất|sắp xỉu|ngất xỉu|bất tỉnh|mất ý thức|không tỉnh lại)(?!\p{L})/iu],
 ['collapse',true,/(?:突然)?(?:全身)?無力.{0,6}(?:站不起來|動不了)|站不起來|癱軟/iu],
 ['sweat',true,/冒冷汗/iu],['vomiting',true,/一直吐|狂吐|吐不停|嘔吐不止/iu],
 // These are urgent only as an asserted combination, not independently.
 ['heartbeat',false,/心跳(?:很|好)?快|心跳|心悸|\bheart (?:is )?racing\b|\bpalpitations\b|(?<!\p{L})(?:tim đập nhanh|hồi hộp)(?!\p{L})/iu],
 ['breathingHint',false,/喘/iu],
 ['dizziness',false,/頭暈|暈|\bdizz(?:y|iness)\b|(?<!\p{L})chóng mặt(?!\p{L})/iu],
];
/**
 * A finite evidence interpreter. Regexes below only lex semantic operators;
 * no regex decides urgency or vetoes an entire message. Unknown modifiers do
 * not terminate a predicate's polarity. New actors/predicates and structural
 * edges do. Each symptom keeps its evidence before the final decision.
 */
const OPERATORS=[
 ['actor',/(?<![\p{L}\p{N}_])(?:my (?:friend|mother|father|child|wife|husband)|i|my|he|she|his|her|we|they|people|patients|someone|the patient)(?![\p{L}\p{N}_])|我朋友|我|他|她|媽媽|爸爸|朋友|有人|病人|(?<!\p{L})(?:tôi|anh ấy|cô ấy|bạn tôi)(?!\p{L})/giu],
 ['present',/\b(?:have|has|having|experience|experiencing|feel|feeling|suffering from|am|is|are)\b|感到|覺得|出現|有|(?<!\p{L})(?:bị|có|cảm thấy)(?!\p{L})/giu],
 ['pastPredicate',/\b(?:had|experienced|felt|was|were)\b/giu],
 ['pastTime',/昨天|昨晚|以前|曾經|之前|\b(?:yesterday|last (?:night|week|month|year)|years ago)\b|hôm qua|trước đây/giu],
 ['currentTime',/現在|目前|正在|此刻|\b(?:now|currently|current|right now|still)\b|đang|hiện tại|bây giờ/giu],
 ['negative',/\b(?:no|not|without|never|neither|don't|do not|doesn't|does not)\b|沒有|沒|不會|不曾|並沒|未|(?<!\p{L})(?:không|chưa|chẳng)(?!\p{L})/giu],
 ['resolution',/\b(?:no longer|stopped|resolved|gone|went away|cleared|disappeared|back to normal|fine|well|okay)\b|不再|已無|好了|沒事了|恢復了|不會了|沒問題了|緩解了|沒有了|消失了|(?<!\p{L})(?:hết|khỏi|ổn|bình thường)(?!\p{L})/giu],
 ['recurrence',/\b(?:again|back|returned|returning|recurring|came back)\b|又來了|又出現|復發|trở lại|tái phát/giu],
 ['education',/\b(?:what (?:is|are|does|causes)|define|definition|usually|generally|in general|meaning|means|learn about|learning|want to know|question about|asking about|information about|be caused by|why (?:do|does) (?:people|patients))\b|通常|一般來說|一般而言|一般|哪些|什麼原因|是什麼意思|代表什麼|定義|怎麼分辨|為什麼會有人|想知道|là gì|nghĩa là|nguyên nhân|thường|tại sao|tìm hiểu|hỏi/giu],
 ['information',/\b(?:in (?:this|an?) (?:example|case study)|hypothetical case|fictional|(?:article|textbook|example))\b|假設案例|教科書|例句|舉例|ví dụ|trường hợp giả định/giu],
 ['report',/\b(?:says|said|saying|tells|told|telling)\b|說|(?<!\p{L})nói(?!\p{L})/giu],
 ['reference',/(?<![\p{L}\p{N}_])(?:it|it's|this|these symptoms|that pain|they)(?![\p{L}\p{N}_])|這個症狀|這些症狀|它|(?<!\p{L})(?:nó|triệu chứng này)(?!\p{L})/giu],
 ['uncertainty',/\b(?:wonder|unsure|uncertain|not sure|whether)\b|不確定|懷疑|không chắc|không biết/giu],
 ['ongoing',/\b(?:experiencing|having|feeling|happening|have|has)\b|有|感到|經歷|發生|(?<!\p{L})(?:bị|có|cảm thấy)(?!\p{L})/giu],
 ['figurative',/笑(?:到|得|死)|(?:recovery|hrv|strain|分數|數字|指數|股票|房價|價格)[^。，,]{0,6}(?:低|高|爛|差|掉)(?:到|得)|(?:工作|案子|天氣|事情|行程|會議|考試|報告)[^。，,]{0,4}(?:累|忙|煩)到|(?:累|忙|煩|氣)到讓人|laugh(?:ing|ed)? (?:so hard|until)|cười.{0,20}(?:khó thở|ngất)/giu],
];
const EDGES=/[.!?。！？\n]+|[,，、;；]+|(?<!\p{L})(?:even though|although|however|because|after|while|but|yet|and|or|nor|also|which|that|if|suppose|hypothetically|what if|nhưng|tuy nhiên|mặc dù|sau khi|vì|dù|và|hoặc|hay|nếu|giả sử)(?!\p{L})|但是|可是|不過|因為|雖然|假設|假如|如果|若是|萬一|但|而且|也|和|與|或|又|且/giu;
const WORD=/[\p{L}\p{N}_]/u;
function quotesOf(text){
 const out=[],stack=[];
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==="'"&&WORD.test(text[i-1]??'')&&WORD.test(text[i+1]??''))continue;
  if(stack.length&&c===stack.at(-1).close){const q=stack.pop();if(!stack.length)out.push({start:q.start,end:i+1,depth:q.depth});}
  else if(['"',"'",'「','『'].includes(c)&&!(c==="'"&&WORD.test(text[i-1]??''))){
   const depth=stack.length+1;if(depth>TRIAGE_LIMITS.depth)return null;
   for(const q of stack)q.depth=Math.max(q.depth,depth);
   stack.push({start:i,close:{'「':'」','『':'』'}[c]??c,depth});
  }
 }
 return stack.length?null:out;
}
function symptomsOf(text){
 const all=[];
 for(const [kind,strong,re] of SYMPTOMS)for(const m of text.matchAll(new RegExp(re.source,re.flags+'g')))all.push({kind,strong,text:m[0],start:m.index,end:m.index+m[0].length});
 return all.sort((a,b)=>a.start-b.start||b.end-a.end).filter((m,i,a)=>!a.slice(0,i).some(n=>n.start<=m.start&&n.end>=m.end));
}
function edgeKind(word){
 if(/^[.!?。！？\n]/u.test(word))return 'sentence';
 if(/^[,，、;；]/u.test(word))return 'comma';
 if(/^(?:if|what if|suppose|hypothetically|nếu|giả sử|如果|假設|假如|若是|萬一)$/iu.test(word))return 'hypothetical';
 if(/^(?:which|that)$/iu.test(word))return 'relative';
 if(/^(?:although|even though|after|while|mặc dù|sau khi|dù|雖然)$/iu.test(word))return 'subordinate';
 if(/^(?:because|vì|因為)$/iu.test(word))return 'cause';
 if(/^(?:but|however|yet|nhưng|tuy nhiên|但是|可是|不過|但)$/iu.test(word))return 'contrast';
 return 'coordinate';
}
function clausesOf(text,symptoms,quotes){
 const parts=[];let start=0,edge='start',connector='',connectorSpan={start:0,end:0};
 for(const m of text.matchAll(EDGES)){
  if(symptoms.some(s=>m.index>s.start&&m.index<s.end)||quotes.some(q=>m.index>q.start&&m.index<q.end))continue;
  if(text.slice(start,m.index).trim())parts.push({start,end:m.index,edge,connector,connectorSpan,text:text.slice(start,m.index)});
  edge=edgeKind(m[0]);connector=m[0];connectorSpan={start:m.index,end:m.index+m[0].length};start=m.index+m[0].length;
 }
 if(text.slice(start).trim())parts.push({start,end:text.length,edge,connector,connectorSpan,text:text.slice(start)});
 return parts;
}
function eventsOf(part){
 const result=[];
 for(const [type,re] of OPERATORS)for(const m of part.text.matchAll(re)){
  if(part.symptoms.some(s=>m.index>=s.start&&m.index<s.end))continue;
  // These are semantic operators, not the negative component of a registered
  // inability-to-breathe expression. That expression is an indivisible symptom.
  if(type==='negative'&&m[0].toLowerCase()==='not'&&/^\s+only\b/iu.test(part.text.slice(m.index+m[0].length)))continue;
  result.push({type,word:m[0],start:m.index,end:m.index+m[0].length,quote:part.quotes.findIndex(q=>m.index>=q.start&&m.index<q.end)});
 }
 return result.sort((a,b)=>a.start-b.start||b.end-a.end);
}
const ofType=(events,type)=>events.filter(e=>e.type===type);
const last=(events,type)=>ofType(events,type).at(-1);
function speakerOf(event){
 if(!event)return null;
 const word=event.word.toLowerCase();
 if(['i','my','we','我','tôi'].includes(word))return 'SELF';
 if(['people','patients','someone','the patient','有人','病人'].includes(word))return 'GENERIC';
 return {'我朋友':'my friend','朋友':'my friend','bạn tôi':'my friend','媽媽':'my mother','爸爸':'my father','他':'he','她':'she','anh ấy':'he','cô ấy':'she','his':'he','her':'she'}[word]??word;
}
function negativeAt(events,position){
 // Callers supply only one predicate's owned operators. An object possessor
 // or an arbitrary modifier cannot terminate that predicate's negation.
 return events.some(e=>e.type==='negative'&&e.end<=position);
}
function outcomeEvidence(events){
 const resolved=last(events,'resolution'),recurrence=last(events,'recurrence');
 const unresolved=resolved&&negativeAt(events,resolved.start);
 return {absent:Boolean(recurrence&&negativeAt(events,recurrence.start)),resolved:Boolean(resolved&&!unresolved),ongoing:Boolean(unresolved),recurrence:Boolean(recurrence&&(!resolved||recurrence.start>resolved.start)&&!negativeAt(events,recurrence.start))};
}
// The vocabulary and grammar are one deterministic, in-process contract. No
// transport, model, database or health-context input participates in parsing.
export const TRIAGE_GRAMMAR_VERSION='predicate-ownership-v1';
const spanOf=e=>({start:e.start,end:e.end});
const isHead=e=>['present','pastPredicate','report'].includes(e.type);
const intrinsic=s=>/^(?:cannot|can't|unable|không thở|không thể thở|無法|喘不過氣)/iu.test(s.text);
const connective=p=>['coordinate','comma','cause'].includes(p.edge);
function stateOf(e){
 if(e.framing!=='ACTUAL')return e.framing;
 if(e.polarity==='NEGATED'||e.resolution==='ABSENT')return 'NEGATED';
 if(e.resolution==='RESOLVED')return 'RESOLVED';
 if(e.temporal==='PAST')return 'HISTORICAL';
 return e.assertion==='ACTUAL'||e.temporal==='CURRENT'?'CURRENT':'AMBIGUOUS';
}
function overflow(){return {decision:TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT,urgent:true,matched:null,excluded:null,reason:'scope_limit',mentions:[]};}

// All boundaries are constructed before any symptom is evaluated. Punctuation
// is a candidate boundary, not evidence authority. An explicit subject with a
// head also creates a boundary, even when its connector is not in EDGES.
function unitsOf(text,lexical,quotes){
 const parts=clausesOf(text,lexical,quotes),units=[];
 const add=(part,start,end,quote=null,edge=part.edge,connector=part.connector)=>{
  const value=text.slice(start,end);if(!value.trim())return;
  const local={text:value,symptoms:symptomsOf(value),quotes:[]};
  const events=eventsOf(local).map(e=>({...e,start:start+e.start,end:start+e.end}));
  const symptoms=local.symptoms.map(e=>({...e,start:start+e.start,end:start+e.end}));
  const actors=ofType(events,'actor');let boundary=start,hasSubject=false;
  for(const actor of actors){
   const before=events.filter(e=>e.start>=boundary&&e.end<=actor.start);
   const beforeSymptoms=symptoms.filter(e=>e.start>=boundary&&e.end<=actor.start);
   const after=events.filter(e=>e.start>=actor.end);
   const governing=before.filter(isHead).at(-1),nextSymptom=symptoms.find(e=>e.start>=actor.end);
   const objectPossessor=['my','his','her'].includes(actor.word.toLowerCase())&&!beforeSymptoms.length&&governing&&!before.some(e=>e.start>governing.start&&['resolution','pastTime','education','uncertainty'].includes(e.type))&&!after.some(e=>isHead(e)&&e.start<(nextSymptom?.start??end));
   if(objectPossessor){actor.role='POSSESSOR_OBJECT';continue;}
   actor.role='SUBJECT';
   const newHead=after.some(isHead)||symptoms.some(e=>e.start>=actor.end)||after.some(e=>['resolution','recurrence'].includes(e.type));
   if(hasSubject&&newHead&&(beforeSymptoms.length||before.some(e=>isHead(e)||['resolution','education','uncertainty','pastTime','currentTime','negative'].includes(e.type)))){
    const prefix=before.filter(e=>['pastTime','currentTime','negative','resolution'].includes(e.type)&&!text.slice(e.end,actor.start).trim()).at(-1);
    const cut=prefix?.start??actor.start;
    units.push({start:boundary,end:cut,edge,connector,quote,connectorSpan:part.connectorSpan,events:events.filter(e=>e.start>=boundary&&e.end<=cut),symptoms:symptoms.filter(e=>e.start>=boundary&&e.end<=cut)});
    boundary=cut;edge='subject';connector='';
   }
   hasSubject=true;
  }
  units.push({start:boundary,end,edge,connector,quote,connectorSpan:part.connectorSpan,events:events.filter(e=>e.start>=boundary&&e.end<=end),symptoms:symptoms.filter(e=>e.start>=boundary&&e.end<=end)});
 };
 for(const part of parts){
  let start=part.start;
  for(const quote of quotes.filter(q=>q.start>=part.start&&q.end<=part.end)){
   add(part,start,quote.start);
   const inside=text.slice(quote.start+1,quote.end-1);
   const inner=clausesOf(inside,symptomsOf(inside),[]);
   for(const ip of inner)add(part,quote.start+1+ip.start,quote.start+1+ip.end,quote,ip.edge==='start'?'quote':ip.edge,ip.connector);
   start=quote.end;
  }
  add(part,start,part.end,null,start>part.start?'quote-tail':part.edge);
 }
 // Multiple objects share a predicate only through a proven list edge. A
 // separate head, or an unsupported symptom relationship, cannot inherit a
 // preceding past/negative operator merely because punctuation is absent.
 const bounded=[];
 for(const unit of units){
  let start=unit.start,edge=unit.edge;
  for(let i=1;i<unit.symptoms.length;i++){
   const old=unit.symptoms[i-1],next=unit.symptoms[i];
   const between=unit.events.filter(e=>e.start>=old.end&&e.end<=next.start);
   const head=between.find(e=>isHead(e)&&!between.some(o=>o.type==='resolution'&&o.start>e.start));
   const modifier=between.filter(e=>['currentTime','negative'].includes(e.type)&&!text.slice(e.end,head?.start??next.start).trim()).at(-1);
   const cut=modifier?.start??head?.start??next.start;
   bounded.push({...unit,start,end:cut,edge,events:unit.events.filter(e=>e.start>=start&&e.end<=cut),symptoms:unit.symptoms.filter(e=>e.start>=start&&e.end<=cut)});
   start=cut;edge=head?'predicate':'unresolved';
  }
  bounded.push({...unit,start,edge,events:unit.events.filter(e=>e.start>=start),symptoms:unit.symptoms.filter(e=>e.start>=start)});
 }
 return {parts,units:bounded};
}
function buildOwnership(text,lexical,quotes){
 const {parts,units}=unitsOf(text,lexical,quotes);
 if(parts.length>TRIAGE_LIMITS.clauses)return null;
 const predicates=[],symptoms=[],operators=[],links=[];
 const link=(type,from,to,proof)=>links.push({id:'L'+(links.length+1),type,fromPredicateId:from.id,toPredicateId:to.id,span:spanOf(proof)});
 let previous=null;
 for(const unit of units){
  const actorEvent=ofType(unit.events,'actor')[0],explicit=speakerOf(actorEvent);
  const first=unit.symptoms[0],heads=unit.events.filter(isHead);
  const independent=first&&intrinsic(first)&&/^(?:and|also|và|也|又|而且|且)$/iu.test(unit.connector);
  const list=previous&&first&&!actorEvent&&unit.quote===previous.quote&&['coordinate','comma'].includes(unit.edge)&&previous.symptomIds.length&&!independent&&!unit.events.some(e=>e.type==='negative'&&e.end<=first.start)&&(!heads.length||heads[0].start>=first.end);
  if(list){
   previous.ownedSpan.end=unit.end;
   previous.units.push(unit);
   for(const symptom of unit.symptoms){const node={...symptom,id:'S'+(symptoms.length+1),span:spanOf(symptom),ownerPredicateId:previous.id};symptoms.push(node);previous.symptomIds.push(node.id);}
   for(const event of unit.events){const op={...event,id:'O'+(operators.length+1),span:spanOf(event),ownerPredicateId:previous.id};operators.push(op);previous.operatorIds.push(op.id);}
   if(symptoms.length>TRIAGE_LIMITS.mentions||operators.length>TRIAGE_LIMITS.operators)return null;
   continue;
  }
  const head=heads.find(e=>e.type==='pastPredicate'||e.type==='report')??heads.find(e=>!['am','is','are'].includes(e.word.toLowerCase()))??heads[0]??first??unit.events.find(e=>['resolution','recurrence','reference'].includes(e.type));
  const p={id:'P'+(predicates.length+1),headSpan:head?spanOf(head):{start:unit.start,end:unit.start},ownedSpan:{start:unit.start,end:unit.end},actor:explicit??null,assertion:'UNRESOLVED',frame:'ACTUAL',symptomIds:[],operatorIds:[],edge:unit.edge,quote:unit.quote,units:[unit]};
  const source=last(unit.events,'information'),education=last(unit.events,'education');
  const ownedCurrent=actorEvent&&['my','his','her','我','tôi'].includes(actorEvent.word.toLowerCase())&&unit.events.some(e=>e.type==='currentTime'&&e.start<=(first?.start??unit.end));
  const epistemic=unit.events.some(e=>e.type==='uncertainty')||['hypothetical','subject'].includes(unit.edge)&&previous?.epistemic;
  p.epistemic=Boolean(epistemic);p.hypothetical=Boolean((unit.edge==='hypothetical'||connective(unit)&&previous?.hypothetical)&&!epistemic&&!ownedCurrent);
  p.information=Boolean(source||(connective(unit)||unit.edge==='relative'||unit.edge==='sentence'&&['he','she','they'].includes(explicit))&&previous?.information&&explicit!=='SELF');
  p.education=Boolean(education||!actorEvent&&['coordinate','comma'].includes(unit.edge)&&previous?.education);
  p.frame=p.hypothetical?'HYPOTHETICAL':p.information?'INFORMATIONAL':unit.quote?'QUOTED':'ACTUAL';
  if(previous&&(p.hypothetical&&unit.edge!=='hypothetical'||p.epistemic&&!unit.events.some(e=>e.type==='uncertainty')||p.information&&!source||p.education&&!education)){
   const origin=predicates.find(q=>q.id===previous.frameSourceId)??previous;
   const proof=operators.find(o=>o.ownerPredicateId===origin.id&&['conditionalFrame','epistemicFrame','uncertainty','information','education'].includes(o.type));
   if(proof){p.frameSourceId=origin.id;link('FRAME',origin,p,proof);}
  }
  if(!actorEvent&&previous&&(connective(unit)||unit.edge==='contrast'||unit.edge==='relative'||unit.edge==='subordinate'||unit.edge==='quote-tail'||unit.edge==='predicate')){
   p.actor=previous.actor;link('SUBJECT_INHERIT',previous,p,unit.connectorSpan?.end>unit.connectorSpan?.start?unit.connectorSpan:head??unit);
  }
  // First person inside a quotation is relative to its actual reporter. A
  // standalone quotation has no authenticated SELF binding.
  if(unit.quote){
   const wrapper=predicates.filter(q=>!q.quote&&q.ownedSpan.end<=unit.quote.start).at(-1);
   const ev=wrapper?operators.filter(o=>o.ownerPredicateId===wrapper.id):[];
   const report=last(ev,'report'),present=last(ev,'present')||last(ev,'currentTime');
   const reporter=wrapper?.actor&&wrapper.actor!=='GENERIC'&&!wrapper.education&&!wrapper.information;
   if(reporter&&(report||present)){
    if(!explicit||explicit==='SELF')p.actor=wrapper.actor;
    p.hypothetical=wrapper.hypothetical;p.epistemic=wrapper.epistemic;p.frame=p.hypothetical?'HYPOTHETICAL':'ACTUAL';p.quotedAssertion=true;link('REPORT',wrapper,p,report??present);
   }else{p.actor=explicit==='SELF'?null:explicit;p.frame='QUOTED';}
  }
  // A local relative/deictic reference can create its own actual predicate;
  // it never imports the antecedent's temporal or framing operators.
  const reference=last(unit.events,'reference');
  const outcome=outcomeEvidence(unit.events);
  const antecedent=predicates.filter(q=>q.symptomIds.length).at(-1);
  const implicit=!actorEvent&&!first&&(outcome.resolved||outcome.absent||['coordinate','comma'].includes(unit.edge)&&(outcome.ongoing||last(unit.events,'currentTime')&&last(unit.events,'present')));
  const samePast=explicit&&antecedent?.actor===explicit&&operators.some(o=>o.ownerPredicateId===antecedent.id&&['pastTime','pastPredicate'].includes(o.type));
  const related=Boolean(antecedent&&!first&&unit.edge!=='subordinate'&&(reference||unit.edge==='relative'||implicit||samePast&&outcome.resolved));
  if(related){
   p.actor=actorEvent?.word.toLowerCase()==='they'&&reference?.word.toLowerCase()==='they'&&antecedent.symptomIds.length>1?antecedent.actor:explicit??antecedent.actor;
   link('REFERENCE',antecedent,p,reference??head??{start:unit.start,end:unit.end});
   p.referenceId=antecedent.id;
   const continued=outcome.resolved||outcome.absent||outcome.ongoing||outcome.recurrence||last(unit.events,'ongoing')||last(unit.events,'currentTime');
   if(continued&&!p.education&&!p.hypothetical&&!p.information&&!unit.quote){
    for(const id of antecedent.symptomIds){const old=symptoms.find(s=>s.id===id);const node={kind:old.kind,strong:old.strong,text:text.slice(unit.start,unit.end).trim(),start:unit.start,end:unit.end,id:'S'+(symptoms.length+1),span:spanOf(reference??head??unit),ownerPredicateId:p.id,referenceSymptomId:id};symptoms.push(node);p.symptomIds.push(node.id);}
   }
  }
  for(const symptom of unit.symptoms){const node={...symptom,id:'S'+(symptoms.length+1),span:spanOf(symptom),ownerPredicateId:p.id};symptoms.push(node);p.symptomIds.push(node.id);}
  for(const event of unit.events){const op={...event,id:'O'+(operators.length+1),span:spanOf(event),ownerPredicateId:p.id};operators.push(op);p.operatorIds.push(op.id);}
  if(unit.edge==='hypothetical'){
   const op={id:'O'+(operators.length+1),type:epistemic?'epistemicFrame':'conditionalFrame',word:unit.connector,start:unit.start-unit.connector.length,end:unit.start,span:{start:unit.start-unit.connector.length,end:unit.start},ownerPredicateId:p.id};operators.push(op);p.operatorIds.push(op.id);p.ownedSpan.start=Math.min(p.ownedSpan.start,op.start);
  }
  predicates.push(p);previous=p;
  if(predicates.length>TRIAGE_LIMITS.predicates||symptoms.length>TRIAGE_LIMITS.mentions||operators.length>TRIAGE_LIMITS.operators||links.length>TRIAGE_LIMITS.links)return null;
 }
 return {version:TRIAGE_GRAMMAR_VERSION,predicates,symptoms,operators,links};
}
function evaluatePredicate(p,graph){
 // Ownership is the ONLY event selection criterion. No prefix, previous
 // symptom cutoff or group identifier can supply evidence to this evaluator.
 const events=graph.operators.filter(e=>e.ownerPredicateId===p.id);
 const first=graph.symptoms.find(s=>s.ownerPredicateId===p.id);
 const before=events.filter(e=>e.end<=(first?.start??p.ownedSpan.end));
 const actorEvent=ofType(events,'actor')[0],topic=last(before,'education'),source=last(before,'information');
 const personal=p.actor&&p.actor!=='GENERIC'&&(!topic||actorEvent?.start>topic.start)&&(!source||actorEvent?.start>source.start);
 const outcome=outcomeEvidence(events),now=last(events,'currentTime'),past=last(events,'pastPredicate')||last(events,'pastTime');
 const actual=Boolean(personal||p.quotedAssertion||p.referenceId&&!p.education)&&!p.epistemic;
 const education=p.education&&!actual;
 const frame=p.frame!=='ACTUAL'?p.frame:education?'EDUCATIONAL':events.some(e=>e.type==='figurative')?'FIGURATIVE':'ACTUAL';
 const evidence={assertion:actual?'ACTUAL':education||p.information||frame==='QUOTED'?'TOPIC':'UNRESOLVED',speaker:p.actor,
  polarity:negativeAt(before,first?.start??p.ownedSpan.end)&&!outcome.ongoing?'NEGATED':'POSITIVE',
  temporal:p.epistemic?'UNKNOWN':now||outcome.ongoing||outcome.recurrence&&!past?'CURRENT':past?'PAST':actual?'CURRENT':'UNKNOWN',
  resolution:outcome.absent?'ABSENT':outcome.resolved&&!outcome.recurrence?'RESOLVED':outcome.ongoing?'ONGOING':outcome.recurrence?'RECURRENT':'UNKNOWN',
  framing:frame,quotation:p.quote?p.quotedAssertion?'ASSERTED':'MENTIONED':'NONE',relationship:p.referenceId?'ADJACENT_REFERENCE':p.units.length>1?'COORDINATED':'INDEPENDENT'};
 return evidence;
}
function positive(m){return ['CURRENT','AMBIGUOUS'].includes(m.state);}

/** Full ownership traces are in-memory inspection data only. Ingress consumes
 * assessUrgency's small decision adapter and never logs or persists this graph.
 */
export function interpretUrgentSymptoms(input){
 const raw=String(input??'');if(raw.length>TRIAGE_LIMITS.characters)return overflow();
 const text=raw.normalize('NFC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').trim();
 const lexical=symptomsOf(text);if(lexical.length>TRIAGE_LIMITS.mentions)return overflow();
 const quotes=quotesOf(text);if(!quotes)return lexical.length?overflow():{decision:TRIAGE_DECISION.CLEARLY_NONURGENT,urgent:false,matched:null,excluded:null,mentions:[]};
 if(lexical.length&&quotes.some(q=>q.depth>1))return {...overflow(),reason:'quotation_scope'};
 const graph=buildOwnership(text,lexical,quotes);if(!graph)return overflow();
 const mentions=[];
 for(const p of graph.predicates){
  const evidence=Object.freeze(evaluatePredicate(p,graph));p.assertion=evidence.assertion;p.frame=evidence.framing;
  for(const id of p.symptomIds){const s=graph.symptoms.find(s=>s.id===id);mentions.push({...s,index:s.start,group:Number(p.id.slice(1)),predicateId:p.id,evidence,speaker:evidence.speaker,state:stateOf(evidence)});}
 }
 // Latest same-subject/same-symptom outcomes produce bounded links and derived
 // active states. Earlier evidence is immutable; historical or other-speaker
 // outcomes cannot rewrite another assertion.
 for(const m of mentions){
  const closed=m.evidence.polarity==='NEGATED'?'ABSENT':m.evidence.resolution;
  if(!['RESOLVED','ABSENT'].includes(closed)||m.evidence.temporal==='PAST'||m.evidence.framing!=='ACTUAL'||!m.speaker)continue;
  for(const old of mentions){
   if(old===m)break;
   if(old.predicateId===m.predicateId||old.kind!==m.kind||old.speaker!==m.speaker||!['CURRENT','AMBIGUOUS','HISTORICAL'].includes(old.state))continue;
   if(graph.links.length>=TRIAGE_LIMITS.links)return overflow();
   graph.links.push({id:'L'+(graph.links.length+1),type:'OUTCOME',fromPredicateId:m.predicateId,toPredicateId:old.predicateId,span:m.span});
   old.state=closed==='ABSENT'?'NEGATED':'RESOLVED';old.retiredBy=m.predicateId;
  }
 }
 const compatible=(m,n)=>n!==m&&!n.strong&&n.kind!==m.kind&&positive(n)&&(!m.speaker||!n.speaker||m.speaker===n.speaker)&&Math.abs(n.index-m.index)<=80;
 const currentSerious=mentions.find(m=>m.strong&&m.state==='CURRENT');
 const currentPair=mentions.find(m=>!m.strong&&m.state==='CURRENT'&&mentions.some(n=>compatible(m,n)&&n.state==='CURRENT'));
 const possible=mentions.find(m=>m.strong&&positive(m))??mentions.find(m=>!m.strong&&positive(m)&&mentions.some(n=>compatible(m,n)));
 const selected=currentSerious??currentPair??possible;
 const decision=currentSerious||currentPair?TRIAGE_DECISION.CURRENT_URGENT:possible?TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT:TRIAGE_DECISION.CLEARLY_NONURGENT;
 return {decision,urgent:decision!==TRIAGE_DECISION.CLEARLY_NONURGENT,matched:selected?.text??null,excluded:selected?null:mentions.at(-1)?.state.toLowerCase()??null,
  mentions:mentions.map(({kind,text,state,speaker,index,evidence,group,predicateId,retiredBy})=>({kind,text,state,actor:speaker,index,group,predicateId,evidence,...(retiredBy?{retiredBy}:{})})),
  ownership:{version:graph.version,predicates:graph.predicates.map(({units,quote,...p})=>p),symptoms:graph.symptoms,operators:graph.operators,links:graph.links}};
}
export function assessUrgency(text){const {decision,urgent,matched,excluded,reason}=interpretUrgentSymptoms(text);return {decision,urgent,matched,excluded,...(reason?{reason}:{})};}
export function isSymptomEducationQuestion(text){const r=interpretUrgentSymptoms(text);return r.decision===TRIAGE_DECISION.CLEARLY_NONURGENT&&r.mentions.some(m=>['EDUCATIONAL','INFORMATIONAL','QUOTED'].includes(m.state));}
export function symptomEducationReply(locale='zh-TW'){return t(locale,'triage.education');}
export function urgentReply(locale='zh-TW'){return t(locale,'triage.urgent');}
