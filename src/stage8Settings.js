const copy={
 'zh-TW':{notifications:'🔔 通知與晨間簡報',wake:'🌅 起床後',fixed:'🕘 固定時間',fallback:'🕙 備用時間',delay:'⏱ 起床後延遲',pause:'⏸ 暫停／恢復通知',owner:'👁 擁有者追蹤',empty:'尚無已授權分享的追蹤對象。',choose:'選擇對方已授權的分享類別；一般問答仍只能查自己。',time:'請輸入使用者當地時間 HH:mm，例如 10:00。',invalid:'請輸入有效時間 HH:mm。',daily:'📋 每日摘要',important:'🔔 重要提示',weekly:'🗓 每週摘要',on:'開啟',off:'關閉',paused:'已暫停',active:'正常通知',subject:'追蹤對象'},
 en:{notifications:'🔔 Notifications & Morning Brief',wake:'🌅 After wake',fixed:'🕘 Fixed time',fallback:'🕙 Fallback time',delay:'⏱ Delay after wake',pause:'⏸ Pause / resume notifications',owner:'👁 Owner follows',empty:'No subjects have currently consented to sharing.',choose:'Choose a class the subject has consented to share. Ordinary Q&A remains self-only.',time:'Enter user-local time HH:mm, for example 10:00.',invalid:'Enter a valid HH:mm time.',daily:'📋 Daily summary',important:'🔔 Important alert',weekly:'🗓 Weekly summary',on:'On',off:'Off',paused:'Paused',active:'Notifications active',subject:'Subject'},
 vi:{notifications:'🔔 Thông báo & bản tin',wake:'🌅 Sau khi thức dậy',fixed:'🕘 Giờ cố định',fallback:'🕙 Giờ dự phòng',delay:'⏱ Độ trễ sau thức dậy',pause:'⏸ Tạm dừng / tiếp tục thông báo',owner:'👁 Chủ sở hữu theo dõi',empty:'Chưa có người cho phép chia sẻ hiện tại.',choose:'Chọn loại mà người đó đã cho phép chia sẻ. Hỏi đáp thông thường chỉ xem dữ liệu của bạn.',time:'Nhập giờ địa phương HH:mm, ví dụ 10:00.',invalid:'Vui lòng nhập giờ hợp lệ HH:mm.',daily:'📋 Tóm tắt hằng ngày',important:'🔔 Thông báo quan trọng',weekly:'🗓 Tóm tắt hằng tuần',on:'Bật',off:'Tắt',paused:'Đã tạm dừng',active:'Thông báo hoạt động',subject:'Người được theo dõi'},
};
const sharingCopy={
 'zh-TW':{manage:'🔐 健康分享授權',serviceOwner:'服務擁有者',unavailable:'目前無法新增分享授權；仍可撤銷既有授權。',recipient:'分享接收者',explain:'預設不分享。請逐項允許或撤銷；只分享所選類別的當期摘要。接收者仍需另外啟用追蹤。撤銷會阻止後續存取與通知，無法收回已送達的 Telegram 訊息。',allow:'允許分享',revoke:'撤銷分享',on:'已授權',off:'未授權'},
 en:{manage:'🔐 Health sharing consent',serviceOwner:'Service owner',unavailable:'New sharing grants are currently unavailable. You can still revoke existing consent.',recipient:'Share with',explain:'Sharing is off by default. Allow or revoke each class; only current summaries in selected classes are shared. The recipient must separately follow you. Revoking blocks future access and notifications; it cannot recall Telegram messages already delivered.',allow:'Allow sharing',revoke:'Revoke sharing',on:'Allowed',off:'Not allowed'},
 vi:{manage:'🔐 Cho phép chia sẻ sức khỏe',serviceOwner:'Chủ dịch vụ',unavailable:'Hiện chưa thể cho phép chia sẻ mới. Bạn vẫn có thể thu hồi quyền đã cấp.',recipient:'Chia sẻ với',explain:'Mặc định không chia sẻ. Cho phép hoặc thu hồi từng loại; chỉ chia sẻ tóm tắt hiện tại của loại đã chọn. Người nhận vẫn phải bật theo dõi riêng. Thu hồi chặn truy cập và thông báo sau này, không thể thu hồi tin Telegram đã gửi.',allow:'Cho phép chia sẻ',revoke:'Thu hồi chia sẻ',on:'Đã cho phép',off:'Chưa cho phép'},
};
export const STAGE8_SETTINGS_MODES=['notifications','morning_time_edit','owner_list','owner_classes','source_sharing'];
export const STAGE8_SETTINGS_ACTIONS='notifications|wake|fixed|fallback|delay|pause|owner|subject\\d{1,3}|daily|important|weekly|sharing|share_(?:daily|important|weekly)_(?:on|off)';
export function stage8SettingsMenu(s,locale,button){const c=copy[locale]??copy.en,g=sharingCopy[locale]??sharingCopy.en;return s.stage8?[[button(c.notifications,'notifications')],...(s.sourceConsentAvailable?[[button(g.manage,'sharing')]]:[]),...(s.ownerAvailable?[[button(c.owner,'owner')]]:[])]:[];}
export function stage8SettingsRender(s,locale,button,nav){const c=copy[locale]??copy.en,p=s.morningPreferences;
 if(s.mode==='notifications')return {text:`${c.notifications}\n${p.notifications_paused?c.paused:c.active}\n${p.morning_brief_mode==='AFTER_WAKE'?c.wake:c.fixed} · ${p.morning_brief_mode==='AFTER_WAKE'?p.after_wake_delay_minutes+' min':p.morning_brief_local_time}\n${c.fallback}: ${p.fallback_local_time}`,rows:[[button(c.wake,'wake'),button(c.fixed,'fixed')],[button(c.delay,'delay'),button(c.fallback,'fallback')],[button(c.pause,'pause')],nav]};
 if(s.mode==='morning_time_edit')return {text:c.time,rows:[nav]};
 if(s.mode==='owner_list')return {text:s.ownerSubjects.length?c.choose:c.empty,rows:[...s.ownerSubjects.map((value,index)=>[button(`👤 ${c.subject}: ${value.label||value.alias}`,`subject${index}`)]),nav]};
 if(s.mode==='owner_classes')return {text:`${c.choose}\n👤 ${c.subject}: ${s.ownerSubjectLabel}`,rows:[...['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY'].flatMap((klass,i)=>s.ownerConsentClasses?.includes(klass)?[[button(`${c[['daily','important','weekly'][i]]}: ${s.ownerSubscriptions[klass]?.enabled?c.on:c.off}`,['daily','important','weekly'][i])]]:[]),nav]};
 if(s.mode==='source_sharing'){
  const g=sharingCopy[locale]??sharingCopy.en,classes=['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY'],names=['daily','important','weekly'];
  return {text:`${g.manage}\n👤 ${g.recipient}: ${s.sourceConsent.recipientLabel||g.serviceOwner+' · '+s.sourceConsent.recipientAlias}\n${g.explain}${s.sourceConsent.canGrant?'':'\n'+g.unavailable}\n${classes.map((klass,i)=>`${c[names[i]]}: ${s.sourceConsent.classes[klass].enabled?'✅ '+g.on:'🔒 '+g.off}`).join('\n')}`,
   rows:[...classes.map((klass,i)=>[...(s.sourceConsent.canGrant?[button(`✅ ${g.allow} · ${c[names[i]]}`,`share_${names[i]}_on`)]:[]),button(`🚫 ${g.revoke} · ${c[names[i]]}`,`share_${names[i]}_off`)]),nav]};
 }
 return null;
}
export async function stage8SettingsAction(s,action,stage8,input){
 if(!s.stage8||!stage8?.eligible(input.user.id))return false;
 const c=copy[input.locale]??copy.en;
 if(action==='sharing'&&s.mode==='menu'&&s.sourceConsentAvailable&&stage8.sourceConsent){s.sourceConsent=await stage8.sourceConsent.read(input);s.mode='source_sharing';return true;}
 const sharing=/^share_(daily|important|weekly)_(on|off)$/.exec(action??'');
 if(sharing&&s.mode==='source_sharing'&&s.sourceConsentAvailable&&stage8.sourceConsent){
  const klass={daily:'DAILY_SUMMARY',important:'IMPORTANT_ALERT',weekly:'WEEKLY_SUMMARY'}[sharing[1]],previous=s.sourceConsent.classes[klass];
  try{s.sourceConsent=await stage8.sourceConsent.update(input,{notificationClass:klass,enabled:sharing[2]==='on',expectedRevision:previous.revision,authority:previous.authority,operationKey:`settings:${s.nonce}:${s.revision}`});return true;}
  catch(error){if(/^SOURCE_CONSENT_/.test(error?.code??''))return false;throw error;}
 }
 if(action==='notifications'&&s.mode==='menu'){s.morningPreferences=await stage8.preferences.read(input);s.mode='notifications';return true;}
 if(['wake','fixed','fallback','delay','pause'].includes(action)&&s.mode==='notifications'){
  if(action==='fixed'||action==='fallback'){s.timeTarget=action;s.mode='morning_time_edit';return true;}
  const p=s.morningPreferences,patch=action==='wake'?{morning_brief_mode:'AFTER_WAKE'}:action==='pause'?{notifications_paused:p.notifications_paused?0:1}:{after_wake_delay_minutes:({15:30,30:45,45:60,60:15})[p.after_wake_delay_minutes]??30};
  s.morningPreferences=await stage8.preferences.update(input,p.preference_version,patch);return true;
 }
 if(action==='owner'&&s.mode==='menu'&&s.ownerAvailable){s.ownerSubjects=await stage8.owner.enrolled(input);s.mode='owner_list';return true;}
 if(/^subject\d+$/.test(action??'')&&s.mode==='owner_list'){
  const subject=s.ownerSubjects[Number(action.slice(7))];if(!subject)return false;s.ownerSubjectId=subject.subjectId;s.ownerSubjectLabel=subject.label||subject.alias;s.ownerConsentClasses=subject.allowedClasses??[];
  s.ownerSubscriptions=await stage8.owner.read(input,subject.subjectId);s.mode='owner_classes';return true;
 }
 const classes={daily:'DAILY_SUMMARY',important:'IMPORTANT_ALERT',weekly:'WEEKLY_SUMMARY'};
 if(classes[action]&&s.mode==='owner_classes'){
  const klass=classes[action],previous=s.ownerSubscriptions[klass]??{revision:0,enabled:0};
  try{await stage8.owner.configure(input,{subjectId:s.ownerSubjectId,notificationClass:klass,enabled:!previous.enabled,expectedRevision:previous.revision,operationKey:`settings:${s.nonce}:${s.revision}`});}catch(error){if(/OWNER_SOURCE_CONSENT_REQUIRED/.test(error?.message??''))return false;throw error;}
  s.ownerSubscriptions=await stage8.owner.read(input,s.ownerSubjectId);return true;
 }
 if(action===null&&s.mode==='morning_time_edit'){
  const time=String(input.text??'').trim();if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return {text:c.invalid};
  const patch=s.timeTarget==='fixed'?{morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:time}:{fallback_local_time:time};
  s.morningPreferences=await stage8.preferences.update(input,s.morningPreferences.preference_version,patch);s.mode='notifications';return true;
 }
 return false;
}
