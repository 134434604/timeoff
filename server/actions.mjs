// The four things anyone does to a request (ask, approve, deny, cancel),
// one function each, shared by the site and Slack so both follow one path:
// validation and the state machine (domain/requests.mjs), one transaction
// with its audit row, then the follow-up: the shared calendar, email, and
// Slack messages.
//
// Each function takes { db, env, dataDir, fetchImpl, outboxDir, origin,
// actor, ... } (the server's context spread in, plus the arguments). The
// database part runs at once and throws a plain-sentence refusal when the
// rules say no. The outside work comes back as `followUp()`, a promise that
// never rejects: the site awaits it before answering; Slack answers first
// (it allows three seconds) and runs it after. A calendar, mail or Slack
// failure is written to the audit table and never undoes the decision.

import { nowIso, parseJson, transaction } from "./db.mjs";
import { newId } from "./auth/sessions.mjs";
import { yearOf } from "./domain/dates.mjs";
import { requestDayWeights } from "./domain/balance.mjs";
import { MAX_NOTE, checkDraft, fail, transition } from "./domain/requests.mjs";
import { calendarStatus } from "./google/calendar-grant.mjs";
import { calendarErrorWords, deleteEvent, eventIdFor, insertAllDayEvent } from "./google/calendar.mjs";
import { notify } from "./mail.mjs";
import { announceRequest, askAdminsAboutManager, decisionLine, dm, esc, repostApproval, requestLine, settleMessages } from "./slack/messages.mjs";
import { enrollManager } from "./slack/identity.mjs";
import * as store from "./store.mjs";
import { makeDecidePair } from "./decide.mjs";

import { KIND_LABELS, calendarTitleWord } from "./domain/kinds.mjs";
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const log = (ctx, action, subject, detail, actorId = null) => store.audit(ctx.db, { actorId, action, subject, detail });

/**
 * Text a person typed: control characters out (newlines kept only where
 * `lines` says so), trimmed, capped.
 */
export function cleanText(value, max, { lines = false } = {}) {
  if (typeof value !== "string") return "";
  const stripped = lines ? value.replace(/[^\P{Cc}\n]/gu, "") : value.replace(/\p{Cc}+/gu, " ");
  return stripped.trim().slice(0, max);
}

// ---------------------------------------------------------------- people --

const canDecide = (row) => Boolean(row) && row.active === 1 && row.sample !== 1 && (row.role === "manager" || row.role === "admin");

/** Everyone a person may send a request to: active managers and admins, not themselves. */
export function eligibleApprovers(db, person) {
  return db.prepare("SELECT * FROM people WHERE active = 1 AND sample = 0 AND role IN ('manager', 'admin') AND id != ? ORDER BY name COLLATE NOCASE").all(person.id);
}

/** The approver picked when the requester picks none: their manager, while active and a manager. */
export function defaultApprover(db, person) {
  const manager = person.manager_id ? store.personRow(db, person.manager_id) : null;
  return canDecide(manager) && manager.id !== person.id ? manager : null;
}

/** The approver id to store: the one chosen (checked), else the default; null leaves it to the admins. */
export function chooseApprover(db, person, approverId) {
  const chosen = String(approverId ?? "").trim();
  if (!chosen) return defaultApprover(db, person)?.id ?? null;
  const row = store.personRow(db, chosen);
  if (!canDecide(row) || row.id === person.id) throw fail("Choose who should approve this from the list.", "invalid_approver");
  return row.id;
}

/**
 * Who decides a request: the approver it names, while they can still
 * decide; else the requester's manager under the same rule; else every
 * active admin (admins see all pending).
 */
export function approversOf(ctx, person, request = null) {
  // A Manager pick waiting for confirmation (or turned down): the admins decide.
  if (request?.pending_manager) return adminsFor(ctx, person);
  const named = request?.approver_id ? store.personRow(ctx.db, request.approver_id) : null;
  if (canDecide(named) && named.id !== person.id) return [named];
  const manager = defaultApprover(ctx.db, person);
  if (manager) return [manager];
  return adminsFor(ctx, person);
}

