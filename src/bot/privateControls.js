import {betaRuntime,betaEnabled,createBetaEnrollment} from '../betaEnrollment.js';
import {publicBetaKeys} from '../publicBetaConfig.js';

const copy={
 'zh-TW':{
  buttons:['🔋 電量','📝 記錄','⚙️ 設定'],prompt:'📝 想記錄什麼？直接打字告訴我就好，例如：「昨天喝了三杯酒」「今天喝了兩杯咖啡」「今天飛胡志明」',
  descriptions:['🔋 現在的 Body Energy','✍️ 記錄事件','📝 看最近的記錄','⚙️ 語言、名稱、帳號設定','📊 資料同步狀況','🧠 長期規律','🔮 恢復預測','🧪 自我實驗','💰 AI 使用成本','🩺 系統狀態','❓ 所有功能說明'],start:'👋 開始使用',admin:'🛠 管理',toggle:['🔋 定時電量：關','🔋 定時電量：開']},
 en:{
  buttons:['🔋 Energy','📝 Log','⚙️ Settings'],prompt:'📝 What would you like to log? Just type it, for example: “I had three drinks yesterday”, “I had two coffees today”, or “I flew to Ho Chi Minh City today”.',
  descriptions:['🔋 Current Body Energy','✍️ Log an event','📝 Recent logs','⚙️ Language, name, account','📊 Data sync status','🧠 Long-term patterns','🔮 Recovery prediction','🧪 Self-experiments','💰 AI usage cost','🩺 System status','❓ All features'],start:'👋 Get started',admin:'🛠 Admin',toggle:['🔋 Scheduled energy: off','🔋 Scheduled energy: on']},
 vi:{
  buttons:['🔋 Năng lượng','📝 Ghi chép','⚙️ Cài đặt'],prompt:'📝 Bạn muốn ghi lại điều gì? Hãy nhập trực tiếp, ví dụ: “Hôm qua tôi uống ba ly rượu”, “Hôm nay tôi uống hai ly cà phê” hoặc “Hôm nay tôi bay đến TP.HCM”.',
  descriptions:['🔋 Body Energy hiện tại','✍️ Ghi lại sự kiện','📝 Ghi chép gần đây','⚙️ Ngôn ngữ, tên, tài khoản','📊 Trạng thái đồng bộ dữ liệu','🧠 Quy luật dài hạn','🔮 Dự đoán phục hồi','🧪 Tự thử nghiệm','💰 Chi phí AI','🩺 Trạng thái hệ thống','❓ Tất cả tính năng'],start:'👋 Bắt đầu',admin:'🛠 Quản trị',toggle:['🔋 Năng lượng định kỳ: tắt','🔋 Năng lượng định kỳ: bật']},
};
const words=locale=>copy[locale]??copy.en;
const canonical=['/energy','/journal 7','/settings'];
const shortcuts=new Map(Object.values(copy).flatMap(c=>c.buttons.map((label,i)=>[label,canonical[i]])));
export const privateShortcut=text=>typeof text==='string'?shortcuts.get(text.trim())??null:null;
export const logPrompt=locale=>words(locale).prompt;
export async function fixedJournal({db,user,now=new Date()}){
 const {handleJournal}=await import('./commands.js'),locale=await db.getLocale(user.id);
 return logPrompt(locale)+'\n\n'+await handleJournal({db,userId:user.id,argsText:'7',timezone:user.timezone,now,locale});
}
export const timedToggleLabel=(locale,on)=>words(locale).toggle[Number(on)];
export const privateKeyboard=locale=>({keyboard:[words(locale).buttons.map(text=>({text}))],is_persistent:true,resize_keyboard:true,one_time_keyboard:false});
export function commandsFor(locale,{owner=false,defaults=false}={}){
 const c=words(locale),names=['energy','log','journal','settings','healthdata','insights','predictions','experiment','cost','status','help'];
 return defaults?[{command:'start',description:c.start},{command:'help',description:c.descriptions.at(-1)}]:
 [...names.map((command,i)=>({command,description:c.descriptions[i]})),...(owner?[{command:'admin',description:c.admin}]:[])];
}
export function enrollmentFor(db){
 return db&&(betaRuntime(db)??(betaEnabled(process.env)?createBetaEnrollment({db,keys:publicBetaKeys(process.env),environment:process.env}):null));
}
export async function privateContext(db,chatId,userId,enrollment=enrollmentFor(db)){
 if(!enrollment||!/^\d+$/.test(String(chatId)))return null;
 const u=(await db.resolveUserByChatId(String(chatId)))?.user;
 if(!u||(userId!=null&&u.id!==userId)||!await enrollment.eligible(u))return null;
 const locale=await db.getLocale(u.id);
 return Object.hasOwn(copy,locale)?{locale,owner:enrollment.owners().includes(u.id)}:null;
}
// Presentation only. Never modify signed or persisted reply text.
export function attachKeyboard(reply,context){
 if(!context||!reply||reply.editMessageId||reply.replyMarkup)return reply;
 return {...(typeof reply==='string'?{text:reply}:reply),replyMarkup:privateKeyboard(context.locale)};
}
export async function presentPrivate(db,chatId,reply,userId){
 if(!reply||reply.replyMarkup||reply.editMessageId)return reply;
 try{return attachKeyboard(reply,await privateContext(db,chatId,userId));}
 catch{return reply;} // Optional UI may disappear; the original delivery still has its own final authorization.
}
export function createCommandMenus({db,enrollment,api}){
 const seen=new Map(),pending=new Map();
 function sync(chatId,{remove=false}={}){
  const id=String(chatId);if(!/^\d+$/.test(id))return Promise.resolve(false);
  const job=(pending.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
   const c=await privateContext(db,id,null,enrollment),scope={type:'chat',chat_id:id};
   if(!c){if(remove||seen.has(id)){await api.deleteMyCommands({scope});seen.delete(id);}return false;}
   const signature=c.locale+':'+c.owner;
   if(seen.get(id)!==signature){await api.setMyCommands({scope,commands:commandsFor(c.locale,c)});seen.set(id,signature);}
   return true;
  });pending.set(id,job);return job.finally(()=>{if(pending.get(id)===job)pending.delete(id);});
 }
 async function initialize(){
  let chats=0,defaults=0,failed=0;
  for(const [locale,code] of [['en',null],['en','en'],['zh-TW','zh'],['vi','vi']]){
   try{await api.setMyCommands({scope:{type:'default'},...(code?{language_code:code}:{}),commands:commandsFor(locale,{defaults:true})});defaults++;}catch{failed++;}
  }
  for(const u of await db.listActiveUsers()){try{const id=await db.getActiveChatIdForUser(u.id,{expectedLifecycleGeneration:u.lifecycleGeneration});if(id&&await sync(id))chats++;}catch{failed++;}}
  console.log(JSON.stringify({event:'telegram_menu_sync',defaults,chats,failed}));
  return {defaults,chats,failed};
 }
 async function prepare(chatId,reply,userId){
  // Fast path: no menu API request unless the current locale/role changed.
  // Leave the original reply intact if the optional control lookup fails.
  try{
   if(reply?.replyMarkup?.remove_keyboard){await sync(chatId,{remove:true});return reply;}
   if(!userId)return reply;
   const c=await privateContext(db,chatId,userId,enrollment);
   if(c?seen.get(String(chatId))!==c.locale+':'+c.owner:seen.has(String(chatId)))await sync(chatId);
   return attachKeyboard(reply,c);
  }catch{console.warn(JSON.stringify({event:'telegram_menu_update_failed'}));return reply;}
 }
 return {sync,initialize,prepare};
}
export const timedEnergyEnabled=async(store,id)=>(await store.read('member',id))?.timedEnergy!==false;
