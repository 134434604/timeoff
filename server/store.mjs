// Reading and shaping rows for the API (docs/API.md shapes), and the two
// small writers every route shares: the audit row and a setting. The rules
// themselves live in domain/; this file only fetches what they need.

import { nowIso, parseJson } from "./db.mjs";
import { isoToday, workingDays, yearOf } from "./domain/dates.mjs";
import { computeBalances } from "./domain/balance.mjs";
import { classOf } from "./domain/kinds.mjs";

// ---------------------------------------------------------------- people --

export const personRow = (db, id) => db.prepare("SELECT * FROM people WHERE id = ?").get(String(id ?? "")) ?? null;

export function personView(db, row) {
  if (!row) return null;
  const manager = row.manager_id ? db.prepare("SELECT id, name FROM people WHERE id = ?").get(row.manager_id) : null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    worker_type: row.worker_type,
    manager: manager ? { id: manager.id, name: manager.name } : null,
    active: row.active === 1,
    timezone: row.timezone,
    slack_user_id: row.slack_user_id ?? null,
    pay_basis: row.pay_basis || "monthly",
    hours_per_day: Number(row.hours_per_day ?? 8),
    team: row.team ?? null,
    enrolled_via: row.enrolled_via || "admin",
    sample: row.sample === 1,
    // Nothing set up for them yet (someone who enrolled from Slack): no
    // allowance and no manager.
    // Someone with no manager yet (typically added from Slack): requests go
    // to the admins until one is set. Admins need no manager.
    needs_setup: row.role !== "admin" && !row.manager_id,
    class: classOf(row),
  };
}

// --------------------------------------------------------- class defaults --

/**
 * The policy a new person gets from their class (classOf):
 *   employee            SMTO and sick unlimited; company holidays not counted as days off
 *   contractor_monthly  SMTO 10 a year, sick 5; holidays count as working days
 *   contractor_hourly   SMTO 15 a year, no sick time; holidays count as working days
 * Contractor allowances are all on Jan 1, nothing carried over. Existing
 * policies were not changed when these came in; only people added (or whose
 * worker type or pay basis changes) get them.
 */
export const CLASS_DEFAULTS = Object.freeze({
  employee: { annual_days: 0, sick_days: 0, accrual: "front_loaded", carryover_cap: 0, pto_unlimited: true, sick_unlimited: true, holidays_apply: true },
  contractor_monthly: { annual_days: 10, sick_days: 5, accrual: "front_loaded", carryover_cap: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false },
  contractor_hourly: { annual_days: 15, sick_days: 0, accrual: "front_loaded", carryover_cap: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false },
});

/** Write a policy (all fields) for a person. */
export function writePolicy(db, personId, policy) {
  db.prepare(`INSERT INTO policies (person_id, annual_days, accrual, carryover_cap, start_date, sick_days, pto_unlimited, sick_unlimited, holidays_apply, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(person_id) DO UPDATE SET annual_days = excluded.annual_days, accrual = excluded.accrual, carryover_cap = excluded.carryover_cap, start_date = excluded.start_date,
                sick_days = excluded.sick_days, pto_unlimited = excluded.pto_unlimited, sick_unlimited = excluded.sick_unlimited, holidays_apply = excluded.holidays_apply, updated_at = excluded.updated_at`)
    .run(personId, policy.annual_days, policy.accrual, policy.carryover_cap, policy.start_date, policy.sick_days, policy.pto_unlimited ? 1 : 0, policy.sick_unlimited ? 1 : 0, policy.holidays_apply ? 1 : 0, nowIso());
}

/**
 * Set a person's policy to their class's default (keeping the start date of
 * a policy they already have, else today where they are). Audited.
 */
export function applyClassPolicy(db, personId, { actorId = null, reason = "Set to the class default." } = {}) {
  const person = personRow(db, personId);
  const existing = policyFor(db, personId);
  const cls = classOf(person);
  writePolicy(db, personId, { ...CLASS_DEFAULTS[cls], start_date: existing?.start_date || todayFor(person) });
  audit(db, { actorId, action: "policy.class_default", subject: personId, detail: `${reason} Class: ${cls}.` });
  return policyFor(db, personId);
}

