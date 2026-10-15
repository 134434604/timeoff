// Classes (employee, monthly contractor, hourly contractor): default
// policies, unlimited balances, holidays as working days, the Types each
// class is offered, Home's team summary, and the migration that kept
// existing policies as they were.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeBalances } from "../server/domain/balance.mjs";
import { addDays, isoToday, weekday, workingDays } from "../server/domain/dates.mjs";
import { openDb } from "../server/db.mjs";
import { monthlyReport } from "../server/reports.mjs";
import * as store from "../server/store.mjs";

process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

// ------------------------------------------------------------------ units --

test("an unlimited balance has no allowance or available, but counts used and waiting", () => {
  const policy = { annual_days: 0, accrual: "front_loaded", carryover_cap: 0, start_date: "2026-01-01", sick_days: 0, pto_unlimited: true, sick_unlimited: false, holidays_apply: true };
  const requests = [
    { kind: "pto", status: "approved", start_date: "2026-03-02", end_date: "2026-03-04" },
    { kind: "pto", status: "pending", start_date: "2026-04-06", end_date: "2026-04-06" },
  ];
  const { pto, sick } = computeBalances({ policy, year: 2026, today: "2026-07-01", requests });
  assert.deepEqual(pto, { unit: "days", year: 2026, allowance: null, accrued: null, carried_over: 0, adjustments: 0, used: 3, pending: 1, available: null, tracked: true, unlimited: true });
  assert.deepEqual([sick.tracked, sick.unlimited], [false, false]);
});

