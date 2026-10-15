// Calendar dates as plain `YYYY-MM-DD` strings. A day off is a date on the
// company's calendar, not an instant, so nothing here goes through a Date
// in a time zone: dates become whole day numbers (days since 1970-01-01,
// Howard Hinnant's civil-day algorithm) and back, which cannot drift across
// a daylight-saving change or a server in another zone.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: era * 400 + yoe + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n, width = 2) => String(n).padStart(width, "0");

/** { y, m, d } for a real calendar date, else null (2026-02-30 is null). */
export function parseDate(value) {
  const match = DATE_PATTERN.exec(String(value ?? ""));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1) return null;
  const back = civilFromDays(daysFromCivil(y, m, d));
  return back.y === y && back.m === m && back.d === d ? { y, m, d } : null;
}

export const isDate = (value) => parseDate(value) !== null;

export function dayNumber(value) {
  const parsed = parseDate(value);
  if (!parsed) throw new RangeError(`not a date: ${String(value).slice(0, 20)}`);
  return daysFromCivil(parsed.y, parsed.m, parsed.d);
}

export function fromDayNumber(n) {
  const { y, m, d } = civilFromDays(n);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export const addDays = (value, n) => fromDayNumber(dayNumber(value) + n);

/** 0 = Sunday .. 6 = Saturday. Day 0 (1970-01-01) was a Thursday. */
export const weekday = (value) => (((dayNumber(value) + 4) % 7) + 7) % 7;

export const isWeekend = (value) => {
  const day = weekday(value);
  return day === 0 || day === 6;
};

export const yearOf = (value) => Number(String(value).slice(0, 4));
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/**
 * Working days in an inclusive range: weekends and holidays are skipped,
 * and a half-day flag makes the first (or last) counted date half a day.
 * One counted date with either or both flags is half a day.
 * Returns { days, byYear: { [year]: days }, dates: [counted dates],
 * weights: [1 or 0.5 for each of dates] }.
 */
export function workingDays({ start_date, end_date, half_day_start = false, half_day_end = false, holidays = new Set() }) {
  const first = dayNumber(start_date);
  const last = dayNumber(end_date);
  const dates = [];
  for (let n = first; n <= last; n += 1) {
    const date = fromDayNumber(n);
    if (isWeekend(date) || holidays.has(date)) continue;
    dates.push(date);
  }
  const weights = dates.map(() => 1);
  if (dates.length === 1 && (half_day_start || half_day_end)) weights[0] = 0.5;
  else if (dates.length > 1) {
    if (half_day_start) weights[0] = 0.5;
    if (half_day_end) weights[weights.length - 1] = 0.5;
  }
  const byYear = {};
  let days = 0;
  dates.forEach((date, index) => {
    const year = yearOf(date);
    byYear[year] = (byYear[year] || 0) + weights[index];
    days += weights[index];
  });
  return { days, byYear, dates, weights };
}

const monthIndex = (value) => {
  const { y, m } = parseDate(value);
  return y * 12 + (m - 1);
};

/**
 * Calendar months from `from`'s month through `to`'s month, both counted:
 * Jan 20 to Mar 2 is 3. Zero when `to` is in an earlier month.
 */
export function monthsElapsed(from, to) {
  return Math.max(0, monthIndex(to) - monthIndex(from) + 1);
}

/** Today's date where the person is (an IANA zone), as YYYY-MM-DD. */
export function isoToday(now = new Date(), timeZone = "UTC") {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  }
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function validTimeZone(value) {
  const zone = String(value ?? "").trim();
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon, Oct 19, 2026" for an email or a sentence. */
export function formatDate(value, { withYear = true } = {}) {
  const { y, m, d } = parseDate(value);
  return `${WEEKDAYS[weekday(value)]}, ${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}

/** "Mon, Oct 19 to Wed, Oct 21, 2026", or one date when they are the same. */
export function formatRange(start, end) {
  if (start === end) return formatDate(start);
  const sameYear = yearOf(start) === yearOf(end);
  return `${formatDate(start, { withYear: !sameYear })} to ${formatDate(end)}`;
}

/** "1 day", "1.5 days", "0.5 days". */
export function formatDays(days) {
  const n = Math.round(Number(days) * 100) / 100;
  return `${n} ${n === 1 ? "day" : "days"}`;
}
