const copy={
 'zh-TW':{notifications:'🔔 通知與晨間簡報',wake:'🌅 起床後',fixed:'🕘 固定時間',fallback:'🕙 備用時間',delay:'⏱ 起床後延遲',pause:'⏸ 暫停／恢復通知',owner:'👁 擁有者追蹤',empty:'尚未設定追蹤對象。只可選擇已加入服務的使用者。',choose:'選擇追蹤對象與通知類別；一般問答仍只能查自己。',time:'請輸入使用者當地時間 HH:mm，例如 10:00。',invalid:'請輸入有效時間 HH:mm。',daily:'📋 每日摘要',important:'🔔 重要提示',weekly:'🗓 每週摘要',on:'開啟',off:'關閉',paused:'已暫停',active:'正常通知'},
 en:{notifications:'🔔 Notifications & Morning Brief',wake:'🌅 After wake',fixed:'🕘 Fixed time',fallback:'🕙 Fallback time',delay:'⏱ Delay after wake',pause:'⏸ Pause / resume notifications',owner:'👁 Owner follows',empty:'No followed subjects configured. Only enrolled users can be selected.',choose:'Choose an enrolled subject and notification class. Ordinary Q&A remains self-only.',time:'Enter user-local time HH:mm, for example 10:00.',invalid:'Enter a valid HH:mm time.',daily:'📋 Daily summary',important:'🔔 Important alert',weekly:'🗓 Weekly summary',on:'On',off:'Off',paused:'Paused',active:'Notifications active'},
 vi:{notifications:'🔔 Thông báo & bản tin',wake:'🌅 Sau khi thức dậy',fixed:'🕘 Giờ cố định',fallback:'🕙 Giờ dự phòng',delay:'⏱ Độ trễ sau thức dậy',pause:'⏸ Tạm dừng / tiếp tục thông báo',owner:'👁 Chủ sở hữu theo dõi',empty:'Chưa cấu hình người được theo dõi. Chỉ chọn người đã tham gia dịch vụ.',choose:'Chọn người đã tham gia và loại thông báo. Hỏi đáp thông thường chỉ xem dữ liệu của bạn.',time:'Nhập giờ địa phương HH:mm, ví dụ 10:00.',invalid:'Vui lòng nhập giờ hợp lệ HH:mm.',daily:'📋 Tóm tắt hằng ngày',important:'🔔 Thông báo quan trọng',weekly:'🗓 Tóm tắt hằng tuần',on:'Bật',off:'Tắt',paused:'Đã tạm dừng',active:'Thông báo hoạt động'},
};
export const STAGE8_SETTINGS_MODES=['notifications','morning_time_edit','owner_list','owner_classes'];
export const STAGE8_SETTINGS_ACTIONS='notifications|wake|fixed|fallback|delay|pause|owner|subject\\d{1,3}|daily|important|weekly';
export function stage8SettingsMenu(s,locale,button){const c=copy[locale]??copy.en;return s.stage8?[[button(c.notifications,'notifications')],...(s.ownerAvailable?[[button(c.owner,'owner')]]:[])]:[];}
export function stage8SettingsRender(s,locale,button,nav){const c=copy[locale]??copy.en,p=s.morningPreferences;
 if(s.mode==='notifications')return {text:`${c.notifications}\n${p.notifications_paused?c.paused:c.active}\n${p.morning_brief_mode==='AFTER_WAKE'?c.wake:c.fixed} · ${p.morning_brief_mode==='AFTER_WAKE'?p.after_wake_delay_minutes+' min':p.morning_brief_local_time}\n${c.fallback}: ${p.fallback_local_time}`,rows:[[button(c.wake,'wake'),button(c.fixed,'fixed')],[button(c.delay,'delay'),button(c.fallback,'fallback')],[button(c.pause,'pause')],nav]};
 if(s.mode==='morning_time_edit')return {text:c.time,rows:[nav]};
 if(s.mode==='owner_list')return {text:s.ownerSubjects.length?c.choose:c.empty,rows:[...s.ownerSubjects.map((value,index)=>[button(`👤 ${value.label||index+1}`,`subject${index}`)]),nav]};
 if(s.mode==='owner_classes')return {text:c.choose,rows:[...['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY'].map((klass,i)=>[button(`${c[['daily','important','weekly'][i]]}: ${s.ownerSubscriptions[klass]?.enabled?c.on:c.off}`,['daily','important','weekly'][i])]),nav]};
 return null;
}
export async function stage8SettingsAction(s,action,stage8,input){
 if(!s.stage8||!stage8?.eligible(input.user.id))return false;
 const c=copy[input.locale]??copy.en;
 if(action==='notifications'&&s.mode==='menu'){s.morningPreferences=await stage8.preferences.read(input);s.mode='notifications';return true;}
 if(['wake','fixed','fallback','delay','pause'].includes(action)&&s.mode==='notifications'){
  if(action==='fixed'||action==='fallback'){s.timeTarget=action;s.mode='morning_time_edit';return true;}
  const p=s.morningPreferences,patch=action==='wake'?{morning_brief_mode:'AFTER_WAKE'}:action==='pause'?{notifications_paused:p.notifications_paused?0:1}:{after_wake_delay_minutes:({15:30,30:45,45:60,60:15})[p.after_wake_delay_minutes]??30};
  s.morningPreferences=await stage8.preferences.update(input,p.preference_version,patch);return true;
 }
 if(action==='owner'&&s.mode==='menu'&&s.ownerAvailable){s.ownerSubjects=await stage8.owner.enrolled(input);s.mode='owner_list';return true;}
 if(/^subject\d+$/.test(action??'')&&s.mode==='owner_list'){
  const subject=s.ownerSubjects[Number(action.slice(7))];if(!subject)return false;s.ownerSubjectId=subject.subjectId;
  s.ownerSubscriptions=await stage8.owner.read(input,subject.subjectId);s.mode='owner_classes';return true;
 }
 const classes={daily:'DAILY_SUMMARY',important:'IMPORTANT_ALERT',weekly:'WEEKLY_SUMMARY'};
 if(classes[action]&&s.mode==='owner_classes'){
  const klass=classes[action],previous=s.ownerSubscriptions[klass]??{revision:0,enabled:0};
  await stage8.owner.configure(input,{subjectId:s.ownerSubjectId,notificationClass:klass,enabled:!previous.enabled,expectedRevision:previous.revision,operationKey:`settings:${s.nonce}:${s.revision}`});
  s.ownerSubscriptions=await stage8.owner.read(input,s.ownerSubjectId);return true;
 }
 if(action===null&&s.mode==='morning_time_edit'){
  const time=String(input.text??'').trim();if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return {text:c.invalid};
  const patch=s.timeTarget==='fixed'?{morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:time}:{fallback_local_time:time};
  s.morningPreferences=await stage8.preferences.update(input,s.morningPreferences.preference_version,patch);s.mode='notifications';return true;
 }
 return false;
}
