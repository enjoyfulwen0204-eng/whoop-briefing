/** Public copy for private journal validation outcomes. */
export const VALIDATION_CATALOG = Object.freeze({
  'zh-TW': {
    'validation.negative': '⚠️ 數量不能是負數，這筆紀錄尚未儲存。',
    'validation.unit': '⚠️ 單位無法辨識或缺少單位，請檢查後再試。',
    'validation.required': '⚠️ 缺少必要的內容，請補上後再試。',
    'validation.unsupported': '⚠️ 這個值目前不支援，請換個說法再試。',
    'validation.generic': '⚠️ 這筆紀錄無法驗證，尚未儲存。請檢查後再試。',
  },
  en: {
    'validation.negative': '⚠️ The amount cannot be negative. This entry was not saved.',
    'validation.unit': '⚠️ The unit is missing or unclear. Check it and try again.',
    'validation.required': '⚠️ A required value is missing. Add it and try again.',
    'validation.unsupported': '⚠️ This value is not supported. Try describing it another way.',
    'validation.generic': '⚠️ This entry could not be validated and was not saved. Check it and try again.',
  },
  vi: {
    'validation.negative': '⚠️ Số lượng không thể là số âm. Mục ghi chép chưa được lưu.',
    'validation.unit': '⚠️ Thiếu đơn vị hoặc đơn vị chưa rõ. Hãy kiểm tra rồi thử lại.',
    'validation.required': '⚠️ Thiếu giá trị bắt buộc. Hãy bổ sung rồi thử lại.',
    'validation.unsupported': '⚠️ Giá trị này chưa được hỗ trợ. Hãy diễn đạt theo cách khác.',
    'validation.generic': '⚠️ Không thể xác thực mục ghi chép này nên chưa lưu. Hãy kiểm tra rồi thử lại.',
  },
});
