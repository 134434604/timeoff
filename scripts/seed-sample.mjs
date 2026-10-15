// Sample data for a demo, written straight into the database: two teams,
// eight "Sample" people, their policies, a company holiday, an adjustment
// and about thirty requests over the last nine months and the next six
// weeks, covering every status and the cases worth showing:
//
//   1. a span over a weekend and the sample holiday (both skipped)
//   2. a single day with both half-day boxes (0.5)
//   3. a request across New Year (charged to two balance years)
//   4. a pending request that overdraws its balance (the hourly contractor)
//   5. the hourly contractor across the holiday, which he works (counted), with hours
//   6. typed working days that differ from the calendar count
//   7. a denied request with a note
//   8. an approved request that was later cancelled
//   plus Sick, LOA and Unpaid Time, two requests waiting on a sample
//   manager and one waiting on the admins.
//
// Nothing goes out: no Slack, no email, no calendar (calendar_state 'none').
// Every seeded person has people.sample = 1, the holiday's name starts with
// "Sample ", and requests and adjustments belong to sample people, so
// --remove finds and deletes exactly what --add made.
//
//   node scripts/seed-sample.mjs --add    [--data <DATA_DIR>]
//   node scripts/seed-sample.mjs --remove [--data <DATA_DIR>]
//
// Safe against the live database while the server runs: it opens the file
// with the server's own settings (WAL, a busy timeout) and does all its
// writes in one transaction. --add a second time does nothing.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { nowIso, openDb, transaction } from "../server/db.mjs";
import { newId } from "../server/auth/sessions.mjs";
import { addDays, isoToday, weekday, yearOf } from "../server/domain/dates.mjs";
import { requestDayWeights } from "../server/domain/balance.mjs";
import { classOf } from "../server/domain/kinds.mjs";
import * as store from "../server/store.mjs";

export const SAMPLE_PREFIX = "Sample ";
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** The Monday of the week `date` is in. */
const mondayOf = (date) => addDays(date, -((weekday(date) + 6) % 7));

/**
 * The seeding plan for a given today: people, policies, the holiday, the
 * adjustment and the requests, with every date worked out. Exported so the
 * tests can see what each edge case should come to.
 */
