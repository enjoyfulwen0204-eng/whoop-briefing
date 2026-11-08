import {randomBytes} from 'node:crypto';

const fail=code=>{throw Object.assign(Error(code),{code});};
export const isAccountCallback=x=>typeof x==='string'&&/^av1:[\w-]{22}\.\d{1,3}\.(disconnect|stop|confirm|final|cancel|erase|erase_final)$/.test(x);
const COPY={
 'zh-TW':{disconnect:'🔌 中斷 WHOOP',stop:'🛑 停用帳號',cancel:'✖️ 取消',confirm:'🔌 確認中斷',stopConfirm:'🛑 確認停用',final:'🛑 停用',disconnectText:'🔌 中斷 WHOOP 連結？\n中斷後不再同步數據、不會收到晨報，歷史資料保留。\n之後輸入 /connect 就能重新連結。',stopText:'🛑 停用帳號？\n停用後會中斷 WHOOP、撤銷你給出和收到的所有家人分享、停止所有訊息，並解除這個 Telegram 的綁定。\n你的歷史資料會保留在系統裡，但不會再被讀取。想完整刪除資料，請用 🗑 刪除我的資料。',last:'⚠️ 最後確認：真的要停用嗎？',done:'🔌 已中斷 WHOOP。歷史資料保留；輸入 /connect 可重新連結。',stopped:'🛑 帳號已停用，歷史資料保留。重新啟用請聯絡 Kelvin。',warning:'WHOOP 那邊可能還保留授權，可以到 WHOOP App 移除。',expired:'操作已失效，請重新開啟 /settings。',cancelled:'已取消。'},
 en:{disconnect:'🔌 Disconnect WHOOP',stop:'🛑 Deactivate account',cancel:'✖️ Cancel',confirm:'🔌 Confirm disconnect',stopConfirm:'🛑 Confirm deactivation',final:'🛑 Deactivate',disconnectText:'🔌 Disconnect WHOOP?\nSync, Morning Brief and companion messages will stop. History is retained. Use /connect to reconnect.',stopText:'🛑 Deactivate account?\nThis disconnects WHOOP, revokes all incoming and outgoing family sharing, stops messages and unlinks Telegram. History is retained but will not be read. For full erasure, use 🗑 Delete my data.',last:'⚠️ Final confirmation: deactivate your account?',done:'🔌 WHOOP disconnected. History is retained. Use /connect to reconnect.',stopped:'🛑 Account deactivated. History retained. Contact Kelvin to reactivate.',warning:'WHOOP may still retain authorization. You can remove it in the WHOOP App.',expired:'This action expired. Open /settings again.',cancelled:'Cancelled.'},
 vi:{disconnect:'🔌 Ngắt WHOOP',stop:'🛑 Vô hiệu hóa tài khoản',cancel:'✖️ Hủy',confirm:'🔌 Xác nhận ngắt',stopConfirm:'🛑 Xác nhận vô hiệu hóa',final:'🛑 Vô hiệu hóa',disconnectText:'🔌 Ngắt kết nối WHOOP?\nDừng đồng bộ, bản tin sáng và tin nhắn đồng hành. Lịch sử được giữ lại. Dùng /connect để kết nối lại.',stopText:'🛑 Vô hiệu hóa tài khoản?\nNgắt WHOOP, thu hồi mọi chia sẻ gia đình hai chiều, dừng tin nhắn và gỡ liên kết Telegram. Lịch sử được giữ nhưng không đọc nữa. Để xóa hoàn toàn, dùng 🗑 Xóa dữ liệu của tôi.',last:'⚠️ Xác nhận cuối: thật sự vô hiệu hóa?',done:'🔌 Đã ngắt WHOOP. Giữ lịch sử. Dùng /connect để kết nối lại.',stopped:'🛑 Đã vô hiệu hóa tài khoản và giữ lịch sử. Liên hệ Kelvin để kích hoạt lại.',warning:'WHOOP có thể vẫn giữ quyền. Bạn có thể gỡ trong ứng dụng WHOOP.',expired:'Thao tác hết hạn. Mở lại /settings.',cancelled:'Đã hủy.'},
};
export const ERASURE_COPY={
 'zh-TW':{button:'🗑 刪除我的資料',confirm:'🗑 確認刪除',final:'🗑 永久刪除',text:'🗑 刪除我的所有資料？\n會立刻永久刪除：WHOOP 數據、晨報與分析紀錄、Journal、設定和家人分享，並中斷 WHOOP、解除這個 Telegram 綁定。\n系統運作紀錄（不含健康數據）會在 30 天內自動清除。\n刪除後無法復原，之後想再使用需要新的邀請連結。',last:'⚠️ 最後確認：真的要永久刪除嗎？',owner:'管理員帳號不能在這裡刪除',done:'✅ 你的資料已經全部刪除。系統運作紀錄會在 30 天內自動清除。謝謝你參加測試 🙏',pending:'⏳ 帳號已停用並解除綁定，刪除處理會自動繼續。'},
 en:{button:'🗑 Delete my data',confirm:'🗑 Confirm deletion',final:'🗑 Delete permanently',text:'🗑 Delete all my data?\nYour WHOOP data, reports, analysis, Journal, settings and family sharing will be permanently deleted immediately. WHOOP will be disconnected and this Telegram link removed.\nSystem operational records (without health data) will be automatically removed within 30 days.\nDeletion cannot be undone. A new invitation is required to return.',last:'⚠️ Final confirmation: permanently delete your data?',owner:'Administrator accounts cannot be deleted here.',done:'✅ Your data has been deleted. System operational records will be automatically removed within 30 days. Thank you for joining the beta 🙏',pending:'⏳ Your account is disabled and unlinked. Deletion will continue automatically.'},
 vi:{button:'🗑 Xóa dữ liệu của tôi',confirm:'🗑 Xác nhận xóa',final:'🗑 Xóa vĩnh viễn',text:'🗑 Xóa toàn bộ dữ liệu của tôi?\nDữ liệu WHOOP, bản tin, phân tích, Journal, cài đặt và chia sẻ gia đình sẽ bị xóa vĩnh viễn ngay lập tức. WHOOP sẽ bị ngắt và liên kết Telegram này được gỡ.\nNhật ký vận hành hệ thống (không chứa dữ liệu sức khỏe) sẽ tự động được xóa trong vòng 30 ngày.\nKhông thể hoàn tác. Bạn cần lời mời mới để quay lại.',last:'⚠️ Xác nhận cuối: thật sự xóa vĩnh viễn?',owner:'Không thể xóa tài khoản quản trị viên tại đây.',done:'✅ Dữ liệu của bạn đã được xóa. Nhật ký vận hành hệ thống sẽ tự động được xóa trong vòng 30 ngày. Cảm ơn bạn đã tham gia thử nghiệm 🙏',pending:'⏳ Tài khoản đã bị vô hiệu hóa và gỡ liên kết. Việc xóa sẽ tự động tiếp tục.'},
};
export async function revokeWhoopAccess(token,{fetchImpl=globalThis.fetch}={}){
 if(!token)return true;
 try{const r=await fetchImpl('https://api.prod.whoop.com/developer/v2/user/access',{method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});await r.body?.cancel();return r.ok;}catch{return false;}
}
/** Only user-confirmed, private account controls. No health payload or token is
 * placed in a reply, KV session, receipt, or log. The transport runs these as
 * NON_HEALTH operations because revoking the old authority must fence it. */
