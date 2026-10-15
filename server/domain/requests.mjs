// The rules for a time-off request: what a new one must satisfy, who may
// move it from one status to the next, which other time off it overlaps,
// and the plain sentences a preview shows. Pure; the server reads the rows
// and hands them in.
//
//   pending  --approve (the approver they chose, their manager, or an
//                       admin; never themselves)-----------------------> approved
//   pending  --deny    (the same people)--------------------------------> denied
//   pending  --cancel  (the requester, any time)------------------------> cancelled
//   approved --cancel  (the requester before the first day; their
//                       manager or an admin any time)-------------------> cancelled
// Denied and cancelled are final.

import { addDays, daysBetween, formatDays, isDate } from "./dates.mjs";
import { requestDayWeights } from "./balance.mjs";
import { KINDS, KIND_LABELS, kindsFor } from "./kinds.mjs";

export { KINDS };
export const STATUSES = Object.freeze(["pending", "approved", "denied", "cancelled"]);
export const LIVE_STATUSES = Object.freeze(["pending", "approved"]);
export const MAX_SPAN_DAYS = 366;
export const PAST_LIMIT_DAYS = 30;
// Two years ahead is as far as anyone plans time off; past that a typo
// (9999) would make every balance walk thousands of years.
export const FUTURE_LIMIT_DAYS = 730;
export const MAX_NOTE = 1000;

export const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

// Labels live in kinds.mjs (KIND_LABELS); kept here under the old name for older imports.
export const KIND_WORDS = KIND_LABELS;

/** Do two inclusive date ranges share a date? */
export const rangesOverlap = (a, b) => a.start_date <= b.end_date && b.start_date <= a.end_date;

/** The pending and approved requests among `requests` that share a date with `range`. */
export function findOverlaps(range, requests, { excludeId = null } = {}) {
  return (requests || []).filter((row) => row.id !== excludeId && LIVE_STATUSES.includes(row.status) && rangesOverlap(range, row));
}

/**
 * Check a new request (or a preview of one) and count its days. Throws
 * fail(...) with a sentence for the screen; returns the cleaned draft with
 * its days and the per-year split.
 *   person: { worker_type }, today: YYYY-MM-DD, holidays: Set,
 *   own: the person's existing requests (any status)
 */
export function checkDraft(body, { person, today, holidays = new Set(), own = [], preview = false }) {
  const start_date = String(body?.start_date ?? "");
  const end_date = String(body?.end_date ?? "");
  if (!isDate(start_date) || !isDate(end_date)) throw fail("Choose a start date and an end date.", "invalid_dates");
  if (end_date < start_date) throw fail("The end date is before the start date.", "end_before_start");
  if (daysBetween(start_date, end_date) >= MAX_SPAN_DAYS) throw fail("One request can cover at most a year. Split it into two.", "too_long");
  if (today && start_date > addDays(today, FUTURE_LIMIT_DAYS)) throw fail("Time off can be asked for up to two years ahead.", "too_far_ahead");
  const kind = body?.kind === undefined && preview ? "pto" : String(body?.kind ?? "");
  if (!KINDS.includes(kind)) throw fail("Choose a Type.", "invalid_kind");
  // Only the Types this person is offered (kindsFor); Unavailable is no
  // longer asked for by anyone, and hourly contractors have no Sick time.
  const offered = person ? kindsFor(person) : KINDS.filter((item) => item !== "unavailable");
  if (!offered.includes(kind)) throw fail(`That Type isn't offered to you. Choose ${offered.map((item) => KIND_LABELS[item]).join(", ")}.`, "kind_not_offered");
  const half_day_start = body?.half_day_start === true;
  const half_day_end = body?.half_day_end === true;
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (note.length > MAX_NOTE) throw fail(`Keep the note under ${MAX_NOTE} characters.`, "note_too_long");
  // A typed number of working days (half-day steps, at most the calendar
  // days in the span) replaces the count; the count is kept beside it.
  const typedRaw = body?.days_requested;
  const typed = typedRaw === undefined || typedRaw === null || typedRaw === "";
  const span = daysBetween(start_date, end_date) + 1;
  let days_requested = null;
  if (!typed) {
    days_requested = Number(typedRaw);
    if (!Number.isFinite(days_requested) || days_requested < 0.5 || days_requested > span || Math.round(days_requested * 2) !== days_requested * 2) {
      throw fail(`Type the working days in half-day steps, from 0.5 to ${span}.`, "invalid_days_requested");
    }
  }
  const counted = requestDayWeights({ start_date, end_date, half_day_start, half_day_end, days: days_requested, days_overridden: days_requested !== null }, holidays);
  if (!preview) {
    if (start_date < addDays(today, -PAST_LIMIT_DAYS)) throw fail(`Time off can be asked for up to ${PAST_LIMIT_DAYS} days back, not earlier.`, "too_far_back");
    if (counted.days <= 0) throw fail("Those dates are all weekends or holidays, so there is nothing to ask for. Type how many days you will work less, or pick other dates.", "no_working_days");
    if (findOverlaps({ start_date, end_date }, own).length) throw fail("You already have time off asked for or approved on some of these dates.", "overlaps_own");
  }
  return { start_date, end_date, kind, half_day_start, half_day_end, note, days: counted.days, days_computed: counted.computed, days_overridden: days_requested !== null, byYear: counted.byYear, dates: counted.dates };
}