/** Every active admin but the requester (the only admin, when that is the requester). */
function adminsFor(ctx, person) {
  const admins = ctx.db.prepare("SELECT * FROM people WHERE role = 'admin' AND active = 1 AND sample = 0 AND id != ?").all(person.id);
  // The only admin asking: nobody else can decide, so it comes to them.
  if (!admins.length && store.soleAdmin(ctx.db, person) && store.reachable(person)) return [person];
  return admins;
}

/**
 * The balances the requester would have in the request's first year, on its
 * first day: monthly accrual counts up to then, and a request for next year
 * is measured against next year's days. `extra` is what this request would
 * add (a preview); a submitted request is already held. Returns
 * { pto, sick }: the one this kind draws on is a number (null when that
 * balance is not tracked or unlimited), the other null; unpaid, LOA and
 * unavailable draw on neither.
 */
export function balanceAfter(ctx, person, { kind, start_date, extra = 0 }, holidays = store.holidaysFor(ctx.db, person)) {
  const after = { pto: null, sick: null };
  if (kind !== "pto" && kind !== "sick") return after;
  const today = store.todayFor(person);
  const balance = store.balanceFor(ctx.db, person, { today: start_date > today ? start_date : today, year: yearOf(start_date), holidays })[kind];
  after[kind] = balance.tracked && !balance.unlimited ? round2(balance.available - extra) : null;
  return after;
}

/**
 * What the approval message shows besides the request: the balance after
 * (as it stood with this request held, also once it is denied or cancelled)
 * and who else on the team is out then.
 */
function messageFacts(ctx, request, person) {
  const holidays = store.holidaysFor(ctx.db, person);
  const held = request.status === "pending" || request.status === "approved";
  const share = held ? 0 : requestDayWeights(request, holidays).byYear[yearOf(request.start_date)] || 0;
  return {
    balanceAfter: balanceAfter(ctx, person, { kind: request.kind, start_date: request.start_date, extra: share }, holidays),
    overlaps: store.overlapsFor(ctx.db, store.teamIds(ctx.db, person), { from: request.start_date, to: request.end_date }),
  };
}

const mailOptions = (ctx) => ({ env: ctx.env, origin: ctx.origin, outboxDir: ctx.outboxDir, dataDir: ctx.dataDir, fetchImpl: ctx.fetchImpl, audit: (action, subject, detail) => log(ctx, action, subject, detail) });

/** Run the outside work; anything that escapes is an audit row, never a rejection. */
const safely = (ctx, subject, work) => async () => {
  try {
    await work();
  } catch (error) {
    // Even the audit row is best effort here: the change itself is committed.
    try {
      log(ctx, "followup.failed", subject, `Something after the change did not finish (${error?.code || error?.name || "error"}).`);
    } catch {
      console.error("[followup] could not record a failed follow-up");
    }
  }
};

// ---------------------------------------------------------- the calendar --

const calendarOptions = (ctx) => ({ env: ctx.env, dataDir: ctx.dataDir, fetchImpl: ctx.fetchImpl });

