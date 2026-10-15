// scripts/seed-sample.mjs: the demo set goes in, shows each edge case, and
// comes out again leaving the database exactly as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../server/db.mjs";
import { addSample, removeSample, sampleCount } from "../scripts/seed-sample.mjs";
import { computeBalances } from "../server/domain/balance.mjs";
import { addDays, workingDays } from "../server/domain/dates.mjs";
import { monthlyReport } from "../server/reports.mjs";
import * as store from "../server/store.mjs";

const TABLES = ["people", "policies", "requests", "adjustments", "holidays", "sessions", "decide_links"];
const counts = (db) => Object.fromEntries(TABLES.map((table) => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]));

test("add, then remove: every table back to where it was; add twice adds once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-sample-"));
  const db = openDb(path.join(dir, "timeoff.sqlite"));
  try {
    // Something real already there, which must come through untouched.
    db.prepare("INSERT INTO people (id, email, name, role, worker_type, active, timezone, created_at) VALUES ('per_real00000000000001', 'real@example.com', 'Real Person', 'admin', 'employee', 1, 'UTC', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO holidays (date, name) VALUES ('2026-07-03', 'Independence Day (observed)')").run();
    const before = counts(db);
    const added = addSample(db, { now: new Date("2026-10-14T15:00:00Z") });
    assert.equal(added.added, true);
    assert.equal(added.people, 8);
    assert.ok(added.requests >= 30);
    assert.equal(sampleCount(db), 8);
    assert.deepEqual(addSample(db).added, false);
    assert.equal(counts(db).people, before.people + 8);
    // Statuses: all four are there.
    const statuses = new Set(db.prepare("SELECT status FROM requests").all().map((row) => row.status));
    assert.deepEqual([...statuses].sort(), ["approved", "cancelled", "denied", "pending"]);
    // Nothing went out.
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM requests WHERE calendar_state != 'none' OR slack_ts IS NOT NULL").get().n), 0);
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'sample.added'").get());

    const removed = removeSample(db);
    assert.equal(removed.removed, true);
    assert.deepEqual(counts(db), before);
    assert.equal(db.prepare("SELECT name FROM people").get().name, "Real Person");
    assert.equal(db.prepare("SELECT name FROM holidays").get().name, "Independence Day (observed)");
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'sample.removed'").get());
    assert.equal(db.prepare("SELECT 1 FROM audit WHERE action = 'sample.added'").get(), undefined);
    assert.equal(removeSample(db).removed, false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the edge cases come to the right numbers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-sample-"));
  const db = openDb(path.join(dir, "timeoff.sqlite"));
  try {
    const { requests_by_case: cases, ids } = addSample(db, { now: new Date("2026-10-14T15:00:00Z") });
    const row = (key) => store.requestRow(db, cases[key]);
    const holidays = store.holidaySet(db);

    // 1. Over a weekend and the holiday: 6 of the 9 dates; 7 without the holiday.
    const span = row("holiday_span");
    assert.equal(span.days, 6);
    assert.equal(workingDays({ start_date: span.start_date, end_date: span.end_date }).days, 7);

    // 2. Both half-day boxes on one day: 0.5, and the report says so.
    const half = row("half_day");
    assert.equal(half.days, 0.5);
    const halfMonth = monthlyReport(db, { year: Number(half.start_date.slice(0, 4)), month: Number(half.start_date.slice(5, 7)) });
    const jordan = halfMonth.teams.flatMap((team) => team.people).find((person) => person.id === ids.jordan);
    assert.equal(jordan.pto, 0.5);

    // 3. Across New Year: charged to both years' balances.
    const newYear = row("new_year");
    const split = workingDays({ start_date: newYear.start_date, end_date: newYear.end_date, holidays }).byYear;
    assert.equal(Object.keys(split).length, 2);
    const taylor = store.personRow(db, ids.taylor);
    const lastYear = Number(newYear.start_date.slice(0, 4));
    const last = store.balanceFor(db, taylor, { year: lastYear, today: `${lastYear}-12-31` }).pto;
    const ours = store.balanceFor(db, taylor, { year: lastYear + 1, today: "2026-10-14" }).pto;
    assert.equal(last.used, split[lastYear]);
    assert.ok(ours.used >= split[lastYear + 1]);
    // Employees are unlimited: days used counted, nothing available.
    assert.deepEqual([ours.unlimited, ours.available, ours.allowance], [true, null, null]);

    // 4. Pending, and more than Riley (an hourly contractor, 15 a year) has.
    const overdraw = row("overdraw");
    const rileyBalance = store.balanceFor(db, store.personRow(db, ids.riley), { year: Number(overdraw.start_date.slice(0, 4)), today: overdraw.start_date }).pto;
    assert.equal(overdraw.status, "pending");
    assert.equal(rileyBalance.unlimited, false);
    assert.ok(rileyBalance.available < 0, `available ${rileyBalance.available}`);

    // 5. The hourly contractor across the holiday he works: 3 days, 24 hours,
    //    and the class default policy (15 SMTO, no sick time, holidays counted).
    const contractor = row("contractor");
    assert.deepEqual([contractor.kind, contractor.days, contractor.hours], ["pto", 3, 24]);
    assert.deepEqual(store.policyFor(db, ids.riley), { annual_days: 15, accrual: "front_loaded", carryover_cap: 0, start_date: "2026-01-01", sick_days: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false });
    assert.deepEqual(store.policyFor(db, ids.casey), { annual_days: 10, accrual: "front_loaded", carryover_cap: 0, start_date: "2026-01-01", sick_days: 5, pto_unlimited: false, sick_unlimited: false, holidays_apply: false });

    // 6. Typed days: 2 apply, 4 counted, and the report counts 2.
    const override = row("override");
    assert.deepEqual([override.days, override.days_computed, override.days_overridden, override.hours], [2, 4, 1, 14]);
    const overrideMonth = monthlyReport(db, { year: Number(override.start_date.slice(0, 4)), month: Number(override.start_date.slice(5, 7)) });
    const jamie = overrideMonth.teams.flatMap((team) => team.people).find((person) => person.id === ids.jamie);
    assert.equal(jamie.pto, 2);
    assert.equal(jamie.hours, 14 + 7 * jamie.sick + 7 * jamie.unpaid + 7 * jamie.loa);

    // 7 and 8.
    assert.deepEqual([row("denied").status, Boolean(row("denied").decision_note)], ["denied", true]);
    assert.equal(row("cancelled").status, "cancelled");
    // Waiting on a sample manager, and on the admins.
    assert.equal(row("waiting_1").approver_id, ids.morgan);
    assert.equal(row("waiting_admins").approver_id, null);
    assert.equal(store.personRow(db, ids.priya).manager_id, null);
    // Every type shows up.
    const kinds = new Set(db.prepare("SELECT kind FROM requests").all().map((item) => item.kind));
    assert.deepEqual([...kinds].sort(), ["loa", "pto", "sick", "unpaid"]);
    // A sick adjustment lands on sick (Casey, a monthly contractor).
    const balances = computeBalances({ policy: store.policyFor(db, ids.casey), year: 2026, today: "2026-10-14", requests: store.requestsFor(db, ids.casey), adjustments: store.adjustmentsFor(db, ids.casey), holidays: new Set() });
    assert.equal(balances.sick.adjustments, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing the sample holiday recounts real requests that spanned it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-sample-"));
  const db = openDb(path.join(dir, "timeoff.sqlite"));
  try {
    db.prepare("INSERT INTO people (id, email, name, role, worker_type, active, timezone, hours_per_day, created_at) VALUES ('per_real00000000000001', 'real@example.com', 'Real Person', 'admin', 'employee', 1, 'UTC', 8, '2026-01-01T00:00:00Z')").run();
    const { holiday } = addSample(db, { now: new Date("2026-10-14T15:00:00Z") });
    // A real request made while the sample holiday was on the calendar: Mon to Fri of that week, 4 days.
    const monday = addDays(holiday, -2);
    db.prepare(`INSERT INTO requests (id, person_id, kind, status, start_date, end_date, days, days_computed, hours, calendar_state, created_at, updated_at)
                VALUES ('req_real0000000000001', 'per_real00000000000001', 'pto', 'approved', ?, ?, 4, 4, 32, 'none', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(monday, addDays(monday, 4));
    const removed = removeSample(db);
    assert.equal(removed.recounted, 1);
    const row = store.requestRow(db, "req_real0000000000001");
    assert.deepEqual([row.days, row.days_computed, row.hours], [5, 5, 40]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
