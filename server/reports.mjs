// Who was out, by month and team: the monthly report emailed on the 1st and
// the numbers on the Insights page. Only approved time counts, split by the
// day: a request across a month end counts in both months, half days as
// half, weekends and holidays not at all (the same workingDays as balances).
//
// Scope: an admin sees the whole company. A manager sees themselves, their
// direct reports, and anyone who named them as the approver of a request.
// The free-text team is only a label for grouping, never a key to data.
//
// Hours: for people paid hourly, the days away times their hours per day
// (as it is set now). For monthly people hours is null.
//
// Sending: once per month. The month's key in settings is claimed inside a
// transaction before anything is sent, so the host's cron
// (POST /api/jobs/monthly-report) and the lazy trigger (any signed-in
// request after the 1st) can race and still send one set of emails.

import { transaction } from "./db.mjs";
import { addDays, isoToday, yearOf } from "./domain/dates.mjs";
import { requestDayWeights } from "./domain/balance.mjs";
import { KINDS, KIND_LABELS, classOf } from "./domain/kinds.mjs";
import { notify } from "./mail.mjs";
import * as store from "./store.mjs";

export { KINDS };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const zero = () => Object.fromEntries(KINDS.map((kind) => [kind, 0]));
const pad2 = (n) => String(n).padStart(2, "0");

/** The first and last date of a month. */
export function monthRange(year, month) {
  const from = `${year}-${pad2(month)}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
  return { from, to: addDays(next, -1) };
}

/** The month before the one `today` is in: { year, month }. */
export function previousMonth(today) {
  const year = yearOf(today);
  const month = Number(today.slice(5, 7));
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export const monthKey = ({ year, month }) => `${year}-${pad2(month)}`;
export const monthTitle = ({ year, month }) => `${MONTH_NAMES[month - 1]} ${year}`;

/** The people a viewer's reports cover (rows, inactive included). */
export function scopeFor(db, viewer) {
  if (viewer.role === "admin") return db.prepare("SELECT * FROM people ORDER BY name COLLATE NOCASE").all();
  return db.prepare("SELECT * FROM people WHERE id = ? OR manager_id = ? OR id IN (SELECT person_id FROM requests WHERE approver_id = ?) ORDER BY name COLLATE NOCASE").all(viewer.id, viewer.id, viewer.id);
}

/**
 * Approved days per person and kind between `from` and `to`, with the
 * per-month split: Map(person id -> { pto, sick, unpaid, loa, unavailable,
 * months: { "YYYY-MM": { ...kinds } } }).
 */
export function approvedDays(db, personIds, { from, to }) {
  const tallies = new Map(personIds.map((id) => [id, { ...zero(), months: {} }]));
  if (!personIds.length) return tallies;
  const holidays = store.holidaySet(db);
  const workers = store.holidayWorkers(db);
  const none = new Set();
  const marks = personIds.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT * FROM requests WHERE status = 'approved' AND person_id IN (${marks}) AND start_date <= ? AND end_date >= ?`).all(...personIds, to, from);
  for (const row of rows) {
    // A typed number of days counts as typed, spread over the same dates.
    const counted = requestDayWeights(row, workers.has(row.person_id) ? none : holidays);
    const tally = tallies.get(row.person_id);
    counted.dates.forEach((date, index) => {
      if (date < from || date > to) return;
      const weight = counted.weights[index];
      tally[row.kind] += weight;
      const month = date.slice(0, 7);
      tally.months[month] ??= zero();
      tally.months[month][row.kind] += weight;
    });
  }
  return tallies;
}

const totalDays = (tally) => KINDS.reduce((sum, kind) => sum + tally[kind], 0);
const hoursOf = (person, tally) => (person.pay_basis === "hourly" ? round2(totalDays(tally) * Number(person.hours_per_day ?? 8)) : null);
const rounded = (tally) => Object.fromEntries(KINDS.map((kind) => [kind, round2(tally[kind])]));

function sumRows(rows) {
  const totals = { ...zero(), hours: 0 };
  for (const row of rows) {
    for (const kind of KINDS) totals[kind] += row[kind];
    totals.hours += row.hours ?? 0;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round2(value)]));
}

// Teams in name order, people without a team last.
function byTeam(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.team)) groups.set(row.team, []);
    groups.get(row.team).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === null) - (b === null) || String(a).localeCompare(String(b)));
}

