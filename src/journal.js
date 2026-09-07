/**
 * 個人 journal：把「昨天喝了三杯酒」變成一筆結構化事件。
 *
 * ## 分工（不可違反）
 *
 *   LLM  →  只把自然語言變成 **candidate**（一包 JSON 提案）
 *   Node →  validate / normalize / 決定 health_date / 寫 DB
 *
 * LLM 永遠不直接寫 DB，也不決定 health_date（那是日期運算，不是語言理解）。
 *
 * ## health_date 怎麼決定
 *
 * 健康日的定義是「起床那天」。凌晨 2 點喝的酒，你還沒睡，所以那仍然屬於
 * **前一個**健康日。這裡用 DAY_BOUNDARY_HOUR（凌晨 4 點）當切點。
 *
 * ⚠️ 這是一個近似值。真正的健康日邊界由 sleep.end 決定，但 journal 事件
 * 常常在睡眠資料還沒同步回來之前就被記錄，所以不能等 WHOOP。
 * 之後若要精修，可以在 sleep 同步後重新對齊（目前刻意不做）。
 */

import { localDate, localHour, addDays } from './time.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

/** 凌晨幾點之前算前一天。 */
export const DAY_BOUNDARY_HOUR = 4;

/** 允許的 category（DB 不設 CHECK，改由這裡把關，方便日後擴充）。 */
export const CATEGORIES = [
  'alcohol', 'caffeine', 'late_meal', 'supplement', 'medication', 'sickness',
  'stress', 'travel', 'flight', 'location', 'late_sleep', 'exercise_note',
  'sauna', 'massage', 'food', 'custom',
];
const CATEGORY_SET = new Set(CATEGORIES);

/**
 * 使用者實際會打的字 → (category, subtype)。
 * 例如 `/log magnesium 300mg` 的 magnesium 不是 category，是 supplement 的 subtype。
 */
export const ALIASES = {
  // 酒
  alcohol: ['alcohol'], beer: ['alcohol', 'beer'], wine: ['alcohol', 'wine'],
  whisky: ['alcohol', 'whisky'], sake: ['alcohol', 'sake'], drink: ['alcohol'],
  酒: ['alcohol'], 啤酒: ['alcohol', 'beer'], 紅酒: ['alcohol', 'wine'],
  // 咖啡因
  caffeine: ['caffeine'], coffee: ['caffeine', 'coffee'], tea: ['caffeine', 'tea'],
  咖啡: ['caffeine', 'coffee'], 茶: ['caffeine', 'tea'],
  // 補充品
  supplement: ['supplement'], magnesium: ['supplement', 'magnesium'],
  creatine: ['supplement', 'creatine'], zinc: ['supplement', 'zinc'],
  vitamind: ['supplement', 'vitamin_d'], omega3: ['supplement', 'omega3'],
  melatonin: ['supplement', 'melatonin'], 鎂: ['supplement', 'magnesium'],
  // 藥
  medication: ['medication'], med: ['medication'], 藥: ['medication'],
  // 生病 / 壓力
  sick: ['sickness'], sickness: ['sickness'], ill: ['sickness'],
  生病: ['sickness'], 不舒服: ['sickness'], 感冒: ['sickness', 'cold'],
  stress: ['stress'], stressed: ['stress'], 壓力: ['stress'],
  // 旅行
  travel: ['travel'], flight: ['flight'], fly: ['flight'],
  旅行: ['travel'], 飛: ['flight'], 出差: ['travel'],
  location: ['location'],
  // 睡眠 / 飲食
  late_sleep: ['late_sleep'], latesleep: ['late_sleep'], 晚睡: ['late_sleep'],
  late_meal: ['late_meal'], latemeal: ['late_meal'], 宵夜: ['late_meal'],
  food: ['food'], meal: ['food'],
  // 恢復手段
  sauna: ['sauna'], 三溫暖: ['sauna'], massage: ['massage'], 按摩: ['massage'],
  // 運動備註
  exercise_note: ['exercise_note'], exercise: ['exercise_note'], 運動: ['exercise_note'],
  custom: ['custom'],
};

/** 事件時間 → 它屬於哪一個健康日。 */
export function healthDateFor(eventAt, timezone, { boundaryHour = DAY_BOUNDARY_HOUR } = {}) {
  const d = localDate(eventAt, timezone);
  return localHour(eventAt, timezone) < boundaryHour ? addDays(d, -1) : d;
}

/** 「昨天」「今天」之類的相對詞 → 天數位移。null = 沒有相對詞。 */
export function relativeDayOffset(text) {
  const t = String(text ?? '').toLowerCase();
  if (/(前天|day before yesterday)/.test(t)) return -2;
  if (/(昨晚|昨天|昨日|yesterday|last night)/.test(t)) return -1;
  if (/(今天|今日|today|tonight|剛剛|just now)/.test(t)) return 0;
  return null;
}

/** 從一段文字抓出「數量 + 單位」。抓不到回 {} 。 */
export function parseAmount(text) {
  const t = String(text ?? '');
  // 300mg / 3 drinks / 2杯 / 500 ml
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*([a-zA-Z一-龥]*)/);
  if (!m) return {};
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return {};
  const unit = (m[2] || '').trim();
  return { numericValue: value, unit: unit || null };
}

/** 中文數字 → 阿拉伯數字（只處理一到十，夠用就好）。 */
const CN_NUM = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function normalizeChineseNumbers(text) {
  return String(text ?? '').replace(/[一兩二三四五六七八九十]/g, (c) => String(CN_NUM[c] ?? c));
}

/**
 * 解析 `/log ...` 指令（**完全確定性，不碰 LLM**）。
 *
 * 支援：
 *   /log alcohol 3 drinks
 *   /log caffeine 2 coffee
 *   /log flight TPE SGN
 *   /log sick
 *   /log magnesium 300mg
 *   /log 昨天 alcohol 3
 */
