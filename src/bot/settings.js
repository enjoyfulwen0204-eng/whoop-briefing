import {randomBytes,createHash} from 'node:crypto';
import {LOCALES} from '../localization.js';
import {requireUserId} from '../userContext.js';

export const SETTINGS_TTL_MS=15*60_000;
export const SETTINGS_NAME_LIMIT=64;
const copy={
 'zh-TW':{title:'⚙️ 設定',language:'🌐 更改語言',name:'✏️ 更改顯示名稱',choose:'🌐 請選擇語言',confirmLanguage:'確認使用這個語言？',enter:'✏️ 請輸入顯示名稱（最多 64 個字）。',preview:'確認顯示名稱：',saved:'✅ 設定已儲存。',cancelled:'已取消。',expired:'這個設定操作已過期，請重新輸入 /settings。',invalid:'名稱無效，請輸入 1–64 個字，避免控制字元。',conflict:'設定已在其他操作中變更，請重新輸入 /settings。',back:'⬅️ 返回',cancel:'❌ 取消',confirm:'✅ 確認',save:'✅ 儲存',edit:'✏️ 編輯名稱'},
 en:{title:'⚙️ Settings',language:'🌐 Change Language',name:'✏️ Change Display Name',choose:'🌐 Choose a language',confirmLanguage:'Confirm this language?',enter:'✏️ Enter a display name (up to 64 characters).',preview:'Confirm display name:',saved:'✅ Settings saved.',cancelled:'Cancelled.',expired:'This settings interaction has expired. Use /settings again.',invalid:'Invalid name. Enter 1–64 characters without control characters.',conflict:'Settings changed in another interaction. Use /settings again.',back:'⬅️ Back',cancel:'❌ Cancel',confirm:'✅ Confirm',save:'✅ Save',edit:'✏️ Edit Name'},
 vi:{title:'⚙️ Cài đặt',language:'🌐 Đổi ngôn ngữ',name:'✏️ Đổi tên hiển thị',choose:'🌐 Chọn ngôn ngữ',confirmLanguage:'Xác nhận ngôn ngữ này?',enter:'✏️ Nhập tên hiển thị (tối đa 64 ký tự).',preview:'Xác nhận tên hiển thị:',saved:'✅ Đã lưu cài đặt.',cancelled:'Đã hủy.',expired:'Thao tác cài đặt đã hết hạn. Hãy dùng /settings lại.',invalid:'Tên không hợp lệ. Nhập 1–64 ký tự, không dùng ký tự điều khiển.',conflict:'Cài đặt đã thay đổi trong thao tác khác. Hãy dùng /settings lại.',back:'⬅️ Quay lại',cancel:'❌ Hủy',confirm:'✅ Xác nhận',save:'✅ Lưu',edit:'✏️ Sửa tên'},
};
export const SETTINGS_COPY=Object.freeze(copy);
const languages=[['tw','zh-TW','🇹🇼 繁體中文'],['en','en','🇺🇸 English'],['vi','vi','🇻🇳 Tiếng Việt']];
export const settingsKey=uid=>'settings:v1:'+createHash('sha256').update(requireUserId(uid,'settingsKey')).digest('hex');
export function normalizeSettingsName(value){
 if(typeof value!=='string'||!value.isWellFormed())throw Error('SETTINGS_NAME_INVALID');
 const name=value.normalize('NFC').trim();
 if(!name||/[\p{Cc}\p{Cs}]/u.test(name)||/\p{Cf}/u.test(name.replace(/\u200D/g,''))||!/[\p{L}\p{N}\p{S}]/u.test(name))throw Error('SETTINGS_NAME_INVALID');
 const normalized=name.replace(/\s+/gu,' ');
 const size=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(normalized)].length;
 if(size>SETTINGS_NAME_LIMIT||Buffer.byteLength(normalized,'utf8')>256)throw Error('SETTINGS_NAME_INVALID');
 return normalized;
}
const callbackPattern=/^sv1:([A-Za-z0-9_-]{22})\.(\d{1,4})\.(language|name|back|cancel|tw|en|vi|confirm|save|edit)$/;
export const isSettingsCallback=value=>typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&callbackPattern.test(value);
function session(raw,uid,chatId,life,at){
 let s;try{s=JSON.parse(raw);}catch{return null;}
 if(!s||s.version!==1||s.uid!==uid||s.chatId!==chatId||s.lifecycle!==life||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=at
  ||!Number.isSafeInteger(s.revision)||s.revision<0||s.revision>9999||!/^[-\w]{22}$/.test(s.nonce??'')
  ||!Number.isSafeInteger(s.profileRevision)||s.profileRevision<0
  ||typeof s.expectedName!=='string'||(s.expectedLocale!==null&&!LOCALES.includes(s.expectedLocale))
  ||!['menu','language','language_confirm','name_edit','name_confirm'].includes(s.mode))return null;
 if(s.mode==='language_confirm'&&!LOCALES.includes(s.nextLocale))return null;
 if(s.mode==='name_confirm'){try{normalizeSettingsName(s.pendingName);}catch{return null;}}
 return s;
}
function render(s,locale){
 const c=copy[locale??'en'];
 const button=(label,action)=>({text:label,callback_data:`sv1:${s.nonce}.${s.revision}.${action}`});
 const nav=[button(c.back,'back'),button(c.cancel,'cancel')];
 let text,rows;
 if(s.mode==='menu'){text=c.title;rows=[[button(c.language,'language')],[button(c.name,'name')],[button(c.cancel,'cancel')]];}
 if(s.mode==='language'){text=locale?c.choose:'🌐 Language / 語言 / Ngôn ngữ';rows=languages.map(([code,,label])=>[button(label,code)]);rows.push(nav);}
 if(s.mode==='language_confirm'){text=`${c.confirmLanguage}\n${languages.find(x=>x[1]===s.nextLocale)?.[2]??''}`;rows=[[button(c.confirm,'confirm')],nav];}
 if(s.mode==='name_edit'){text=c.enter;rows=[nav];}
 if(s.mode==='name_confirm'){text=`${c.preview}\n${s.pendingName}`;rows=[[button(c.save,'save'),button(c.edit,'edit')],nav];}
 return {text,replyMarkup:{inline_keyboard:rows}};
}
/** Narrow Settings v1 state machine. Transport authenticates private actor;
 * every action rebinds canonical actor inside the existing operation transaction.
 * One expiring profile-only row in existing telegram_state; no new schema. */