/**
 * One month, per team, per person: { year, month: "YYYY-MM", from, to,
 * teams: [{ team, people: [{ id, name, pay_basis, pto, sick, unpaid, loa,
 * unavailable, hours }], totals }], totals }. Every active person in
 * `people` is listed, with zeros when they were not out; someone inactive
 * shows only if they were out that month.
 */
export function monthlyReport(db, { year, month, people = null }) {
  const { from, to } = monthRange(year, month);
  const everyone = people || db.prepare("SELECT * FROM people ORDER BY name COLLATE NOCASE").all();
  const tallies = approvedDays(db, everyone.map((person) => person.id), { from, to });
  const rows = everyone
    .filter((person) => person.active === 1 || totalDays(tallies.get(person.id)) > 0)
    .map((person) => {
      const tally = tallies.get(person.id);
      return { id: person.id, name: person.name, class: classOf(person), team: person.team ?? null, pay_basis: person.pay_basis || "monthly", ...rounded(tally), hours: hoursOf(person, tally) };
    });
  const teams = byTeam(rows).map(([team, members]) => ({ team, people: members.map(({ team: _team, ...rest }) => rest), totals: sumRows(members) }));
  return { year, month: monthKey({ year, month }), from, to, teams, totals: sumRows(rows) };
}

const cell = (value) => (value === null || value === undefined ? "" : String(value));

/** The report as a plain-text table, one block per team. */
export function reportText(report) {
  const header = ["Name", ...KINDS.map((kind) => KIND_LABELS[kind]), "Hours"];
  const widths = [28, 6, 6, 12, 5, 12, 7];
  const line = (cells) => cells.map((value, index) => (index === 0 ? cell(value).slice(0, widths[0]).padEnd(widths[0]) : cell(value).padStart(widths[index]))).join(" ").trimEnd();
  const blocks = [];
  for (const team of report.teams) {
    const rows = [line(header)];
    for (const person of team.people) rows.push(line([person.name, ...KINDS.map((kind) => person[kind]), person.hours]));
    rows.push(line(["Team total", ...KINDS.map((kind) => team.totals[kind]), team.totals.hours || ""]));
    blocks.push(`${team.team ?? "No team"}\n${rows.join("\n")}`);
  }
  const t = report.totals;
  blocks.push(`All together: ${KINDS.map((kind) => `${KIND_LABELS[kind]} ${t[kind]}`).join(", ")} days${t.hours ? `; ${t.hours} hours for hourly staff` : ""}.`);
  return `Days away (approved), ${report.from} to ${report.to}.\n\n${blocks.join("\n\n")}`;
}

/**
 * Email one month's report: every active admin gets the whole company, each
 * active manager their own scope. Returns how many were sent.
 */
async function sendMonth(ctx, period, mailOptions) {
  const { db } = ctx;
  const title = `Time off for ${monthTitle(period)}`;
  // Only a message that went out (or into the practice outbox) counts.
  let recipients = 0;
  const delivered = (outcome) => outcome === "sent" || outcome === "captured";
  const company = monthlyReport(db, period);
  for (const admin of db.prepare("SELECT * FROM people WHERE role = 'admin' AND active = 1 AND sample = 0").all()) {
    if (delivered(await notify("monthly_report", { to: admin.email, data: { title, table: reportText(company) } }, mailOptions))) recipients += 1;
  }
  for (const manager of db.prepare("SELECT * FROM people WHERE role = 'manager' AND active = 1 AND sample = 0").all()) {
    const report = monthlyReport(db, { ...period, people: scopeFor(db, manager) });
    if (delivered(await notify("monthly_report", { to: manager.email, data: { title: `${title}, your team`, table: reportText(report) } }, mailOptions))) recipients += 1;
  }
  return recipients;
}

/**
 * Send a month's report once. Returns { sent: true, month, recipients } or
 * { sent: false, month, already: true } when it went out (or is going out)
 * already.
 */