function setCalendarState(ctx, id, fields) {
  const sets = Object.keys(fields).map((key) => `${key} = ?`).join(", ");
  ctx.db.prepare(`UPDATE requests SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), nowIso(), id);
}

function calendarWaiting(ctx, id, words) {
  setCalendarState(ctx, id, { calendar_state: "pending", calendar_error: words });
  store.setSetting(ctx.db, "calendar", { ...store.getSetting(ctx.db, "calendar", {}), last_error: words });
  log(ctx, "calendar.write_failed", id, words);
  return "pending";
}

/** The chosen calendar's id while one is connected and chosen, else null. */
export function calendarTarget(ctx) {
  const chosen = store.getSetting(ctx.db, "calendar", {});
  return calendarStatus({ env: ctx.env, dataDir: ctx.dataDir }).connected && chosen.calendar_id ? chosen.calendar_id : null;
}

// Add an approved request to the shared calendar. The approval already
// committed the row as 'pending' (so a restart mid-write is picked up by
// Retry), and a failed write never undoes it: the row stays 'pending' with
// a plain reason. The event id is fixed per request, so a write repeated
// after a timeout lands once.
export async function addToCalendar(ctx, id) {
  const calendarId = calendarTarget(ctx);
  if (!calendarId) return calendarWaiting(ctx, id, "The shared calendar is not connected. Connect it in Settings.");
  const row = store.requestRow(ctx.db, id);
  const person = store.personRow(ctx.db, row.person_id);
  const manager = person.manager_id ? store.personRow(ctx.db, person.manager_id) : null;
  const decider = row.decided_by ? store.personRow(ctx.db, row.decided_by) : null;
  const halves = [row.half_day_start ? "The first day is a half day." : "", row.half_day_end ? "The last day is a half day." : ""].filter(Boolean).join(" ");
  const description = [`Time Off request ${row.id}.`, manager ? `Manager: ${manager.name}.` : "", decider ? `Approved by ${decider.name}.` : "", halves].filter(Boolean).join("\n");
  try {
    const event = await insertAllDayEvent({ eventId: eventIdFor(row.id), calendarId, summary: `${person.name} — ${calendarTitleWord(row.kind, store.getSetting(ctx.db, "calendar", {}).titles || "out")}`, description, start_date: row.start_date, end_date: row.end_date }, calendarOptions(ctx));
    setCalendarState(ctx, id, { calendar_state: "added", calendar_event_id: event.id, calendar_id: calendarId, calendar_error: null });
  } catch (error) {
    // Status only: a Google error body can quote the calendar id, which is often an address.
    console.warn(`[calendar] add failed for ${row.id} (status ${error.googleStatus ?? error.name ?? "unknown"})`);
    return calendarWaiting(ctx, id, calendarErrorWords(error));
  }
  // A cancel that landed while the event was being written: take it off again.
  if (store.requestRow(ctx.db, id).status !== "approved") return removeFromCalendar(ctx, id);
  return "added";
}

// Take a cancelled request off the calendar. A row still 'pending' with a
// calendar recorded may have had its write land before a restart, so its
// fixed event id is deleted too (a missing event counts as removed).
export async function removeFromCalendar(ctx, id) {
  const row = store.requestRow(ctx.db, id);
  const eventId = row.calendar_event_id || (row.calendar_state === "pending" && row.calendar_id ? eventIdFor(row.id) : null);
  if (!eventId) {
    if (row.calendar_state === "pending") setCalendarState(ctx, id, { calendar_state: "none", calendar_error: null });
    return row.calendar_state === "pending" ? "none" : row.calendar_state;
  }
  try {
    await deleteEvent({ calendarId: row.calendar_id || store.getSetting(ctx.db, "calendar", {}).calendar_id, eventId }, calendarOptions(ctx));
    const state = row.calendar_event_id ? "removed" : "none";
    setCalendarState(ctx, id, { calendar_state: state, calendar_error: null });
    return state;
  } catch (error) {
    console.warn(`[calendar] remove failed for ${row.id} (status ${error.googleStatus ?? error.name ?? "unknown"})`);
    return calendarWaiting(ctx, id, calendarErrorWords(error));
  }
}

/** Re-run every calendar write still owed. With no calendar connected the rows stay waiting and count as failed. */
export async function retryCalendar(ctx) {
  const { actor } = ctx;
  const waiting = ctx.db.prepare("SELECT id, status, calendar_event_id FROM requests WHERE calendar_state = 'pending' ORDER BY updated_at").all();
  let failed = 0;
  for (const row of waiting) {
    let state;
    if (row.status === "approved" && !row.calendar_event_id) state = await addToCalendar(ctx, row.id);
    else if (row.status === "cancelled") state = await removeFromCalendar(ctx, row.id);
    else {
      // Pending, denied or already added: nothing is owed to the calendar.
      setCalendarState(ctx, row.id, { calendar_state: row.calendar_event_id ? "added" : "none", calendar_error: null });
      state = "done";
    }
    if (state === "pending") failed += 1;
  }
  if (!failed) store.setSetting(ctx.db, "calendar", { ...store.getSetting(ctx.db, "calendar", {}), last_error: null });
  log(ctx, "calendar.retry", "calendar", `Tried ${waiting.length} waiting calendar changes; ${failed} still waiting.`, actor?.id ?? null);
  return { retried: waiting.length, failed };
}

// -------------------------------------------------------------- requests --

/**
 * Ask for time off. `body` is { start_date, end_date, half_day_start?,
 * half_day_end?, kind, note? }. Returns { request, followUp }.
 */
/** Hours a request comes to: its days times the person's hours per day. */
export const hoursFor = (person, days) => round2(Number(days) * Number(person.hours_per_day ?? 8));

/** The Approve and Deny links in the email to one approver. */
function decideLinks(ctx, request, approver) {
  const pair = makeDecidePair(ctx.db, { requestId: request.id, actions: ["approve", "deny"], approverId: approver.id });
  return { approve: `${ctx.origin}/approve/${pair.approve}`, deny: `${ctx.origin}/deny/${pair.deny}` };
}

/**
 * Yes / No links for the Manager question: only to an admin, and only while
 * the request has a Manager pick waiting; null otherwise.
 */
function managerLinks(ctx, request, admin) {
  const pick = parseJson(request.pending_manager, null);
  if (admin?.role !== "admin" || !pick || pick.rejected) return null;
  const pair = makeDecidePair(ctx.db, { requestId: request.id, actions: ["confirm_manager", "reject_manager"], approverId: admin.id });
  return { confirm: `${ctx.origin}/confirm-manager/${pair.confirm_manager}`, reject: `${ctx.origin}/reject-manager/${pair.reject_manager}` };
}

export function createRequest(ctx) {
  const { db, actor, body } = ctx;
  const today = store.todayFor(actor);
  const holidays = store.holidaysFor(db, actor);
  const id = transaction(db, () => {
    const draft = checkDraft({ ...body, note: cleanText(body?.note, MAX_NOTE, { lines: true }) }, { person: actor, today, holidays, own: store.requestsFor(db, actor.id) });
    // A Manager pick an admin must confirm first: no approver until then.
    const pending = ctx.pendingManager || null;
    const approverId = pending ? null : chooseApprover(db, actor, body?.approver_id);
    const hours = hoursFor(actor, draft.days);
    const newRequest = newId("req");
    const at = nowIso();
    db.prepare(`INSERT INTO requests (id, person_id, kind, status, start_date, end_date, half_day_start, half_day_end, days, days_computed, days_overridden, hours, approver_id, pending_manager, note, calendar_state, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`)
      .run(newRequest, actor.id, draft.kind, draft.start_date, draft.end_date, draft.half_day_start ? 1 : 0, draft.half_day_end ? 1 : 0, draft.days, draft.days_computed, draft.days_overridden ? 1 : 0, hours, approverId, pending ? JSON.stringify(pending) : null, draft.note, at, at);
    const hourly = actor.pay_basis === "hourly" ? `, ${hours} hours` : "";
    log(ctx, "request.submit", newRequest, `${KIND_LABELS[draft.kind]}, ${draft.start_date} to ${draft.end_date}, ${draft.days} days${draft.days_overridden && draft.days !== draft.days_computed ? ` (counted ${draft.days_computed})` : ""}${hourly}`, actor.id);
    return newRequest;
  });
  const request = store.requestRow(db, id);
  const followUp = safely(ctx, id, async () => {
    const approvers = approversOf(ctx, actor, request);
    const overlapsNow = store.overlapsFor(db, store.teamIds(db, actor), { from: request.start_date, to: request.end_date });
    if (request.pending_manager) {
      // The admins are asked whether the pick is right (and may decide it too).
      const pick = JSON.parse(request.pending_manager);
      for (const admin of approvers) {
        await notify("manager_confirm", { to: admin.email, data: { requester: actor.name, manager: pick.name, request, links: decideLinks(ctx, request, admin), managerLinks: managerLinks(ctx, request, admin) } }, mailOptions(ctx));
      }
      await askAdminsAboutManager(ctx, { request, person: actor, admins: approvers, pick, balanceAfter: balanceAfter(ctx, actor, request, holidays), overlaps: overlapsNow });
      return;
    }
    for (const approver of approvers) {
      await notify("request_submitted", { to: approver.email, data: { person: actor, request, approver, links: decideLinks(ctx, request, approver) } }, mailOptions(ctx));
    }
    // The approver's message shows the real kind and every overlap: they decide on it.
    const overlaps = store.overlapsFor(db, store.teamIds(db, actor), { from: request.start_date, to: request.end_date });
    await announceRequest(ctx, { request, person: actor, approvers, balanceAfter: balanceAfter(ctx, actor, request, holidays), overlaps });
  });
  return { request, followUp };
}

/** Would `actor` be allowed to `action` this request right now? Returns the row or throws the refusal; writes nothing. */
export function checkDecision({ db, actor, id, action }) {
  const row = store.requestRow(db, id);
  if (!row) throw fail("That request was not found.", "not_found", 404);
  const owner = store.personRow(db, row.person_id);
  transition(row, action, actor, { managerId: owner.manager_id, today: store.todayFor(owner), soleAdmin: store.soleAdmin(db, actor) });
  return row;
}

function decide(ctx, action) {
  const { db, actor, id } = ctx;
  const note = action === "cancel" ? "" : cleanText(ctx.note, MAX_NOTE, { lines: true });
  const { before, requester } = transaction(db, () => {
    const row = store.requestRow(db, id);
    if (!row) throw fail("That request was not found.", "not_found", 404);
    const owner = store.personRow(db, row.person_id);
    const next = transition(row, action, actor, { managerId: owner.manager_id, today: store.todayFor(owner), soleAdmin: store.soleAdmin(db, actor) });
    if (action !== "cancel" && row.person_id === actor.id) log(ctx, "request.self_decided", id, `The only admin ${next} their own request.`, actor.id);
    const at = nowIso();
    if (action === "cancel") db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run(next, at, id);
    else db.prepare("UPDATE requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(next, actor.id, at, note, at, id);
    // The calendar write is owed from the moment the approval commits: a
    // restart before it lands leaves the row 'pending' for Retry.
    if (action === "approve") {
      const target = calendarTarget(ctx);
      db.prepare("UPDATE requests SET calendar_state = ?, calendar_id = ?, calendar_error = NULL WHERE id = ?").run(target ? "pending" : "none", target, id);
    }
    const hourly = owner.pay_basis === "hourly" && row.hours !== null ? ` (${Number(row.hours)} hours)` : "";
    log(ctx, `request.${action}`, id, `${row.status} to ${next}${hourly}${note ? " with a note" : ""}`, actor.id);
    return { before: row, requester: owner };
  });
  const followUp = safely(ctx, id, async () => {
    const current = () => store.requestRow(db, id);
    // Names and notes are escaped here because these DMs are Slack text.
    const who = esc(actor.name);
    const noteLine = note ? `\nTheir note: ${esc(note)}` : "";
    if (action === "approve") {
      if (current().calendar_state === "pending") await addToCalendar(ctx, id);
      if (store.reachable(requester)) await notify("request_approved", { to: requester.email, data: { request: current(), decider: actor } }, mailOptions(ctx));
      await settleMessages(ctx, { request: current(), line: decisionLine(db, current()), ...messageFacts(ctx, current(), requester) });
      await dm(ctx, requester, `${who} approved your ${requestLine(current())}.${current().calendar_state === "added" ? " It's on the team calendar." : ""}${noteLine}`);
    } else if (action === "deny") {
      if (store.reachable(requester)) await notify("request_denied", { to: requester.email, data: { request: current(), decider: actor } }, mailOptions(ctx));
      await settleMessages(ctx, { request: current(), line: decisionLine(db, current()), ...messageFacts(ctx, current(), requester) });
      await dm(ctx, requester, `${who} did not approve your ${requestLine(current())}.${noteLine}`);
    } else {
      await removeFromCalendar(ctx, id);
      // The approver hears when approved time off goes away, unless they did it.
      if (before.status === "approved") {
        for (const approver of approversOf(ctx, requester, before)) {
          if (approver.id !== actor.id) await notify("request_cancelled", { to: approver.email, data: { person: requester, request: current(), actor } }, mailOptions(ctx));
        }
      }
      await settleMessages(ctx, { request: current(), line: `Cancelled by ${actor.name}`, ...messageFacts(ctx, current(), requester) });
      if (actor.id !== requester.id) await dm(ctx, requester, `${who} cancelled your ${requestLine(current())}.`);
    }
  });
  return { request: store.requestRow(db, id), requester, before, followUp };
}

/** Approve: { actor, id, note? }. The person's manager (while a manager) or an admin, never their own. */
export const approveRequest = (ctx) => decide(ctx, "approve");
/** Deny: { actor, id, note? }. Same rule as approve. */
export const denyRequest = (ctx) => decide(ctx, "deny");
/** Cancel: { actor, id }. The requester (approved: before it starts), or their manager or an admin. */
export const cancelRequest = (ctx) => decide(ctx, "cancel");

// ------------------------------------------------- the Manager pick, confirmed --

function pendingPick(db, actor, id) {
  if (actor?.role !== "admin") throw fail("Only an admin can confirm a manager.", "not_admin", 403);
  const row = store.requestRow(db, id);
  if (!row) throw fail("That request was not found.", "not_found", 404);
  const pick = parseJson(row.pending_manager, null);
  if (!pick || pick.rejected || row.status !== "pending") throw fail("There is no manager waiting to be confirmed on this request.", "no_pending_manager", 409);
  return { row, pick };
}

/**
 * An admin says yes to a Manager pick: the person named becomes a manager
 * (promoted, or added from Slack), the requester's manager when they have
 * none, and this request's approver, who then gets it with buttons.
 */
export function confirmManager(ctx) {
  const { db, actor, id } = ctx;
  const { manager, requester } = transaction(db, () => {
    const { row, pick } = pendingPick(db, actor, id);
    let person = (pick.person_id && store.personRow(db, pick.person_id)) || db.prepare("SELECT * FROM people WHERE email = ?").get(pick.email) || null;
    if (person && person.active !== 1) throw fail(`${pick.name} is no longer on the roster.`, "inactive", 409);
    if (!person) person = enrollManager(ctx, pick).person;
    if (!person) throw fail(`${pick.name} could not be added. Add them on the People page.`, "not_added", 409);
    if (person.role === "employee") db.prepare("UPDATE people SET role = 'manager' WHERE id = ?").run(person.id);
    if (!person.slack_user_id && pick.slack_user_id && !db.prepare("SELECT 1 FROM people WHERE slack_user_id = ?").get(pick.slack_user_id)) {
      db.prepare("UPDATE people SET slack_user_id = ? WHERE id = ?").run(pick.slack_user_id, person.id);
    }
    const owner = store.personRow(db, row.person_id);
    let loop = false;
    for (let cursor = store.personRow(db, person.id), hops = 0; cursor && hops < 100; hops += 1) {
      if (cursor.manager_id === owner.id) loop = true;
      cursor = cursor.manager_id ? store.personRow(db, cursor.manager_id) : null;
    }
    if (!owner.manager_id && !loop && person.id !== owner.id) db.prepare("UPDATE people SET manager_id = ? WHERE id = ?").run(person.id, owner.id);
    db.prepare("UPDATE requests SET approver_id = ?, pending_manager = NULL, updated_at = ? WHERE id = ?").run(person.id, nowIso(), id);
    log(ctx, "person.manager_confirmed", person.id, `${actor.name} confirmed ${person.name} as ${owner.name}'s manager.`, actor.id);
    return { manager: store.personRow(db, person.id), requester: store.personRow(db, owner.id) };
  });
  const request = store.requestRow(db, id);
  const followUp = safely(ctx, id, async () => {
    // The admins' messages are closed, then the new manager gets the request.
    await settleMessages(ctx, { request, line: `Confirmed by ${actor.name}: ${manager.name} is a manager`, ...messageFacts(ctx, request, requester) });
    db.prepare("UPDATE requests SET slack_channel = NULL, slack_ts = NULL, slack_extra = NULL WHERE id = ?").run(id);
    const fresh = store.requestRow(db, id);
    if (store.reachable(manager)) await notify("request_submitted", { to: manager.email, data: { person: requester, request: fresh, approver: manager, links: decideLinks(ctx, fresh, manager) } }, mailOptions(ctx));
    await announceRequest(ctx, { request: fresh, person: requester, approvers: [manager], ...messageFacts(ctx, fresh, requester) });
  });
  return { request, manager, requester, followUp };
}

