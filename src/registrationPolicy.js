// Registration is closed unless the operator explicitly selects a supported mode.
export function registrationMode(environment=process.env){
 const mode=String(environment.REGISTRATION_MODE??'closed').trim().toLowerCase();
 return ['closed','invite','open'].includes(mode)?mode:'closed';
}
export function telegramRegistrationLocale(message){
 const code=String(message?.from?.language_code??'').toLowerCase();
 return code.startsWith('zh')?'zh-TW':code.startsWith('vi')?'vi':'en';
}
export function registrationClosedReply(message){
 return {text:{'zh-TW':'🔒 這是私人測試中的服務，目前不開放註冊。',vi:'🔒 Đây là dịch vụ thử nghiệm riêng tư, hiện chưa mở đăng ký.',en:'🔒 This is a private beta service. Registration is currently closed.'}[telegramRegistrationLocale(message)]};
}