export function samplePlan(today) {
  const thisYear = yearOf(today);
  const monday = mondayOf(today);
  // dow: 0 = Monday ... 4 = Friday, in the week `weeks` from this one.
  const day = (weeks, dow = 0) => addDays(monday, weeks * 7 + dow);

  // The sample holiday: a Wednesday about six weeks back, this year (or,
  // early in January, three weeks ahead).
  let holiday = day(-6, 2);
  if (yearOf(holiday) !== thisYear) holiday = day(3, 2);

  // Everyone gets their class's default policy (store.CLASS_DEFAULTS):
  // employees unlimited, Casey a monthly contractor (10 SMTO, 5 sick), Riley
  // an hourly contractor (15 SMTO, no sick time). Both contractors work the
  // company holidays.
  const people = {
    morgan: { name: "Sample Morgan Lee", email: "sample.morgan.lee@example.com", role: "manager", team: "Support" },
    priya: { name: "Sample Priya Shah", email: "sample.priya.shah@example.com", role: "manager", team: "Operations" },
    alex: { name: "Sample Alex Rivera", email: "sample.alex.rivera@example.com", manager: "morgan", team: "Support" },
    jamie: { name: "Sample Jamie Chen", email: "sample.jamie.chen@example.com", manager: "morgan", team: "Support", pay_basis: "hourly", hours_per_day: 7 },
    casey: { name: "Sample Casey Morgan", email: "sample.casey.morgan@example.com", manager: "morgan", team: "Support", worker_type: "contractor", pay_basis: "monthly" },
    taylor: { name: "Sample Taylor Brooks", email: "sample.taylor.brooks@example.com", manager: "priya", team: "Operations", start_date: `${thisYear - 1}-01-01` },
    jordan: { name: "Sample Jordan Kim", email: "sample.jordan.kim@example.com", manager: "priya", team: "Operations" },
    riley: { name: "Sample Riley Park", email: "sample.riley.park@example.com", manager: "priya", team: "Operations", worker_type: "contractor", pay_basis: "hourly", hours_per_day: 8 },
  };

  const A = "approved";
  const requests = [
    // 1. Thursday to the next week's Friday, over a weekend and the holiday: 6 days.
    { key: "holiday_span", who: "alex", kind: "pto", status: A, start: addDays(holiday, -6), end: addDays(holiday, 2) },
    // 2. One day, both half-day boxes: 0.5.
    { key: "half_day", who: "jordan", kind: "pto", status: A, start: day(-8, 1), end: day(-8, 1), half_day_start: true, half_day_end: true },
    // 3. Across the last New Year: some days in each year.
    { key: "new_year", who: "taylor", kind: "pto", status: A, start: `${thisYear - 1}-12-29`, end: `${thisYear}-01-02` },
    // 4. Waiting, and more than Riley has: 15 a year, this asks for 20
    //    (a contractor: the weekdays only, holidays count).
    { key: "overdraw", who: "riley", kind: "pto", status: "pending", start: day(1, 0), end: addDays(day(1, 0), 25) },
    // 5. The hourly contractor across the holiday, which he works: 3 days, 24 hours.
    { key: "contractor", who: "riley", kind: "pto", status: A, start: addDays(holiday, -1), end: addDays(holiday, 1) },
    // 6. Monday to Thursday, but Jamie typed 2 days.
    { key: "override", who: "jamie", kind: "pto", status: A, start: day(-7, 0), end: day(-7, 3), days_requested: 2 },
    // 7. Denied, with a note.
    { key: "denied", who: "casey", kind: "pto", status: "denied", start: day(-10, 0), end: day(-10, 2), decision_note: "We are short-staffed that week. Could you pick the week after?" },
    // 8. Approved, then cancelled.
    { key: "cancelled", who: "alex", kind: "pto", status: "cancelled", start: day(-20, 1), end: day(-20, 2) },
    // Waiting on a sample manager (two) and on the admins (Priya has no manager).
    { key: "waiting_1", who: "alex", kind: "pto", status: "pending", start: day(3, 0), end: day(3, 1), approver: "morgan" },
    { key: "waiting_2", who: "jamie", kind: "sick", status: "pending", start: day(2, 2), end: day(2, 2), approver: "morgan" },
    { key: "waiting_admins", who: "priya", kind: "pto", status: "pending", start: day(4, 0), end: day(4, 4) },
    // Sick, LOA and Unpaid Time.
    { key: "sick", who: "jamie", kind: "sick", status: A, start: day(-12, 1), end: day(-12, 2) },
    { key: "loa", who: "taylor", kind: "loa", status: A, start: day(-16, 0), end: day(-16, 4), note: "Family leave" },
    { key: "unpaid", who: "casey", kind: "unpaid", status: A, start: day(-14, 3), end: day(-14, 4) },
    // The rest of the year, spread out.
    { who: "alex", kind: "pto", status: A, start: day(-30, 0), end: day(-30, 4) },
    { who: "alex", kind: "sick", status: A, start: day(-25, 2), end: day(-25, 2) },
    { who: "jamie", kind: "pto", status: A, start: day(-30, 1), end: day(-30, 3) },
    { who: "jamie", kind: "pto", status: A, start: day(-18, 0), end: day(-18, 1) },
    { who: "casey", kind: "pto", status: A, start: day(-34, 0), end: day(-34, 4) },
    { who: "casey", kind: "sick", status: A, start: day(-4, 0), end: day(-4, 0) },
    { who: "taylor", kind: "pto", status: A, start: day(-26, 1), end: day(-26, 3) },
    { who: "taylor", kind: "sick", status: A, start: day(-9, 4), end: day(-9, 4) },
    { who: "jordan", kind: "pto", status: A, start: day(-28, 0), end: day(-28, 4) },
    { who: "jordan", kind: "sick", status: A, start: day(-15, 1), end: day(-15, 1) },
    { who: "morgan", kind: "pto", status: A, start: day(-22, 0), end: day(-22, 4) },
    { who: "priya", kind: "pto", status: A, start: day(-32, 2), end: day(-32, 4) },
    { who: "priya", kind: "sick", status: A, start: day(-3, 1), end: day(-3, 1) },
    { who: "riley", kind: "pto", status: A, start: day(-24, 0), end: day(-24, 2) },
    { who: "riley", kind: "unpaid", status: A, start: day(-38, 0), end: day(-38, 1) },
    { who: "taylor", kind: "pto", status: A, start: day(2, 0), end: day(2, 1) },
    { who: "casey", kind: "pto", status: "denied", start: day(-2, 0), end: day(-2, 0), decision_note: "Month-end close." },
  ];
  return { holiday: { date: holiday, name: `${SAMPLE_PREFIX}Founders Day` }, people, requests, startDate: `${thisYear}-01-01` };
}

/** Is the sample set there? */
export const sampleCount = (db) => Number(db.prepare("SELECT count(*) AS n FROM people WHERE sample = 1").get().n);