export async function runMonthlyReport(ctx, period, { mailOptions, now = new Date() } = {}) {
  const key = `monthly_report:${monthKey(period)}`;
  const claimed = transaction(ctx.db, () => {
    if (store.getSetting(ctx.db, key, null)) return false;
    store.setSetting(ctx.db, key, { claimed_at: now.toISOString() });
    return true;
  });
  if (!claimed) return { sent: false, month: monthKey(period), already: true };
  // A failed or empty send gives the month back, so the next try sends it.
  const release = () => ctx.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  let recipients;
  try {
    recipients = await sendMonth(ctx, period, mailOptions);
  } catch (error) {
    release();
    throw error;
  }
  if (!recipients) {
    release();
    store.audit(ctx.db, { action: "report.monthly_not_sent", subject: monthKey(period), detail: "The monthly report reached nobody (mail is off or failed); it will be tried again." });
    return { sent: false, month: monthKey(period), recipients: 0, retry: true };
  }
  store.setSetting(ctx.db, key, { claimed_at: now.toISOString(), sent_at: new Date().toISOString(), recipients });
  store.audit(ctx.db, { action: "report.monthly_sent", subject: monthKey(period), detail: `Monthly report sent to ${recipients} people.` });
  return { sent: true, month: monthKey(period), recipients };
}

/** The company's today, for deciding which month just ended. */
export const companyToday = (env, now = new Date()) => isoToday(now, String(env?.DEFAULT_TIMEZONE || "America/New_York"));

/**
 * The lazy trigger: last month's report, if it has not gone out and the app
 * was in use before this month began (a new install does not send a report
 * of an empty month). Cheap when there is nothing to do.
 */
export async function maybeSendLastMonth(ctx, { mailOptions, now = new Date() } = {}) {
  const today = companyToday(ctx.env, now);
  const period = previousMonth(today);
  if (store.getSetting(ctx.db, `monthly_report:${monthKey(period)}`, null)) return null;
  const first = ctx.db.prepare("SELECT min(created_at) AS at FROM people").get()?.at;
  if (!first || first.slice(0, 10) >= `${today.slice(0, 7)}-01`) return null;
  return runMonthlyReport(ctx, period, { mailOptions, now });
}

/**
 * The Insights page: one year for a viewer's scope.
 */
export function insights(db, viewer, { year, today }) {
  const people = scopeFor(db, viewer);
  const ids = people.map((person) => person.id);
  const tallies = approvedDays(db, ids, { from: `${year}-01-01`, to: `${year}-12-31` });
  const holidays = store.holidaySet(db);
  const workers = store.holidayWorkers(db);
  const none = new Set();
  const listed = people.filter((person) => person.active === 1 || totalDays(tallies.get(person.id)) > 0);
  const byPerson = listed.map((person) => {
    const tally = tallies.get(person.id);
    const balances = store.balanceFor(db, person, { today, year, holidays });
    return {
      id: person.id,
      name: person.name,
      class: classOf(person),
      team: person.team ?? null,
      ...rounded(tally),
      hours: hoursOf(person, tally),
      pto_available: balances.pto.tracked ? balances.pto.available : null,
      sick_available: balances.sick.tracked ? balances.sick.available : null,
    };
  });
  const byMonth = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${pad2(index + 1)}`;
    const sums = zero();
    for (const id of ids) for (const kind of KINDS) sums[kind] += tallies.get(id).months[month]?.[kind] || 0;
    return { month, ...rounded(sums) };
  });
  const byTeamRows = byTeam(byPerson).map(([team, members]) => {
    const totals = sumRows(members);
    return { team, people: members.length, ...Object.fromEntries(KINDS.map((kind) => [kind, totals[kind]])), hours: totals.hours };
  });
  const kinds = sumRows(byPerson);
  // Who is out: active people with an approved, counted date in the range
  // (weekends and holidays are not "out"; typed days spread as charged).
  const activeIds = people.filter((person) => person.active === 1).map((person) => person.id);
  const outBetween = (from, to) => {
    if (!activeIds.length) return 0;
    const marks = activeIds.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT * FROM requests WHERE status = 'approved' AND person_id IN (${marks}) AND start_date <= ? AND end_date >= ?`).all(...activeIds, to, from);
    const out = new Set();
    for (const row of rows) {
      const counted = requestDayWeights(row, workers.has(row.person_id) ? none : holidays);
      if (counted.dates.some((date, index) => date >= from && date <= to && counted.weights[index] > 0)) out.add(row.person_id);
    }
    return out.size;
  };
  const pending = ids.length ? Number(db.prepare(`SELECT count(*) AS n FROM requests WHERE status = 'pending' AND person_id IN (${ids.map(() => "?").join(", ")})`).get(...ids).n) : 0;
  return {
    year,
    by_month: byMonth,
    by_team: byTeamRows,
    by_person: byPerson,
    by_kind: Object.fromEntries(KINDS.map((kind) => [kind, kinds[kind]])),
    out_today: outBetween(today, today),
    out_next_30: outBetween(today, addDays(today, 30)),
    pending,
    unused_pto_total: round2(byPerson.reduce((sum, row) => sum + Math.max(0, row.pto_available ?? 0), 0)),
  };
}

