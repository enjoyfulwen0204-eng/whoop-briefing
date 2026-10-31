import {readableRow,fail} from './phase4Core.js';
import {presentationLocale} from './stage7Registry.js';
import {localDate,addDays,localMidnightUtc} from './time.js';
import {COACH_FOLLOWUPS,COACH_CONTEXT_COPY} from './companionCoachContext.js';
export const COACH_TOPICS=Object.freeze(['sleep','recovery','exercise']);
export const COACH_COPY=Object.freeze({
 'zh-TW':{title:'💬 想聊聊哪一方面？',topics:['😴 睡眠','🌿 恢復','🏃 運動'],today:'📅 今天',week:'🗓 最近 7 天',free:'⌨️ 自由提問',ask:'直接輸入你的健康問題即可。',skip:'⏭️ 今天略過',pause:'⏸️ 暫停邀請',paused:'已暫停自動 Coach 邀請。仍可隨時輸入 /coach。',empty:'這個期間沒有可用的已評分紀錄；不推定為零。',asof:'資料截至',count:'筆已評分紀錄',mean:'平均',source:'WHOOP 紀錄 · Kelvin Health OS',minutes:'分鐘',strain:'運動負荷',preferences:'📔 日誌與 Coach 設定',coach:'💬 自動 Coach 邀請',quiet:'🌙 安靜時段',enabled:'開啟',disabled:'關閉',quietChoices:'安靜時段依你的當地時間。'},
 en:{title:'💬 What would you like to explore?',topics:['😴 Sleep','🌿 Recovery','🏃 Exercise'],today:'📅 Today',week:'🗓 Last 7 days',free:'⌨️ Type a question',ask:'Type your health question whenever you are ready.',skip:'⏭️ Skip today',pause:'⏸️ Pause invitations',paused:'Automatic Coach invitations are paused. You can still use /coach.',empty:'No usable scored records in this period; missing data is not treated as zero.',asof:'Data as of',count:'scored records',mean:'Average',source:'WHOOP records · Kelvin Health OS',minutes:'minutes',strain:'Workout strain',preferences:'📔 Journal and Coach settings',coach:'💬 Automatic Coach invitations',quiet:'🌙 Quiet hours',enabled:'On',disabled:'Off',quietChoices:'Quiet hours use your local timezone.'},
 vi:{title:'💬 Bạn muốn tìm hiểu điều gì?',topics:['😴 Giấc ngủ','🌿 Phục hồi','🏃 Vận động'],today:'📅 Hôm nay',week:'🗓 7 ngày qua',free:'⌨️ Nhập câu hỏi',ask:'Hãy nhập câu hỏi sức khỏe của bạn.',skip:'⏭️ Bỏ qua hôm nay',pause:'⏸️ Tạm dừng lời mời',paused:'Đã tạm dừng lời mời Coach tự động. Bạn vẫn có thể dùng /coach.',empty:'Không có bản ghi đã chấm điểm phù hợp; dữ liệu thiếu không được coi là số 0.',asof:'Dữ liệu tính đến',count:'bản ghi đã chấm điểm',mean:'Trung bình',source:'Dữ liệu WHOOP · Kelvin Health OS',minutes:'phút',strain:'Mức tải vận động',preferences:'📔 Cài đặt Nhật ký và Coach',coach:'💬 Lời mời Coach tự động',quiet:'🌙 Giờ yên tĩnh',enabled:'Bật',disabled:'Tắt',quietChoices:'Giờ yên tĩnh theo múi giờ địa phương.'},
});
const specs={sleep:{table:'whoop_sleeps',key:'id',time:'end_at',field:'total_sleep_milli',unit:'minutes',scale:60000,type:'sleep'},recovery:{table:'whoop_recoveries',key:'sleep_id',time:'health_date',field:'recovery_score',unit:'%',scale:1,type:'recovery'},exercise:{table:'whoop_workouts',key:'id',time:'start_at',field:'strain',unit:'strain',scale:1,type:'workout'}};
export function createCompanionCoach({core,stores,db,companion,coachContext=null}){
 const {interactions}=companion;
 async function query(actor,row,topic,range,c){
  if(!COACH_TOPICS.includes(topic)||!['today','week'].includes(range))fail('COACH_REGISTERED_QUERY_REQUIRED');
  const to=localDate(core.now(),actor.state.timezone),from=range==='today'?to:addDays(to,-6),spec=specs[topic];
  return stores.withContext(actor.control.userId,{executionMode:'SHADOW'},async context=>{
   const dateRange=topic==='recovery',start=dateRange?from:localMidnightUtc(from,actor.state.timezone).toISOString(),end=dateRange?to:core.timestamp();
   const rows=(await core.client.execute({sql:`SELECT ${spec.key} id FROM ${spec.table} WHERE user_id=? AND ${spec.time}>=? AND ${spec.time}<=? ORDER BY ${spec.time} DESC LIMIT 101`,args:[actor.control.userId,start,end]})).rows;
   if(rows.length>100)fail('COACH_QUERY_BOUNDS');const samples=[];
   for(const selected of rows){const root=await stores.root(context,spec.type,String(selected.id)),v=root.row[spec.field];
    await interactions.link('quick_action_interactions',row,spec.type,String(selected.id));
    if(root.row.score_state!=='SCORED'||topic==='sleep'&&root.row.nap!==0||topic==='recovery'&&root.row.user_calibrating===1||!Number.isFinite(v))continue;
    samples.push({value:v/spec.scale,at:root.row.updated_at??root.row.synced_at??root.row.health_date});
   }
   await stores.assertCurrent(context);
   if(!samples.length)return c.empty;
   const average=samples.reduce((sum,v)=>sum+v.value,0)/samples.length,asof=samples.map(v=>v.at).filter(v=>typeof v==='string').sort().at(-1);
   return `${c.topics[COACH_TOPICS.indexOf(topic)]} · ${from} — ${to}\n${c.mean}: ${average.toFixed(1)} ${c[spec.unit]??spec.unit} (${samples.length} ${c.count})\n${c.asof}: ${asof}\n${c.source}`;
  });
 }
 async function card(actor,row,{includeQuery=true}={}){
  // Render performs the same current actor/revision/profile/privacy check first.
  const reply=await interactions.render(actor,row),d=JSON.parse(row.diagnostics_json??'{}'),locale=presentationLocale(await db.getLocale(row.user_id)),c=COACH_COPY[locale],contextCopy=COACH_CONTEXT_COPY[locale];
  let text=c.title,buttons=[];
  if(includeQuery&&d.coachRange&&d.coachTopic)text=await query(actor,row,d.coachTopic,d.coachRange,c);
  if(d.coachFree)text=c.ask;
  if(row.state==='SKIPPED'||row.state==='CANCELLED')return {...reply,text:row.state==='CANCELLED'?c.paused:c.skip,replyMarkup:{inline_keyboard:[]}};
  buttons.push(COACH_TOPICS.map((topic,i)=>({text:c.topics[i],action:`coach:topic:${topic}`})));
  if(d.coachTopic){
   if(!d.coachRange&&!d.coachFree)text=`${c.topics[COACH_TOPICS.indexOf(d.coachTopic)]}\n${contextCopy.choose}`;
   buttons.push([{text:c.today,action:'coach:range:today'},{text:c.week,action:'coach:range:week'}]);
  }
  if(d.coachTopic&&d.coachRange&&!d.coachFree){
   text+=`\n\n${contextCopy.next}`;
   for(let i=0;i<COACH_FOLLOWUPS.length;i+=2)buttons.push(COACH_FOLLOWUPS.slice(i,i+2).map((focus,j)=>({text:contextCopy.followups[d.coachTopic][i+j],action:`coach:focus:${focus}`})));
  }
  buttons.push([{text:c.free,action:'coach:free'}]);
  if(d.automatic)buttons.push([{text:c.skip,action:'coach:skip'},{text:c.pause,action:'coach:pause'}]);
  const keyboard=[];for(const list of buttons){const line=[];for(const b of list)line.push(await interactions.button(actor,row,b));keyboard.push(line);}
  const projection={...reply,text,replyMarkup:{inline_keyboard:keyboard},stage7View:'COACH'};
  if(includeQuery&&d.coachTopic&&d.coachRange&&!d.coachFree){
   if(coachContext)return coachContext.project({user:await db.getUser(row.user_id),chatId:actor.chat,topic:d.coachTopic,range:d.coachRange,focus:d.coachFocus??'baseline',locale,reply:projection});
   return {...projection,text:`${text}\n\n${contextCopy.unavailable}`};
  }
  return projection;
 }
 async function issue(actor,{semanticKey=null,automatic=false,topic=null}={}){
  const issued=await interactions.issue(actor,{kind:'COACH',...(semanticKey?{semanticKey}:{}),diagnostics:{automatic,coachTopic:COACH_TOPICS.includes(topic)?topic:null}});
  return card(actor,issued.row);
 }
 async function handle({text,user,chatId,callback=null,requestKey=null,deferQuery=false}){
  const command=typeof text==='string'&&/^\/coach(?:@[A-Za-z0-9_]+)?\s*$/i.test(text.trim());
  if(!command&&!callback)return null;
  return core.transaction(async()=>{
   const actor=await interactions.authenticate({user,chatId,callback});
   if(command)return issue(actor,{semanticKey:requestKey?core.keys.lookup(['coach-command',user.id,requestKey]):null});
   const resolved=await interactions.resolve(actor,callback);if(!resolved||resolved.row.kind!=='COACH')return null;
   let {row,action}=resolved;const d=JSON.parse(row.diagnostics_json??'{}');
   if(!['ISSUED','COMPLETED'].includes(row.state))return interactions.expired(actor);
   if(action.startsWith('coach:topic:')&&COACH_TOPICS.includes(action.slice(12))){d.coachTopic=action.slice(12);delete d.coachRange;delete d.coachFocus;delete d.coachFree;}
   else if(action.startsWith('coach:range:')&&['today','week'].includes(action.slice(12))&&COACH_TOPICS.includes(d.coachTopic)){d.coachRange=action.slice(12);d.coachFocus='baseline';delete d.coachFree;}
   else if(action.startsWith('coach:focus:')&&COACH_FOLLOWUPS.includes(action.slice(12))&&COACH_TOPICS.includes(d.coachTopic)&&['today','week'].includes(d.coachRange)){d.coachFocus=action.slice(12);delete d.coachFree;}
   else if(action==='coach:free'){d.coachFree=true;delete d.coachRange;delete d.coachFocus;}
   else if(action==='coach:skip'&&d.automatic){row=await interactions.update(actor,row,{state:'SKIPPED'});return card(actor,row);}
   else if(action==='coach:pause'&&d.automatic){const p=await companion.preferences(actor);await companion.changePreferences(actor,p,{coach_enabled:0});row=await interactions.update(actor,row,{state:'CANCELLED'});return card(actor,row);}
   else return interactions.expired(actor);
   row=await interactions.update(actor,row,{diagnostics_json:JSON.stringify(d)});return card(actor,row,{includeQuery:!deferQuery});
  });
 }
 return {handle,issue,card};
}
