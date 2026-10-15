// Calendar dates arrive as "YYYY-MM-DD" with no time zone. They are parsed
// into UTC parts and read back with UTC getters, so "2026-10-20" is Oct 20
// for everyone, wherever their browser thinks it is. Never `new Date("YYYY-MM-DD")`
// followed by local getters: that shifts a day west of UTC.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DateParts {
  y: number;
  m: number; // 1-12
  d: number;
}

export function parts(iso: string): DateParts {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function utc(iso: string): Date {
  const { y, m, d } = parts(iso);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return fromUtc(utc(value)) === value;
}

/** Today on the viewer's own wall calendar. */
export function todayIso(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const date = utc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return utc(iso).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const day = weekday(iso);
  return day === 0 || day === 6;
}

/** "Tue, Oct 20" (with the year when it isn't this year). */
export function formatDay(iso: string, withYear = false): string {
  const { y, m, d } = parts(iso);
  const showYear = withYear || y !== parts(todayIso()).y;
  return `${WEEKDAYS[weekday(iso)]}, ${MONTHS[m - 1]} ${d}${showYear ? `, ${y}` : ""}`;
}

/** "Oct 20" */
export function formatShort(iso: string): string {
  const { m, d } = parts(iso);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Oct 20–24", "Oct 30 – Nov 3", "Dec 30, 2026 – Jan 2, 2027", or one day "Tue, Oct 20". */
export function formatRange(start: string, end: string): string {
  if (!end || start === end) return formatDay(start);
  const a = parts(start);
  const b = parts(end);
  const thisYear = parts(todayIso()).y;
  if (a.y !== b.y) {
    return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  }
  const year = a.y !== thisYear ? `, ${a.y}` : "";
  if (a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d}–${b.d}${year}`;
  return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}${year}`;
}

/** "October 2026" for "2026-10". */
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return fromUtc(date).slice(0, 7);
}

/** Every date in a "YYYY-MM" month. */
export function daysInMonth(month: string): string[] {
  const first = `${month}-01`;
  const out: string[] = [];
  for (let day = first; monthOf(day) === month; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The Monday on or before a date. */
export function startOfWeek(iso: string): string {
  const day = weekday(iso);
  return addDays(iso, day === 0 ? -6 : 1 - day);
}

export function overlapsRange(start: string, end: string, from: string, to: string): boolean {
  return start <= to && end >= from;
}

/** "1 day", "2.5 days", "Half a day". */
export function daysLabel(days: number): string {
  if (days === 0.5) return "Half a day";
  const n = formatNumber(days);
  return `${n} ${days === 1 ? "day" : "days"}`;
}

/** Up to one decimal, no trailing ".0"; a minus sign for negatives. */
export function formatNumber(value: number | null): string {
  if (value === null) return "–";
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return text.replace("-", "−");
}

/** A timestamp (ISO, UTC) on the viewer's clock: "Oct 12, 3:04 PM". */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A timestamp as a time when it's today ("12:40 PM"), else "Oct 12, 12:40 PM". */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : formatStamp(iso);
}

/** A timestamp as just its day: "Oct 12". */
export function formatStampDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function weekdayLetter(iso: string): string {
  return WEEKDAYS[weekday(iso)].slice(0, 2);
}
