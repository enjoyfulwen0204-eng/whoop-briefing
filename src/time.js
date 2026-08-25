/**
 * 時區工具。
 *
 * 規則：
 * - 「30 分鐘是否已過」直接比 UTC timestamp（絕不轉時區）。
 * - 「顯示日期」與「今天去重」才轉成 TIMEZONE（預設 Asia/Taipei）的 local date。
 * - Cron 是 UTC，程式判斷「今天」一律用 local date，不用 server 的 UTC 日期。
 */

const DTF_CACHE = new Map();

function dtf(tz) {
  let f = DTF_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    DTF_CACHE.set(tz, f);
  }
  return f;
}

function parts(date, tz) {
  const out = {};
  for (const p of dtf(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** 該時區在某個瞬間的 UTC offset（毫秒）。 */
function tzOffsetMs(date, tz) {
  const p = parts(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - date.getTime();
}

/** 該時區的 local date，格式 YYYY-MM-DD。 */
export function localDate(date, tz) {
  const p = parts(toDate(date), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 該時區的 local 小時（0-23）。 */
export function localHour(date, tz) {
  return parts(toDate(date), tz).hour;
}

/** 該時區的 "HH:MM"。 */
export function localTime(date, tz) {
  const p = parts(toDate(date), tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * 某個 local date 的當地午夜，對應到哪個 UTC 瞬間。
 * 迭代兩次以正確處理有日光節約的時區（Asia/Taipei 沒有，但別寫死）。
 */
export function localMidnightUtc(dateStr, tz) {
  const naive = Date.parse(`${dateStr}T00:00:00Z`);
  let ts = naive - tzOffsetMs(new Date(naive), tz);
  ts = naive - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** local date 字串 → 星期幾（1=週一 … 7=週日）。 */
export function localWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=週日
  return d === 0 ? 7 : d;
}

/** local date 字串 + n 天 → local date 字串。 */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 以 now 為基準，回傳「上一個完整週」與「再前一個完整週」的區間。
 * 一週定義：週一 00:00:00.000 ～ 週日 23:59:59.999（當地時間）。
 */
export function completedWeeks(now, tz) {
  const today = localDate(now, tz);
  const thisMonday = addDays(today, -(localWeekday(today) - 1)); // 本週一
  const lastMonday = addDays(thisMonday, -7);
  const prevMonday = addDays(thisMonday, -14);
  return {
    last: {
      key: lastMonday,
      startDate: lastMonday,
      endDate: addDays(lastMonday, 6),
      startUtc: localMidnightUtc(lastMonday, tz),
      endUtc: new Date(localMidnightUtc(thisMonday, tz).getTime() - 1),
    },
    prev: {
      key: prevMonday,
      startDate: prevMonday,
      endDate: addDays(prevMonday, 6),
      startUtc: localMidnightUtc(prevMonday, tz),
      endUtc: new Date(localMidnightUtc(lastMonday, tz).getTime() - 1),
    },
  };
}

/** 顯示用：YYYY-MM-DD → "8/21（四）" */
export function prettyDate(dateStr) {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}（${names[localWeekday(dateStr) - 1]}）`;
}

/** 兩個 local date 字串相差幾天（a - b，可為負）。 */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function minutesBetween(a, b) {
  return (toDate(a).getTime() - toDate(b).getTime()) / 60000;
}

export function toDate(v) {
  if (v instanceof Date) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`無法解析時間：${v}`);
  return d;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
