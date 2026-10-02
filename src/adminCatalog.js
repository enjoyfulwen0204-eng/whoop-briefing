/** Operational notifications go only to the configured system destination. */
export const ADMIN_CATALOG = Object.freeze({
  'zh-TW': {
    'admin.schedulerStale':'預期的 {provider} 排程最近沒有成功完成。',
    'admin.schedulerRecovered':'✅ 簡報排程已恢復正常，後續會照常檢查。',
    'admin.repoTitle':'🛠 WHOOP 簡報系統維護提醒',
    'admin.repoAge':'這個 repo 已經 {days} 天沒有新的 commit。',
    'admin.repoWarning':'GitHub 會在滿 {days} 天無活動時自動停用排程；屆時每日簡報可能停止，也不會產生排程錯誤通知。',
    'admin.repoRemaining':'還剩約 {days} 天。推任何一個 commit 就會重置計時。',
    'admin.repoExpired':'已經超過 {days} 天了，請去 GitHub 的 Actions 分頁確認排程是否還啟用中。',
    'admin.globalError':'🚨 WHOOP 簡報系統異常\n類型：{type}\n{message}\n\n（同類型錯誤 {hours} 小時內只通知一次）',
  },
  en: {
    'admin.schedulerStale':'The expected {provider} scheduler has no recent successful completion.',
    'admin.schedulerRecovered':'✅ The briefing scheduler has recovered and will keep checking.',
    'admin.repoTitle':'🛠 WHOOP briefing maintenance reminder',
    'admin.repoAge':'This repository has had no new commit for {days} days.',
    'admin.repoWarning':'GitHub may disable the scheduled workflow after {days} days without activity, which would stop daily briefings without a scheduler error notice.',
    'admin.repoRemaining':'About {days} days remain. Any new commit resets the timer.',
    'admin.repoExpired':'The {days}-day inactivity threshold has passed. Check GitHub Actions to confirm the schedule is enabled.',
    'admin.globalError':'🚨 WHOOP briefing system issue\nType: {type}\n{message}\n\n(This error type is reported at most once every {hours} hours.)',
  },
  vi: {
    'admin.schedulerStale':'Lịch {provider} dự kiến chưa hoàn tất thành công gần đây.',
    'admin.schedulerRecovered':'✅ Lịch gửi bản tin đã hoạt động trở lại và sẽ tiếp tục kiểm tra.',
    'admin.repoTitle':'🛠 Nhắc bảo trì hệ thống bản tin WHOOP',
    'admin.repoAge':'Kho lưu trữ này chưa có commit mới trong {days} ngày.',
    'admin.repoWarning':'GitHub có thể tắt lịch chạy sau {days} ngày không hoạt động, khiến bản tin hằng ngày dừng mà không có cảnh báo lỗi từ lịch.',
    'admin.repoRemaining':'Còn khoảng {days} ngày. Commit mới sẽ đặt lại bộ đếm.',
    'admin.repoExpired':'Đã vượt ngưỡng {days} ngày không hoạt động. Hãy kiểm tra GitHub Actions để xác nhận lịch chạy vẫn bật.',
    'admin.globalError':'🚨 Hệ thống bản tin WHOOP gặp sự cố\nLoại: {type}\n{message}\n\n(Loại lỗi này chỉ được báo tối đa một lần mỗi {hours} giờ.)',
  },
});
