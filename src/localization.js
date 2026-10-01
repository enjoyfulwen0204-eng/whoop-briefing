/** Application-owned Telegram copy. Missing translations fail closed. */
import { BRIEFING_CATALOG } from './briefingCatalog.js';
import { OAUTH_CATALOG } from './oauthCatalog.js';
import { PROACTIVE_CATALOG } from './proactiveCatalog.js';
import { GUARDIAN_CATALOG } from './guardianCatalog.js';
import { ASSERTION_CATALOG } from './assertionCatalog.js';
import { COMMAND_CATALOG } from './bot/commandCatalog.js';
import { BRIEFING_STATUS_CATALOG } from './briefingStatusCatalog.js';
import { ANSWER_CATALOG } from './bot/answerCatalog.js';
import { ANSWER_EXTRA_CATALOG } from './bot/answerExtraCatalog.js';
import { TRIAGE_CATALOG } from './bot/triageCatalog.js';
import { EDUCATION_CATALOG } from './bot/educationCatalog.js';
import { ROUTER_CATALOG } from './bot/routerCatalog.js';
import { COMMAND_EXTRA_CATALOG } from './bot/commandExtraCatalog.js';
import { DATA_QUALITY_CATALOG } from './dataQualityCatalog.js';
import { AUXILIARY_CATALOG } from './auxiliaryCatalog.js';
import { EXPERIMENT_CATALOG } from './bot/experimentCatalog.js';
import { LINK_CATALOG } from './bot/linkCatalog.js';
export const LOCALES = Object.freeze(['zh-TW', 'en', 'vi']);

export function normalizeLocale(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return ({ 'zh-tw': 'zh-TW', 'zh_tw': 'zh-TW', '繁體中文': 'zh-TW',
    english: 'en', en: 'en', 'tiếng việt': 'vi', vietnamese: 'vi', vi: 'vi' })[raw] ?? null;
}

export const LANGUAGE_SELECTOR = '🌐 Choose language / 選擇語言 / Chọn ngôn ngữ\n\n繁體中文 · English · Tiếng Việt';

