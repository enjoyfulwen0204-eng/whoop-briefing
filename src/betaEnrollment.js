import {randomBytes,timingSafeEqual} from 'node:crypto';
import {requirePhase4Keys} from './phase4Keys.js';
import {isApprovedStage7Three} from './stage7Cohort.js';
import {registrationMode,telegramRegistrationLocale,registrationClosedReply} from './registrationPolicy.js';
import {workStepOptions} from './phase4WorkStep.js';

export const DISCLAIMER_VERSION='2026-11-07-v2';
// Owner explicitly grandfathered the original three for v1 AND v2. A future
// version is not exempt automatically and must make a new consent decision.
const GRANDFATHERED_DISCLAIMER_VERSIONS=new Set(['2026-11-06-v1','2026-11-07-v2']);
const runtimes=new WeakMap();
const fail=code=>{throw Object.assign(Error(code),{code});};
export const betaEnabled=env=>env.BETA_MAX_USERS!==undefined;
export const isBetaCallback=value=>/^eb1:[A-Za-z0-9_-]{22}:(yes|no)$/.test(value??'');
export const betaRuntime=db=>runtimes.get(db);
export async function requireBetaConsent(db,userId){
 if(!betaEnabled(process.env)&&!runtimes.has(db))return;
 const runtime=runtimes.get(db);if(!runtime||!await runtime.consented(userId))fail('BETA_CONSENT_REQUIRED');
}
export const BETA_COPY={
 'zh-TW':{invalid:'❌ 邀請碼無效或已過期。',full:'🔒 目前名額已滿。',welcome:'👋 歡迎加入 WHOOP Health OS（測試版）\n你的邀請碼有效，接下來請先閱讀使用說明。',
 disclosure:'📋 使用前請先閱讀\n• 這是個人開發的測試服務，不是醫療器材，不能取代醫生的診斷\n• 健康分析和建議由 AI 產生，可能會有錯\n• 身體不舒服或遇到緊急狀況，請立刻就醫或撥打急救電話（台灣 119、越南 115）\n• 我們會讀取你的 WHOOP 資料（睡眠、恢復、心率、活動）來產生報告，不會提供給其他人；AI 分析時，必要的數字會傳給 AI 服務商處理\n• 你隨時可以中斷 WHOOP 連結，或刪除所有資料（健康資料會立刻刪除，系統運作紀錄會在 30 天內自動清除）',yes:'✅ 我已閱讀並同意',no:'✖️ 不同意',accepted:'✅ 已記錄同意。請輸入 /start 繼續連結 WHOOP。',declined:'✖️ 尚未同意，不會建立 WHOOP 連結。之後可輸入 /start 重來。',expired:'⌛ 操作已過期，請輸入 /start。',invite:'🔗 邀請連結（7 天內限用一次）',lost:'⌛ 邀請連結未能安全重播，請重新輸入 /admin invite。',users:'👥 使用者｜狀態｜加入日期｜本月 AI 費用｜最後同步'},
 en:{invalid:'❌ This invitation is invalid or expired.',full:'🔒 All beta places are currently filled.',welcome:'👋 Welcome to WHOOP Health OS (beta)\nYour invitation is valid. Please read the following information.',disclosure:'📋 Please read before continuing\n• This is a personally developed beta service, not a medical device or a substitute for medical diagnosis.\n• AI health analysis and suggestions may be wrong.\n• If you feel unwell or face an emergency, seek medical care immediately or call Taiwan 119 / Vietnam 115.\n• We read your WHOOP sleep, recovery, heart-rate and activity data to create reports. We do not share it with other people; necessary measurements are sent to AI providers for AI analysis.\n• You can disconnect WHOOP or delete all your data at any time (health data is deleted immediately; system operational records are automatically removed within 30 days).',yes:'✅ I have read and agree',no:'✖️ I do not agree',accepted:'✅ Agreement recorded. Send /start to continue connecting WHOOP.',declined:'✖️ No agreement recorded; WHOOP will not be connected. Send /start to try again.',expired:'⌛ This action expired. Send /start.',invite:'🔗 Invitation (one use within 7 days)',lost:'⌛ This invitation cannot be safely replayed. Send /admin invite again.',users:'👥 User | Status | Joined | Monthly AI cost | Last sync'},
 vi:{invalid:'❌ Mã mời không hợp lệ hoặc đã hết hạn.',full:'🔒 Hiện đã hết chỗ thử nghiệm.',welcome:'👋 Chào mừng đến WHOOP Health OS (thử nghiệm)\nMã mời hợp lệ. Vui lòng đọc hướng dẫn sau.',disclosure:'📋 Vui lòng đọc trước khi tiếp tục\n• Đây là dịch vụ thử nghiệm do cá nhân phát triển, không phải thiết bị y tế và không thay thế chẩn đoán của bác sĩ.\n• Phân tích và gợi ý sức khỏe do AI tạo có thể sai.\n• Khi không khỏe hoặc gặp tình huống khẩn cấp, hãy đi khám ngay hoặc gọi Việt Nam 115 / Đài Loan 119.\n• Chúng tôi đọc dữ liệu WHOOP về giấc ngủ, phục hồi, nhịp tim và hoạt động để tạo báo cáo, không cung cấp cho người khác; các số liệu cần thiết được gửi đến nhà cung cấp AI để phân tích.\n• Bạn có thể ngắt WHOOP hoặc xóa toàn bộ dữ liệu bất cứ lúc nào (dữ liệu sức khỏe được xóa ngay; nhật ký vận hành hệ thống được tự động xóa trong vòng 30 ngày).',yes:'✅ Tôi đã đọc và đồng ý',no:'✖️ Không đồng ý',accepted:'✅ Đã ghi nhận đồng ý. Gửi /start để tiếp tục kết nối WHOOP.',declined:'✖️ Chưa đồng ý; WHOOP sẽ không được kết nối. Gửi /start để thử lại.',expired:'⌛ Thao tác hết hạn. Gửi /start.',invite:'🔗 Lời mời (dùng một lần trong 7 ngày)',lost:'⌛ Không thể phát lại lời mời an toàn. Gửi lại /admin invite.',users:'👥 Người dùng | Trạng thái | Ngày tham gia | Phí AI tháng | Đồng bộ cuối'},
};
export function createBetaEnrollment({db,keys,environment=process.env,now=()=>new Date(),nonce=()=>randomBytes(16).toString('base64url'),version=DISCLAIMER_VERSION}){
 requirePhase4Keys(keys);
 const owners=()=>String(environment.OWNER_USER_IDS??'').split(',').map(x=>x.trim()).filter(Boolean);
 const original=String(environment.FAMILY_GROUP_USER_IDS??'').split(',').map(x=>x.trim()).filter(Boolean);
 const grandfathered=GRANDFATHERED_DISCLAIMER_VERSIONS.has(version)&&isApprovedStage7Three(original)?original:[];
 const key=(kind,id)=>'beta:v1:'+keys.lookup(['beta-state-key-v1',kind,id]);
 async function read(kind,id){const raw=await db.getState(key(kind,id));if(raw==null)return null;
  try{const {body,signature,...other}=JSON.parse(raw),expected=keys.lookup(['beta-state-v1',kind,id,body]);
   if(Object.keys(other).length||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))fail('BETA_STATE_INVALID');return body;
  }catch{fail('BETA_STATE_INVALID');}}
 const write=(kind,id,body)=>db.setState(key(kind,id),JSON.stringify({body,signature:keys.lookup(['beta-state-v1',kind,id,body])}),{now:now()});
 const transaction=(kind,id,fn)=>db.transaction(fn,workStepOptions('beta.'+kind,id,{discardResult:true,replay:()=>fail('BETA_REPLAY_FENCED')}));
 async function consented(uid){if(grandfathered.includes(uid))return true;const s=await read('member',uid);return s?.consent?.version===version&&typeof s.consent.at==='string';}
 async function eligible(user){
  if(!user||user.status!=='ACTIVE'||!await consented(user.id))return false;
  const r=(await db.raw.execute({sql:"SELECT 1 ok FROM user_whoop_tokens t JOIN user_onboarding o ON o.user_id=t.user_id JOIN users u ON u.id=t.user_id WHERE t.user_id=? AND u.status='ACTIVE' AND u.lifecycle_generation=? AND t.access_token IS NOT NULL AND t.access_token<>'' AND o.state='READY'",args:[user.id,user.lifecycleGeneration]})).rows;
  return r.length===1;
 }
 async function eligibleIds(){const users=await db.listActiveUsers(),ids=[];for(const u of users)if(await eligible(u))ids.push(u.id);return ids;}
 const rawInvites=new Map(); // Bearer code lives only until the acknowledged send, never in a receipt.
 async function invite(user,requestId){return transaction('invite',[user.id,requestId],async()=>{
  for(const [id,value] of rawInvites)if(value.expires<=now().getTime())rawInvites.delete(id);
  const current=await db.getUser(user.id);if(!owners().includes(user.id)||current?.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration)fail('BETA_OWNER_REQUIRED');
  const raw=randomBytes(24).toString('base64url'),hash=keys.lookup(['beta-invite-v1',raw]),handle=nonce();
  await write('invite',hash,{inviteHash:hash,issuedBy:user.id,createdAt:now().toISOString(),expiresAt:new Date(now().getTime()+7*86400000).toISOString(),used:false});
  rawInvites.set(handle,{raw,owner:user.id,expires:now().getTime()+600000});return handle;
 });}
 async function card(user,locale,{welcome=false}={}){const c=BETA_COPY[locale]??BETA_COPY.en,token=nonce(),s=await read('member',user.id)??{};
  s.prompt={token,version,life:user.lifecycleGeneration,expires:now().getTime()+86400000};await write('member',user.id,s);
  return {text:(welcome?c.welcome+'\n\n':'')+c.disclosure,replyMarkup:{inline_keyboard:[[{text:c.yes,callback_data:`eb1:${token}:yes`}],[{text:c.no,callback_data:`eb1:${token}:no`}]]}};
 }
 async function register({message,chatId}){
  if(registrationMode(environment)!=='invite')return registrationClosedReply(message);
  if(message?.chat?.type!=='private'||message.from?.is_bot===true||String(message.from?.id)!==String(chatId)||String(message.chat.id)!==String(chatId))fail('BETA_PRIVATE_SENDER_REQUIRED');
  const locale=telegramRegistrationLocale(message),c=BETA_COPY[locale],match=/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{32})\s*$/i.exec(message?.text??'');
  if(!match)return {text:c.invalid};const hash=keys.lookup(['beta-invite-v1',match[1]]);
  return transaction('register',[hash,String(chatId)],async()=>{
   if(registrationMode(environment)!=='invite')return registrationClosedReply(message);
   if(await db.getTelegramLink(String(chatId)))return {text:c.invalid};
   const invitation=await read('invite',hash);if(!invitation||invitation.used||Date.parse(invitation.expiresAt)<=now().getTime())return {text:c.invalid};
   const cap=Number(environment.BETA_MAX_USERS??7);if(!Number.isSafeInteger(cap)||cap<1||cap>7)fail('BETA_CAP_INVALID');
   const active=await db.listActiveUsers();let count=0;for(const u of active)if((await read('member',u.id))?.invited===true)count++;
   if(count>=cap)return {text:c.full};
   const name=[message?.from?.first_name,message?.from?.last_name].filter(Boolean).join(' ').trim().slice(0,60);
   const user=await db.createUser({displayName:name,allowEmptyDisplayName:true,timezone:'UTC',status:'ACTIVE',now:now()});
   const claim=await db.claimTelegramChat({chatId:String(chatId),userId:user.id,now:now()});if(!claim.ok||claim.userId!==user.id)fail('BETA_REGISTRATION_CONFLICT');
   await db.ensureOnboarding(user.id,{state:'STARTED',now:now()});await db.setLocale(user.id,locale,{now:now()});
   await write('member',user.id,{invited:true,inviteHash:hash,invitedBy:invitation.issuedBy,joinedAt:now().toISOString(),consent:null});
   await write('invite',hash,{...invitation,usedBy:user.id,used:true,usedAt:now().toISOString()});
   return card(user,locale,{welcome:true});
  });
 }
 async function handle({user,chatId,text,callback,requestId}){
  if(!user||user.status!=='ACTIVE')return null;
  const locale=await db.getLocale(user.id)??'en',c=BETA_COPY[locale]??BETA_COPY.en;
  if(/^\/admin(?:\s|$)/i.test(text??'')&&owners().includes(user.id)){
   if(/^\/admin\s+invite\s*$/i.test(text))return {text:c.invite,betaInviteHandle:await invite(user,requestId),betaLocale:locale};
   if(/^\/admin\s+users\s*$/i.test(text))return {betaAdminUsers:true,text:c.users};
   return {text:'🛠 /admin invite\n👥 /admin users'};
  }
  if(isBetaCallback(callback?.data))return transaction('consent',[user.id,callback.data],async()=>{
   const current=await db.resolveUserByChatId(String(chatId));if(current?.user?.id!==user.id||current.user.lifecycleGeneration!==user.lifecycleGeneration)fail('BETA_ACTOR_FENCED');
   const [,token,action]=callback.data.split(':'),s=await read('member',user.id);
   if(!s?.prompt||s.prompt.token!==token||s.prompt.version!==version||s.prompt.life!==user.lifecycleGeneration||s.prompt.expires<=now().getTime())return {text:c.expired};
   delete s.prompt;if(action==='yes')s.consent={version,at:now().toISOString()};await write('member',user.id,s);
   return {text:action==='yes'?c.accepted:c.declined,editMessageId:callback.message?.message_id,replyMarkup:{inline_keyboard:[]}};
  });
  if(!await consented(user.id))return transaction('prompt',[user.id,requestId],()=>card(user,locale));
  return null;
 }
 async function intercept({user,text,callback}){return Boolean(user&&(isBetaCallback(callback?.data)||/^\/admin(?:\s|$)/i.test(text??'')&&owners().includes(user.id)||!await consented(user.id)));}
 function wrapSender(send,{botUsername,adminUsers}){return async input=>{
  let reply=input.reply;
  if(reply?.betaInviteHandle){const v=rawInvites.get(reply.betaInviteHandle),c=BETA_COPY[reply.betaLocale]??BETA_COPY.en;
   const current=input.userId&&await db.getUser(input.userId);
   if(!current||current.status!=='ACTIVE'||!owners().includes(current.id))return {sent:false,reason:'beta_owner_fenced'};
   const username=v?typeof botUsername==='function'?await botUsername():botUsername:null;
   reply={text:v&&v.owner===current.id&&v.expires>now().getTime()&&/^[A-Za-z0-9_]{5,32}$/.test(username??'')?`${c.invite}\nhttps://t.me/${username}?start=${v.raw}`:c.lost};
   try{return await send({...input,reply});}finally{rawInvites.delete(input.reply.betaInviteHandle);}
  }
  if(reply?.betaAdminUsers){if(!owners().includes(input.userId)||(await db.getUser(input.userId))?.status!=='ACTIVE')return {sent:false,reason:'beta_owner_fenced'};reply={text:await adminUsers(reply.text)};}
  return send({...input,reply});
 };}
 const api={key,read,write,consented,eligible,eligibleIds,register,handle,intercept,invite,wrapSender,owners};runtimes.set(db,api);return api;
}
