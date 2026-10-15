// A person's balance for one year, from their policy, their requests and
// the admin's adjustments. Pure: the caller hands in everything, including
// "today", so the same inputs always give the same answer.
//
// Rules (docs/API.md, Balance):
//   - tracked only when annual_days > 0; an untracked person has nothing
//     accrued and available 0 (used and pending are still reported).
//   - front_loaded: the whole year's days on Jan 1; in the start year,
//     annual_days x (months left counting the start month) / 12, to the
//     nearest half day, on the start date.
//   - monthly: annual_days / 12 on the 1st of each month, from the start
//     month (in the start year) or January, through today's month.
//   - carried over: the prior year's available on Dec 31, never below 0,
//     never above the cap; nothing before the start year.
//   - used / pending: approved / pending requests of the balance's kind,
//     split by the year of each counted date, so a request across New Year
//     is charged to both years. Unpaid, LOA and unavailable touch nothing.
//     A typed number of days (days_overridden) replaces the count.
//
// Two balances per person (computeBalances): time off ("pto", the policy's
// annual_days, accrual and carryover cap) and sick time ("sick", the
// policy's sick_days: front-loaded on Jan 1, prorated in the start year
// like time off, never carried over). Each is the same Balance shape.

import { addDays, daysBetween, parseDate, workingDays, monthsElapsed } from "./dates.mjs";

const round2 = (n) => {
  const value = Math.round(Number(n) * 100) / 100;
  return Object.is(value, -0) ? 0 : value;
};
const roundHalf = (n) => Math.round(Number(n) * 2) / 2;

/**
 * The dates a request charges and how much each: the working days
 * (weekends and holidays out, half days as 0.5), or, when the requester
 * typed their own number of days (days_overridden), those days spread over
 * the same working days in proportion (or evenly over every date in the
 * span when the calendar counts none). Returns { days, computed, dates,
 * weights, byYear }. Balances and reports both read days through here.
 */
export function requestDayWeights(request, holidays = new Set()) {
  const counted = workingDays({
    start_date: request.start_date,
    end_date: request.end_date,
    half_day_start: Boolean(request.half_day_start),
    half_day_end: Boolean(request.half_day_end),
    holidays,
  });
  const overridden = request.days_overridden === true || request.days_overridden === 1;
  let { dates, weights } = counted;
  const days = overridden ? Number(request.days) : counted.days;
  if (overridden) {
    if (counted.days > 0) weights = weights.map((weight) => (weight * days) / counted.days);
    else {
      const span = daysBetween(request.start_date, request.end_date) + 1;
      dates = Array.from({ length: span }, (_, index) => addDays(request.start_date, index));
      weights = dates.map(() => days / span);
    }
  }
  const byYear = {};
  dates.forEach((date, index) => {
    const year = Number(date.slice(0, 4));
    byYear[year] = (byYear[year] || 0) + weights[index];
  });
  return { days, computed: counted.days, dates, weights, byYear };
}

// Approved and pending days of one kind by year, counting each request
// once: a request across New Year adds to both years.
function chargedByYear(requests, holidays, kind) {
  const byYear = {};
  for (const request of requests || []) {
    if (request.kind !== kind || (request.status !== "approved" && request.status !== "pending")) continue;
    const counted = requestDayWeights(request, holidays);
    for (const [year, days] of Object.entries(counted.byYear)) {
      byYear[year] ??= { approved: 0, pending: 0 };
      byYear[year][request.status] += days;
    }
  }
  return byYear;
}