export function createSettings({db,now=()=>new Date(),nonce=()=>randomBytes(16).toString('base64url')}={}){
 return async function handleSettings({text,chatId,user,callback}={}){
  const command=typeof text==='string'?text.trim().match(/^\/(settings|language|name)(?:@[A-Za-z0-9_]+)?\s*$/i):null;
  const data=callback?.data;
  if(callback&&!isSettingsCallback(data))return null;
  if(!command&&!callback&&(!text||text.trim().startsWith('/')))return null;
  return db.transaction(async()=>{
   const uid=requireUserId(user?.id,'settings'),chat=String(chatId),resolved=await db.resolveUserByChatId(chat),current=resolved?.user??resolved;
   if(!current||current.id!==uid||current.status!=='ACTIVE'||!Number.isSafeInteger(current.lifecycleGeneration)||current.lifecycleGeneration<1||current.lifecycleGeneration!==user.lifecycleGeneration)return {text:copy.en.expired};
   const profileRevision=await db.getProfileRevision(uid);
   const locale=await db.getLocale(uid),c=copy[locale??'en'],at=now().getTime(),key=settingsKey(uid),raw=await db.getState(key);
   let s=session(raw,uid,chat,current.lifecycleGeneration,at);
   const persist=()=>db.setState(key,JSON.stringify(s),{now:now()});
   if(command){
    s={version:1,profileRevision,uid,chatId:chat,lifecycle:current.lifecycleGeneration,nonce:nonce(),revision:0,expiresAt:at+SETTINGS_TTL_MS,
     mode:command[1].toLowerCase()==='name'?'name_edit':command[1].toLowerCase()==='language'||!locale?'language':'menu',expectedName:current.displayName??'',expectedLocale:locale};
    await persist();return render(s,locale);
   }
   if(!s){if(raw)await db.setState(key,null);if(callback)return {text:c.expired};return null;}
   if(callback){
    const [,id,rev,action]=data.match(callbackPattern);
    if(id!==s.nonce||Number(rev)!==s.revision)return {text:c.expired};
    if(action==='cancel'){await db.setState(key,null);return {text:c.cancelled};}
    if(action==='back'){s.mode='menu';delete s.pendingName;delete s.nextLocale;}
    else if(action==='language'&&s.mode==='menu'){s.mode='language';s.expectedLocale=locale;}
    else if(action==='name'&&s.mode==='menu'){s.mode='name_edit';s.expectedName=current.displayName??'';}
    else if(languages.some(x=>x[0]===action)&&s.mode==='language'){s.nextLocale=languages.find(x=>x[0]===action)[1];s.mode='language_confirm';}
    else if(action==='edit'&&s.mode==='name_confirm'){s.mode='name_edit';delete s.pendingName;}
    else if(action==='confirm'&&s.mode==='language_confirm'){
     if(!LOCALES.includes(s.nextLocale))return {text:c.expired};
     if(profileRevision!==s.profileRevision||locale!==s.expectedLocale)return {text:c.conflict};
     await db.setLocale(uid,s.nextLocale,{now:now(),expectedProfileRevision:s.profileRevision});await db.setState(key,null);return {text:copy[s.nextLocale].saved};
    }else if(action==='save'&&s.mode==='name_confirm'){
     const name=normalizeSettingsName(s.pendingName);
     if(profileRevision!==s.profileRevision||(current.displayName??'')!==s.expectedName)return {text:c.conflict};
     if(name!==current.displayName)await db.updateUser(uid,{displayName:name},{now:now(),expectedProfileRevision:s.profileRevision});
     await db.setState(key,null);return {text:c.saved};
    }else return {text:c.expired};
    s.revision++;await persist();return render(s,locale);
   }
   if(s.mode!=='name_edit')return null;
   try{s.pendingName=normalizeSettingsName(text);}catch{return {text:c.invalid};}
   s.mode='name_confirm';s.revision++;await persist();return render(s,locale);
  });
 };
}