/** Add the sample set. Returns what was added, or { added: false } when it is already there. */
export function addSample(db, { now = new Date(), timezone = "America/New_York" } = {}) {
  if (sampleCount(db)) return { added: false, reason: "The sample data is already there." };
  const today = isoToday(now, timezone);
  const plan = samplePlan(today);
  return transaction(db, () => {
    const at = nowIso(now);
    // The holiday: moved a week at a time off any date already taken or
    // covered by someone real's live request, so real balances never change.
    let date = plan.holiday.date;
    const taken = (candidate) => db.prepare("SELECT 1 FROM holidays WHERE date = ?").get(candidate)
      || db.prepare("SELECT 1 FROM requests JOIN people ON people.id = requests.person_id WHERE people.sample = 0 AND requests.status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?").get(candidate, candidate);
    for (let tries = 0; tries < 10 && taken(date); tries += 1) date = addDays(date, 7);
    db.prepare("INSERT INTO holidays (date, name) VALUES (?, ?)").run(date, plan.holiday.name);
    const holidays = store.holidaySet(db);
    if (date !== plan.holiday.date) {
      // The spans that were built around the holiday follow it.
      const shift = (Date.parse(date) - Date.parse(plan.holiday.date)) / 86_400_000;
      for (const row of plan.requests.filter((item) => item.key === "holiday_span" || item.key === "contractor")) {
        row.start = addDays(row.start, shift);
        row.end = addDays(row.end, shift);
      }
    }

    const ids = {};
    for (const [key, person] of Object.entries(plan.people)) {
      ids[key] = newId("per");
      db.prepare(`INSERT INTO people (id, email, name, role, worker_type, manager_id, active, timezone, pay_basis, hours_per_day, team, created_at, enrolled_via, sample)
                  VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, 'admin', 1)`)
        .run(ids[key], person.email, person.name, person.role || "employee", person.worker_type || "employee", timezone, person.pay_basis || "monthly", person.hours_per_day || 8, person.team, at);
    }
    for (const [key, person] of Object.entries(plan.people)) {
      if (person.manager) db.prepare("UPDATE people SET manager_id = ? WHERE id = ?").run(ids[person.manager], ids[key]);
      const cls = classOf({ worker_type: person.worker_type || "employee", pay_basis: person.pay_basis || "monthly" });
      store.writePolicy(db, ids[key], { ...store.CLASS_DEFAULTS[cls], start_date: person.start_date || plan.startDate });
    }
    db.prepare("INSERT INTO adjustments (id, person_id, year, days, note, actor_id, created_at, kind) VALUES (?, ?, ?, ?, ?, NULL, ?, 'sick')")
      .run(newId("adj"), ids.casey, yearOf(today), 1, "Sample: worked a holiday", at);

    const made = {};
    for (const row of plan.requests) {
      const person = plan.people[row.who];
      const overridden = row.days_requested !== undefined;
      // Contractors work the company holidays: nothing taken out of their count.
      const theirs = person.worker_type === "contractor" ? new Set() : holidays;
      const counted = requestDayWeights({ start_date: row.start, end_date: row.end, half_day_start: row.half_day_start, half_day_end: row.half_day_end, days: overridden ? row.days_requested : null, days_overridden: overridden }, theirs);
      const id = newId("req");
      const decided = row.status === "approved" || row.status === "denied" || row.status === "cancelled";
      const decider = person.manager ? ids[person.manager] : ids.morgan;
      db.prepare(`INSERT INTO requests (id, person_id, kind, status, start_date, end_date, half_day_start, half_day_end, days, days_computed, days_overridden, hours, approver_id,
                                        note, decided_by, decided_at, decision_note, calendar_state, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`)
        .run(id, ids[row.who], row.kind, row.status, row.start, row.end, row.half_day_start ? 1 : 0, row.half_day_end ? 1 : 0, counted.days, counted.computed, overridden ? 1 : 0,
          round2(counted.days * (person.hours_per_day || 8)), row.approver ? ids[row.approver] : person.manager ? ids[person.manager] : null,
          row.note || "", decided ? decider : null, decided ? at : null, row.decision_note || "", at, at);
      if (row.key) made[row.key] = id;
    }
    store.audit(db, { action: "sample.added", subject: "sample", detail: `Sample data added: ${Object.keys(ids).length} people, ${plan.requests.length} requests, 1 holiday.` });
    return { added: true, people: Object.keys(ids).length, requests: plan.requests.length, holiday: date, ids, requests_by_case: made };
  });
}

