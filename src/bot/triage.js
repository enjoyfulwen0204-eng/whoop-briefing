import {t} from '../localization.js';

export const TRIAGE_LIMITS=Object.freeze({characters:8192,clauses:128,mentions:128});
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
const EDGES=/[.!?。！？\n]+|[,，;；]+|(?<!\p{L})(?:even though|although|however|because|after|while|but|yet|and|or|nor|also|which|that|if|suppose|hypothetically|what if|nhưng|tuy nhiên|mặc dù|sau khi|vì|dù|và|hoặc|hay|nếu|giả sử)(?!\p{L})|但是|可是|不過|因為|雖然|假設|假如|如果|若是|萬一|但|而且|也|和|與|或|又|且/giu;
const WORD=/[\p{L}\p{N}_]/u;
function quotesOf(text){
 const out=[];let open=null;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==="'"&&WORD.test(text[i-1]??'')&&WORD.test(text[i+1]??''))continue;
  if(open){if(c===open.close){out.push({start:open.start,end:i+1});open=null;}}
  else if(['"',"'",'「','『'].includes(c)&&!(c==="'"&&WORD.test(text[i-1]??'')))open={start:i,close:{'「':'」','『':'』'}[c]??c};
 }
 return out;
}
function symptomsOf(text){
 const all=[];
 for(const [kind,strong,re] of SYMPTOMS)for(const m of text.matchAll(new RegExp(re.source,re.flags+'g')))all.push({kind,strong,text:m[0],start:m.index,end:m.index+m[0].length});
 return all.sort((a,b)=>a.start-b.start||b.end-a.end).filter((m,i,a)=>!a.slice(0,i).some(n=>n.start<=m.start&&n.end>=m.end));
}
function edgeKind(word){
 if(/^[.!?。！？\n]/u.test(word))return 'sentence';
 if(/^[,，;；]/u.test(word))return 'comma';
 if(/^(?:if|what if|suppose|hypothetically|nếu|giả sử|如果|假設|假如|若是|萬一)$/iu.test(word))return 'hypothetical';
 if(/^(?:which|that)$/iu.test(word))return 'relative';
 if(/^(?:although|even though|after|while|mặc dù|sau khi|dù|雖然)$/iu.test(word))return 'subordinate';
 if(/^(?:because|vì|因為)$/iu.test(word))return 'cause';
 if(/^(?:but|however|yet|nhưng|tuy nhiên|但是|可是|不過|但)$/iu.test(word))return 'contrast';
 return 'coordinate';
}
function clausesOf(text,symptoms,quotes){
 const parts=[];let start=0,edge='start',connector='';
 for(const m of text.matchAll(EDGES)){
  if(symptoms.some(s=>m.index>s.start&&m.index<s.end)||quotes.some(q=>m.index>q.start&&m.index<q.end))continue;
  if(text.slice(start,m.index).trim())parts.push({start,end:m.index,edge,connector,text:text.slice(start,m.index)});
  edge=edgeKind(m[0]);connector=m[0];start=m.index+m[0].length;
 }
 if(text.slice(start).trim())parts.push({start,end:text.length,edge,connector,text:text.slice(start)});
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
 const neg=ofType(events,'negative').filter(e=>e.end<=position).at(-1);
 if(!neg||position-neg.end>96)return false;
 // A later explicit subject starts a different predicate. Arbitrary adjective
 // tokens do not end polarity, avoiding an adjective whitelist.
 return !events.some(e=>e.type==='actor'&&e.start>neg.end&&e.start<position);
}
function outcomeEvidence(events){
 const resolved=last(events,'resolution'),recurrence=last(events,'recurrence');
 const unresolved=resolved&&negativeAt(events,resolved.start);
 return {absent:Boolean(recurrence&&negativeAt(events,recurrence.start)),resolved:Boolean(resolved&&!unresolved),ongoing:Boolean(unresolved),recurrence:Boolean(recurrence&&(!resolved||recurrence.start>resolved.start)&&!negativeAt(events,recurrence.start))};
}
function evidenceFor(part,symptom,prior){
 const quoteId=part.quotes.findIndex(q=>symptom.start>=q.start&&symptom.end<=q.end);
 const local=part.events.filter(e=>e.quote===quoteId);
 const sameClause=prior&&prior.index>=part.start&&prior.index<part.end;
 const cutoff=sameClause?prior.end:0;
 const before=local.filter(e=>e.start>=cutoff&&e.end<=symptom.start);
 const next=part.symptoms.find(s=>s.start>=symptom.end);
 const after=local.filter(e=>e.start>=symptom.end&&e.start<(next?.start??part.text.length));
 const actor=last(before,'actor'),speaker=speakerOf(actor)??prior?.speaker??null;
 const topic=last(before,'education'),source=last(before,'information');
 const personal=actor&&speaker!=='GENERIC'&&(!topic||actor.start>topic.start)&&(!source||actor.start>source.start);
 const asserted=Boolean(personal||prior?.evidence.assertion==='ACTUAL'&&!actor);
 const outside=part.events.filter(e=>e.quote===-1);
 const quote=part.quotes[quoteId];
 let quoteAssertion=false,reportSpeaker=null;
 if(quote){
  const wrapperBefore=outside.filter(e=>e.end<=quote.start),wrapperAfter=outside.filter(e=>e.start>=quote.end);
  const wa=last(wrapperBefore,'actor'),wt=last(wrapperBefore,'education'),wi=last(wrapperBefore,'information');
  const externalActor=wa&&speakerOf(wa)!=='GENERIC'&&(!wt||wa.start>wt.start)&&(!wi||wa.start>wi.start);
  const report=last(wrapperBefore,'report');
  quoteAssertion=Boolean(externalActor&&(report||wrapperBefore.some(e=>['present','currentTime'].includes(e.type)))||wrapperAfter.some(e=>e.type==='currentTime')&&!outside.some(e=>e.type==='education'||e.type==='information'));
  if(report&&externalActor)reportSpeaker=speakerOf(wa);
 }
 const tailActor=after.find(e=>e.type==='actor'&&e.word.toLowerCase()!=='they');
 const relative=tailActor&&part.text.slice(symptom.end,tailActor.start).trim()===''&&after.some(e=>['present','pastPredicate'].includes(e.type)&&e.start>=tailActor.end);
 const scopeEnd=relative?part.text.length:tailActor?.start??part.text.length;
 const tail=after.filter(e=>e.start<scopeEnd),outcome=outcomeEvidence([...before,...tail]);
 const ownedCurrent=actor&&['my','his','her'].includes(actor.word.toLowerCase())&&last(before,'currentTime');
 const epistemic=Boolean(part.epistemic||last(before,'uncertainty')&&personal);
 const actual=(asserted||quoteAssertion||Boolean(relative))&&!epistemic;
 const owner=reportSpeaker??(relative?speakerOf(tailActor):speaker);
 const now=Boolean(last([...before,...tail],'currentTime')),past=Boolean(last([...before,...tail],'pastPredicate')||last([...before,...tail],'pastTime'));
 const educational=Boolean(topic||!asserted&&local.some(e=>e.type==='education')||prior?.evidence.framing==='EDUCATIONAL'&&!actor);
 const informational=Boolean(source||part.information&&(!personal||['he','she','they'].includes(speaker)));
 return {
  assertion:actual?'ACTUAL':educational||informational?'TOPIC':'UNRESOLVED',
  speaker:owner,polarity:negativeAt(before,symptom.start)||prior?.evidence.polarity==='NEGATED'&&!actor?'NEGATED':'POSITIVE',
  temporal:epistemic?'UNKNOWN':now||outcome.ongoing||outcome.recurrence?'CURRENT':past?'PAST':actual?'CURRENT':'UNKNOWN',
  resolution:outcome.absent?'ABSENT':(outcome.resolved||prior?.evidence.resolution==='RESOLVED')&&!outcome.recurrence?'RESOLVED':outcome.ongoing?'ONGOING':outcome.recurrence?'RECURRENT':'UNKNOWN',
  framing:part.hypothetical&&!epistemic&&!ownedCurrent?'HYPOTHETICAL':quote&&!quoteAssertion?'QUOTED':informational?'INFORMATIONAL':educational&&!actual?'EDUCATIONAL':part.events.some(e=>e.type==='figurative')?'FIGURATIVE':'ACTUAL',
  quotation:quoteId<0?'NONE':quoteAssertion?'ASSERTED':'MENTIONED',
  relationship:relative?'POSTNOMINAL_REFERENCE':prior?'COORDINATED':'INDEPENDENT',
 };
}
function stateOf(e){
 if(e.framing!=='ACTUAL')return e.framing;
 if(e.polarity==='NEGATED')return 'NEGATED';
 if(e.resolution==='RESOLVED')return 'RESOLVED';
 if(e.resolution==='ABSENT')return 'NEGATED';
 if(e.temporal==='PAST')return 'HISTORICAL';
 return e.assertion==='ACTUAL'||e.temporal==='CURRENT'?'CURRENT':'AMBIGUOUS';
}
function overflow(){return {decision:TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT,urgent:true,matched:null,excluded:null,reason:'scope_limit',mentions:[]};}
function referenceEvidence(part,previous){
 const events=part.events.filter(e=>e.quote===-1),actor=last(events,'actor'),speaker=speakerOf(actor);
 const reference=last(events,'reference')||part.edge==='relative';
 const outcome=outcomeEvidence(events),present=last(events,'ongoing'),now=last(events,'currentTime'),past=last(events,'pastPredicate')||last(events,'pastTime');
 // A named new subject without a deictic/relative relationship is unrelated:
 // "my headache is gone" cannot close "I have chest pain".
 const implicit=!actor&&!part.symptoms.length&&(outcome.resolved||outcome.absent||['coordinate','comma'].includes(part.edge)&&(outcome.ongoing||now&&last(events,'present')));
 const related=Boolean(reference||implicit||previous.every(m=>m.state==='HISTORICAL')&&outcome.resolved&&speaker==='SELF');
 if(!related||part.edge==='subordinate')return null;
 const ongoing=Boolean(!(past&&!now)&&(outcome.ongoing||!outcome.resolved&&(reference||implicit)&&(present||now||outcome.recurrence)&&!negativeAt(events,last(events,'reference')?.start??part.text.length)));
 if(!outcome.resolved&&!outcome.absent&&!ongoing)return null;
 return {outcome,ongoing,speaker,events,temporal:past&&!now?'PAST':'CURRENT'};
}
function applyResolution(mention,resolution='RESOLVED'){
 for(let m=mention;m;m=m.antecedent){
  if(['CURRENT','AMBIGUOUS','HISTORICAL'].includes(m.state)){
   m.evidence={...m.evidence,resolution};m.state=stateOf(m.evidence);
  }
 }
}
function positive(m){return ['CURRENT','AMBIGUOUS'].includes(m.state);}

