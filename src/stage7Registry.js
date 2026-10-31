import {CATEGORIES} from './journal.js';
import {LOCALES} from './localization.js';
export const JOURNAL_REGISTRY_VERSION='journal-buttons-v1';
export const DAILY_POLICY_VERSION='smart-daily-v1';
export const DAILY_ANSWER_WINDOW_MS=48*60*60*1000;
export const TOPICS=Object.freeze(['caffeine','alcohol','late_meal','exercise_note','travel','stress','late_sleep']);
for(const c of TOPICS)if(!CATEGORIES.includes(c))throw Error('STAGE7_UNREGISTERED_CATEGORY');
export const ANSWER_STATES=Object.freeze(['YES','NO','NOT_SURE','SKIPPED','NO_RESPONSE','NOT_ASKED']);
export const registryQuestion=category=>{if(!TOPICS.includes(category))throw Error('STAGE7_UNREGISTERED_QUESTION');return `journal:${category}:presence:v1`;};
export const DETAILS=Object.freeze({caffeine:['morning','afternoon','evening']});
export const presentationLocale=locale=>LOCALES.includes(locale)?locale:'en';
const icons=['☕','🍷','🍽','🏃','✈️','🧠','😴'];
export const TOPIC_ICONS=Object.freeze(Object.fromEntries(TOPICS.map((c,i)=>[c,icons[i]])));
export const JOURNAL_COPY=Object.freeze({
 'zh-TW':{
  title:'KELVIN HEALTH OS\nPERSONAL HEALTH COMPANION · 個人健康夥伴',menu:'📔 生活日誌',topics:['咖啡因','酒精','晚餐／宵夜','運動感受','旅行','壓力','晚睡習慣'],
  questions:['這一天有攝取咖啡因嗎？','這一天有喝酒嗎？','這一天有吃較晚的餐點或宵夜嗎？','這一天有運動嗎？','這一天有旅行嗎？','這一天有感到壓力嗎？','這一天有比平常晚睡嗎？'],
  target:'記錄日期',yes:'有',no:'沒有',unsure:'不確定',skipToday:'略過今天這一題',skip:'略過',skipDetail:'略過細節',detail:'最後一次攝取咖啡因是在什麼時段？',details:['早上','下午','晚上'],
  back:'返回',cancel:'取消',confirm:'確認',edit:'編輯',undo:'撤回',note:'加上備註',enterNote:'請輸入備註（最多 500 字），或按返回。',invalidNote:'備註無效，請使用最多 500 字的純文字。',
  saved:'已記錄',removed:'已撤回記錄',cancelled:'已取消',expired:'這個按鈕已過期或記錄已更新。請使用 /journal。',
  pause:'暫停通知',ignore:'不再詢問',preferences:'追蹤偏好',daily:'每日一題',enabled:'已啟用',disabled:'已停用',enable:'啟用每日一題',disable:'停用每日一題',
  weekly:'每週回顧',weeklyEnable:'開啟每週回顧偏好',weeklyDisable:'關閉每週回顧偏好',recent:'最近記錄',empty:'目前沒有可顯示的日誌記錄。',
  weekTitle:'每週生活日誌回顧',recorded:'有記錄的天數',observed:'已記錄的習慣',coverage:'追蹤主題覆蓋',missing:'未記錄的日期仍屬未知。',insufficient:'資料不足，尚無可報告的關聯。',association:'可能的關聯（不代表因果）',next:'下週可以繼續觀察',unknown:'未回答',notAsked:'未詢問',
 },
 en:{
  title:'KELVIN HEALTH OS\nPERSONAL HEALTH COMPANION',menu:'📔 Lifestyle Journal',topics:['Caffeine','Alcohol','Late meals','Exercise experience','Travel','Stress','Late sleep'],
  questions:['Did you have caffeine on this day?','Did you drink alcohol on this day?','Did you have a late meal on this day?','Did you exercise on this day?','Did you travel on this day?','Did you feel stressed on this day?','Did you go to bed later than usual on this day?'],
  target:'Journal date',yes:'Yes',no:'No',unsure:'Not sure',skipToday:'Skip today’s question',skip:'Skip',skipDetail:'Skip detail',detail:'When was your last caffeine intake?',details:['Morning','Afternoon','Evening'],
  back:'Back',cancel:'Cancel',confirm:'Confirm',edit:'Edit',undo:'Retract',note:'Add note',enterNote:'Enter a note (up to 500 characters), or go back.',invalidNote:'Invalid note. Use plain text up to 500 characters.',
  saved:'Recorded',removed:'Entry retracted',cancelled:'Cancelled',expired:'This button expired or the entry changed. Use /journal.',
  pause:'Pause notifications',ignore:'Do not ask',preferences:'Tracking preferences',daily:'Daily question',enabled:'Enabled',disabled:'Disabled',enable:'Enable Daily Journal',disable:'Disable Daily Journal',
  weekly:'Weekly review',weeklyEnable:'Enable weekly review preference',weeklyDisable:'Disable weekly review preference',recent:'Recent entries',empty:'No Journal entries to show yet.',
  weekTitle:'Weekly lifestyle Journal review',recorded:'Days recorded',observed:'Recorded habits',coverage:'Tracked topic coverage',missing:'Unrecorded dates remain unknown.',insufficient:'Insufficient data for a reportable association.',association:'Possible association (not causation)',next:'Next week, consider observing',unknown:'No response',notAsked:'Not asked',
 },
 vi:{
  title:'KELVIN HEALTH OS\nPERSONAL HEALTH COMPANION · Bạn đồng hành sức khỏe',menu:'📔 Nhật ký lối sống',topics:['Caffeine','Rượu bia','Ăn muộn','Trải nghiệm tập luyện','Du lịch','Căng thẳng','Ngủ muộn'],
  questions:['Bạn có dùng caffeine trong ngày này không?','Bạn có uống rượu bia trong ngày này không?','Bạn có ăn muộn trong ngày này không?','Bạn có tập luyện trong ngày này không?','Bạn có đi du lịch trong ngày này không?','Bạn có cảm thấy căng thẳng trong ngày này không?','Bạn có ngủ muộn hơn thường lệ trong ngày này không?'],
  target:'Ngày ghi nhật ký',yes:'Có',no:'Không',unsure:'Không chắc',skipToday:'Bỏ qua câu hỏi hôm nay',skip:'Bỏ qua',skipDetail:'Bỏ qua chi tiết',detail:'Bạn dùng caffeine lần cuối vào lúc nào?',details:['Buổi sáng','Buổi chiều','Buổi tối'],
  back:'Quay lại',cancel:'Hủy',confirm:'Xác nhận',edit:'Sửa',undo:'Rút lại',note:'Thêm ghi chú',enterNote:'Nhập ghi chú (tối đa 500 ký tự), hoặc quay lại.',invalidNote:'Ghi chú không hợp lệ. Dùng văn bản tối đa 500 ký tự.',
  saved:'Đã ghi',removed:'Đã rút lại bản ghi',cancelled:'Đã hủy',expired:'Nút đã hết hạn hoặc bản ghi đã thay đổi. Hãy dùng /journal.',
  pause:'Tạm dừng thông báo',ignore:'Không hỏi nữa',preferences:'Tùy chọn theo dõi',daily:'Câu hỏi hằng ngày',enabled:'Đã bật',disabled:'Đã tắt',enable:'Bật nhật ký hằng ngày',disable:'Tắt nhật ký hằng ngày',
  weekly:'Tổng kết tuần',weeklyEnable:'Bật tùy chọn tổng kết tuần',weeklyDisable:'Tắt tùy chọn tổng kết tuần',recent:'Bản ghi gần đây',empty:'Chưa có bản ghi nhật ký để hiển thị.',
  weekTitle:'Tổng kết nhật ký lối sống hằng tuần',recorded:'Số ngày đã ghi',observed:'Thói quen đã ghi',coverage:'Mức bao phủ chủ đề theo dõi',missing:'Ngày chưa ghi vẫn chưa xác định.',insufficient:'Chưa đủ dữ liệu để báo cáo mối liên hệ.',association:'Mối liên hệ có thể có (không phải quan hệ nhân quả)',next:'Tuần tới, có thể tiếp tục quan sát',unknown:'Chưa trả lời',notAsked:'Chưa được hỏi',
 },
});
export function normalizeJournalNote(value){
 if(typeof value!=='string'||!value.isWellFormed()||/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value)||[...value].length>500||Buffer.byteLength(value)>2000)throw Error('STAGE7_NOTE_INVALID');
 return value.normalize('NFC').trim()||null;
}
