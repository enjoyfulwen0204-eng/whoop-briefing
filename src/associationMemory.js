import {recordInsight,reviseInsight} from './healthMemory.js';
import {localDate} from './time.js';
import {renderAssociations} from './onDemandAssociations.js';
import {currentExecutionBudget} from './executionBudget.js';

export const MEMORY_VERSION='b2-memory-v1';
export const INSIGHT_ICONS=Object.freeze({EMERGING:'🔎',SUPPORTED:'✅',WEAKENED:'⚠️',RETIRED:'❌'});
export const INSIGHT_PRIORITY=Object.freeze({SUPPORTED:0,RETIRED:0,EMERGING:1,WEAKENED:2});
const copy={
 'zh-TW':{EMERGING:'初步',SUPPORTED:'確立',WEAKENED:'變弱',RETIRED:'已推翻',title:'🧠 洞察更新',since:'開始觀察',weeks:'週',retired:'推翻日期',caution:'個人觀察不代表因果；還需要持續記錄。'},
 en:{EMERGING:'Emerging',SUPPORTED:'Supported',WEAKENED:'Weakened',RETIRED:'Retired',title:'🧠 Insight update',since:'First observed',weeks:'weeks',retired:'Retired',caution:'Personal observations do not establish causation; keep recording.'},
 vi:{EMERGING:'Sơ bộ',SUPPORTED:'Được hỗ trợ',WEAKENED:'Yếu đi',RETIRED:'Đã bác bỏ',title:'🧠 Cập nhật nhận định',since:'Ghi nhận từ',weeks:'tuần',retired:'Ngày bác bỏ',caution:'Quan sát cá nhân không chứng minh nhân quả; cần tiếp tục ghi chép.'},
};
export function memoryEvidence(row){try{const e=JSON.parse(row.evidence_json);return e?.version===MEMORY_VERSION?e:null;}catch{return null;}}
export async function latestMemory(db,id){
 const rows=await db.getRecentInsights(id);if(rows.length>500)throw Error('INSIGHT_HISTORY_BOUNDS');
 const seen=new Set();return rows.filter(row=>{if(!memoryEvidence(row)||seen.has(row.subject))return false;seen.add(row.subject);return true;});
}
export async function updateAssociationMemory({db,user,reader,view,now=new Date()}){
 const day=localDate(now,user.timezone);
 for(const topic of view.topics)for(const metric of topic.evidence??[]){
  if(currentExecutionBudget()&&currentExecutionBudget().remainingMs()<10000)return {status:'PARTIAL'};
  if(!Number.isFinite(metric.effectSize))continue;
  await db.transaction(async()=>{
   await reader.assertFresh(user.id,view);await db.assertAccountActive(user.id,user.lifecycleGeneration);
   const subject=`${MEMORY_VERSION}:${topic.topic}:${metric.metric}`;
   const current=(await latestMemory(db,user.id)).find(row=>row.subject===subject);
   // An acknowledged or uncertain commit is reconciled by persisted evidence;
   // the same day's retry cannot advance the state machine a second time.
   if(current&&memoryEvidence(current)?.evaluatedDay===day)return;
   if(current?.status==='RETIRED')return; // Terminal means terminal.
   const shown=topic.metrics.filter(m=>m.metric===metric.metric);
   const evidence={version:MEMORY_VERSION,evaluatedDay:day,topic:topic.topic,metric:metric.metric,
    n:metric.n,exposed:metric.exposed,unexposed:metric.unexposed,pearson:metric.effectSize,
    difference:metric.difference,view:{today:view.today,topics:[{...topic,evidence:undefined,metrics:shown}]}};
   const payload={insightType:'journal_association',subject,statement:renderAssociations(evidence.view,'en'),
    evidence,sampleCount:metric.n,effectSize:shown.length?metric.effectSize:0};
   if(current){
    const revised=await reviseInsight(db,user.id,current.id,payload,{now});
    if(!revised.ok)throw Object.assign(Error('INSIGHT_REVISION_FENCED'),{code:'INSIGHT_REVISION_FENCED'});
   }
   else if(shown.length)await recordInsight(db,user.id,payload,{now});
   await reader.assertFresh(user.id,view);
  });
 }
 return {status:'SUCCESS'};
}
export function renderMemory(row,locale='zh-TW',now=new Date()){
 const c=copy[locale]??copy.en,e=memoryEvidence(row);if(!e||!INSIGHT_ICONS[row.status])return null;
 const date=String(row.first_detected_at).slice(0,10),weeks=Math.max(0,Math.floor((now-Date.parse(row.first_detected_at))/604800000));
 return [`${c.title}：${INSIGHT_ICONS[row.status]} ${c[row.status]}`,renderAssociations(e.view,locale),
  `${c.since} ${date} · ${weeks} ${c.weeks}`,
  ...(row.status==='RETIRED'?[`${c.retired} ${String(row.retired_at??row.last_recalculated_at).slice(0,10)}`]:[]),c.caution].join('\n');
}
export function selectMemoryChange(rows,weekStart,notified=new Set()){
 return rows.filter(r=>INSIGHT_ICONS[r.status]&&!notified.has(`${r.id}:${r.version}`))
  .sort((a,b)=>INSIGHT_PRIORITY[a.status]-INSIGHT_PRIORITY[b.status]||a.id-b.id)[0]??null;
}