export function createAccountSelfService({db,keys,family=null,now=()=>new Date(),revoke=revokeWhoopAccess,erasure=null,ownerIds=[]}){
 const key=id=>'account-self:v1:'+keys.lookup(['account-self',id]);
 const seal=s=>JSON.stringify({s,proof:keys.lookup(['account-self-v1',s])});
 async function read(id){const raw=await db.getState(key(id));if(!raw)return null;try{const x=JSON.parse(raw);if(x.proof!==keys.lookup(['account-self-v1',x.s]))fail('ACCOUNT_CONTROL_INVALID');return x.s;}catch{fail('ACCOUNT_CONTROL_INVALID');}}
 const save=s=>db.setState(key(s.id),seal(s),{now:now()});
 const btn=(s,text,action)=>({text,callback_data:`av1:${s.nonce}.${s.rev}.${action}`});
 async function decorate(input){
  if(!/^\/settings(?:@\w+)?\s*$/i.test(input.text??''))return input.reply;
  const locale=await db.getLocale(input.user.id),c=COPY[locale]??COPY.en;
  const s={id:input.user.id,chat:String(input.chatId),life:input.user.lifecycleGeneration,nonce:randomBytes(16).toString('base64url'),rev:0,messageId:null,mode:'menu',expires:now().getTime()+900000};await save(s);
  return {...(typeof input.reply==='string'?{text:input.reply}:input.reply),accountSession:{id:s.id,nonce:s.nonce,rev:s.rev},replyMarkup:{inline_keyboard:[...(input.reply?.replyMarkup?.inline_keyboard??[]),[btn(s,c.disconnect,'disconnect')],[btn(s,c.stop,'stop')],...(erasure?[[btn(s,(ERASURE_COPY[locale]??ERASURE_COPY.en).button,'erase')]]:[]) ]}};
 }
 async function handle({user,chatId,callback}){
  const locale=await db.getLocale(user.id),c=COPY[locale]??COPY.en,s=await read(user.id);
  const match=isAccountCallback(callback?.data)&&/^av1:([\w-]+)\.(\d+)\.(\w+)$/.exec(callback.data);
  const resolved=await db.resolveUserByChatId(String(chatId)),current=resolved?.user??resolved;
  if(!s||!match||!current||current.id!==user.id||current.status!=='ACTIVE'||s.chat!==String(chatId)||s.life!==current.lifecycleGeneration||s.expires<=now().getTime()||s.nonce!==match[1]||s.rev!==Number(match[2])||s.messageId===null||String(s.messageId)!==String(callback.message?.message_id))return {text:c.expired};
  const action=match[3],ec=ERASURE_COPY[locale]??ERASURE_COPY.en;
  if(action==='erase_final')return {text:c.expired};
  if(action==='cancel'){s.rev++;s.expires=0;await save(s);return {text:c.cancelled};}
  if(action==='disconnect'&&s.mode==='menu')s.mode='disconnect';
  else if(action==='stop'&&s.mode==='menu')s.mode='stop';
  else if(action==='erase'&&s.mode==='menu'&&erasure){
   s.mode=ownerIds.includes(user.id)?'erase_owner':'erase';
  }
  else if(action==='confirm'&&s.mode==='erase'&&erasure&&!ownerIds.includes(user.id))s.mode='erase_final';
  else if(action==='confirm'&&s.mode==='stop')s.mode='final';
  else if(action==='confirm'&&s.mode==='disconnect'||action==='final'&&s.mode==='final'){
   const deactivate=s.mode==='final',tokens=await db.getTokens(user.id),generation=tokens?.authGeneration;
   // Provider call has a short bound; transport retries never skip local
   // revocation because remote failure is an explicit, sanitized result.
   const remote=()=>revoke(tokens?.accessToken);
   const revoked=db.outsideProcessingTransaction?await db.outsideProcessingTransaction('account-revoke:'+s.nonce,remote):await remote();
   await db.assertAccountActive(user.id,s.life);
   const fresh=await db.getTokens(user.id);if(fresh?.authGeneration!==generation)fail('ACCOUNT_AUTH_CHANGED');
   if(tokens?.accessToken||tokens?.refreshToken){
    const changed=await db.raw.execute({sql:"UPDATE user_whoop_tokens SET access_token='',refresh_token='',access_token_expires_at=?,auth_generation=auth_generation+1,updated_at=? WHERE user_id=? AND auth_generation=?",args:[now().toISOString(),now().toISOString(),user.id,generation]});
    if(Number(changed.rowsAffected)!==1)fail('ACCOUNT_AUTH_CHANGED');
   }
   await db.setOnboardingState(user.id,'ACTION_REQUIRED',{failureCode:'REAUTH_REQUIRED',failureDetail:'user_disconnected',expectedLifecycleGeneration:s.life,requireActiveLifecycle:true,now:now()});
   if(family){if(deactivate)await family.store.revokeMember(user.id);else await family.store.disconnectMember(user.id,generation);}
   if(deactivate){await db.revokeTelegramLink(String(chatId));await db.transitionUserLifecycle({userId:user.id,targetStatus:'DISABLED',expectedCurrentStatus:'ACTIVE',now:now()});}
   s.rev++;s.expires=0;await save(s);
   return {replyMarkup:{remove_keyboard:true},text:(deactivate?c.stopped:c.done)+(revoked?'':'\n'+c.warning)};
  }else return {text:c.expired};
  s.rev++;await save(s);
  if(s.mode.startsWith('erase'))return {accountSession:{id:s.id,nonce:s.nonce,rev:s.rev},text:s.mode==='erase_final'?ec.last:ec.text+(s.mode==='erase_owner'?'\n'+ec.owner:''),replyMarkup:{inline_keyboard:[s.mode==='erase_owner'?[btn(s,c.cancel,'cancel')]:[btn(s,s.mode==='erase'?ec.confirm:ec.final,s.mode==='erase'?'confirm':'erase_final'),btn(s,c.cancel,'cancel')]]}};
  return {accountSession:{id:s.id,nonce:s.nonce,rev:s.rev},text:s.mode==='disconnect'?c.disconnectText:s.mode==='stop'?c.stopText:c.last,replyMarkup:{inline_keyboard:[[btn(s,s.mode==='disconnect'?c.confirm:s.mode==='stop'?c.stopConfirm:c.final,s.mode==='final'?'final':'confirm'),btn(s,c.cancel,'cancel')]]}};
 }
 const wrapSender=send=>async input=>{
  const marker=input.reply?.accountSession;
  const result=await send(input);
  if(result?.sent&&marker)await db.transaction(async()=>{
   const s=await read(marker.id);if(s?.nonce===marker.nonce&&s.rev===marker.rev){s.messageId=String(result.messageId);await save(s);}
  });
  return result;
 };
 async function eraseFinal({chatId,callback}){
  if(!erasure)return {handled:false};
  let prepared=null;
  await db.transaction(async()=>{
   const resolved=await db.resolveUserByChatId(String(chatId)),user=resolved?.user??resolved;
   if(!user||user.status!=='ACTIVE'||ownerIds.includes(user.id))return;
   const s=await read(user.id),m=/^av1:([\w-]{22})\.(\d{1,3})\.erase_final$/.exec(callback?.data??'');
   if(!s||!m||s.mode!=='erase_final'||s.chat!==String(chatId)||s.life!==user.lifecycleGeneration
    ||s.expires<=now().getTime()||s.nonce!==m[1]||s.rev!==Number(m[2])||s.messageId===null||String(s.messageId)!==String(callback.message?.message_id))return;
   const locale=await db.getLocale(user.id);s.rev++;s.expires=0;await save(s);
   const fenced=await erasure.fence(user.id,{expectedLife:s.life});prepared={id:user.id,locale,revoked:fenced.revoked};
  });
  if(!prepared)return {handled:true,reply:null};
  const ec=ERASURE_COPY[prepared.locale]??ERASURE_COPY.en,c=COPY[prepared.locale]??COPY.en;
  let outcome;try{outcome=await erasure.eraseDisabled(prepared.id);}catch{outcome={status:'PENDING'};}
  // The final reply has no accountSession or userId. No receipt/session/usage
  // write may follow it; retries see the removed binding and never send again.
  return {handled:true,reply:{replyMarkup:{remove_keyboard:true},text:(['ERASED','ALREADY_ABSENT','PENDING_RECEIPTS'].includes(outcome.status)?ec.done:ec.pending)+(prepared.revoked?'':'\n'+c.warning)}};
 }
 return Object.freeze({decorate,handle,wrapSender,matches:isAccountCallback,eraseFinal,erasureEnabled:Boolean(erasure)});
}