/** Is this person the only active admin? (They may then decide their own requests.) */
export const soleAdmin = (db, person) => person?.role === "admin" && person.active === 1 && Number(db.prepare("SELECT count(*) AS n FROM people WHERE role = 'admin' AND active = 1").get().n) === 1;

/** Sample people (scripts/seed-sample.mjs) never get mail or Slack messages. */
export const reachable = (person) => Boolean(person) && person.sample !== 1;

/** The person's own date today, in their time zone. */
export const todayFor = (person, now = new Date()) => isoToday(now, person?.timezone || "UTC");

/** Active teammates who share this person's manager, plus their direct reports. */
export function teamIds(db, person) {
  const ids = new Set();
  if (person.manager_id) for (const row of db.prepare("SELECT id FROM people WHERE manager_id = ? AND active = 1").all(person.manager_id)) ids.add(row.id);
  for (const row of db.prepare("SELECT id FROM people WHERE manager_id = ? AND active = 1").all(person.id)) ids.add(row.id);
  ids.delete(person.id);
  return [...ids];
}

// -------------------------------------------------------------- policies --

export function policyFor(db, personId) {
  const row = db.prepare("SELECT * FROM policies WHERE person_id = ?").get(personId);
  return row ? {
    annual_days: Number(row.annual_days), accrual: row.accrual, carryover_cap: Number(row.carryover_cap), start_date: row.start_date, sick_days: Number(row.sick_days ?? 0),
    pto_unlimited: row.pto_unlimited === 1, sick_unlimited: row.sick_unlimited === 1, holidays_apply: row.holidays_apply !== 0,
  } : null;
}

/**
 * The company holidays that come out of this person's day counts: all of
 * them, or none when their policy says holidays_apply is false (a
 * contractor who works them). Weekends are always out.
 */
/** Ids of the people whose company holidays are working days (holidays_apply false). */
export function holidayWorkers(db) {
  return new Set(db.prepare("SELECT person_id FROM policies WHERE holidays_apply = 0").all().map((row) => row.person_id));
}

export function holidaysFor(db, person, all = holidaySet(db)) {
  const row = person?.id ? db.prepare("SELECT holidays_apply FROM policies WHERE person_id = ?").get(person.id) : null;
  return row && row.holidays_apply === 0 ? new Set() : all;
}

export const holidaySet = (db) => new Set(db.prepare("SELECT date FROM holidays").all().map((row) => row.date));

/**
 * After the holiday list changed between `from` and `to`: recount the
 * pending and approved requests touching those dates. The count beside
 * the days always follows the calendar; a typed number of days stays as
 * typed; hours follow the days. Returns how many rows changed.
 */
export function recountDays(db, { from, to, personId = null }) {
  const holidays = holidaySet(db);
  const touched = db.prepare("SELECT requests.*, people.hours_per_day, policies.holidays_apply FROM requests JOIN people ON people.id = requests.person_id LEFT JOIN policies ON policies.person_id = requests.person_id WHERE requests.status IN ('pending', 'approved') AND requests.start_date <= ? AND requests.end_date >= ?").all(to, from).filter((row) => !personId || row.person_id === personId);
  const update = db.prepare("UPDATE requests SET days = ?, days_computed = ?, hours = ?, updated_at = ? WHERE id = ?");
  let changed = 0;
  for (const row of touched) {
    // Someone whose holidays are working days is not recounted by a holiday change.
    const counted = workingDays({ start_date: row.start_date, end_date: row.end_date, half_day_start: row.half_day_start === 1, half_day_end: row.half_day_end === 1, holidays: row.holidays_apply === 0 ? new Set() : holidays }).days;
    const days = row.days_overridden === 1 ? Number(row.days) : counted;
    if (counted === Number(row.days_computed) && days === Number(row.days)) continue;
    update.run(days, counted, Math.round(days * Number(row.hours_per_day ?? 8) * 100) / 100, nowIso(), row.id);
    changed += 1;
  }
  return changed;
}

