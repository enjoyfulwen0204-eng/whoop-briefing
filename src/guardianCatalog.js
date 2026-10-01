/** Guardian's per-user notification copy; global operational alerts stay internal. */
export const GUARDIAN_CATALOG = Object.freeze({
  'zh-TW': {
    'guardian.title':'🛡 系統健康檢查',
    'guardian.sync':'WHOOP 資料已經 {hours} 小時沒有成功同步',
    'guardian.stuck':'有 {count} 則主動訊息送出後長時間沒有收尾',
    'guardian.auth':'WHOOP 授權已經連續失敗 {count} 次，需要重新授權',
    'guardian.hintSync':'可能是 WHOOP 授權失效或連線問題。可以先用 /status 看看目前狀態。',
    'guardian.hintStuck':'主動訊息的收尾流程可能沒有執行。資料本身不受影響。',
    'guardian.hintAuth':'請使用 /connect 重新連接 WHOOP。',
    'guardian.cooldown':'（同一項目在冷卻時間內只會通知一次）',
  },
  en: {
    'guardian.title':'🛡 Service health check',
    'guardian.sync':'WHOOP data has not synced successfully for {hours} hours.',
    'guardian.stuck':'{count} proactive messages have remained unfinished for a long time.',
    'guardian.auth':'WHOOP authorization has failed {count} times in a row. Please reconnect.',
    'guardian.hintSync':'This may be an authorization or connection issue. Use /status to check the current state.',
    'guardian.hintStuck':'The follow-up process may not have completed. Your data is unaffected.',
    'guardian.hintAuth':'Use /connect to reconnect WHOOP.',
    'guardian.cooldown':'(You will be notified only once per issue during the cooldown period.)',
  },
  vi: {
    'guardian.title':'🛡 Kiểm tra trạng thái hệ thống',
    'guardian.sync':'Dữ liệu WHOOP chưa đồng bộ thành công trong {hours} giờ.',
    'guardian.stuck':'Có {count} tin nhắn chủ động chưa được hoàn tất trong thời gian dài.',
    'guardian.auth':'Quyền truy cập WHOOP đã lỗi {count} lần liên tiếp. Vui lòng kết nối lại.',
    'guardian.hintSync':'Có thể quyền truy cập hoặc kết nối WHOOP gặp vấn đề. Dùng /status để kiểm tra.',
    'guardian.hintStuck':'Quy trình theo dõi có thể chưa hoàn tất. Dữ liệu của bạn không bị ảnh hưởng.',
    'guardian.hintAuth':'Dùng /connect để kết nối lại WHOOP.',
    'guardian.cooldown':'(Mỗi vấn đề chỉ được báo một lần trong thời gian tạm ngừng thông báo.)',
  },
});