/** An admin says no: the request stays with the admins, and the requester is told. */
export function rejectManager(ctx) {
  const { db, actor, id } = ctx;
  const { pick, requester } = transaction(db, () => {
    const { row, pick } = pendingPick(db, actor, id);
    db.prepare("UPDATE requests SET pending_manager = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...pick, rejected: true }), nowIso(), id);
    log(ctx, "person.manager_rejected", row.person_id, `${actor.name} did not confirm ${pick.name} as manager.`, actor.id);
    return { pick, requester: store.personRow(db, row.person_id) };
  });
  const request = store.requestRow(db, id);
  const followUp = safely(ctx, id, async () => {
    // The admins' messages lose the confirm buttons but keep Approve / Deny.
    await settleMessages(ctx, { request, line: `${pick.name} not confirmed as manager by ${actor.name}; an admin decides this one`, buttons: true, ...messageFacts(ctx, request, requester) });
    await dm(ctx, requester, `${esc(pick.name)} isn't set up as a manager; an admin will handle this one.`);
  });
  return { request, requester, followUp };
}

// ------------------------------------------------------------- reminders --

export const REMIND_GAP_MS = 10 * 60 * 1000;

/**
 * Nudge the approver of a pending request: the approval email again with
 * fresh Approve/Deny links, and the Slack message again when the last one
 * is more than ten minutes old. An admin or the request's approver may;
 * at most once every ten minutes per request.
 */
export function remindRequest(ctx) {
  const { db, actor, id } = ctx;
  const now = Date.now();
  const row = transaction(db, () => {
    const found = store.requestRow(db, id);
    if (!found) throw fail("That request was not found.", "not_found", 404);
    if (actor.role !== "admin" && actor.id !== found.approver_id) throw fail("Only an admin or the person asked to approve it can send a reminder.", "not_allowed", 403);
    if (found.status !== "pending") throw fail(`This request is already ${found.status}.`, "not_pending", 409);
    if (found.last_reminded_at && now - Date.parse(found.last_reminded_at) < REMIND_GAP_MS) throw fail("A reminder went out less than ten minutes ago.", "too_soon", 409);
    db.prepare("UPDATE requests SET last_reminded_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
    log(ctx, "request.reminded", id, `${actor.name} sent a reminder.`, actor.id);
    return store.requestRow(db, id);
  });
  const followUp = safely(ctx, id, async () => {
    const requester = store.personRow(db, row.person_id);
    const approvers = approversOf(ctx, requester, row);
    const pick = parseJson(row.pending_manager, null);
    for (const approver of approvers.filter(store.reachable)) {
      const links = decideLinks(ctx, row, approver);
      if (pick && !pick.rejected) await notify("manager_confirm", { to: approver.email, data: { requester: requester.name, manager: pick.name, request: row, links, managerLinks: managerLinks(ctx, row, approver) } }, mailOptions(ctx));
      else await notify("request_submitted", { to: approver.email, data: { person: requester, request: row, approver, links } }, mailOptions(ctx));
    }
    const lastPosted = row.slack_ts ? Number.parseFloat(row.slack_ts) * 1000 : 0;
    if (!lastPosted || now - lastPosted > REMIND_GAP_MS) {
      await repostApproval(ctx, { request: row, person: requester, approvers, pick, ...messageFacts(ctx, row, requester) });
    }
  });
  return { request: row, followUp };
}