/**
 * The Insights drill-down: the requests behind a number. Same scope as
 * insights (scopeFor) and the same per-date weights as approvedDays, so
 * days_in_window is the slice of each request inside the window and the
 * totals equal the matching Insights figure.
 * filters: { year, month (YYYY-MM) | null, window: "today" | "next_30" |
 * "pending" | null, today (for the windows), team (string, "" = no team) |
 * null, person_id | null, kind | null, class | null, status: "approved" | "pending" }.
 * The windows match the Insights tiles: "today" and "next_30" are approved
 * time off of active people with a counted day in [today, today] or
 * [today, today + 30] (total_people is the tile); "pending" is every pending
 * request in scope, any year (total_requests is the tile).
 * Newest start first, at most 500 listed; the totals count every match.
 */
export const INSIGHT_REQUEST_CAP = 500;
export function insightRequests(db, viewer, filters) {
  const { year = null, month = null, window = null, today = null, team = null, person_id: personId = null, kind = null } = filters;
  const cls = filters.class ?? null;
  const status = window === "pending" ? "pending" : window ? "approved" : filters.status || "approved";
  let from = null;
  let to = null;
  if (window === "today") [from, to] = [today, today];
  else if (window === "next_30") [from, to] = [today, addDays(today, 30)];
  else if (!window) {
    from = month ? `${month}-01` : `${year}-01-01`;
    to = month ? monthRange(year, Number(month.slice(5, 7))).to : `${year}-12-31`;
  }
  const people = new Map(scopeFor(db, viewer)
    // The out tiles count active people only.
    .filter((person) => (window === "today" || window === "next_30" ? person.active === 1 : true))
    .filter((person) => team === null || (team === "" ? !person.team : person.team === team))
    .filter((person) => personId === null || person.id === personId)
    .filter((person) => cls === null || classOf(person) === cls)
    .map((person) => [person.id, person]));
  const out = {
    filters: { year, month, window, from, to, team, person_id: personId, kind, class: cls, status },
    total_days: 0, total_requests: 0, total_people: 0, truncated: false, requests: [],
  };
  if (!people.size) return out;
  const ids = [...people.keys()];
  const marks = ids.map(() => "?").join(", ");
  const dated = from !== null;
  const rows = db.prepare(`SELECT * FROM requests WHERE status = ? AND person_id IN (${marks})${dated ? " AND start_date <= ? AND end_date >= ?" : ""}${kind ? " AND kind = ?" : ""} ORDER BY start_date DESC, created_at DESC`)
    .all(status, ...ids, ...(dated ? [to, from] : []), ...(kind ? [kind] : []));
  const holidays = store.holidaySet(db);
  const workers = store.holidayWorkers(db);
  const none = new Set();
  const names = new Map();
  const nameOf = (id) => {
    if (!names.has(id)) names.set(id, db.prepare("SELECT name FROM people WHERE id = ?").get(id)?.name ?? null);
    return names.get(id);
  };
  let total = 0;
  const who = new Set();
  for (const row of rows) {
    const counted = requestDayWeights(row, workers.has(row.person_id) ? none : holidays);
    let inWindow = 0;
    counted.dates.forEach((date, index) => {
      if (!dated || (date >= from && date <= to)) inWindow += counted.weights[index];
    });
    // A dated window lists only requests with a counted day in it; every
    // pending request counts, whatever its days.
    if (dated && inWindow <= 0) continue;
    total += inWindow;
    out.total_requests += 1;
    who.add(row.person_id);
    if (out.requests.length >= INSIGHT_REQUEST_CAP) {
      out.truncated = true;
      continue;
    }
    const person = people.get(row.person_id);
    out.requests.push({
      id: row.id,
      person: { id: person.id, name: person.name, class: classOf(person), team: person.team ?? null },
      kind: row.kind,
      status: row.status,
      start_date: row.start_date,
      end_date: row.end_date,
      days: Number(row.days),
      days_computed: Number(row.days_computed ?? row.days),
      days_overridden: row.days_overridden === 1,
      days_in_window: round2(inWindow),
      hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
      approver: row.approver_id ? { id: row.approver_id, name: nameOf(row.approver_id) } : null,
      decided_at: row.decided_at ?? null,
    });
  }
  out.total_days = round2(total);
  out.total_people = who.size;
  return out;
}