function accrual(policy, year, asOf) {
  const annual = Number(policy.annual_days);
  const start = parseDate(policy.start_date);
  const yearStart = `${year}-01-01`;
  if (year < start.y) return { allowance: 0, accrued: 0 };
  const isStartYear = year === start.y;
  const monthsLeft = isStartYear ? 12 - start.m + 1 : 12;
  const accrualStart = isStartYear ? policy.start_date : yearStart;
  if (policy.accrual === "monthly") {
    const perMonth = annual / 12;
    const allowance = perMonth * monthsLeft;
    if (asOf < accrualStart) return { allowance, accrued: 0 };
    return { allowance, accrued: perMonth * monthsElapsed(accrualStart, asOf) };
  }
  const allowance = isStartYear ? roundHalf((annual * monthsLeft) / 12) : annual;
  return { allowance, accrued: asOf >= accrualStart ? allowance : 0 };
}

/**
 * The Balance shape in docs/API.md for `year`, as of `today` (YYYY-MM-DD).
 * `holidays` (a Set of dates) decides which dates of a request count.
 */
export function computeBalance({ policy, year, today, requests = [], adjustments = [], holidays = new Set(), kind = "pto" }) {
  const charged = chargedByYear(requests, holidays, kind);
  const usedIn = (y) => charged[y]?.approved || 0;
  const pendingIn = (y) => charged[y]?.pending || 0;
  const adjustedIn = (y) => (adjustments || []).filter((row) => Number(row.year) === y && (row.kind ?? "pto") === kind).reduce((sum, row) => sum + Number(row.days || 0), 0);
  // Unlimited: nothing to run out of, so no allowance, accrual or available;
  // the days used and waiting are still counted.
  if (policy?.unlimited) {
    return { unit: "days", year, allowance: null, accrued: null, carried_over: 0, adjustments: round2(adjustedIn(year)), used: round2(usedIn(year)), pending: round2(pendingIn(year)), available: null, tracked: true, unlimited: true };
  }
  const tracked = Boolean(policy) && Number(policy.annual_days) > 0 && parseDate(policy.start_date) !== null;
  if (!tracked) {
    return { unit: "days", year, allowance: 0, accrued: 0, carried_over: 0, adjustments: 0, used: round2(usedIn(year)), pending: round2(pendingIn(year)), available: 0, tracked: false, unlimited: false };
  }
  // Carryover walks forward from the start year, one year at a time, each
  // year's Dec 31 available feeding the next. A loop, not recursion: a
  // start date decades back must not run out of stack.
  const cap = Math.max(0, Number(policy.carryover_cap) || 0);
  let carried = 0;
  for (let y = parseDate(policy.start_date).y; y < year; y += 1) {
    const { accrued } = accrual(policy, y, `${y}-12-31`);
    const available = round2(accrued + carried + adjustedIn(y) - usedIn(y) - pendingIn(y));
    carried = Math.min(cap, Math.max(0, available));
  }
  const yearEnd = `${year}-12-31`;
  const asOf = today < yearEnd ? today : yearEnd;
  const { allowance, accrued } = accrual(policy, year, asOf);
  const adjusted = adjustedIn(year);
  const used = usedIn(year);
  const pending = pendingIn(year);
  return {
    unit: "days",
    year,
    allowance: round2(allowance),
    accrued: round2(accrued),
    carried_over: round2(carried),
    adjustments: round2(adjusted),
    used: round2(used),
    pending: round2(pending),
    available: round2(accrued + carried + adjusted - used - pending),
    tracked: true,
    unlimited: false,
  };
}

/** The sick allowance as a policy of its own: front-loaded, nothing carried. */
export function sickPolicy(policy) {
  if (!policy) return null;
  return { annual_days: Number(policy.sick_days) || 0, accrual: "front_loaded", carryover_cap: 0, start_date: policy.start_date, unlimited: policy.sick_unlimited === true };
}

/** { pto, sick }: both Balance shapes for one person and year. */
export function computeBalances(input) {
  const pto = input.policy ? { ...input.policy, unlimited: input.policy.pto_unlimited === true } : null;
  return {
    pto: computeBalance({ ...input, policy: pto, kind: "pto" }),
    sick: computeBalance({ ...input, policy: sickPolicy(input.policy), kind: "sick" }),
  };
}
