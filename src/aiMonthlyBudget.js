import {localDate,localMidnightUtc} from './time.js';
import {healthReminderTiming} from './healthReminderPolicy.js';
import {createTelegram} from './telegram.js';
import {createBetaEnrollment,betaRuntime} from './betaEnrollment.js';
import {workStepOptions} from './phase4WorkStep.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
export const AI_CAP_COPY={
 'zh-TW':'本月 AI 額度已用完，下個月 1 日恢復。',
 en:'Your monthly AI allowance is used up. It resets on the first day of next month.',
 vi:'Bạn đã dùng hết hạn mức AI tháng này. Hạn mức sẽ được khôi phục vào ngày 1 tháng sau.',
};
export function aiMonth(at=new Date()){
 const month=localDate(at,'Asia/Taipei').slice(0,7),[y,m]=month.split('-').map(Number);
 return {month,fromIso:localMidnightUtc(month+'-01','Asia/Taipei').toISOString(),toIso:new Date(Date.UTC(y,m,1)-8*3600000-1).toISOString()};
}
export async function monthlyAiUsage(db,userId,at=new Date()){
 if(typeof db?.getAiUsage!=='function')fail('AI_BUDGET_LEDGER_UNAVAILABLE');
 const range=aiMonth(at),rows=await db.getAiUsage(userId,{...range,limit:10001});
 if(!Array.isArray(rows)||rows.length>10000)fail('AI_BUDGET_LEDGER_BOUNDS');
 let cost=0,unknown=0;
 for(const row of rows){const value=row.estimated_cost_usd;
  if(value==null){if(row.request_status==='OK'||row.total_tokens>0)unknown++;continue;}
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('AI_BUDGET_LEDGER_INVALID');cost+=value;
 }
 return {...range,cost,unknown,calls:rows.length};
}
export async function checkAiBudget({db,userId,environment=process.env,now=new Date()}){
 if(environment.AI_MONTHLY_CAP_USD===undefined)return {limited:false,disabled:true};
 const cap=Number(environment.AI_MONTHLY_CAP_USD);if(!Number.isFinite(cap)||cap<=0)fail('AI_BUDGET_CONFIG_INVALID');
 if(typeof userId!=='string'||!userId)fail('AI_BUDGET_OWNER_REQUIRED');
 const usage=await monthlyAiUsage(db,userId,now);
 if(usage.unknown)fail('AI_BUDGET_COST_UNKNOWN');
 return {...usage,cap,limited:usage.cost>=cap,warning:usage.cost>=cap*.8};
}
export async function assertAiBudget(args){const s=await checkAiBudget(args);if(s.limited)fail('AI_MONTHLY_CAP_REACHED');return s;}
export async function renderAdminUsers(db,title,at=new Date()){
 const lines=[title];for(const u of await db.listUsers()){
  const cost=await monthlyAiUsage(db,u.id,at),sync=(await db.raw.execute({sql:'SELECT MAX(last_success_at) at FROM whoop_sync_state WHERE user_id=?',args:[u.id]})).rows[0]?.at;
  lines.push(`${String(u.displayName??'').replace(/[\r\n]/g,' ')}｜${u.status}｜${u.createdAt.slice(0,10)}｜${cost.unknown?'UNKNOWN':'US$'+cost.cost.toFixed(4)}｜${sync??'—'}`);
 }return lines.join('\n');
}
export async function notifyAiBudget(input){
 try{return await notifyBudget(input);}catch(error){
  // Optional notification failures cannot consume the user's entire companion
  // pass. A durable DELIVERY_STARTED barrier remains closed after uncertainty.
  try{const code=String(error?.code??error?.name??'UNKNOWN');console.log(JSON.stringify({event:'ai_budget_notice_skipped',user:input.keys.lookup(['companion-diagnostic-user-v1',input.user.id]),code:/^[A-Z_a-z0-9:]{1,100}$/.test(code)?code:'UNKNOWN'}));}catch{}
  return {status:'SKIPPED'};
 }
}
async function notifyBudget({db,keys,user,env,environment=process.env,now=()=>new Date(),send=null}){
 const budget=await checkAiBudget({db,userId:user.id,environment,now:now()});
 if(budget.disabled||!budget.warning)return {status:'NOT_DUE'};
 const store=betaRuntime(db)??createBetaEnrollment({db,keys,environment,now});
 const destinations=[...store.owners().map(id=>({id,threshold:80})),...(budget.limited?[{id:user.id,threshold:100}]:[])];
 for(const {id,threshold} of destinations){
  const recipient=await db.getUser(id);if(recipient?.status!=='ACTIVE')continue;
  const timing=await healthReminderTiming(db,id,recipient.timezone,now());if(timing.quiet||timing.paused)continue;
  const chatId=await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:recipient.lifecycleGeneration});if(!chatId)continue;
  const identity=[user.id,budget.month,threshold,id],stamp=keys.lookup(identity),locale=await db.getLocale(id)??'en';
  const authorized=async()=>{await db.assertAccountActive(id,recipient.lifecycleGeneration);await db.assertAccountActive(user.id,user.lifecycleGeneration);const t=await healthReminderTiming(db,id,recipient.timezone,now());return !t.quiet&&!t.paused&&aiMonth(now()).month===budget.month;};
  const claimed=await db.transaction(async()=>{if(await store.read('cost-notice',stamp)||!await authorized())return false;await store.write('cost-notice',stamp,{month:budget.month,threshold,status:'DELIVERY_STARTED'});return true;},workStepOptions('beta.cost.claim',identity,{discardResult:true,replay:()=>false}));
  if(!claimed)continue;
  const text=threshold===100?(AI_CAP_COPY[locale]??AI_CAP_COPY.en):({
   'zh-TW':`💰 ${user.displayName??'使用者'} 本月 AI 用量已達上限的 80%。`,
   vi:`💰 ${user.displayName??'Người dùng'} đã đạt 80% hạn mức AI tháng này.`,
   en:`💰 ${user.displayName??'A user'} has reached 80% of their monthly AI allowance.`,
  }[locale]??'💰 Monthly AI allowance: 80%.');
  const telegram=send??createTelegram({botToken:env.telegramBotToken,chatId,db,locale,dryRun:env.dryRun}).send;
  const result=await telegram(text,{authorize:authorized});
  if(result?.suppressed||result?.dryRun)return {status:'SUPPRESSED'};
  if(!/^\d+$/.test(String(result?.messageId??'')))fail('AI_BUDGET_NOTICE_UNCONFIRMED');
  await db.transaction(async()=>{
   await db.assertAccountActive(id,recipient.lifecycleGeneration);
   await db.assertAccountActive(user.id,user.lifecycleGeneration);
   await store.write('cost-notice',stamp,{month:budget.month,threshold,status:'DELIVERED'});
  },workStepOptions('beta.cost.settle',identity,{discardResult:true}));
 }
 return {status:'COMPLETE'};
}
