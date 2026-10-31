import {randomBytes} from 'node:crypto';
import {familyIdentity,FAMILY_CLASSES,familyFail} from './familySharingStore.js';

export const isFamilyCallback=text=>typeof text==='string'&&/^fv1:[A-Za-z0-9_-]{22}\.\d{1,4}\.[a-z0-9_]{1,16}$/.test(text);
export const FAMILY_COPY=Object.freeze({
 'zh-TW':{tracking:'👁 家人追蹤',sharing:'🔐 分享授權',invite:'➕ 邀請分享',daily:'📋 每日摘要',alert:'🔔 重要提醒',weekly:'🗓 每週摘要',back:'⬅️ 返回',cancel:'✖️ 關閉',decline:'✖️ 都不要',allow:'允許',revoke:'撤銷',receiving:'接收中',muted:'已靜音',all:'全部類別',none:'目前沒有其他可分享的家人。',expired:'這張分享卡已失效，請重新開啟 /settings。',explain:'預設不分享。只分享 Recovery、睡眠時數、Body Energy 與狀態燈；不分享生活紀錄、備註或問答。撤銷立即停止後續分享，但無法收回已送出的 Telegram 訊息。',request:'想查看你的健康摘要，預設不分享：',requested:'邀請已排入待送；勿擾時段後才會送出。',access:'對方分享給你',toggle:'點選切換；關閉即撤銷。',inviteTitle:'🔐 健康分享授權'},
 en:{tracking:'👁 Family tracking',sharing:'🔐 Sharing permissions',invite:'➕ Invite to share',daily:'📋 Daily summary',alert:'🔔 Important alerts',weekly:'🗓 Weekly summary',back:'⬅️ Back',cancel:'✖️ Close',decline:'✖️ Allow none',allow:'Allow',revoke:'Revoke',receiving:'Receiving',muted:'Muted',all:'All categories',none:'No other eligible family members.',expired:'This sharing card has expired. Open /settings again.',explain:'Sharing is off by default. Only Recovery, sleep hours, Body Energy and status lights are shared; never Journal, notes or Q&A. Revoking stops future sharing immediately but cannot recall Telegram messages already sent.',request:'would like to see your health summary. Nothing is shared by default:',requested:'Invitation queued; it will be sent outside quiet hours.',access:'Shared with you',toggle:'Tap to toggle; turning off revokes access.',inviteTitle:'🔐 Health sharing consent'},
 vi:{tracking:'👁 Theo dõi gia đình',sharing:'🔐 Quyền chia sẻ',invite:'➕ Mời chia sẻ',daily:'📋 Tóm tắt hằng ngày',alert:'🔔 Cảnh báo quan trọng',weekly:'🗓 Tóm tắt hằng tuần',back:'⬅️ Quay lại',cancel:'✖️ Đóng',decline:'✖️ Không cho phép',allow:'Cho phép',revoke:'Thu hồi',receiving:'Đang nhận',muted:'Đã tắt nhận',all:'Tất cả loại',none:'Không có thành viên gia đình phù hợp khác.',expired:'Thẻ chia sẻ đã hết hạn. Hãy mở lại /settings.',explain:'Mặc định không chia sẻ. Chỉ chia sẻ Recovery, số giờ ngủ, Body Energy và đèn trạng thái; không chia sẻ Nhật ký, ghi chú hay hỏi đáp. Thu hồi chặn chia sẻ tiếp theo ngay lập tức nhưng không thu hồi được tin Telegram đã gửi.',request:'muốn xem tóm tắt sức khỏe của bạn. Mặc định không chia sẻ:',requested:'Đã xếp hàng lời mời; sẽ gửi ngoài giờ yên tĩnh.',access:'Được chia sẻ với bạn',toggle:'Nhấn để đổi; tắt sẽ thu hồi quyền.',inviteTitle:'🔐 Cho phép chia sẻ sức khỏe'},
});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const cleanName=row=>String(row.display_name).replace(/[\r\n\t\u0000-\u001f]/g,' ').slice(0,64);
export {cleanName as familyName};
export function createFamilyUi({store,db,keys,now=()=>new Date(),nonce=()=>randomBytes(16).toString('base64url')}){
 const copy=async id=>FAMILY_COPY[await db.getLocale(id)]??FAMILY_COPY['zh-TW'];
 const button=(s,text,action)=>({text,callback_data:`fv1:${s.nonce}.${s.revision}.${action}`});
 async function issue(actor,{view='tracking',peer=null}={}){
  const s={version:1,nonce:nonce(),revision:0,actor:familyIdentity(actor),expires:now().getTime()+15*60000,view,peer,messageId:null};
  await store.write('ui',actor.id,s);return s;
 }
 async function render(actor,s,rows,state){
  const c=await copy(actor.id),peers=rows.filter(r=>r.id!==actor.id),peer=peers.find(r=>r.id===s.peer),keyboard=[];
  const index=id=>store.config.ids.indexOf(id);
  let text=s.view==='sharing'?c.sharing:c.tracking;
  if(s.view==='grants'&&peer){
   text=`${c.sharing} → ${cleanName(peer)}\n${c.explain}\n${c.toggle}`;
   for(const [i,category] of FAMILY_CLASSES.entries()){
    const granted=store.grantVisible(state,rows,actor.id,peer.id,category);
    keyboard.push([button(s,`${granted?'✅':'⛔'} ${c[category]}：${granted?c.revoke:c.allow}`,`g${index(peer.id)}${i}`)]);
   }
   keyboard.push([button(s,c.decline,`x${index(peer.id)}`)]);
  }else if(s.view==='follow'&&peer){
   text=`${c.tracking}：${cleanName(peer)}\n${c.access}\n`+FAMILY_CLASSES.map(k=>`${store.grantVisible(state,rows,peer.id,actor.id,k)?'✅':'⛔'} ${c[k]}`).join('\n');
   const m=state.mutes[store.pair(peer.id,actor.id)]??{};
   for(const [i,k] of ['all',...FAMILY_CLASSES].entries())keyboard.push([button(s,`${m[k]?'⛔':'✅'} ${c[k]}：${m[k]?c.muted:c.receiving}`,`m${index(peer.id)}${i}`)]);
   keyboard.push([button(s,c.invite,`i${index(peer.id)}`)]);
  }else{
   if(!peers.length)text+='\n'+c.none;
   for(const row of peers)keyboard.push([button(s,`👤 ${cleanName(row)}`,`${s.view==='sharing'?'s':'f'}${index(row.id)}`)]);
   if(s.view==='tracking')keyboard.push([button(s,c.invite,'invites')]);
   if(s.view==='invites'){text=c.invite;keyboard.length=0;for(const row of peers)keyboard.push([button(s,`👤 ${cleanName(row)}`,`i${index(row.id)}`)]);}
  }
  keyboard.push([button(s,c.back,s.view==='grants'?'sharing':'tracking'),button(s,c.cancel,'close')]);
  return sealReply(actor,s,{text,replyMarkup:{inline_keyboard:keyboard}});
 }
 function sealReply(actor,s,reply){const guard={actor:familyIdentity(actor),nonce:s.nonce,revision:s.revision,expires:s.expires};
  return {...reply,familyGuard:{...guard,signature:keys.lookup(['family-reply-v1',store.group,guard,reply])}};
 }
 async function decorate(input){
  if(!/^\/settings(?:@[A-Za-z0-9_]+)?\s*$/i.test(input.text??'')||!input.reply)return input.reply;
  const rows=await store.members();if(!rows.some(r=>r.id===input.user.id))return input.reply;
  const actor=await store.authenticate(input.user,input.chatId,rows),s=await issue(actor),c=await copy(actor.id);
  const reply={...(typeof input.reply==='string'?{text:input.reply}:input.reply)};
  reply.replyMarkup={inline_keyboard:[...(reply.replyMarkup?.inline_keyboard??[]),[button(s,c.tracking,'tracking')],[button(s,c.sharing,'sharing')]]};
  // This non-health menu is subsequently sealed by the existing Stage 7
  // presenter. Do not wrap two signatures around a mutually changing payload.
  return {...reply,familySession:{actor:familyIdentity(actor),nonce:s.nonce,revision:s.revision,expires:s.expires}};
 }
 async function handle({user,chatId,callback}){
  if(!isFamilyCallback(callback?.data))return null;
  return store.transaction('control',[user.id,callback.data],async()=>{
   const rows=await store.members(),actor=await store.authenticate(user,chatId,rows),c=await copy(actor.id),s=await store.read('ui',actor.id);
   const [,n,r,action]=/^fv1:([\w-]+)\.(\d+)\.(.+)$/.exec(callback.data);
   if(!s||s.version!==1||s.nonce!==n||s.revision!==Number(r)||s.expires<=now().getTime()
    ||!same(s.actor,familyIdentity(actor))||s.messageId===null||String(s.messageId)!==String(callback.message?.message_id))return {text:c.expired};
   if(action==='close'){s.revision++;s.expires=0;await store.write('ui',actor.id,s);return {text:c.sharing};}
   const match=/^([sfgmix])(\d)([0-3])?$/.exec(action),peer=match&&rows.find(r=>r.id===store.config.ids[Number(match[2])]&&r.id!==actor.id);
   let state=await store.state(),requested=false;
   if(['tracking','sharing','invites'].includes(action)){s.view=action;s.peer=null;}
   else if(peer){
    const op=match[1],category=FAMILY_CLASSES[Number(match[3])];s.peer=peer.id;
    if(op==='s')s.view='grants';else if(op==='f')s.view='follow';
    else if(op==='g'&&category){state=await store.change({actor,peer,category,kind:'grant',value:!store.grantVisible(state,rows,actor.id,peer.id,category)});s.view='grants';}
    else if(op==='x'){state=await store.change({actor,peer,kind:'decline'});s.view='grants';}
    else if(op==='m'){const k=['all',...FAMILY_CLASSES][Number(match[3])];if(!k)familyFail('FAMILY_ACTION_INVALID');state=await store.change({actor,peer,kind:'mute',category:k,value:!state.mutes[store.pair(peer.id,actor.id)]?.[k]});s.view='follow';}
    else if(op==='i'){state=await store.change({actor,peer,kind:'invite'});s.view='follow';requested=true;}
    else familyFail('FAMILY_ACTION_INVALID');
   }else return {text:c.expired};
   s.revision++;if(s.revision>9999)familyFail('FAMILY_SESSION_EXHAUSTED');await store.write('ui',actor.id,s);
   const reply=await render(actor,s,rows,state);
   if(requested){const {familyGuard,...body}=reply;body.text=c.requested+'\n'+body.text;return sealReply(actor,s,body);}return reply;
  });
 }
 async function invitation(actor,requester){
  const s=await issue(actor,{view:'grants',peer:requester.id}),c=await copy(actor.id),i=store.config.ids.indexOf(requester.id);
  return sealReply(actor,s,{text:`${c.inviteTitle}\n${cleanName(requester)} ${c.request}\n${c.explain}`,replyMarkup:{inline_keyboard:[...FAMILY_CLASSES.map((k,n)=>[button(s,`✅ ${c.allow} ${c[k]}`,`g${i}${n}`)]),[button(s,c.decline,`x${i}`)]]}});
 }
 async function verify(input){
  const g=input.reply?.familyGuard??input.reply?.familySession;if(!g)return true;
  if(input.reply.familyGuard){const {familyGuard,...body}=input.reply,{signature,...guard}=g;
   if(signature!==keys.lookup(['family-reply-v1',store.group,guard,body]))return false;}
  const rows=await store.members(),actor=rows.find(r=>r.id===input.userId),s=await store.read('ui',input.userId);
  return Boolean(actor&&actor.telegram_chat_id===String(input.chatId)&&same(g.actor,familyIdentity(actor))&&s
   &&s.nonce===g.nonce&&s.revision===g.revision&&g.expires>now().getTime());
 }
 async function bind(input,messageId){
  const g=input.reply?.familyGuard??input.reply?.familySession;if(!g)return;
  await store.transaction('bind',[input.userId,g.nonce,g.revision,messageId],async()=>{
   const s=await store.read('ui',input.userId);if(s?.nonce===g.nonce&&s.revision===g.revision){s.messageId=String(messageId);await store.write('ui',input.userId,s);}
  });
 }
 const wrapSender=send=>async input=>{
  const beforeSend=async()=> (!input.beforeSend||await input.beforeSend())&&await verify(input);
  if(!await beforeSend())return {sent:false,messageId:null,reason:'family_reply_fenced'};
  const result=await send({...input,beforeSend});if(result?.sent)await bind(input,result.messageId);return result;
 };
 return Object.freeze({handle,decorate,invitation,verify,bind,wrapSender});
}
