// Owner-selected safety backstop: every mention warns, including negation,
// resolved symptoms, quotations and educational questions. No diagnosis.
const EMERGENCY_KEYWORDS = Object.freeze([
  '胸痛', '胸口痛', '胸悶', '呼吸困難', '喘不過氣', '昏倒', '暈倒',
  '失去意識', '中風', '半邊麻', '說話不清楚',
  '胸闷', '呼吸困难', '喘不过气', '晕倒', '失去意识', '中风', '半边麻', '说话不清楚',
  'đau ngực', 'tức ngực', 'khó thở', 'ngất', 'bất tỉnh', 'đột quỵ',
  'dau nguc', 'tuc nguc', 'kho tho', 'ngat', 'bat tinh', 'dot quy',
  'chest pain', "can't breathe", 'can’t breathe', 'cant breathe', 'cannot breathe',
  'shortness of breath', 'fainted', 'passed out', 'stroke',
]);

export function emergencyKeywordHit(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.normalize('NFC').toLowerCase();
  return EMERGENCY_KEYWORDS.some(keyword => normalized.includes(keyword));
}