export const CATALOG = Object.freeze({
  'zh-TW': Object.freeze({
    ...BRIEFING_CATALOG['zh-TW'],
    ...OAUTH_CATALOG['zh-TW'],
    ...PROACTIVE_CATALOG['zh-TW'],
    ...GUARDIAN_CATALOG['zh-TW'],
    ...ASSERTION_CATALOG['zh-TW'],
    ...COMMAND_CATALOG['zh-TW'],
    ...BRIEFING_STATUS_CATALOG['zh-TW'],
    ...ANSWER_CATALOG['zh-TW'],
    ...ANSWER_EXTRA_CATALOG['zh-TW'],
    ...TRIAGE_CATALOG['zh-TW'],
    ...EDUCATION_CATALOG['zh-TW'],
    ...ROUTER_CATALOG['zh-TW'],
    ...COMMAND_EXTRA_CATALOG['zh-TW'],
    ...DATA_QUALITY_CATALOG['zh-TW'],
    ...AUXILIARY_CATALOG['zh-TW'],
    ...EXPERIMENT_CATALOG['zh-TW'],
    ...LINK_CATALOG['zh-TW'],
    'onboarding.welcome': '👋 歡迎使用 WHOOP 健康助理。\n\n這個助理會讀你自己的 WHOOP 資料，只在這個私訊裡回覆你。\n設定只有兩步：先告訴我你的時區，再授權 WHOOP。\n\n第 1 步：你的時區是？直接輸入標準 IANA 時區，例如 Asia/Taipei 或 Europe/Berlin。',
    'onboarding.timezoneInvalid': '這個時區我不認得。請輸入標準 IANA 時區名稱，例如 Asia/Taipei；不要輸入 +08:00 這種時差。',
    'onboarding.timezonePending': '設定還沒完成。第 1 步：請輸入你的 IANA 時區，例如 Asia/Taipei。',
    'onboarding.timezoneSet': '✅ 時區設定為 {timezone}。\n\n第 2 步：連接你的 WHOOP 帳號。請用你自己的帳號登入並授權：\n{url}\n\n連結 {minutes} 分鐘內有效；過期請輸入 /connect。',
    'onboarding.connectLink': '連接你的 WHOOP 帳號。請用你自己的帳號登入並授權：\n{url}\n\n連結 {minutes} 分鐘內有效。',
    'onboarding.connectCooldown': '剛剛才產生過授權連結，請先用那一條。稍後可輸入 /connect 取得新的。',
    'onboarding.connectTooMany': '授權連結產生太多次。請先完成其中一條，或稍後再試。',
    'onboarding.connectFailure': '目前無法產生授權連結，請稍後輸入 /connect 再試。',
    'onboarding.authorizedSyncing': '✅ WHOOP 已連接。正在同步你的資料；首次同步可能需要較長時間。完成後我會通知你。',
    'onboarding.ready': '🎉 你的 Health OS 準備好了。你可以直接提問，或使用 /status、/healthdata、/log、/help。每天起床後會收到當日簡報。',
    'onboarding.authPending': '設定還沒完成。時區：{timezone} ✅\n第 2 步：輸入 /connect 連接 WHOOP。',
    'onboarding.syncing': '⏳ WHOOP 已連接，資料仍在同步中。完成後我會通知你。',
    'onboarding.actionRequired': '⚠️ 設定尚未完成。{reason}\n輸入 /connect 取得新的授權連結。',
    'onboarding.reasonDefault': '授權沒有完成。',
    'onboarding.reasonOAuthDenied': '你取消了 WHOOP 授權。',
    'onboarding.reasonOAuthStateInvalid': '授權連結已過期或已使用。',
    'onboarding.reasonTokenExchangeFailed': 'WHOOP 授權交換未完成。',
    'onboarding.reasonIdentityUnverified': '無法確認 WHOOP 帳號身分，已停止連接以保護資料。',
    'onboarding.reasonAlreadyLinked': '此 WHOOP 帳號已經連到另一個使用者。',
    'onboarding.reasonMismatch': '此帳號先前連接了不同的 WHOOP 帳號，無法安全更換。',
    'onboarding.reasonBootstrapFailed': '首次同步多次失敗。',
    'onboarding.reasonReauthRequired': 'WHOOP 授權已失效，請重新連接。',
    'onboarding.reasonScopeIncomplete': 'WHOOP 權限不足。請重新連接並授予睡眠和恢復資料讀取權限。',
    'onboarding.reasonInactive': '帳號目前停用，請聯絡管理者。',
    'onboarding.unlinked': '你尚未連接帳號。輸入 /start 開始設定。',
    'onboarding.unavailable': '這個聊天室目前無法自動設定，請聯絡管理者。',
    'onboarding.languageSaved': '✅ 已選擇繁體中文。',
    'beta.title': '🧪 Phase 4 Beta 摘要{nameSuffix}',
    'beta.nameSuffix': '（{name}）',
    'beta.episodeHigher': '• {metric}高於個人基準，近期仍在觀察。',
    'beta.episodeLower': '• {metric}低於個人基準，近期仍在觀察。',
    'metric.recovery_score': '恢復分數', 'metric.hrv': 'HRV', 'metric.rhr': '靜息心率',
    'metric.sleep_performance': '睡眠表現', 'metric.sleep_duration_minutes': '睡眠時間',
    'metric.sleep_efficiency': '睡眠效率', 'metric.respiratory_rate': '呼吸率',
    'metric.cycle_strain': '活動負荷',
    'beta.associationSupported': '{factor}與{metric}{direction}在你的資料中多次呈現關聯。',
    'beta.associationEmerging': '{factor}可能與{metric}{direction}有關，仍在確認中。',
    'beta.directionHigher': '偏高', 'beta.directionLower': '偏低',
    'factor.alcohol':'飲酒','factor.caffeine':'咖啡因','factor.stress':'壓力',
    'factor.lateMeal':'晚餐較晚','factor.lateSleep':'晚睡','factor.sickness':'身體不適',
    'factor.travel':'旅行','factor.exercise':'運動','factor.sauna':'三溫暖',
    'factor.supplement':'補充品','factor.medication':'用藥紀錄','factor.flight':'飛行',
    'factor.location':'所在地變化','factor.massage':'按摩','factor.food':'飲食','factor.custom':'其他紀錄',
    'error.temporary': '目前暫時無法完成，請稍後再試。',
    'error.authorization': 'WHOOP 授權目前無法使用，請重新連接或稍後再試。',
    'error.daily': '今天的簡報暫時無法產生，請稍後再試。',
    'error.weekly': '本週回顧暫時無法產生，請稍後再試。',
    'error.dailyMissed': '{date} 的晨報已超過可補發時限，因此不再補發。後續簡報不受影響。',
    'error.dailyRecord': '今天的簡報已送出，但發送紀錄暫時無法儲存。簡報不會重複發送。',
    'error.weeklyRecord': '本週回顧已送出，但發送紀錄暫時無法儲存。回顧不會重複發送。',
    'unit.count':'次',
    'journal.eventDescription':'{details}（{date}）',
    'telegram.errorNotice':'🚨 WHOOP 簡報暫時有問題\n{message}\n\n（同類通知 {hours} 小時內最多一次）',
  }),
  en: Object.freeze({
    ...BRIEFING_CATALOG.en,
    ...OAUTH_CATALOG.en,
    ...PROACTIVE_CATALOG.en,
    ...GUARDIAN_CATALOG.en,
    ...ASSERTION_CATALOG.en,
    ...COMMAND_CATALOG.en,
    ...BRIEFING_STATUS_CATALOG.en,
    ...ANSWER_CATALOG.en,
    ...ANSWER_EXTRA_CATALOG.en,
    ...TRIAGE_CATALOG.en,
    ...EDUCATION_CATALOG.en,
    ...ROUTER_CATALOG.en,
    ...COMMAND_EXTRA_CATALOG.en,
    ...DATA_QUALITY_CATALOG.en,
    ...AUXILIARY_CATALOG.en,
    ...EXPERIMENT_CATALOG.en,
    ...LINK_CATALOG.en,
    'onboarding.welcome': '👋 Welcome to your WHOOP health assistant.\n\nIt reads only your WHOOP data and replies here in this private chat. Setup has two steps: confirm your timezone, then authorize WHOOP.\n\nStep 1: Enter your IANA timezone, such as America/New_York or Europe/Berlin.',
    'onboarding.timezoneInvalid': 'I could not recognize that timezone. Enter an IANA timezone such as America/New_York, rather than an offset like +08:00.',
    'onboarding.timezonePending': 'Setup is incomplete. Step 1: Enter your IANA timezone, such as America/New_York.',
    'onboarding.timezoneSet': '✅ Timezone set to {timezone}.\n\nStep 2: Connect your WHOOP account. Sign in with your own account and authorize access:\n{url}\n\nThis link expires in {minutes} minutes. Use /connect for a new one.',
    'onboarding.connectLink': 'Connect your WHOOP account. Sign in with your own account and authorize access:\n{url}\n\nThis link expires in {minutes} minutes.',
    'onboarding.connectCooldown': 'I just created an authorization link. Please use that one first, or try /connect again shortly.',
    'onboarding.connectTooMany': 'Too many authorization links have been created. Finish one of them or try again later.',
    'onboarding.connectFailure': 'I cannot create an authorization link right now. Please try /connect again later.',
    'onboarding.authorizedSyncing': '✅ WHOOP is connected. Your data is syncing; the first sync may take a while. I will let you know when it finishes.',
    'onboarding.ready': '🎉 Your Health OS is ready. You can ask a question or use /status, /healthdata, /log, or /help. Your daily briefing will arrive after you wake up.',
    'onboarding.authPending': 'Setup is incomplete. Timezone: {timezone} ✅\nStep 2: Use /connect to connect WHOOP.',
    'onboarding.syncing': '⏳ WHOOP is connected and your data is still syncing. I will let you know when it finishes.',
    'onboarding.actionRequired': '⚠️ Setup is incomplete. {reason}\nUse /connect for a new authorization link.',
    'onboarding.reasonDefault': 'Authorization was not completed.',
    'onboarding.reasonOAuthDenied': 'You canceled authorization on WHOOP.',
    'onboarding.reasonOAuthStateInvalid': 'The authorization link expired or was already used.',
    'onboarding.reasonTokenExchangeFailed': 'WHOOP did not complete the authorization exchange.',
    'onboarding.reasonIdentityUnverified': 'I could not verify the WHOOP account, so I stopped to protect your data.',
    'onboarding.reasonAlreadyLinked': 'This WHOOP account is already connected to another user.',
    'onboarding.reasonMismatch': 'This account was previously connected to a different WHOOP account and cannot be switched safely.',
    'onboarding.reasonBootstrapFailed': 'The initial data sync failed repeatedly.',
    'onboarding.reasonReauthRequired': 'Your WHOOP authorization expired. Please reconnect.',
    'onboarding.reasonScopeIncomplete': 'WHOOP permissions are incomplete. Reconnect and grant access to sleep and recovery data.',
    'onboarding.reasonInactive': 'This account is inactive. Please contact an administrator.',
    'onboarding.unlinked': 'Your account is not connected. Use /start to begin setup.',
    'onboarding.unavailable': 'This chat cannot be set up automatically right now. Please contact an administrator.',
    'onboarding.languageSaved': '✅ English selected.',
    'beta.title': '🧪 Phase 4 Beta Summary{nameSuffix}',
    'beta.nameSuffix': ' ({name})',
    'beta.episodeHigher': '• {metric} is above your personal baseline and remains under observation.',
    'beta.episodeLower': '• {metric} is below your personal baseline and remains under observation.',
    'metric.recovery_score': 'Recovery score', 'metric.hrv': 'HRV', 'metric.rhr': 'Resting heart rate',
    'metric.sleep_performance': 'Sleep performance', 'metric.sleep_duration_minutes': 'Sleep duration',
    'metric.sleep_efficiency': 'Sleep efficiency', 'metric.respiratory_rate': 'Respiratory rate',
    'metric.cycle_strain': 'Strain',
    'beta.associationSupported': '{factor} has repeatedly been associated with {direction} {metric} in your data.',
    'beta.associationEmerging': '{factor} may be associated with {direction} {metric}; the pattern is still being checked.',
    'beta.directionHigher': 'higher', 'beta.directionLower': 'lower',
    'factor.alcohol':'Alcohol','factor.caffeine':'Caffeine','factor.stress':'Stress',
    'factor.lateMeal':'Late meals','factor.lateSleep':'Late bedtime','factor.sickness':'Illness',
    'factor.travel':'Travel','factor.exercise':'Exercise','factor.sauna':'Sauna',
    'factor.supplement':'Supplements','factor.medication':'Medication records','factor.flight':'Flights',
    'factor.location':'Location changes','factor.massage':'Massage','factor.food':'Food','factor.custom':'Other journal events',
    'error.temporary': 'I cannot complete that right now. Please try again later.',
    'error.authorization': 'WHOOP authorization is unavailable. Please reconnect or try again later.',
    'error.daily': 'I cannot prepare today’s briefing right now. Please try again later.',
    'error.weekly': 'I cannot prepare this week’s review right now. Please try again later.',
    'error.dailyMissed': 'The morning briefing for {date} passed its delivery window, so it will not be sent late. Future briefings are unaffected.',
    'error.dailyRecord': 'Today’s briefing was sent, but its delivery record could not be saved. The briefing will not be sent again.',
    'error.weeklyRecord': 'This week’s review was sent, but its delivery record could not be saved. The review will not be sent again.',
    'unit.count':'times',
    'journal.eventDescription':'{details} ({date})',
    'telegram.errorNotice':'🚨 There is a temporary WHOOP briefing issue\n{message}\n\n(This type of notice is sent at most once every {hours} hours.)',
  }),
  vi: Object.freeze({
    ...BRIEFING_CATALOG.vi,
    ...OAUTH_CATALOG.vi,
    ...PROACTIVE_CATALOG.vi,
    ...GUARDIAN_CATALOG.vi,
    ...ASSERTION_CATALOG.vi,
    ...COMMAND_CATALOG.vi,
    ...BRIEFING_STATUS_CATALOG.vi,
    ...ANSWER_CATALOG.vi,
    ...ANSWER_EXTRA_CATALOG.vi,
    ...TRIAGE_CATALOG.vi,
    ...EDUCATION_CATALOG.vi,
    ...ROUTER_CATALOG.vi,
    ...COMMAND_EXTRA_CATALOG.vi,
    ...DATA_QUALITY_CATALOG.vi,
    ...AUXILIARY_CATALOG.vi,
    ...EXPERIMENT_CATALOG.vi,
    ...LINK_CATALOG.vi,
    'onboarding.welcome': '👋 Chào mừng bạn đến với trợ lý sức khỏe WHOOP.\n\nTrợ lý chỉ đọc dữ liệu WHOOP của bạn và trả lời trong cuộc trò chuyện riêng này. Việc thiết lập gồm hai bước: xác nhận múi giờ rồi cấp quyền WHOOP.\n\nBước 1: Nhập múi giờ IANA của bạn, ví dụ Asia/Ho_Chi_Minh hoặc Europe/Berlin.',
    'onboarding.timezoneInvalid': 'Tôi không nhận ra múi giờ đó. Hãy nhập múi giờ IANA như Asia/Ho_Chi_Minh, thay vì độ lệch như +07:00.',
    'onboarding.timezonePending': 'Bạn chưa thiết lập xong. Bước 1: Nhập múi giờ IANA của bạn, ví dụ Asia/Ho_Chi_Minh.',
    'onboarding.timezoneSet': '✅ Đã đặt múi giờ là {timezone}.\n\nBước 2: Kết nối tài khoản WHOOP. Đăng nhập bằng tài khoản của chính bạn và cấp quyền:\n{url}\n\nLiên kết có hiệu lực trong {minutes} phút. Dùng /connect để lấy liên kết mới.',
    'onboarding.connectLink': 'Kết nối tài khoản WHOOP của bạn. Đăng nhập bằng tài khoản của chính bạn và cấp quyền:\n{url}\n\nLiên kết có hiệu lực trong {minutes} phút.',
    'onboarding.connectCooldown': 'Tôi vừa tạo một liên kết cấp quyền. Hãy dùng liên kết đó trước hoặc thử lại /connect sau ít phút.',
    'onboarding.connectTooMany': 'Đã tạo quá nhiều liên kết cấp quyền. Hãy hoàn tất một liên kết hoặc thử lại sau.',
    'onboarding.connectFailure': 'Hiện tôi chưa thể tạo liên kết cấp quyền. Vui lòng thử lại /connect sau.',
    'onboarding.authorizedSyncing': '✅ WHOOP đã kết nối. Dữ liệu của bạn đang đồng bộ; lần đầu có thể mất thêm thời gian. Tôi sẽ báo khi hoàn tất.',
    'onboarding.ready': '🎉 Health OS của bạn đã sẵn sàng. Bạn có thể đặt câu hỏi hoặc dùng /status, /healthdata, /log hay /help. Bản tóm tắt hằng ngày sẽ đến sau khi bạn thức dậy.',
    'onboarding.authPending': 'Bạn chưa thiết lập xong. Múi giờ: {timezone} ✅\nBước 2: Dùng /connect để kết nối WHOOP.',
    'onboarding.syncing': '⏳ WHOOP đã kết nối và dữ liệu vẫn đang đồng bộ. Tôi sẽ báo khi hoàn tất.',
    'onboarding.actionRequired': '⚠️ Bạn chưa thiết lập xong. {reason}\nDùng /connect để lấy liên kết cấp quyền mới.',
    'onboarding.reasonDefault': 'Quá trình cấp quyền chưa hoàn tất.',
    'onboarding.reasonOAuthDenied': 'Bạn đã hủy cấp quyền trên WHOOP.',
    'onboarding.reasonOAuthStateInvalid': 'Liên kết cấp quyền đã hết hạn hoặc đã được sử dụng.',
    'onboarding.reasonTokenExchangeFailed': 'WHOOP chưa hoàn tất quá trình cấp quyền.',
    'onboarding.reasonIdentityUnverified': 'Tôi không thể xác minh tài khoản WHOOP nên đã dừng lại để bảo vệ dữ liệu của bạn.',
    'onboarding.reasonAlreadyLinked': 'Tài khoản WHOOP này đã kết nối với người dùng khác.',
    'onboarding.reasonMismatch': 'Tài khoản này từng kết nối với một tài khoản WHOOP khác và không thể đổi một cách an toàn.',
    'onboarding.reasonBootstrapFailed': 'Quá trình đồng bộ ban đầu đã thất bại nhiều lần.',
    'onboarding.reasonReauthRequired': 'Quyền truy cập WHOOP đã hết hiệu lực. Vui lòng kết nối lại.',
    'onboarding.reasonScopeIncomplete': 'Quyền WHOOP chưa đầy đủ. Hãy kết nối lại và cấp quyền đọc dữ liệu giấc ngủ và phục hồi.',
    'onboarding.reasonInactive': 'Tài khoản này đang ngừng hoạt động. Vui lòng liên hệ quản trị viên.',
    'onboarding.unlinked': 'Tài khoản của bạn chưa kết nối. Dùng /start để bắt đầu thiết lập.',
    'onboarding.unavailable': 'Hiện chưa thể tự thiết lập cuộc trò chuyện này. Vui lòng liên hệ quản trị viên.',
    'onboarding.languageSaved': '✅ Đã chọn Tiếng Việt.',
    'beta.title': '🧪 Tóm tắt Beta Giai đoạn 4{nameSuffix}',
    'beta.nameSuffix': ' ({name})',
    'beta.episodeHigher': '• {metric} cao hơn mức nền cá nhân và vẫn đang được theo dõi.',
    'beta.episodeLower': '• {metric} thấp hơn mức nền cá nhân và vẫn đang được theo dõi.',
    'metric.recovery_score': 'Điểm phục hồi', 'metric.hrv': 'HRV', 'metric.rhr': 'Nhịp tim nghỉ',
    'metric.sleep_performance': 'Hiệu quả giấc ngủ', 'metric.sleep_duration_minutes': 'Thời lượng ngủ',
    'metric.sleep_efficiency': 'Hiệu suất giấc ngủ', 'metric.respiratory_rate': 'Nhịp thở',
    'metric.cycle_strain': 'Mức gắng sức',
    'beta.associationSupported': 'Dữ liệu của bạn nhiều lần cho thấy {factor} có liên quan đến {metric} {direction}.',
    'beta.associationEmerging': '{factor} có thể liên quan đến {metric} {direction}; mối liên hệ này vẫn đang được kiểm tra.',
    'beta.directionHigher': 'cao hơn', 'beta.directionLower': 'thấp hơn',
    'factor.alcohol':'Việc uống rượu','factor.caffeine':'Caffeine','factor.stress':'Căng thẳng',
    'factor.lateMeal':'Ăn muộn','factor.lateSleep':'Đi ngủ muộn','factor.sickness':'Tình trạng ốm',
    'factor.travel':'Việc đi lại','factor.exercise':'Tập luyện','factor.sauna':'Xông hơi',
    'factor.supplement':'Thực phẩm bổ sung','factor.medication':'Việc dùng thuốc','factor.flight':'Chuyến bay',
    'factor.location':'Thay đổi địa điểm','factor.massage':'Mát-xa','factor.food':'Ăn uống','factor.custom':'Sự kiện khác trong nhật ký',
    'error.temporary': 'Hiện tôi chưa thể hoàn tất việc này. Vui lòng thử lại sau.',
    'error.authorization': 'Quyền truy cập WHOOP hiện không dùng được. Vui lòng kết nối lại hoặc thử sau.',
    'error.daily': 'Hiện tôi chưa thể chuẩn bị bản tóm tắt hôm nay. Vui lòng thử lại sau.',
    'error.weekly': 'Hiện tôi chưa thể chuẩn bị bản tổng kết tuần này. Vui lòng thử lại sau.',
    'error.dailyMissed': 'Bản tóm tắt buổi sáng ngày {date} đã quá thời hạn gửi bù nên sẽ không được gửi muộn. Các bản tiếp theo không bị ảnh hưởng.',
    'error.dailyRecord': 'Bản tóm tắt hôm nay đã được gửi, nhưng chưa thể lưu lịch sử gửi. Bản này sẽ không được gửi lại.',
    'error.weeklyRecord': 'Bản tổng kết tuần này đã được gửi, nhưng chưa thể lưu lịch sử gửi. Bản này sẽ không được gửi lại.',
    'unit.count':'lần',
    'journal.eventDescription':'{details} ({date})',
    'telegram.errorNotice':'🚨 Bản tin WHOOP đang gặp sự cố tạm thời\n{message}\n\n(Thông báo cùng loại được gửi tối đa một lần mỗi {hours} giờ.)',
  }),
});