/** Structured evidence is returned for inspection only and is never logged by
 * ingress. Both current and possible decisions take the conditional safety path.
 */
export function interpretUrgentSymptoms(input){
 const raw=String(input??'');if(raw.length>TRIAGE_LIMITS.characters)return overflow();
 const text=raw.normalize('NFC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').trim();
 const lexical=symptomsOf(text);if(lexical.length>TRIAGE_LIMITS.mentions)return overflow();
 const parts=clausesOf(text,lexical,quotesOf(text));if(parts.length>TRIAGE_LIMITS.clauses)return overflow();
 const mentions=[];let previous=null,group=0;
 for(const part of parts){
  part.symptoms=symptomsOf(part.text);part.quotes=quotesOf(part.text);part.events=eventsOf(part);
  const unquoted=part.events.filter(e=>e.quote===-1),actor=speakerOf(last(unquoted,'actor'));
  const connective=['coordinate','comma','cause'].includes(part.edge);
  part.hypothetical=part.edge==='hypothetical'||Boolean(connective&&previous?.hypothetical);
  part.epistemic=Boolean(part.edge==='hypothetical'&&previous?.events.some(e=>e.quote===-1&&e.type==='uncertainty')&&speakerOf(last(previous.events.filter(e=>e.quote===-1),'actor'))==='SELF');
  const source=last(unquoted,'information');
  part.information=Boolean(source||(connective||part.edge==='relative')&&previous?.information||part.edge==='sentence'&&previous?.information&&['he','she','they'].includes(actor));
  const predicate=part.symptoms[0]&&/^(?:cannot|can't|unable|không thở|không thể thở|無法|喘不過氣)/iu.test(part.symptoms[0].text);
  const list=['coordinate','comma'].includes(part.edge)&&previous?.mentions.length&&!last(unquoted.filter(e=>e.end<part.symptoms[0]?.start),'actor')&&!(predicate&&/^(?:and|also|và|也|又|而且|且)$/iu.test(part.connector));
  const inherited=list?previous.mentions.at(-1):null;
  part.mentions=[];if(!list)group++;
  for(const symptom of part.symptoms){
   const preceding=part.mentions.at(-1);
   const prefix=part.events.filter(e=>e.start>=(preceding?.end??0)&&e.end<=symptom.start);
   const gap=preceding?part.text.slice(preceding.end,symptom.start):'';
   const internalList=preceding&&[...gap.matchAll(EDGES)].some(e=>edgeKind(e[0])==='coordinate')&&!last(prefix,'actor');
   if(preceding&&!internalList)group++;
   const prior=internalList?preceding:preceding?null:inherited;
   const evidence=evidenceFor(part,symptom,prior);
   if(part.edge==='coordinate'&&!actor&&!prior&&previous?.mentions.at(-1)?.evidence.framing==='EDUCATIONAL')evidence.framing='EDUCATIONAL';
   const m={...symptom,index:part.start+symptom.start,group,evidence,speaker:evidence.speaker,state:stateOf(evidence)};
   mentions.push(m);part.mentions.push(m);
   // One shared predicate resolves an entire coordinated list, but never a
   // separate subject/predicate. Metadata changes do not cross that group.
   if(['RESOLVED','ABSENT'].includes(evidence.resolution))for(const old of mentions.filter(n=>n.group===group))applyResolution(old,evidence.resolution);
   // A latest explicit same-speaker outcome retires that symptom's prior
   // assertion. Past accounts and a different person cannot rewrite it.
   const closed=evidence.polarity==='NEGATED'?'ABSENT':evidence.resolution;
   if(['RESOLVED','ABSENT'].includes(closed)&&evidence.temporal!=='PAST'&&evidence.framing==='ACTUAL'){
    for(const old of mentions.filter(n=>n!==m&&n.kind===m.kind&&(!m.speaker||n.speaker===m.speaker)))applyResolution(old,closed);
   }
  }
  if(!part.mentions.length&&previous?.mentions.length){
   const referents=previous.mentions.filter(m=>m.group===previous.mentions.at(-1).group);
   const ref=referenceEvidence(part,referents);
   if(ref&&!part.hypothetical&&!part.information){
    if(ref.ongoing){
     for(const old of referents){
      if(mentions.length>=TRIAGE_LIMITS.mentions)return overflow();
      const evidence={...old.evidence,assertion:'ACTUAL',polarity:'POSITIVE',temporal:'CURRENT',resolution:ref.outcome.recurrence?'RECURRENT':'ONGOING',framing:'ACTUAL',quotation:'NONE',relationship:'ADJACENT_REFERENCE',speaker:ref.speaker??old.speaker};
      const m={...old,text:part.text.trim(),index:part.start,group:++group,evidence,speaker:evidence.speaker,state:stateOf(evidence),antecedent:old};
      mentions.push(m);part.mentions.push(m);
     }
    }else if(ref.outcome.resolved||ref.outcome.absent){for(const old of referents)applyResolution(old,ref.outcome.absent?'ABSENT':'RESOLVED');part.mentions.push(...referents);}
   }
  }
  previous=part;
 }
 const compatible=(m,n)=>n!==m&&!n.strong&&n.kind!==m.kind&&positive(n)&&(!m.speaker||!n.speaker||m.speaker===n.speaker)&&Math.abs(n.index-m.index)<=80;
 const currentSerious=mentions.find(m=>m.strong&&m.state==='CURRENT');
 const currentPair=mentions.find(m=>!m.strong&&m.state==='CURRENT'&&mentions.some(n=>compatible(m,n)&&n.state==='CURRENT'));
 const possible=mentions.find(m=>m.strong&&positive(m))??mentions.find(m=>!m.strong&&positive(m)&&mentions.some(n=>compatible(m,n)));
 const selected=currentSerious??currentPair??possible;
 const decision=currentSerious||currentPair?TRIAGE_DECISION.CURRENT_URGENT:possible?TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT:TRIAGE_DECISION.CLEARLY_NONURGENT;
 return {decision,urgent:decision!==TRIAGE_DECISION.CLEARLY_NONURGENT,matched:selected?.text??null,excluded:selected?null:mentions.at(-1)?.state.toLowerCase()??null,
  mentions:mentions.map(({kind,text,state,speaker,index,evidence,group})=>({kind,text,state,actor:speaker,index,group,evidence}))};
}
export function assessUrgency(text){const {decision,urgent,matched,excluded,reason}=interpretUrgentSymptoms(text);return {decision,urgent,matched,excluded,...(reason?{reason}:{})};}
export function isSymptomEducationQuestion(text){const r=interpretUrgentSymptoms(text);return r.decision===TRIAGE_DECISION.CLEARLY_NONURGENT&&r.mentions.some(m=>['EDUCATIONAL','INFORMATIONAL','QUOTED'].includes(m.state));}
export function symptomEducationReply(locale='zh-TW'){return t(locale,'triage.education');}
export function urgentReply(locale='zh-TW'){return t(locale,'triage.urgent');}
