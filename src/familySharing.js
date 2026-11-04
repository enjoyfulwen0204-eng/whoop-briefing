import {createFamilyStore,familyConfiguration,familyIdentity,FAMILY_CLASSES,familyFail} from './familySharingStore.js';
import {createFamilyUi,familyName} from './familySharingUi.js';
import {localDate} from './time.js';
import {inStage7QuietHours} from './companionTimingPolicy.js';
import {currentExecutionBudget} from './executionBudget.js';
import {runCompanionStep,observeCompanionStep} from './companionStep.js';
import {createTelegramApi} from './bot/api.js';
import {createBodyEnergyRuntime} from './bodyEnergyRuntime.js';
import {POLICY_VERSION,SIGNAL_POLICY} from './proactivePolicy.js';
import {WEEKLY} from './config.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const dayShift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const taipeiParts=at=>({day:localDate(at,'Asia/Taipei'),minute:Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hourCycle:'h23',hour:'2-digit'}).format(at))*60+Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',minute:'2-digit'}).format(at))});
export function familyDue(at,category){const {day,minute}=taipeiParts(at),dow=new Date(day+'T00:00:00Z').getUTCDay();
 return category==='daily'?minute>=570&&minute<720:category==='weekly'?dow>=1&&dow<=WEEKLY.CATCHUP_DAYS&&(dow!==1||minute>=540):true;}
export const familyLight=value=>!Number.isFinite(value)?'⚪':value>=67?'🟢':value>=34?'🟡':'🔴';
const COPY={
 'zh-TW':{daily:'👨‍👩‍👧 家人今日狀況（09:30）',weekly:'🗓 家人每週摘要',missing:'今天還沒有資料',sleep:'睡',average:'平均',noWeek:'資料不足',reference:'參考值',advice:'建議關心一下，問問最近是不是比較累',signal:'有需要留意的健康訊號',low:'偏低',high:'偏高',repeat:'連續 2 天'},
 en:{daily:'👨‍👩‍👧 Family today (09:30 Taipei)',weekly:'🗓 Family weekly summary',missing:'No data today yet',sleep:'Sleep',average:'Average',noWeek:'Insufficient data',reference:'estimate',advice:'Consider checking in and asking whether they have been more tired recently',signal:'has a health signal worth attention',low:'low',high:'high',repeat:'for 2 consecutive days'},
 vi:{daily:'👨‍👩‍👧 Gia đình hôm nay (09:30 Đài Bắc)',weekly:'🗓 Tóm tắt gia đình hằng tuần',missing:'Hôm nay chưa có dữ liệu',sleep:'Ngủ',average:'Trung bình',noWeek:'Chưa đủ dữ liệu',reference:'tham khảo',advice:'Hãy hỏi thăm xem gần đây có mệt hơn không',signal:'có tín hiệu sức khỏe cần chú ý',low:'thấp',high:'cao',repeat:'trong 2 ngày liên tiếp'},
};
const METRICS={
 'zh-TW':{hrv:'HRV',rhr:'靜止心率',recovery:'Recovery',respiratory_rate:'呼吸率',sleep_performance:'睡眠表現',sleep_debt:'睡眠不足',previous_day_strain:'前一天活動負荷'},
 en:{hrv:'HRV',rhr:'Resting heart rate',recovery:'Recovery',respiratory_rate:'Respiratory rate',sleep_performance:'Sleep performance',sleep_debt:'Sleep debt',previous_day_strain:'Previous-day strain'},
 vi:{hrv:'HRV',rhr:'Nhịp tim nghỉ',recovery:'Recovery',respiratory_rate:'Nhịp thở',sleep_performance:'Hiệu suất giấc ngủ',sleep_debt:'Thiếu ngủ',previous_day_strain:'Mức gắng sức hôm trước'},
};
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const number=x=>Number.isFinite(x)?x.toFixed(1):'—';
const arrow=(a,b)=>!Number.isFinite(a)||!Number.isFinite(b)?'—':Math.abs(a-b)<.05?'→':a>b?'↗':'↘';
const quiet=(row,at)=>row.connected===0||row.paused===1||inStage7QuietHours(at,row.timezone,row.quiet_start,row.quiet_end);
const freshStamp=row=>row?[...familyIdentity(row),row.source_generation,row.connected,row.display_name,row.timezone,row.paused,row.quiet_start,row.quiet_end]:null;

/** On-demand, explicitly allowlisted projection. No Journal/Q&A reader is
 * reachable from this module; no summary or provider payload is persisted. */