/** Remove everything --add made. Returns how much was removed. */
export function removeSample(db) {
  return transaction(db, () => {
    const people = db.prepare("SELECT id FROM people WHERE sample = 1").all().map((row) => row.id);
    if (!people.length && !db.prepare("SELECT 1 FROM holidays WHERE name LIKE ?").get(`${SAMPLE_PREFIX}%`)) return { removed: false, reason: "There is no sample data." };
    const marks = people.map(() => "?").join(", ") || "''";
    const requests = people.length ? db.prepare(`SELECT id FROM requests WHERE person_id IN (${marks})`).all(...people).map((row) => row.id) : [];
    const subjects = [...people, ...requests];
    const subjectMarks = subjects.map(() => "?").join(", ") || "''";
    const counts = {
      audit: db.prepare(`DELETE FROM audit WHERE action = 'sample.added' OR actor_id IN (${marks}) OR subject IN (${subjectMarks})`).run(...people, ...subjects).changes,
      decide_links: requests.length ? db.prepare(`DELETE FROM decide_links WHERE request_id IN (${requests.map(() => "?").join(", ")})`).run(...requests).changes : 0,
      sessions: db.prepare(`DELETE FROM sessions WHERE person_id IN (${marks})`).run(...people).changes,
      // Real requests that named a sample person as approver keep going to the admins.
      approver_refs: db.prepare(`UPDATE requests SET approver_id = NULL WHERE approver_id IN (${marks}) AND person_id NOT IN (${marks})`).run(...people, ...people).changes,
      requests: db.prepare(`DELETE FROM requests WHERE person_id IN (${marks})`).run(...people).changes,
      adjustments: db.prepare(`DELETE FROM adjustments WHERE person_id IN (${marks})`).run(...people).changes,
      policies: db.prepare(`DELETE FROM policies WHERE person_id IN (${marks})`).run(...people).changes,
    };
    // The sample holiday goes, and any real request across it is recounted
    // the way PUT /api/holidays recounts (the date is a working day again).
    const sampleHolidays = db.prepare("SELECT date FROM holidays WHERE name LIKE ?").all(`${SAMPLE_PREFIX}%`).map((row) => row.date);
    counts.holidays = db.prepare("DELETE FROM holidays WHERE name LIKE ?").run(`${SAMPLE_PREFIX}%`).changes;
    counts.recounted = sampleHolidays.reduce((sum, date) => sum + store.recountDays(db, { from: date, to: date }), 0);
    // Anyone real who was put under a sample manager loses that manager.
    db.prepare(`UPDATE people SET manager_id = NULL WHERE manager_id IN (${marks}) AND sample = 0`).run(...people);
    db.prepare(`UPDATE requests SET decided_by = NULL WHERE decided_by IN (${marks})`).run(...people);
    db.prepare(`UPDATE adjustments SET actor_id = NULL WHERE actor_id IN (${marks})`).run(...people);
    db.prepare(`UPDATE people SET manager_id = NULL WHERE sample = 1`).run();
    counts.people = db.prepare("DELETE FROM people WHERE sample = 1").run().changes;
    store.audit(db, { action: "sample.removed", subject: "sample", detail: `Sample data removed: ${counts.people} people, ${counts.requests} requests, ${counts.holidays} holiday.` });
    return { removed: true, ...counts };
  });
}

/**
 * The line --add prints while nobody real is an admin yet: the first
 * sign-in still makes BOOTSTRAP_ADMIN_EMAIL the admin (sample people do not
 * count), so seeding first is fine. Null once a real admin exists.
 */
export function noAdminReminder(db) {
  if (db.prepare("SELECT 1 FROM people WHERE sample = 0 AND role = 'admin' AND active = 1").get()) return null;
  return "No admin yet: sign in as BOOTSTRAP_ADMIN_EMAIL to become the first admin (the sample people do not get in the way).";
}

const runDirectly = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url; } catch { return false; }
})();
if (runDirectly) {
  const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const add = process.argv.includes("--add");
  const remove = process.argv.includes("--remove");
  if (add === remove) {
    console.log("Use --add or --remove (and --data <DATA_DIR> if it is not data/).");
    process.exit(2);
  }
  const dataDir = arg("data") || process.env.DATA_DIR || "data";
  const db = openDb(process.env.DB_FILE || path.join(dataDir, "timeoff.sqlite"));
  try {
    const result = add ? addSample(db, { timezone: process.env.DEFAULT_TIMEZONE || "America/New_York" }) : removeSample(db);
    const { ids, ...printable } = result;
    console.log(JSON.stringify(printable, null, 2));
    const reminder = add ? noAdminReminder(db) : null;
    if (reminder) console.log(reminder);
  } finally {
    db.close();
  }
}