export function validateCatalogs(catalog = CATALOG) {
  const expected = Object.keys(catalog['zh-TW']).sort();
  for (const locale of LOCALES) {
    if (JSON.stringify(Object.keys(catalog[locale] ?? {}).sort()) !== JSON.stringify(expected))
      throw new Error(`LOCALIZATION_CATALOG_INCOMPLETE:${locale}`);
    for (const key of expected) {
      const pattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
      const args = [...catalog[locale][key].matchAll(pattern)].map(m => m[1]).sort();
      const canonical = [...catalog['zh-TW'][key].matchAll(pattern)].map(m => m[1]).sort();
      if (JSON.stringify(args) !== JSON.stringify(canonical))
        throw new Error(`LOCALIZATION_PLACEHOLDER_MISMATCH:${locale}:${key}`);
    }
  }
  return true;
}
validateCatalogs();

export function t(locale, key, values = {}) {
  if (!LOCALES.includes(locale)) throw new Error('LOCALIZATION_LOCALE_UNSET');
  const template = CATALOG[locale][key];
  if (typeof template !== 'string') throw new Error(`LOCALIZATION_KEY_MISSING:${key}`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`LOCALIZATION_VALUE_MISSING:${key}:${name}`);
    return String(values[name]).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024);
  });
}

/** Format a canonical calendar date without interpreting it as a local instant. */
export function formatLocalDate(dateKey, locale) {
  if (!LOCALES.includes(locale)) throw new Error('LOCALIZATION_LOCALE_UNSET');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new Error('LOCALIZATION_DATE_INVALID');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== dateKey) throw new Error('LOCALIZATION_DATE_INVALID');
  if (locale === 'zh-TW') {
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return `${Number(match[2])}/${Number(match[3])}（${names[date.getUTCDay()]}）`;
  }
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function formatNumber(locale, number, maximumFractionDigits = 0) {
  if (!LOCALES.includes(locale)) throw new Error('LOCALIZATION_LOCALE_UNSET');
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(number);
}

/** Reformat approved metric display strings without changing their values. */
export function localizedDisplay(locale, display) {
  if (!LOCALES.includes(locale)) throw new Error('LOCALIZATION_LOCALE_UNSET');
  if (display === null || display === undefined) return display;
  if (locale === 'zh-TW') return String(display);
  return String(display).replace(/(\d+) 次/g, (_, count) => `${count} ${t(locale, 'unit.count')}`)
    .replace(/\d+\.\d+/g, raw => new Intl.NumberFormat(locale, {
      minimumFractionDigits: raw.split('.')[1].length,
      maximumFractionDigits: raw.split('.')[1].length,
    }).format(Number(raw)));
}
