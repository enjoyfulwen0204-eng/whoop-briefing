import {COACH_COPY,COACH_TOPICS} from './companionCoach.js';
import {JOURNAL_COPY,TOPICS,TOPIC_ICONS,DETAILS,presentationLocale} from './stage7Registry.js';
export function journalCard(row,{locale,displayName=null,preferences=null}={}){
 const c=JOURNAL_COPY[presentationLocale(locale)],buttons=[];
 const button=(label,action)=>({label,action});
 let text;
 if(row.kind==='PREFERENCES'){
  text=`${c.preferences}\n${c.daily}: ${preferences.daily_enabled?c.enabled:c.disabled}\n${c.weekly}: ${preferences.weekly_enabled?c.enabled:c.disabled}`;
  const selected=JSON.parse(preferences.topics_json??'[]'),excluded=JSON.parse(preferences.excluded_topics_json??'[]');
  TOPICS.forEach((topic,i)=>buttons.push([button(`${selected.includes(topic)?'✅':'▫️'} ${TOPIC_ICONS[topic]} ${c.topics[i]}`,`prefs:topic:${topic}:${selected.includes(topic)?0:1}:${preferences.revision}`),button(`🚫 ${excluded.includes(topic)?'✅ ':''}${c.ignore}`,`prefs:exclude:${topic}:${excluded.includes(topic)?0:1}:${preferences.revision}`)]));
  buttons.push([button(`📔 ${preferences.daily_enabled?c.disable:c.enable}`,`prefs:daily:${preferences.daily_enabled?0:1}:${preferences.revision}`)]);
  buttons.push([button(`🗓 ${preferences.weekly_enabled?c.weeklyDisable:c.weeklyEnable}`,`prefs:weekly:${preferences.weekly_enabled?0:1}:${preferences.revision}`)]);
  const cc=COACH_COPY[presentationLocale(locale)],coachTopics=JSON.parse(preferences.coach_topics_json??'[]');
  text+=`\n${cc.coach}: ${preferences.coach_enabled?cc.enabled:cc.disabled}\n${cc.quiet}: ${preferences.quiet_start??'22:00'}–${preferences.quiet_end??'08:00'}`;
  buttons.push([button(`${cc.coach}: ${preferences.coach_enabled?cc.disabled:cc.enabled}`,`prefs:coach:${preferences.coach_enabled?0:1}:${preferences.revision}`)]);
  COACH_TOPICS.forEach((topic,i)=>buttons.push([button(`${coachTopics.includes(topic)?'✅':'▫️'} ${cc.topics[i]}`,`prefs:coachTopic:${topic}:${coachTopics.includes(topic)?0:1}:${preferences.revision}`)]));
  buttons.push(['22-08','23-07','21-09'].map(v=>button(`${cc.quiet}: ${v.replace('-','–')}`, `prefs:quiet:${v}:1:${preferences.revision}`)));
  buttons.push([button(`✅ ${c.confirm}`,'cancel')]);
 }else if(row.category===null){
  text=`${c.menu}\n${c.title}${displayName?`\n${displayName}`:''}`;
  TOPICS.forEach((topic,i)=>buttons.push([button(`${TOPIC_ICONS[topic]} ${c.topics[i]}`,`category:${topic}`)]));
  buttons.push([button(`⚙️ ${c.preferences}`,'preferences'),button(`📋 ${c.recent}`,'recent')]);
  buttons.push([button(`⏭ ${c.skipToday}`,'skipToday')]);
  buttons.push([button(`🗓 ${c.weekly}`,'weekly'),button(`❌ ${c.cancel}`,'cancel')]);
 }else{
  const index=TOPICS.indexOf(row.category),heading=`${TOPIC_ICONS[row.category]} ${c.topics[index]} · ${c.target}: ${row.target_date}`;
  if(['COMPLETED','NOT_SURE','SKIPPED'].includes(row.state)){
   const answer=row.state==='NOT_SURE'?c.unsure:row.state==='SKIPPED'?c.skip:row.selected_choice==='YES'?c.yes:c.no;
   const detail=DETAILS[row.category]?.indexOf(row.detail_choice);
   text=`${heading}\n✅ ${c.saved}: ${answer}${detail>=0?` · ${c.details[detail]}`:''}${row.note?`\n${row.note}`:''}`;
   buttons.push([button(`✏️ ${c.edit}`,'edit'),button(`↩️ ${c.undo}`,'undo')]);
  }else if(row.state==='NOTE'){
   text=`${heading}\n✏️ ${c.enterNote}`;buttons.push([button(`⬅️ ${c.back}`,'back'),button(`❌ ${c.cancel}`,'cancel')]);
  }else if(row.state==='AWAITING_DETAIL'){
   text=`${heading}\n${c.detail}`;buttons.push(DETAILS[row.category].map((a,i)=>button(`${['🌅','☀️','🌙'][i]} ${c.details[i]}`,`detail:${a}`)));
   buttons.push([button(`⏭ ${c.skipDetail}`,'skipDetail'),button(`⬅️ ${c.back}`,'back')]);
  }else if(row.state==='CONFIRM'){
   text=`${heading}\n${row.selected_choice==='YES'?c.yes:c.no}${row.note?`\n${row.note}`:''}`;
   buttons.push([button(`✅ ${c.confirm}`,'confirm'),button(`✏️ ${c.note}`,'note')],[button(`⬅️ ${c.back}`,'back'),button(`❌ ${c.cancel}`,'cancel')]);
  }else{
   text=`${heading}\n${c.questions[index]}${row.note?`\n${row.note}`:''}`;
   buttons.push([button(`🙅 ${c.no}`,'NO'),button(`${TOPIC_ICONS[row.category]} ${c.yes}`,'YES')]);
   buttons.push([button(`🤔 ${c.unsure}`,'NOT_SURE'),button(`⏭ ${c.skip}`,'SKIPPED')]);
   buttons.push([button(`✏️ ${c.note}`,'note')]);
   buttons.push([button(`⬅️ ${c.back}`,'back'),button(`❌ ${c.cancel}`,'cancel')]);
  }
 }
 return {text,buttons};
}
export const isJournalCallback=value=>typeof value==='string'&&/^j7:[A-Za-z0-9_-]{32}$/.test(value)&&Buffer.byteLength(value)<=64;