export function parseLogCommand(text, { now = new Date(), timezone = 'Asia/Taipei' } = {}) {
  const raw = String(text ?? '').trim();
  const body = raw.replace(/^\/log(?:@\w+)?\s*/i, '').trim();
  if (!body) {
    return { ok: false, error: 'empty', hint: '用法例如：/log alcohol 3 drinks' };
  }

  const normalized = normalizeChineseNumbers(body);
  let tokens = normalized.split(/\s+/);

  // 相對日期可以放在最前面：/log 昨天 alcohol 3
  let offset = relativeDayOffset(tokens[0]);
  if (offset !== null) tokens = tokens.slice(1);
  else offset = 0;

  if (!tokens.length) return { ok: false, error: 'no_category' };

  const key = tokens[0].toLowerCase().replace(/[-_\s]/g, '');
  const alias = ALIASES[key] ?? ALIASES[tokens[0]] ?? null;
  let category = null;
  let subtype = null;
  if (alias) {
    [category, subtype = null] = alias;
  } else if (CATEGORY_SET.has(tokens[0].toLowerCase())) {
    category = tokens[0].toLowerCase();
  } else {
    return {
      ok: false,
      error: 'unknown_category',
      token: tokens[0],
      hint: `可用類別：${CATEGORIES.join(', ')}`,
    };
  }

  const rest = tokens.slice(1).join(' ').trim();
  const { numericValue = null, unit = null } = rest ? parseAmount(rest) : {};

  // 事件時間：有相對日期就用那天的中午（沒有更精確的資訊時最不會歸錯日）
  const eventAt = offset === 0
    ? new Date(now)
    : new Date(now.getTime() + offset * 86_400_000);

  return {
    ok: true,
    event: {
      eventAt: eventAt.toISOString(),
      healthDate: offset === 0
        ? healthDateFor(eventAt, timezone)
        : addDays(healthDateFor(now, timezone), offset),
      category,
      subtype,
      numericValue,
      unit,
      textValue: rest || null,
      severity: null,
      note: raw.slice(0, 500),
      source: 'command',
    },
  };
}

/**
 * 驗證並正規化一個 candidate（不管是 /log 解析出來的，還是 LLM 提案的）。
 * **所有寫入 DB 的路徑都必須先過這一關。**
 */
export function validateEvent(candidate, { now = new Date(), timezone = 'Asia/Taipei' } = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['not_an_object'] };
  }

  const category = String(candidate.category ?? '').toLowerCase();
  if (!CATEGORY_SET.has(category)) errors.push(`unknown_category:${category || '(empty)'}`);

  let eventAt = candidate.eventAt ? new Date(candidate.eventAt) : new Date(now);
  if (Number.isNaN(eventAt.getTime())) {
    errors.push('invalid_event_at');
    eventAt = new Date(now);
  }
  // 不接受未來太遠或太古老的事件（LLM 偶爾會把年份寫錯）
  const ahead = eventAt.getTime() - now.getTime();
  if (ahead > 26 * 3_600_000) errors.push('event_in_future');
  if (ahead < -365 * 86_400_000) errors.push('event_too_old');

  let numericValue = candidate.numericValue;
  if (numericValue !== null && numericValue !== undefined) {
    numericValue = Number(numericValue);
    if (!Number.isFinite(numericValue)) {
      errors.push('invalid_numeric_value');
      numericValue = null;
    } else if (numericValue < 0) {
      errors.push('negative_numeric_value');
      numericValue = null;
    }
  } else {
    numericValue = null;
  }

  let severity = candidate.severity;
  if (severity !== null && severity !== undefined) {
    severity = Number(severity);
    if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
      errors.push('invalid_severity');
      severity = null;
    }
  } else {
    severity = null;
  }

  if (errors.length) return { ok: false, errors };

  const healthDate = candidate.healthDate && /^\d{4}-\d{2}-\d{2}$/.test(candidate.healthDate)
    ? candidate.healthDate
    : healthDateFor(eventAt, timezone);

  return {
    ok: true,
    event: {
      eventAt: eventAt.toISOString(),
      healthDate,
      category,
      subtype: candidate.subtype ? String(candidate.subtype).slice(0, 60) : null,
      numericValue,
      unit: candidate.unit ? String(candidate.unit).slice(0, 20) : null,
      textValue: candidate.textValue ? String(candidate.textValue).slice(0, 500) : null,
      severity,
      note: candidate.note ? String(candidate.note).slice(0, 500) : null,
      source: candidate.source ?? 'manual',
    },
  };
}

/** 人看得懂的一行摘要（回訊息用）。 */
export function describeEvent(e) {
  const bits = [e.category];
  if (e.subtype) bits.push(e.subtype);
  if (e.numericValue !== null && e.numericValue !== undefined) {
    bits.push(`${e.numericValue}${e.unit ? ` ${e.unit}` : ''}`);
  }
  return `${bits.join(' · ')}（${e.healthDate}）`;
}

/** 驗證通過才寫 DB。回傳 { ok, id, event } 或 { ok:false, errors }。 */
/** @param {string} userId **必填**。journal 一律綁在內部使用者身上。 */
export async function saveEvent(db, userId, candidate, opts = {}) {
  const uid = requireUserId(userId, 'saveEvent');
  const v = validateEvent(candidate, opts);
  if (!v.ok) {
    log.warn('journal_validation_failed', { errors: v.errors, category: candidate?.category });
    return v;
  }
  const id = await db.addJournalEvent(uid, v.event, { now: opts.now ?? new Date() });
  return { ok: true, id, event: v.event };
}