/**
 * The status an action moves a request to, or a refusal.
 *   actor: { id, role }; context: { managerId (the requester's manager),
 *   approverId (the approver the requester chose, if any), today,
 *   soleAdmin (the actor is the only active admin) }
 * The only active admin may approve or deny their own request (nobody else
 * could); everyone else never decides their own.
 */
export function transition(request, action, actor, { managerId = null, approverId = request.approver_id ?? null, today, soleAdmin = false } = {}) {
  const isOwner = actor?.id === request.person_id;
  // The boss for a request is the approver the requester chose, or their
  // manager; either counts only while their role still says manager (an
  // admin always can). A manager demoted to employee stops deciding at once.
  const named = actor?.id && (actor.id === managerId || actor.id === approverId);
  const isBoss = !isOwner && (actor?.role === "admin" || (actor?.role === "manager" && Boolean(named)));
  if (action === "approve" || action === "deny") {
    if (isOwner && !(soleAdmin && actor?.role === "admin")) throw fail("You cannot approve or deny your own time off.", "own_request", 403);
    if (isOwner) {
      if (request.status !== "pending") throw fail(`This request is already ${request.status}.`, "not_pending", 409);
      return action === "approve" ? "approved" : "denied";
    }
    if (!isBoss) throw fail("Only their manager or an admin can decide this.", "not_your_report", 403);
    if (request.status !== "pending") throw fail(`This request is already ${request.status}.`, "not_pending", 409);
    return action === "approve" ? "approved" : "denied";
  }
  if (action === "cancel") {
    if (!isOwner && !isBoss) throw fail("Only the person who asked, their manager or an admin can cancel this.", "not_allowed", 403);
    if (request.status === "pending") {
      if (isOwner) return "cancelled";
      throw fail("This request is still waiting. Deny it instead of cancelling it.", "deny_instead", 409);
    }
    if (request.status === "approved") {
      if (isBoss) return "cancelled";
      if (today < request.start_date) return "cancelled";
      throw fail("This time off has already started. Ask your manager to cancel it.", "already_started", 409);
    }
    throw fail(`This request is already ${request.status}.`, "not_pending", 409);
  }
  throw fail("That is not something you can do to a request.", "invalid_action", 400);
}

/**
 * Plain sentences for a preview: below the balance, overlaps with the team
 * or with the person's own time off, holidays skipped, nothing to count.
 */
export function previewWarnings({ draft, balanceAfter = null, teamOverlaps = [], ownOverlaps = [], holidaysInRange = [], today }) {
  const warnings = [];
  if (draft.days <= 0) warnings.push("These dates are all weekends or holidays, so no days would be used.");
  if (balanceAfter !== null && balanceAfter < 0) warnings.push(`This takes you ${formatDays(-balanceAfter)} below your ${draft.kind === "sick" ? "sick days" : "balance"}.`);
  if (ownOverlaps.length) warnings.push("You already have time off asked for or approved on some of these dates.");
  const names = [...new Set(teamOverlaps.map((row) => row.name))];
  if (names.length === 1) warnings.push(`${names[0]} is also out during these dates.`);
  else if (names.length > 1) warnings.push(`${names.length} people on your team are also out during these dates.`);
  for (const holiday of holidaysInRange) warnings.push(`${holiday.name} is a company holiday, so it is not counted.`);
  if (today && draft.start_date < today) warnings.push("These dates are in the past.");
  if (today && draft.start_date < addDays(today, -PAST_LIMIT_DAYS)) warnings.push(`Time off can be asked for up to ${PAST_LIMIT_DAYS} days back, not earlier.`);
  return warnings;
}
