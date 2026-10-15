// The types of time away and how they are called, in one place: the Slack
// form and messages, emails, calendar titles and reports all read from
// here. The field itself is called "Type" wherever a person sees it.
//
//   pto          "SMTO"         draws on the time-off balance
//   sick         "Sick"         draws on the sick balance
//   unpaid       "Unpaid Time"  approval needed, no balance
//   loa          "LOA"          leave of absence: approval needed, no balance
//   unavailable  "Unavailable"  contractors only, no balance

import { formatDays } from "./dates.mjs";

export const KINDS = Object.freeze(["pto", "sick", "unpaid", "loa", "unavailable"]);
export const KIND_LABELS = Object.freeze({ pto: "SMTO", sick: "Sick", unpaid: "Unpaid Time", loa: "LOA", unavailable: "Unavailable" });

/**
 * The calendar title's type part. "type" shows the Type; "out" (the
 * default) keeps SMTO and Unavailable and shows every other type as "Out",
 * so the shared calendar does not say who is sick or on leave.
 */
export function calendarTitleWord(kind, mode = "out") {
  if (mode === "type") return KIND_LABELS[kind];
  return kind === "pto" || kind === "unavailable" ? KIND_LABELS[kind] : "Out";
}

/**
 * A person's class, from worker type and pay basis: "employee" (any pay
 * basis), "contractor_monthly", or "contractor_hourly". The class decides
 * the default policy (store.mjs) and the Types offered.
 */
export function classOf(person) {
  if (person?.worker_type !== "contractor") return "employee";
  return person.pay_basis === "hourly" ? "contractor_hourly" : "contractor_monthly";
}

/**
 * The Types offered to someone. Hourly contractors have no Sick time.
 * Unavailable is no longer offered to anyone (old requests still show it).
 */
export const kindsFor = (person) => (classOf(person) === "contractor_hourly" ? ["pto", "unpaid", "loa"] : ["pto", "sick", "unpaid", "loa"]);

/** "3 days", or "3 days (counted 4)" when the requester typed a number the calendar math disagrees with. */
export function daysText(request) {
  const days = Number(request.days);
  const computed = request.days_computed === null || request.days_computed === undefined ? days : Number(request.days_computed);
  const overridden = request.days_overridden === true || request.days_overridden === 1;
  return overridden && computed !== days ? `${formatDays(days)} (counted ${computed})` : formatDays(days);
}