test("migration 10 keeps existing policies: numbers, limited, holidays taken out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-classes-migrate-"));
  const file = path.join(dir, "timeoff.sqlite");
  try {
    let db = openDb(file);
    db.prepare("INSERT INTO people (id, email, name, role, worker_type, active, timezone, created_at) VALUES ('per_old000000000000001', 'old.timer@example.com', 'Old Timer', 'employee', 'contractor', 1, 'UTC', '2025-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO policies (person_id, annual_days, accrual, carryover_cap, start_date, sick_days, updated_at) VALUES ('per_old000000000000001', 12, 'monthly', 3, '2025-01-01', 4, '2025-01-01T00:00:00Z')").run();
    const version = Number(db.prepare("SELECT version FROM schema_version WHERE id = 1").get().version);
    db.close();
    // Back to the schema before migration 10.
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE policies DROP COLUMN pto_unlimited; ALTER TABLE policies DROP COLUMN sick_unlimited; ALTER TABLE policies DROP COLUMN holidays_apply;");
    raw.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(version - 1);
    raw.close();
    db = openDb(file);
    assert.equal(Number(db.prepare("SELECT version FROM schema_version WHERE id = 1").get().version), version);
    assert.deepEqual(store.policyFor(db, "per_old000000000000001"), { annual_days: 12, accrual: "monthly", carryover_cap: 3, start_date: "2025-01-01", sick_days: 4, pto_unlimited: false, sick_unlimited: false, holidays_apply: true });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- HTTP --

const ADMIN = "admin@example.com";
let app;
let dataDir;
const people = {};
const sessions = {};
let MONDAY = addDays(isoToday(new Date()), 60);
while (weekday(MONDAY) !== 1) MONDAY = addDays(MONDAY, 1);
const week = (n, length = 5) => ({ start_date: addDays(MONDAY, 7 * n), end_date: addDays(MONDAY, 7 * n + length - 1) });
// The company holiday: Wednesday of week 2.
const HOLIDAY = addDays(MONDAY, 16);

async function call(method, route, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(route, app.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, location: response.headers.get("location") };
}

async function signIn(email) {
  const start = await call("GET", "/api/auth/google/start");
  const state = new URL(start.location, app.url).searchParams.get("state");
  const response = await fetch(new URL(`/api/auth/google/callback?${new URLSearchParams({ state, code: "fixture", email })}`, app.url), { headers: { cookie: `timeoff_oauth=${state}` }, redirect: "manual" });
  return response.headers.getSetCookie().map((line) => line.split(";")[0]).find((pair) => /^timeoff_session=[a-f0-9]{64}$/.test(pair));
}

const listed = async (id) => (await call("GET", "/api/people", { cookie: sessions.admin })).json.people.find((row) => row.id === id);
const auditFor = (subject, action) => app.db.prepare("SELECT detail FROM audit WHERE subject = ? AND action = ?").all(subject, action).map((row) => row.detail);
const EMPLOYEE_DEFAULT = { annual_days: 0, accrual: "front_loaded", carryover_cap: 0, sick_days: 0, pto_unlimited: true, sick_unlimited: true, holidays_apply: true };
const MONTHLY_DEFAULT = { annual_days: 10, accrual: "front_loaded", carryover_cap: 0, sick_days: 5, pto_unlimited: false, sick_unlimited: false, holidays_apply: false };
const HOURLY_DEFAULT = { annual_days: 15, accrual: "front_loaded", carryover_cap: 0, sick_days: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false };
const withoutStart = (policy) => {
  const { start_date: _start, ...rest } = policy;
  return rest;
};

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "timeoff-classes-"));
  app = await startServer({ port: 0, host: "127.0.0.1", env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", DATA_DIR: dataDir, BOOTSTRAP_ADMIN_EMAIL: ADMIN } });
  sessions.admin = await signIn(ADMIN);
  const add = async (body) => (await call("POST", "/api/people", { cookie: sessions.admin, body })).json.person;
  people.mo = await add({ email: "mo.manager@example.com", name: "Mo Manager", role: "manager", worker_type: "employee" });
  people.nia = await add({ email: "nia.manager@example.com", name: "Nia Manager", role: "manager", worker_type: "employee" });
  people.em = await add({ email: "em.employee@example.com", name: "Em Employee", role: "employee", worker_type: "employee", pay_basis: "hourly", manager_id: people.mo.id });
  people.cora = await add({ email: "cora.monthly@example.com", name: "Cora Monthly", role: "employee", worker_type: "contractor", pay_basis: "monthly", manager_id: people.mo.id });
  people.hal = await add({ email: "hal.hourly@example.com", name: "Hal Hourly", role: "employee", worker_type: "contractor", pay_basis: "hourly", manager_id: people.mo.id });
  people.ned = await add({ email: "ned.other@example.com", name: "Ned Other", role: "employee", worker_type: "employee", manager_id: people.nia.id });
  const year = Number(HOLIDAY.slice(0, 4));
  assert.equal((await call("PUT", "/api/holidays", { cookie: sessions.admin, body: { year, holidays: [{ date: HOLIDAY, name: "Founders Day" }] } })).status, 200);
  for (const key of ["mo", "nia", "em", "cora", "hal", "ned"]) sessions[key] = await signIn(people[key].email);
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("class defaults on create: employees unlimited, contractors 10/5 or 15/0 with holidays as working days; audited", async () => {
  assert.deepEqual([people.em.class, people.cora.class, people.hal.class], ["employee", "contractor_monthly", "contractor_hourly"]);
  assert.deepEqual(withoutStart((await listed(people.em.id)).policy), EMPLOYEE_DEFAULT);
  assert.deepEqual(withoutStart((await listed(people.cora.id)).policy), MONTHLY_DEFAULT);
  assert.deepEqual(withoutStart((await listed(people.hal.id)).policy), HOURLY_DEFAULT);
  // The first admin, made at sign-in, is an employee too.
  const admin = (await call("GET", "/api/me", { cookie: sessions.admin })).json.person;
  assert.equal(admin.class, "employee");
  assert.deepEqual(withoutStart((await listed(admin.id)).policy), EMPLOYEE_DEFAULT);
  assert.equal(auditFor(people.hal.id, "policy.class_default").length, 1);
  assert.match(auditFor(people.hal.id, "policy.class_default")[0], /contractor_hourly/);
  // Contractor balances are tracked and limited; an employee's are unlimited.
  const cora = (await listed(people.cora.id)).balance;
  assert.deepEqual([cora.pto.tracked, cora.pto.unlimited, cora.sick.tracked, cora.sick.unlimited], [true, false, true, false]);
  const hal = (await listed(people.hal.id)).balance;
  assert.deepEqual([hal.pto.tracked, hal.sick.tracked], [true, false]);
  const em = (await listed(people.em.id)).balance;
  assert.deepEqual([em.pto.unlimited, em.pto.available, em.sick.unlimited, em.sick.available], [true, null, true, null]);
});

test("a class change resets the policy to the new class's default unless keep_policy", async () => {
  const flip = (await call("POST", "/api/people", { cookie: sessions.admin, body: { email: "flip.flop@example.com", name: "Flip Flop", role: "employee", worker_type: "contractor", pay_basis: "monthly" } })).json.person;
  // Monthly to hourly contractor: the hourly default.
  const toHourly = await call("PATCH", `/api/people/${flip.id}`, { cookie: sessions.admin, body: { pay_basis: "hourly" } });
  assert.equal(toHourly.json.person.class, "contractor_hourly");
  assert.deepEqual(withoutStart((await listed(flip.id)).policy), HOURLY_DEFAULT);
  // To employee, keeping the policy: unchanged, and the keep is audited.
  const kept = await call("PATCH", `/api/people/${flip.id}`, { cookie: sessions.admin, body: { worker_type: "employee", keep_policy: true } });
  assert.equal(kept.json.person.class, "employee");
  assert.deepEqual(withoutStart((await listed(flip.id)).policy), HOURLY_DEFAULT);
  assert.equal(auditFor(flip.id, "policy.kept").length, 1);
  // An admin's own numbers, then a pay basis change inside the employee class: kept.
  await call("PUT", `/api/people/${flip.id}/policy`, { cookie: sessions.admin, body: { annual_days: 20, accrual: "monthly", carryover_cap: 2, sick_days: 3, start_date: "2026-01-01" } });
  await call("PATCH", `/api/people/${flip.id}`, { cookie: sessions.admin, body: { pay_basis: "monthly" } });
  assert.equal((await listed(flip.id)).policy.annual_days, 20);
  // Employee to contractor: the monthly default, audited (create, hourly, monthly).
  await call("PATCH", `/api/people/${flip.id}`, { cookie: sessions.admin, body: { worker_type: "contractor" } });
  assert.deepEqual(withoutStart((await listed(flip.id)).policy), MONTHLY_DEFAULT);
  assert.equal(auditFor(flip.id, "policy.class_default").length, 3);
});

test("PUT policy takes the three switches; left out, limited with holidays taken out; anything but a boolean is refused", async () => {
  const pat = (await call("POST", "/api/people", { cookie: sessions.admin, body: { email: "pat.policy@example.com", name: "Pat Policy", role: "employee", worker_type: "employee" } })).json.person;
  const base = { annual_days: 12, accrual: "front_loaded", carryover_cap: 0, sick_days: 4, start_date: "2026-01-01" };
  const bad = await call("PUT", `/api/people/${pat.id}/policy`, { cookie: sessions.admin, body: { ...base, pto_unlimited: "yes" } });
  assert.equal(bad.json.error.code, "invalid_policy_flag");
  const plain = await call("PUT", `/api/people/${pat.id}/policy`, { cookie: sessions.admin, body: base });
  assert.deepEqual([plain.json.balance.pto.unlimited, plain.json.balance.sick.unlimited], [false, false]);
  assert.deepEqual(withoutStart((await listed(pat.id)).policy), { ...withoutStart(base), pto_unlimited: false, sick_unlimited: false, holidays_apply: true });
  const open = await call("PUT", `/api/people/${pat.id}/policy`, { cookie: sessions.admin, body: { ...base, sick_unlimited: true, holidays_apply: false } });
  assert.deepEqual([open.json.balance.pto.unlimited, open.json.balance.sick.unlimited, open.json.balance.sick.available], [false, true, null]);
  assert.equal((await listed(pat.id)).policy.holidays_apply, false);
});

test("Types per class: /api/me lists them; an hourly contractor is refused Sick, and nobody gets Unavailable", async () => {
  assert.deepEqual((await call("GET", "/api/me", { cookie: sessions.em })).json.kinds, ["pto", "sick", "unpaid", "loa"]);
  assert.deepEqual((await call("GET", "/api/me", { cookie: sessions.cora })).json.kinds, ["pto", "sick", "unpaid", "loa"]);
  assert.deepEqual((await call("GET", "/api/me", { cookie: sessions.hal })).json.kinds, ["pto", "unpaid", "loa"]);
  const sick = await call("POST", "/api/requests", { cookie: sessions.hal, body: { ...week(6, 1), kind: "sick" } });
  assert.equal(sick.status, 400);
  assert.equal(sick.json.error.code, "kind_not_offered");
  assert.match(sick.json.error.message, /SMTO, Unpaid Time, LOA/);
  for (const who of ["em", "cora"]) {
    const unavailable = await call("POST", "/api/requests", { cookie: sessions[who], body: { ...week(6, 1), kind: "unavailable" } });
    assert.equal(unavailable.json.error.code, "kind_not_offered", who);
  }
});

test("a contractor's company holiday counts as a working day: preview, submit, holiday changes and reports", async () => {
  const span = week(2);
  // An employee: the holiday is out (4 days) and the preview says so.
  const emPreview = (await call("POST", "/api/requests/preview", { cookie: sessions.em, body: { ...span, kind: "pto" } })).json;
  assert.equal(emPreview.days, 4);
  assert.ok(emPreview.warnings.some((line) => /Founders Day/.test(line)));
  // A contractor works it: 5 days, no holiday warning.
  const coraPreview = (await call("POST", "/api/requests/preview", { cookie: sessions.cora, body: { ...span, kind: "pto" } })).json;
  assert.equal(coraPreview.days, 5);
  assert.equal(coraPreview.warnings.some((line) => /Founders Day/.test(line)), false);
  const emAsk = (await call("POST", "/api/requests", { cookie: sessions.em, body: { ...span, kind: "pto" } })).json.request;
  const coraAsk = (await call("POST", "/api/requests", { cookie: sessions.cora, body: { ...span, kind: "pto" } })).json.request;
  assert.deepEqual([emAsk.days, coraAsk.days], [4, 5]);
  // Removing the holiday recounts only the employee; putting it back, the same.
  const year = Number(HOLIDAY.slice(0, 4));
  await call("PUT", "/api/holidays", { cookie: sessions.admin, body: { year, holidays: [] } });
  assert.deepEqual([store.requestRow(app.db, emAsk.id).days, store.requestRow(app.db, coraAsk.id).days], [5, 5]);
  await call("PUT", "/api/holidays", { cookie: sessions.admin, body: { year, holidays: [{ date: HOLIDAY, name: "Founders Day" }] } });
  assert.deepEqual([store.requestRow(app.db, emAsk.id).days, store.requestRow(app.db, coraAsk.id).days], [4, 5]);
  // Approved, the monthly report counts the holiday for the contractor only
  // (the days of the span in the holiday's month).
  for (const id of [emAsk.id, coraAsk.id]) assert.equal((await call("POST", `/api/requests/${id}/approve`, { cookie: sessions.mo, body: {} })).json.request.status, "approved");
  const month = HOLIDAY.slice(0, 7);
  const report = monthlyReport(app.db, { year, month: Number(HOLIDAY.slice(5, 7)) });
  const row = (id) => report.teams.flatMap((team) => team.people).find((person) => person.id === id);
  const counted = workingDays({ start_date: span.start_date, end_date: span.end_date });
  const inMonth = counted.dates.filter((date) => date.slice(0, 7) === month).length;
  assert.equal(row(people.cora.id).pto, inMonth);
  assert.equal(row(people.em.id).pto, inMonth - 1);
  // The contractor's balance is charged all five days.
  const coraBalance = store.balanceFor(app.db, store.personRow(app.db, people.cora.id), { year: Number(span.start_date.slice(0, 4)), today: span.start_date }).pto;
  assert.equal(coraBalance.used, span.start_date.slice(0, 4) === span.end_date.slice(0, 4) ? 5 : counted.byYear[span.start_date.slice(0, 4)]);
});

test("Home: unlimited balances list the days used this year", async () => {
  const before = (await call("GET", "/api/home", { cookie: sessions.em })).json;
  const year = before.balance.pto.year;
  // Two approved requests early this year, written straight in.
  const at = new Date().toISOString();
  const add = (id, kind, start, end) => {
    const days = workingDays({ start_date: start, end_date: end, holidays: store.holidaySet(app.db) }).days;
    app.db.prepare("INSERT INTO requests (id, person_id, kind, status, start_date, end_date, days, days_computed, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)").run(id, people.em.id, kind, start, end, days, days, at, at);
    return days;
  };
  const ptoDays = add("req_c1a55e5000000000a1", "pto", `${year}-01-05`, `${year}-01-09`);
  const sickDays = add("req_c1a55e5000000000a2", "sick", `${year}-02-03`, `${year}-02-03`);
  const home = (await call("GET", "/api/home", { cookie: sessions.em })).json;
  const { pto, sick } = home.balance;
  assert.deepEqual([pto.unlimited, pto.tracked, pto.allowance, pto.accrued, pto.available], [true, true, null, null, null]);
  assert.equal(pto.used, before.balance.pto.used + ptoDays);
  assert.equal(pto.used_days, undefined);
  assert.deepEqual(home.used_days.pto.find((row) => row.request_id === "req_c1a55e5000000000a1"), { request_id: "req_c1a55e5000000000a1", start_date: `${year}-01-05`, end_date: `${year}-01-09`, days: ptoDays });
  assert.deepEqual(home.used_days.sick, [{ request_id: "req_c1a55e5000000000a2", start_date: `${year}-02-03`, end_date: `${year}-02-03`, days: sickDays }]);
  assert.equal(sick.used, sickDays);
  assert.equal(home.used_days.pto.some((row) => row.request_id === "req_c1a55e5000000000a2"), false);
  assert.equal(home.team, null);
});

test("Approvals: used this year for unlimited people instead of a balance after", async () => {
  const emAsk = (await call("POST", "/api/requests", { cookie: sessions.em, body: { ...week(4), kind: "pto" } })).json.request;
  const coraAsk = (await call("POST", "/api/requests", { cookie: sessions.cora, body: { ...week(4), kind: "unpaid" } })).json.request;
  const halAsk = (await call("POST", "/api/requests", { cookie: sessions.hal, body: { ...week(4), kind: "pto" } })).json.request;
  const items = (await call("GET", "/api/approvals", { cookie: sessions.mo })).json.pending;
  const em = items.find((item) => item.request.id === emAsk.id);
  assert.equal(em.balance_after.pto, null);
  assert.equal(typeof em.used_this_year, "number");
  assert.equal(em.used_this_year, em.balance.pto.used);
  // Limited: a balance after, no used this year. Unpaid draws on nothing.
  const hal = items.find((item) => item.request.id === halAsk.id);
  assert.equal(hal.used_this_year, null);
  assert.equal(typeof hal.balance_after.pto, "number");
  const cora = items.find((item) => item.request.id === coraAsk.id);
  assert.deepEqual([cora.used_this_year, cora.balance_after.pto, cora.balance_after.sick], [null, null, null]);
});

test("Home team summary: a manager sees their team, an admin the company, an employee nothing", async () => {
  const mo = (await call("GET", "/api/home", { cookie: sessions.mo })).json.team;
  assert.deepEqual(mo.month.people.map((row) => row.name).sort(), ["Cora Monthly", "Em Employee", "Hal Hourly", "Mo Manager"]);
  assert.deepEqual(Object.keys(mo).sort(), ["month", "out_next_30", "out_soon", "out_today", "pending", "scope", "unused_pto_total"]);
  assert.equal(mo.scope, "reports");
  // The month is the team calendar's own shape.
  const calendar = (await call("GET", "/api/team/calendar", { cookie: sessions.mo })).json;
  assert.deepEqual(mo.month, calendar);
  // Each person carries their class: the calendar, the monthly report, Insights.
  assert.equal(calendar.people.find((row) => row.name === "Hal Hourly").class, "contractor_hourly");
  const today = isoToday(new Date(), "America/New_York");
  const report = monthlyReport(app.db, { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
  assert.equal(report.teams.flatMap((team) => team.people).find((row) => row.id === people.cora.id).class, "contractor_monthly");
  const insights = (await call("GET", "/api/insights", { cookie: sessions.mo })).json;
  assert.equal(insights.by_person.find((row) => row.id === people.em.id).class, "employee");
  // Out soon: approved, today through 60 days, Mo's team only (the week 2 pair).
  assert.ok(mo.out_soon.every((row) => ["Cora Monthly", "Em Employee", "Hal Hourly", "Mo Manager"].includes(row.name)));
  assert.equal(mo.out_soon.filter((row) => row.start_date === week(2).start_date).length, week(2).start_date <= addDays(isoToday(new Date(), "America/New_York"), 60) ? 2 : 0);
  assert.equal(mo.month.month, isoToday(new Date(), "America/New_York").slice(0, 7));
  assert.equal(mo.pending, (await call("GET", "/api/approvals", { cookie: sessions.mo })).json.pending.length);
  assert.ok(mo.pending >= 3);
  // Only the contractors on Mo's team have a limited SMTO to leave unused.
  const left = (id) => listed(id).then((row) => Math.max(0, row.balance.pto.available));
  assert.equal(mo.unused_pto_total, Math.round(((await left(people.cora.id)) + (await left(people.hal.id))) * 100) / 100);
  const nia = (await call("GET", "/api/home", { cookie: sessions.nia })).json.team;
  assert.deepEqual(nia.month.people.map((row) => row.name).sort(), ["Ned Other", "Nia Manager"]);
  assert.deepEqual([nia.pending, nia.unused_pto_total], [0, 0]);
  const admin = (await call("GET", "/api/home", { cookie: sessions.admin })).json.team;
  assert.equal(admin.scope, "everyone");
  assert.deepEqual(admin.month, (await call("GET", "/api/team/calendar", { cookie: sessions.admin })).json);
  for (const name of ["Cora Monthly", "Em Employee", "Hal Hourly", "Mo Manager", "Ned Other", "Nia Manager"]) assert.ok(admin.month.people.some((row) => row.name === name), name);
  assert.ok(admin.pending >= mo.pending);
  assert.equal((await call("GET", "/api/home", { cookie: sessions.ned })).json.team, null);
});

test("Insights drill-down: month slices, typed and half days, empty months, scope", async () => {
  // Approved requests in 2025, written straight in.
  const at = new Date().toISOString();
  const put = (id, personId, kind, start, end, { days, computed = days, overridden = 0, halfStart = 0, approver = people.mo.id } = {}) => {
    app.db.prepare("INSERT INTO requests (id, person_id, kind, status, start_date, end_date, half_day_start, days, days_computed, days_overridden, approver_id, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, personId, kind, "approved", start, end, halfStart, days, computed, overridden, approver, at, at, at);
  };
  // Mon Jan 27 to Tue Feb 4: 5 days in January, 2 in February.
  put("req_d011d0000000000001", people.em.id, "pto", "2025-01-27", "2025-02-04", { days: 7 });
  // Typed: Mon to Wed counts 3, 1.5 typed. Half day: 0.5.
  put("req_d011d0000000000002", people.cora.id, "pto", "2025-03-10", "2025-03-12", { days: 1.5, computed: 3, overridden: 1 });
  put("req_d011d0000000000003", people.hal.id, "unpaid", "2025-03-17", "2025-03-17", { days: 0.5, halfStart: 1 });
  // Someone outside Mo's team.
  put("req_d011d0000000000004", people.ned.id, "sick", "2025-01-15", "2025-01-15", { days: 1, approver: people.nia.id });
  const drill = async (query, who = "mo") => (await call("GET", `/api/insights/requests?${new URLSearchParams(query)}`, { cookie: sessions[who] })).json;
  const insights = (await call("GET", "/api/insights?year=2025", { cookie: sessions.mo })).json;
  const monthTotal = (key) => {
    const row = insights.by_month.find((item) => item.month === key);
    return Math.round(["pto", "sick", "unpaid", "loa", "unavailable"].reduce((sum, kind) => sum + row[kind], 0) * 100) / 100;
  };

  const jan = await drill({ year: "2025", month: "2025-01" });
  const feb = await drill({ year: "2025", month: "2025-02" });
  const span = (list) => list.requests.find((row) => row.id === "req_d011d0000000000001");
  assert.deepEqual([span(jan).days, span(jan).days_in_window, span(feb).days_in_window], [7, 5, 2]);
  assert.deepEqual(span(jan).person, { id: people.em.id, name: "Em Employee", class: "employee", team: null });
  assert.deepEqual(span(jan).approver, { id: people.mo.id, name: "Mo Manager" });
  assert.equal(jan.total_days, monthTotal("2025-01"));
  assert.equal(feb.total_days, monthTotal("2025-02"));
  // The whole year: the full request, and the sum matches Insights.
  const year = await drill({ year: "2025" });
  assert.equal(span(year).days_in_window, 7);
  assert.equal(year.total_days, Math.round(insights.by_month.reduce((sum, row) => sum + ["pto", "sick", "unpaid", "loa", "unavailable"].reduce((inner, kind) => inner + row[kind], 0), 0) * 100) / 100);
  assert.deepEqual(year.requests.map((row) => row.start_date), [...year.requests.map((row) => row.start_date)].sort().reverse());

  // Typed and half days count as charged, in the list and in Insights.
  const march = await drill({ year: "2025", month: "2025-03" });
  const typed = march.requests.find((row) => row.id === "req_d011d0000000000002");
  const half = march.requests.find((row) => row.id === "req_d011d0000000000003");
  assert.deepEqual([typed.days, typed.days_in_window, half.days, half.days_in_window], [1.5, 1.5, 0.5, 0.5]);
  assert.equal(march.total_days, monthTotal("2025-03"));
  assert.equal(insights.by_month.find((row) => row.month === "2025-03").pto, 1.5);
  // Filters: kind, class, team "" (no team), person.
  assert.deepEqual((await drill({ year: "2025", month: "2025-03", kind: "unpaid" })).requests.map((row) => row.id), ["req_d011d0000000000003"]);
  assert.deepEqual((await drill({ year: "2025", class: "contractor_monthly" })).requests.map((row) => row.id), ["req_d011d0000000000002"]);
  assert.equal((await drill({ year: "2025", team: "", person_id: people.em.id })).total_days, 7);
  assert.deepEqual((await drill({ year: "2025", status: "pending" })).requests, []);

  // An empty month.
  const june = await drill({ year: "2025", month: "2025-06" });
  assert.deepEqual([june.requests, june.total_days], [[], 0]);
  assert.equal(june.filters.month, "2025-06");

  // Scope: Mo never sees Ned; Nia sees only Ned; an admin sees both.
  assert.equal(jan.requests.some((row) => row.person.id === people.ned.id), false);
  assert.deepEqual((await drill({ year: "2025", month: "2025-01" }, "nia")).requests.map((row) => row.id), ["req_d011d0000000000004"]);
  const all = await drill({ year: "2025", month: "2025-01" }, "admin");
  assert.ok(["req_d011d0000000000001", "req_d011d0000000000004"].every((id) => all.requests.some((row) => row.id === id)));
  // Refusals.
  assert.equal((await call("GET", "/api/insights/requests?year=2025&month=2024-01", { cookie: sessions.mo })).json.error.code, "invalid_month");
  assert.equal((await call("GET", "/api/insights/requests", { cookie: sessions.mo })).json.error.code, "invalid_year");
  assert.equal((await call("GET", "/api/insights/requests?year=2025&status=denied", { cookie: sessions.mo })).json.error.code, "invalid_status");
  assert.equal((await call("GET", "/api/insights/requests?year=2025", { cookie: sessions.em })).status, 403);
});

test("Insights drill-down windows match the tiles: today, next 30 days, waiting; rows carry typed days", async () => {
  const today = isoToday(new Date(), "America/New_York");
  const at = new Date().toISOString();
  // Approved from today for nine days (some weekdays in any week), and one
  // starting 20 days out; both inside the next 30 days.
  const put = (id, personId, start, end) => {
    const days = workingDays({ start_date: start, end_date: end, holidays: store.holidaySet(app.db) }).days;
    app.db.prepare("INSERT INTO requests (id, person_id, kind, status, start_date, end_date, days, days_computed, approver_id, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, personId, "pto", "approved", start, end, days, days, people.mo.id, at, at, at);
  };
  put("req_e0d0000000000000a1", people.em.id, today, addDays(today, 8));
  put("req_e0d0000000000000a2", people.cora.id, addDays(today, 20), addDays(today, 22));
  const drill = async (query, who = "mo") => (await call("GET", `/api/insights/requests?${new URLSearchParams(query)}`, { cookie: sessions[who] })).json;
  for (const who of ["mo", "nia", "admin"]) {
    const tiles = (await call("GET", `/api/insights?year=${today.slice(0, 4)}`, { cookie: sessions[who] })).json;
    const now = await drill({ window: "today" }, who);
    const soon = await drill({ window: "next_30" }, who);
    const waiting = await drill({ window: "pending" }, who);
    assert.equal(now.total_people, tiles.out_today, who);
    assert.equal(soon.total_people, tiles.out_next_30, who);
    assert.equal(waiting.total_requests, tiles.pending, who);
    assert.ok(waiting.requests.every((row) => row.status === "pending"));
    assert.equal(soon.filters.from, today);
    assert.equal(soon.filters.to, addDays(today, 30));
  }
  // days_in_window is the part inside the window.
  const soon = await drill({ window: "next_30" });
  const first = soon.requests.find((row) => row.id === "req_e0d0000000000000a1");
  assert.equal(first.days_in_window, first.days);
  assert.ok(soon.requests.some((row) => row.id === "req_e0d0000000000000a2"));
  const now = await drill({ window: "today" });
  const todayRow = now.requests.find((row) => row.id === "req_e0d0000000000000a1");
  if ([0, 6].includes(weekday(today))) assert.equal(todayRow, undefined);
  else assert.equal(todayRow.days_in_window, 1);
  // Waiting: any year, and Nia sees nothing of Mo's team.
  assert.equal((await drill({ window: "pending" }, "nia")).requests.some((row) => row.person.id === people.em.id), false);
  // Refusals: a bad window, and no year without a window.
  assert.equal((await call("GET", "/api/insights/requests?window=soon", { cookie: sessions.mo })).json.error.code, "invalid_window");
  assert.equal((await call("GET", "/api/insights/requests?month=2025-01", { cookie: sessions.mo })).json.error.code, "invalid_year");
  // Rows carry the counted and typed days.
  const typed = (await drill({ year: "2025", month: "2025-03" })).requests.find((row) => row.id === "req_d011d0000000000002");
  assert.deepEqual([typed.days, typed.days_computed, typed.days_overridden], [1.5, 3, true]);
  assert.equal(first.days_overridden, false);
  assert.equal(first.days_computed, first.days);
});

test("the first admin is made at sign-in even when the sample was added first; the seeder reminds until then", async () => {
  const { addSample, noAdminReminder } = await import("../scripts/seed-sample.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-classes-seedfirst-"));
  const outer = app;
  try {
    app = await startServer({ port: 0, host: "127.0.0.1", env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", DATA_DIR: dir, BOOTSTRAP_ADMIN_EMAIL: "first.admin@example.com" } });
    addSample(app.db);
    assert.match(noAdminReminder(app.db), /BOOTSTRAP_ADMIN_EMAIL/);
    const session = await signIn("first.admin@example.com");
    assert.ok(session, "signed in");
    assert.equal((await call("GET", "/api/me", { cookie: session })).json.person.role, "admin");
    assert.equal(noAdminReminder(app.db), null);
    // Once a real person exists, nobody else becomes the first admin.
    assert.equal(await signIn("second.try@example.com"), undefined);
  } finally {
    await app.close();
    app = outer;
    rmSync(dir, { recursive: true, force: true });
  }
  // The command line prints the reminder on an empty database.
  const { spawnSync } = await import("node:child_process");
  const cli = mkdtempSync(path.join(tmpdir(), "timeoff-classes-seedcli-"));
  try {
    const run = spawnSync(process.execPath, ["scripts/seed-sample.mjs", "--add", "--data", cli], { encoding: "utf8", env: { ...process.env, DB_FILE: "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /No admin yet: sign in as BOOTSTRAP_ADMIN_EMAIL/);
  } finally {
    rmSync(cli, { recursive: true, force: true });
  }
});