export function createFamilySharing({db,keys,environment={},env={},now=()=>new Date(),send,bodyEnergyFactory}={}){
 if(!familyConfiguration(environment).enabled)return null;
 const store=createFamilyStore({db,keys,environment,now}),ui=createFamilyUi({store,db,keys,now});
 const transport=send??(async({chatId,reply})=>{
  if(env.dryRun)familyFail('FAMILY_DRY_RUN_SEND_FORBIDDEN');
  return createTelegramApi({botToken:env.telegramBotToken,requestTimeoutMs:4000}).sendMessage(chatId,reply);
 });
 let bodyPromise;
 const body=()=>bodyPromise??=bodyEnergyFactory?bodyEnergyFactory():createBodyEnergyRuntime({db,keys,environment,env,now}).then(r=>r.bodyEnergy);
 // Keep six seconds for the existing tick's heartbeat and cleanup. Cheap
 // deferred checks never consume a delivery identity or a user's quota.
 const room=(needed=10000)=>!currentExecutionBudget()||currentExecutionBudget().remainingMs()>needed+6000;
 async function snapshot(){const rows=await store.members(),state=await store.state();return {rows,state};}
 async function loadSummary(source,at,{daily}){
  if(source.connected===0)return {today:null,energy:null,current:{recovery:null,sleep:null},previous:{recovery:null,sleep:null}};
  const date=localDate(at,source.timezone),{day}=taipeiParts(at),monday=dayShift(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
  const from=dayShift(monday,-14),to=date;
  const [sleeps,recoveries]=await Promise.all([db.getSleeps(source.id,{from,to}),db.getRecoveries(source.id,{from,to})]);
  if(!room(6000))return null;
  const byDay=new Map();
  for(const s of sleeps){if(s.score_state!=='SCORED'||s.nap||byDay.has(s.health_date)||!Number.isFinite(s.total_sleep_milli))continue;
   const r=recoveries.find(r=>r.sleep_id===s.id&&r.score_state==='SCORED'&&Number.isFinite(r.recovery_score));
   if(r)byDay.set(s.health_date,{recovery:r.recovery_score,sleep:s.total_sleep_milli/3600000});
  }
  const today=byDay.get(date)??null;
  let energy=null;
  if(daily&&today){const result=await (await body()).inspect({userId:source.id,healthDate:date,requestedAt:at});
   if(['AVAILABLE','LIMITED'].includes(result.calculation?.quality_state)&&Number.isFinite(result.calculation.value))energy={value:result.calculation.value,limited:result.calculation.quality_state==='LIMITED'};}
  const range=(a,b)=>{const v=[...byDay].filter(([d])=>d>=a&&d<b).map(([,r])=>r);return {recovery:mean(v.map(r=>r.recovery)),sleep:mean(v.map(r=>r.sleep))};};
  return {today,energy,current:range(dayShift(monday,-7),monday),previous:range(dayShift(monday,-14),dayShift(monday,-7))};
 }
 function dailyLine(row,data,c){if(!data.today)return `⚪ ${familyName(row)}　${c.missing}`;
  return `${familyLight(data.today.recovery)} ${familyName(row)}　Recovery ${number(data.today.recovery)}%｜${c.sleep} ${number(data.today.sleep)}h｜🔋 ${data.energy?data.energy.value+(data.energy.limited?' ('+c.reference+')':''):c.noWeek}`;}
 function weeklyLine(row,data,c){return `👤 ${familyName(row)}　${c.average} Recovery ${number(data.current.recovery)}% ${arrow(data.current.recovery,data.previous.recovery)}｜${c.sleep} ${number(data.current.sleep)}h ${arrow(data.current.sleep,data.previous.sleep)}`;}
 async function deliver({recipient,sources=[],category,period,reply,expected,invite=null}){
  if(!room(4000))return {status:'DEFERRED_BUDGET'};
  // A stable per-day/week barrier survives permission, lifecycle and release
  // changes. Unknown ACKs and crashes after commit can never regain send rights.
  const id=keys.lookup(['family-delivery-v1',category,recipient.id,period,...(category==='alert'||category==='invite'?sources.map(r=>r.id):[])]);
  let claimed=false;
  await store.transaction('delivery-start',[id],async()=>{
   const prior=await store.read('delivery',id);if(prior)return;
   const fresh=await snapshot(),r=fresh.rows.find(r=>r.id===recipient.id);
   if(!r||!same(freshStamp(r),freshStamp(recipient))||quiet(r,now())||!familyDue(now(),category))return;
   if(!sources.every(s=>same(freshStamp(fresh.rows.find(r=>r.id===s.id)),freshStamp(s))))return;
   if(category==='invite'){
    if(!same(fresh.state.invites[store.pair(sources[0].id,r.id)],invite))return;
   }else if(!sources.every(s=>store.allowed(fresh.state,fresh.rows,s.id,r.id,category)))return;
   // Consent revision recheck covers a revoke/regrant ABA and recipient mutes.
   if(fresh.state.revision!==expected)return;
   await store.write('delivery',id,{status:'DELIVERY_STARTED',at:now().toISOString()});claimed=true;
  });
  if(!claimed)return {status:'SUPPRESSED'};
  // Final currentness check immediately before the only provider call. No
  // mutation/retry is permitted to resurrect a suppressed or uncertain send.
  const final=await snapshot(),r=final.rows.find(r=>r.id===recipient.id);
  if(!r||quiet(r,now())||!familyDue(now(),category)||final.state.revision!==expected||!same(freshStamp(r),freshStamp(recipient))
   ||!sources.every(s=>{const current=final.rows.find(r=>r.id===s.id);return current&&same(freshStamp(current),freshStamp(s))&&(category==='invite'||store.allowed(final.state,final.rows,s.id,r.id,category));})
   ||!room(0)||category==='invite'&&!await ui.verify({reply,userId:r.id,chatId:r.telegram_chat_id}))return {status:'SUPPRESSED'};
  try{
   const result=await transport({chatId:r.telegram_chat_id,reply,userId:r.id});
   if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0)familyFail('FAMILY_ACK_UNKNOWN');
   await store.transaction('delivery-settle',[id,result.message_id],()=>store.write('delivery',id,{status:'DELIVERED',at:now().toISOString()}));
   if(category==='invite')await ui.bind({reply,userId:r.id},result.message_id);
   return {status:'DELIVERED'};
  }catch(error){
   // Never persist error text/payload. A failed or unknown send remains
   // DELIVERY_STARTED; no automatic replay, replacement or receipt reset.
   throw Object.assign(Error('FAMILY_DELIVERY_UNCERTAIN'),{code:'FAMILY_DELIVERY_UNCERTAIN'});
  }
 }
 async function tick(){
  if(!room()){for(const userId of familyConfiguration(environment).ids)for(const c of FAMILY_CLASSES)observeCompanionStep({keys,userId,step:'family_'+c,status:'DEFERRED_BUDGET'});return {results:[],status:'DEFERRED_BUDGET',deferredSteps:Object.fromEntries(FAMILY_CLASSES.map(c=>['family_'+c,familyConfiguration(environment).ids.length]))};}
  const initial=await snapshot(),at=now(),summaries=new Map(),alerts=new Map(),results=[],{day}=taipeiParts(at);
  if(!Object.keys(initial.state.invites).length&&!initial.rows.some(s=>initial.rows.some(r=>FAMILY_CLASSES.some(c=>store.allowed(initial.state,initial.rows,s.id,r.id,c)))))return {results,status:'NO_CONSENT'};
  // No consent => no health reads, calculation, sender or writes.
  const summary=(row,daily)=>{if(!summaries.has(row.id))summaries.set(row.id,loadSummary(row,at,{daily}));return summaries.get(row.id);};
  const allDaily=source=>initial.rows.some(r=>store.allowed(initial.state,initial.rows,source.id,r.id,'daily'));
  const run=(r,name,fn)=>runCompanionStep({db,keys,userId:r.id,step:name,run:fn});
  for(const recipient of initial.rows){
   let locale,c;
   for(const category of FAMILY_CLASSES){
    const step='family_'+category;
    if(!room()){observeCompanionStep({keys,userId:recipient.id,step,status:'DEFERRED_BUDGET'});results.push({user:rHash(recipient.id),step,status:'DEFERRED_BUDGET',duration_ms:0});continue;}
    if(!locale){locale=await db.getLocale(recipient.id);c=COPY[locale]??COPY['zh-TW'];}
    const stepStarted=Date.now();
    const result=await run(recipient,step,async()=>{
     const {rows,state}=await snapshot(),r=rows.find(v=>v.id===recipient.id);if(!r||quiet(r,at))return {status:'QUIET_HOURS'};
     if(category==='daily'){
      // Invitations contain no health data and have their own dedupe barrier.
      for(const request of Object.values(state.invites)){
       if(request.target[0]!==r.id||Date.parse(request.at)+72*3600000<=at.getTime())continue;
       const a=rows.find(v=>v.id===request.requester[0]);
       if(!a||!same(familyIdentity(a),request.requester)||!same(familyIdentity(r),request.target))continue;
       const id=keys.lookup(['family-delivery-v1','invite',r.id,request.at,a.id]);if(await store.read('delivery',id))continue;
       const reply=await store.transaction('invitation',[r.id,request.at],()=>ui.invitation(r,a));
       return deliver({recipient:r,sources:[a],category:'invite',period:request.at,reply,expected:state.revision,invite:request});
      }
     }
     const sources=rows.filter(s=>store.allowed(state,rows,s.id,r.id,category));if(!sources.length)return {status:'NO_CONSENT'};
     // Monday is also the historical weekly delivery identity. Reusing it
     // keeps Monday's accepted/uncertain sends fenced throughout catch-up.
     const period=category==='weekly'?dayShift(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7)):day;
     if(!familyDue(at,category)){
      if(category==='daily'&&taipeiParts(at).minute>=720){
       const prior=await store.read('delivery',keys.lookup(['family-delivery-v1',category,r.id,period]));
       if(!prior){try{console.log(JSON.stringify({event:'family_daily_window_missed',user:rHash(r.id),day,status:'WINDOW_CLOSED'}));}catch{/* diagnostics cannot authorize delivery */}}
       return {status:prior?'SUPPRESSED':'WINDOW_CLOSED'};
      }
      return {status:'NOT_DUE'};
     }
     if(category==='alert'){
      for(const source of sources){
       if(!room())return {status:'DEFERRED_BUDGET'};
       if(!alerts.has(source.id))alerts.set(source.id,db.getRecentProactiveEvents(source.id,{sinceIso:new Date(at.getTime()-86400000).toISOString(),limit:12}));
       const events=await alerts.get(source.id),event=events.find(e=>e.policyVersion===POLICY_VERSION&&['NOTIFY','ASK_CONTEXT'].includes(e.decision)
        &&e.lifecycleGeneration===source.lifecycle_generation&&e.healthDate===localDate(at,source.timezone)&&Date.parse(e.createdAt)<=at.getTime());
       if(!event)continue;
       // Fixed vocabulary only: no event narrative, answers, numeric signal
       // values, pending question or Journal contents can enter this message.
       const signals=event.signals.filter(s=>SIGNAL_POLICY.MONITORED_METRICS.includes(s.metric));
       const labels=signals.map(s=>((METRICS[locale]??METRICS['zh-TW'])[s.metric])
        +(s.direction==='low'?' '+c.low:s.direction==='high'?' '+c.high:''));
       const persistent=event.reason?.factors?.persistent===true?' '+c.repeat:'';
       const reply={text:`🔔 ${familyName(source)}：${labels.length?[...new Set(labels)].join('、'):c.signal}${persistent}\n${c.advice}`};
       const value=await deliver({recipient:r,sources:[source],category,period:localDate(at,r.timezone),reply,expected:state.revision});
       if(value.status!=='SUPPRESSED')return value;
      }return {status:'NO_NEW_SIGNAL'};
     }
     const id=keys.lookup(['family-delivery-v1',category,r.id,period]);if(await store.read('delivery',id))return {status:'SUPPRESSED'};
     const lines=[];
     for(const source of sources){if(!room())return {status:'DEFERRED_BUDGET'};const data=await summary(source,allDaily(source));
      if(!data)return {status:'DEFERRED_BUDGET'};
      // Discard cached snapshots after a source generation/identity change.
      if(!same(freshStamp(initial.rows.find(v=>v.id===source.id)),freshStamp(source)))return {status:'FENCED'};
      lines.push(category==='daily'?dailyLine(source,data,c):weeklyLine(source,data,c));}
     return deliver({recipient:r,sources,category,period,reply:{text:c[category]+'\n'+lines.join('\n')},expected:state.revision});
    });
    results.push({user:rHash(recipient.id),step,status:result.status,duration_ms:Date.now()-stepStarted});
   }
  }
  return {results,status:'COMPLETE',deferredSteps:Object.fromEntries(FAMILY_CLASSES.map(c=>['family_'+c,results.filter(r=>r.step==='family_'+c&&r.status==='DEFERRED_BUDGET').length]).filter(([,n])=>n))};
 }
 const rHash=id=>keys.lookup(['companion-diagnostic-user-v1',id]);
 return Object.freeze({store,ui,tick});
}
