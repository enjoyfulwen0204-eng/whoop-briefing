import {JOURNAL_COPY,TOPICS,TOPIC_ICONS,DETAILS,presentationLocale} from './stage7Registry.js';
export function journalCard(row,{locale,displayName=null,preferences=null}={}){
 const c=JOURNAL_COPY[presentationLocale(locale)],buttons=[];
 const button=(label,action)=>({label,action});
 let text;
 if(row.kind==='PREFERENCES'){
  text=`${c.preferences}\n${c.daily}: ${preferences.daily_enabled?c.enabled:c.disabled}\n${c.weekly}: ${preferences.weekly_enabled?c.enabled:c.disabled}`;
  const selected=JSON.parse(preferences.topics_json??'[]'),excluded=JSON.parse(preferences.excluded_topics_json??'[]');
  TOPICS.forEach((topic,i)=>buttons.push([button(`${selected.includes(topic)?'✅':'▫️'} ${TOPIC_ICONS[topic]} ${c.topics[i]}`,`topic:${topic}`),button(`${excluded.includes(topic)?'🚫':'▫️'} ${c.ignore}`,`exclude:${topic}`)]));
  buttons.push([button(`📔 ${preferences.daily_enabled?c.disable:c.enable}`,'toggleDaily')]);
  buttons.push([button(`🗓 ${preferences.weekly_enabled?c.weeklyDisable:c.weeklyEnable}`,'toggleWeekly')]);
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
   text=`${heading}\n${c.questions[index]}`;
   buttons.push([button(`🙅 ${c.no}`,'NO'),button(`${TOPIC_ICONS[row.category]} ${c.yes}`,'YES')]);
   buttons.push([button(`🤔 ${c.unsure}`,'NOT_SURE'),button(`⏭ ${c.skip}`,'SKIPPED')]);
   buttons.push([button(`⬅️ ${c.back}`,'back'),button(`❌ ${c.cancel}`,'cancel')]);
  }
 }
 return {text,buttons};
}
export const isJournalCallback=value=>typeof value==='string'&&/^j7:[A-Za-z0-9_-]{32}$/.test(value)&&Buffer.byteLength(value)<=64;
