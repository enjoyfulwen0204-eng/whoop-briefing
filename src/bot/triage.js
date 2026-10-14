import {t} from '../localization.js';

/** Deterministic safety routing only: no diagnosis, model or health-data read.
 * Each symptom receives its own semantic state. Coordinated predicates may
 * share negation/resolution; contrast and new assertions start a new scope.
 * Educational language never vetoes a separately asserted current symptom.
 */
export const TRIAGE_LIMITS=Object.freeze({characters:8192,clauses:128,mentions:128});
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
const BOUNDARY=/[.!?。！？\n]+|[,，;；]+|(?<!\p{L})(?:but|however|yet|because|nhưng|tuy nhiên|vì)(?!\p{L})|但是|可是|不過|因為|但/giu;
const CONTRAST=/^(?:but|however|yet|nhưng|tuy nhiên|但是|可是|不過|但)$/iu;
const WORD=/[\p{L}\p{N}_]/u;
function quoteRanges(text){
 const ranges=[];let open=null;
 for(let i=0;i<text.length;i++){const ch=text[i];
  if(ch==="'"&&WORD.test(text[i-1]??'')&&WORD.test(text[i+1]??''))continue;
  if(open){if(ch===open.close){ranges.push({index:open.index,0:text.slice(open.index,i+1)});open=null;}}
  else if(['\"','「','『',"'"].includes(ch)&&!(ch==="'"&&WORD.test(text[i-1]??'')))open={index:i,close:{'「':'」','『':'』'}[ch]??ch};
 }
 return ranges;
}
function outsideQuotes(text){const chars=text.split('');for(const q of quoteRanges(text))for(let i=q.index;i<q.index+q[0].length;i++)chars[i]=' ';return chars.join('');}
const CONNECTORS=/^(?:\s|and|or|nor|also|và|hoặc|hay|也|和|與|或|又|而且|且)*(?:(?:my|his|her)\s+)?$/iu;
const NEGATION=/(?:沒有|沒|不會|不曾|未|並沒|沒在)(?:(?:現在|目前|正在|任何|劇烈|嚴重|輕微|持續|突然|明顯|的)){0,4}\s*$|\b(?:no|not|without|don't|do not|doesn't|does not|never|no longer)(?:\s+(?:have|has|having|had|feel|feeling|experience|experiencing|currently|now|any|a|severe|intermittent|sharp|mild|sudden|persistent|obvious)){0,8}\s*$|(?:không(?: hề| có| bị| thấy| còn)?|chưa(?: từng)?|chẳng)(?:\s+(?:đang|bị|có|cảm thấy))?\s*$/iu;
const RESOLVED_BEFORE=/(?:已經|現在|目前)?(?:不再|已無|沒有了)\s*$|\b(?:no longer|stopped)(?:\s+(?:have|having|feel|feeling|experiencing))?\s*$|(?:đã\s+)?(?:hết|khỏi)\s*$/iu;
const RESOLVED_AFTER=/^(?:\s|了|已經|現在|目前|都|也|症狀|而且|和|與|或|and|or|it|they|that|the symptoms|has|have|had|is|are|was|were|now|all|completely|đã|bây giờ|hiện tại|triệu chứng|và)*(?:好了|沒事了|恢復了|不會了|沒問題了|緩解了|沒有了|resolved|gone|went away|cleared|hết|khỏi)(?!\p{L})/iu;
const PAST=/昨天|昨晚|以前|曾經|\b(?:had|experienced|felt|yesterday|last (?:night|week|month|year)|years ago)\b|hôm qua|trước đây/iu;
const CURRENT_TIME=/現在|目前|正在|此刻|\b(?:now|currently|current|right now|still)\b|đang|hiện tại|bây giờ/iu;
const EDUCATION=/通常|一般來說|一般而言|哪些|什麼原因|是什麼意思|代表什麼|定義|怎麼分辨|為什麼會有人|想知道|\b(?:what (?:is|are|does|causes)|define|definition|usually|generally|in general|meaning|learn about|want to know|question about|asking about|information about|be caused by|why (?:do|does) (?:people|patients))\b|là gì|nghĩa là|nguyên nhân|thường|tại sao|tìm hiểu/iu;
const INFORMATIONAL=/\b(?:in (?:this|an?) (?:example|case study)|hypothetical case|the (?:article|textbook|example) (?:says|describes|explains)|fictional)\b|假設案例|教科書|例句|舉例|ví dụ|trường hợp giả định/iu;
const CASE_FRAME=/\b(?:in (?:this|an?) (?:example|case study)|hypothetical case|fictional)\b|假設案例|例句|舉例|ví dụ|trường hợp giả định/iu;
const HYPOTHETICAL=/^\s*(?:如果|假設|假如|若是|萬一|if\b|suppose\b|what if\b|hypothetically\b|nếu|giả sử)/iu;
const PRESENT_BEFORE=/(?:我朋友|我|他|她|媽媽|爸爸|朋友)(?:現在|目前|正在|此刻|突然|有|感到|覺得|出現)*\s*$|(?<![\p{L}\p{N}_])(?:i|he|she|we|they|my (?:friend|mother|father|child|wife|husband))\s+(?:(?:am|is|are)\s+)?(?:(?:currently|now|still)\s+)?(?:have|has|having|feel|feeling|experiencing|suffering from)\s+(?:(?:current|a|severe|some|sudden)\s+)*$|\b(?:my|his|her)\s+(?:current\s+)?$|(?:tôi|anh ấy|cô ấy|bạn tôi)\s+(?:(?:đang|bị|có|cảm thấy)\s+)*$/iu;
const PREDICATE_SUBJECT=/(?<![\p{L}\p{N}_])(?:i|he|she|we|they|my (?:friend|mother|father|child|wife|husband))\s*(?:(?:am|is|are|'m|'s|'re)\s*)?(?:(?:currently|now|still)\s*)?$/iu;
const PRESENT_AFTER=/^\s*(?:that\s+)?(?:i|he|she)\s+(?:(?:am|is)\s+)?(?:having|feeling|experiencing)\b|^\s*(?:i am|i'm)\b/iu;
const WELL=/^\s*(?:(?:i am|i'm|it is|i feel|now i am|now i'm|tôi|hiện tại tôi|bây giờ tôi|現在|我現在|現在我)\s*)?(?:fine|well|okay|back to normal|ổn|bình thường|沒事了|好了)(?:\s*(?:now|hiện tại|bây giờ))?\s*$/iu;
const FIGURATIVE=/笑(?:到|得|死)|(?:recovery|hrv|strain|分數|數字|指數|股票|房價|價格)[^。，,]{0,6}(?:低|高|爛|差|掉)(?:到|得)|(?:工作|案子|天氣|事情|行程|會議|考試|報告)[^。，,]{0,4}(?:累|忙|煩)到|(?:累|忙|煩|氣)到讓人|laugh(?:ing|ed)? (?:so hard|until)|cười.{0,20}(?:khó thở|ngất)/iu;
const REPORT=/\b(?:he|she|my (?:friend|mother|father|child))\s+(?:just\s+)?(?:says|said)\s*$|(?:他|她|我朋友)(?:現在|剛剛)?說\s*$|(?:anh ấy|cô ấy)\s+(?:vừa\s+)?nói\s*$/iu;
const REFERENCE=/(?<![\p{L}\p{N}_])(?:it|this|these symptoms|that pain)(?![\p{L}\p{N}_])|這個症狀|這些症狀|它|(?<!\p{L})(?:nó|triệu chứng này)(?!\p{L})/iu;
const RECURRENCE=/(?<!\p{L})(?:it|this|these symptoms)\s+(?:(?:is|are|has|have)\s+)?(?:back|returned|returning|recurring|came back)\b|(?<!\p{L})it's\s+back\b|(?:它|這個症狀|這些症狀)(?:現在|目前)?(?:又來了|又出現|復發)|(?:nó|triệu chứng này)\s+(?:đang\s+)?(?:trở lại|tái phát)/iu;
const ONGOING_REFERENCE=/(?<![\p{L}\p{N}_])(?:i|he|she|we|they)(?:'m|'s|'re)?\s+(?:(?:am|is|are)\s+)?(?:(?:currently|still)\s+)?(?:experiencing|having|feeling|have|has)\s+(?:it|this|these symptoms|that pain)\b|(?:我|他|她)(?:現在|目前|正在)(?:有|感到|經歷)(?:它|這個症狀|這些症狀)|(?:tôi|anh ấy|cô ấy)\s+đang\s+(?:bị|có|cảm thấy)\s+(?:nó|triệu chứng này)/iu;

function splitClauses(text,ranges,quotes){
 const parts=[];let start=0,join='start';
 for(const b of text.matchAll(BOUNDARY)){
  // A connective inside a symptom (喘不過氣) or quotation is not a clause.
  if(ranges.some(m=>b.index>m.start&&b.index<m.end)||quotes.some(q=>b.index>q.index&&b.index<q.index+q[0].length))continue;
  if(text.slice(start,b.index).trim())parts.push({text:text.slice(start,b.index),start,join});
  join=CONTRAST.test(b[0])?'contrast':/[.!?。！？\n]/u.test(b[0])?'hard':/[,，;；]/u.test(b[0])?'soft':'cause';start=b.index+b[0].length;
 }
 if(text.slice(start).trim())parts.push({text:text.slice(start),start,join});return parts;
}
function candidates(part){
 const found=[];
 for(const [kind,strong,re] of SYMPTOMS)for(const m of part.text.matchAll(new RegExp(re.source,re.flags+'g')))found.push({kind,strong,text:m[0],start:m.index,end:m.index+m[0].length,clause:part});
 return found.sort((a,b)=>a.start-b.start||b.end-a.end).filter((m,i,all)=>!all.slice(0,i).some(prior=>prior.start<=m.start&&prior.end>=m.end));
}
function resolutionTail(part,mention){
 let tail=part.text.slice(mention.end),cursor=mention.end;
 for(const next of part.mentions.filter(m=>m.start>=mention.end)){
  if(!CONNECTORS.test(part.text.slice(cursor,next.start)))break;
  tail=tail.replace(next.text,'');cursor=next.end;
 }
 return RESOLVED_AFTER.test(tail);
}
function quotedRange(part,mention){return part.quotes.find(q=>mention.start>=q.index&&mention.end<=q.index+q[0].length);}
function stateFor(part,m,previous){
 const next=part.mentions.find(n=>n.start>=m.end);
 const before=part.text.slice(previous?.end??0,m.start),after=part.text.slice(m.end,next?.start??part.text.length),gap=previous?before:null;
 const prior=previous??part.coordinatedPrior;
 const coordinated=prior&&CONNECTORS.test(previous?gap:before);
 if(NEGATION.test(before)||coordinated&&prior.state==='NEGATED')return 'NEGATED';
 if(RESOLVED_BEFORE.test(before)||resolutionTail(part,m)||coordinated&&prior.state==='RESOLVED')return 'RESOLVED';
 if(part.hypothetical)return 'HYPOTHETICAL';

 if(coordinated&&prior.state==='HISTORICAL')return 'HISTORICAL';
 const quote=quotedRange(part,m),outside=quote?part.text.slice(0,quote.index)+part.text.slice(quote.index+quote[0].length):part.text;
 const present=PRESENT_BEFORE.test(before)||PREDICATE_SUBJECT.test(before)||PRESENT_AFTER.test(after)||coordinated&&prior.state==='CURRENT';
 if(quote){
  const assertedOutside=PRESENT_BEFORE.test(part.text.slice(0,quote.index))||REPORT.test(part.text.slice(0,quote.index))||CURRENT_TIME.test(outside)&&!EDUCATION.test(outside);
  if(!assertedOutside)return 'QUOTED';
 }
 // A subject and a present predicate describe actual experience. Educational
 // verbs elsewhere in this clause cannot reverse that independently local fact.
 if(PAST.test(before+' '+after)&&!CURRENT_TIME.test(before+' '+after))return 'HISTORICAL';
 if(part.caseFrame&&!(previous&&!coordinated&&present))return 'INFORMATIONAL';
 if(part.informational&&['he','she','they'].includes(m.actor)&&INFORMATIONAL.test(part.text.slice(0,m.start))&&!(previous&&!coordinated&&present))return 'INFORMATIONAL';
 if(present)return 'CURRENT';
 if(part.informational)return 'INFORMATIONAL';
 if(FIGURATIVE.test(part.text))return 'FIGURATIVE';
 if(EDUCATION.test(part.text))return 'EDUCATIONAL';
 return 'AMBIGUOUS';
}
function actorFor(part,m,previous){
 const before=part.text.slice(previous?.end??0,m.start);
 const actors=[...before.matchAll(/(?<![\p{L}\p{N}_])(?:my (?:friend|mother|father|child|wife|husband)|i|my|he|she|his|her|we|they)(?![\p{L}\p{N}_])|我朋友|我|他|她|媽媽|爸爸|朋友|(?<!\p{L})(?:tôi|anh ấy|cô ấy|bạn tôi)(?!\p{L})/giu)];
 if(actors.length){
  const actor=actors.at(-1)[0].toLowerCase();
  return {'i':'SELF','my':'SELF','we':'SELF','我':'SELF','tôi':'SELF','我朋友':'my friend','朋友':'my friend','bạn tôi':'my friend','媽媽':'my mother','爸爸':'my father','他':'he','她':'she','anh ấy':'he','cô ấy':'she','his':'he','her':'she'}[actor]??actor;
 }
 const prior=previous??part.coordinatedPrior;return prior&&CONNECTORS.test(before)?prior.actor:null;
}
function resolveReference(mention){
 // References form a forward-only chain within the fixed clause/mention bound.
 for(let m=mention;m;m=m.antecedent)if(['CURRENT','AMBIGUOUS','HISTORICAL'].includes(m.state))m.state='RESOLVED';
}
function positive(m){return m.state==='CURRENT'||m.state==='AMBIGUOUS';}
function overflow(){return {mentions:[],urgent:true,matched:null,excluded:null,reason:'scope_limit'};}

/** Bounded inspectable interpretation. A bare plausible serious symptom is
 * AMBIGUOUS and receives the same conditional, nondiagnostic safety guidance.
 * Clearly excluded mentions alone never trigger emergency routing.
 */
export function interpretUrgentSymptoms(input){
 const raw=String(input??'');if(raw.length>TRIAGE_LIMITS.characters)return overflow();
 const text=raw.normalize('NFC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').trim();if(!text)return {mentions:[],urgent:false,matched:null,excluded:null};
 const lexical=candidates({text});if(lexical.length>TRIAGE_LIMITS.mentions)return overflow();
 const parts=splitClauses(text,lexical,quoteRanges(text));if(parts.length>TRIAGE_LIMITS.clauses)return overflow();
 let previousPart=null;const mentions=[];
 for(const part of parts){
  part.mentions=candidates(part);if(mentions.length+part.mentions.length>TRIAGE_LIMITS.mentions)return overflow();
  part.quotes=quoteRanges(part.text);
  const carry=['soft','cause'].includes(part.join)&&previousPart;
  const explicitList=part.join==='soft'&&/^\s*(?:(?:and|or|nor|và|hoặc|hay)(?!\p{L})|也|和|與|或)/iu.test(part.text);
  part.coordinatedPrior=explicitList?previousPart?.mentions.at(-1):null;
  part.hypothetical=HYPOTHETICAL.test(part.text)||Boolean(carry?.hypothetical);
  part.informational=INFORMATIONAL.test(part.text)||Boolean(carry?.informational);
  part.caseFrame=CASE_FRAME.test(part.text)||Boolean(carry?.caseFrame);
  let previous=null;
  for(const m of part.mentions){m.actor=actorFor(part,m,previous);m.state=stateFor(part,m,previous);mentions.push(m);previous=m;}
  if(!part.mentions.length&&previousPart?.mentions.length){
   const prior=previousPart.mentions;
   const clean=outsideQuotes(part.text);
   if(!part.hypothetical&&!part.caseFrame&&!(PAST.test(clean)&&!CURRENT_TIME.test(clean))&&REFERENCE.test(clean)&&(ONGOING_REFERENCE.test(clean)||RECURRENCE.test(clean))&&!NEGATION.test(clean.slice(0,clean.search(REFERENCE)))){
    // An explicit adjacent current anaphor is a new assertion, even when the
    // original mention was an educational/negated/resolved statement.
    for(const old of prior){
     if(mentions.length>=TRIAGE_LIMITS.mentions)return overflow();
     const ref={...old,text:part.text.trim(),start:part.text.indexOf(part.text.trim()),end:part.text.length,state:'CURRENT',clause:part,antecedent:old};
     part.mentions.push(ref);mentions.push(ref);
    }
   }else if(RESOLVED_AFTER.test(clean)||prior.every(m=>m.state==='HISTORICAL')&&WELL.test(clean)){
    for(const m of prior)resolveReference(m);
   }
  }
  // Explicit absence of the same symptom after a historical mention closes that
  // historical account, without changing any separately current symptom.
  if(previousPart&&part.mentions.length)for(const old of previousPart.mentions){
   if(old.state==='HISTORICAL'&&part.mentions.some(m=>m.kind===old.kind&&m.state==='NEGATED'))old.state='RESOLVED';
  }
  previousPart=part;
 }
 const serious=mentions.find(m=>m.strong&&positive(m));
 const paired=mentions.find(m=>['heartbeat','dizziness','breathingHint'].includes(m.kind)&&positive(m)&&mentions.some(n=>n!==m&&['heartbeat','dizziness','breathingHint'].includes(n.kind)&&n.kind!==m.kind&&positive(n)&&(!n.actor||!m.actor||n.actor===m.actor)&&Math.abs(n.clause.start+n.start-m.clause.start-m.start)<=80));
 const urgent=Boolean(serious||paired),matched=serious?.text??paired?.text??null;
 return {urgent,matched,excluded:urgent?null:mentions.at(-1)?.state.toLowerCase()??null,
  mentions:mentions.map(({kind,text,state,actor,clause,start})=>({kind,text,state,actor,index:clause.start+start}))};
}
export function assessUrgency(text){const {urgent,matched,excluded,reason}=interpretUrgentSymptoms(text);return {urgent,matched,excluded,...(reason?{reason}:{})};}
export function isSymptomEducationQuestion(text){const result=interpretUrgentSymptoms(text);return !result.urgent&&result.mentions.some(m=>['EDUCATIONAL','INFORMATIONAL','QUOTED'].includes(m.state));}
export function symptomEducationReply(locale='zh-TW'){return t(locale,'triage.education');}
export function urgentReply(locale='zh-TW'){return t(locale,'triage.urgent');}