export const holidaysBetween = (db, from, to) => db.prepare("SELECT date, name FROM holidays WHERE date >= ? AND date <= ? ORDER BY date").all(from, to).map((row) => ({ date: row.date, name: row.name }));

export const requestsFor = (db, personId) => db.prepare("SELECT * FROM requests WHERE person_id = ? ORDER BY created_at DESC, rowid DESC").all(personId);

export const adjustmentsFor = (db, personId) => db.prepare("SELECT year, days, kind FROM adjustments WHERE person_id = ?").all(personId);

/** The person's balances, { pto, sick }, for `year` (default: their current year) as of `today`. */
export function balanceFor(db, person, { now = new Date(), today = todayFor(person, now), year = yearOf(today), holidays = holidaySet(db) } = {}) {
  return computeBalances({ policy: policyFor(db, person.id), year, today, requests: requestsFor(db, person.id), adjustments: adjustmentsFor(db, person.id), holidays: holidaysFor(db, person, holidays) });
}

// -------------------------------------------------------------- requests --

const nameOf = (db, id) => (id ? db.prepare("SELECT id, name FROM people WHERE id = ?").get(id) ?? null : null);

export function requestView(db, row) {
  if (!row) return null;
  const decider = nameOf(db, row.decided_by);
  const approver = nameOf(db, row.approver_id);
  return {
    id: row.id,
    person_id: row.person_id,
    kind: row.kind,
    status: row.status,
    start_date: row.start_date,
    end_date: row.end_date,
    half_day_start: row.half_day_start === 1,
    half_day_end: row.half_day_end === 1,
    days: Number(row.days),
    days_computed: row.days_computed === null || row.days_computed === undefined ? Number(row.days) : Number(row.days_computed),
    days_overridden: row.days_overridden === 1,
    hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
    approver: approver ? { id: approver.id, name: approver.name } : null,
    note: row.note || "",
    decided_by: decider ? { id: decider.id, name: decider.name } : null,
    decided_at: row.decided_at ?? null,
    decision_note: row.decision_note || "",
    calendar: { state: row.calendar_state || "none", event_id: row.calendar_event_id ?? null, error: row.calendar_error ?? null },
    // A Manager pick waiting for an admin to confirm it (null when none).
    pending_manager: parseJson(row.pending_manager, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const requestRow = (db, id) => db.prepare("SELECT * FROM requests WHERE id = ?").get(String(id ?? "")) ?? null;

/** Overlap rows: requests joined to names, in `statuses`, for `personIds`, touching [from, to]. */
export function overlapsFor(db, personIds, { from, to, statuses = ["pending", "approved"] }) {
  if (!personIds.length) return [];
  const people = personIds.map(() => "?").join(", ");
  const kinds = statuses.map(() => "?").join(", ");
  return db.prepare(`SELECT requests.person_id, people.name, requests.start_date, requests.end_date, requests.kind, requests.status
                     FROM requests JOIN people ON people.id = requests.person_id
                     WHERE requests.person_id IN (${people}) AND requests.status IN (${kinds}) AND requests.start_date <= ? AND requests.end_date >= ?
                     ORDER BY requests.start_date, people.name`).all(...personIds, ...statuses, to, from)
    .map((row) => ({ person_id: row.person_id, name: row.name, start_date: row.start_date, end_date: row.end_date, kind: row.kind, status: row.status }));
}

// ----------------------------------------------------------------- audit --

export function audit(db, { actorId = null, action, subject = "", detail = "", now = new Date() }) {
  db.prepare("INSERT INTO audit (at, actor_id, action, subject, detail) VALUES (?, ?, ?, ?, ?)").run(nowIso(now), actorId, action, String(subject), String(detail).slice(0, 500));
}

export function auditView(db, { limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 100));
  return db.prepare("SELECT audit.at, audit.action, audit.subject, audit.detail, people.id AS actor_id, people.name AS actor_name FROM audit LEFT JOIN people ON people.id = audit.actor_id ORDER BY audit.id DESC LIMIT ?").all(n)
    .map((row) => ({ at: row.at, actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null, action: row.action, subject: row.subject, detail: row.detail }));
}

// -------------------------------------------------------------- settings --

export function getSetting(db, key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}
