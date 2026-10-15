// Sick balance, pay basis and hours, teams, approver choice, the email
// Approve/Deny links, the monthly report and insights.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeBalances } from "../server/domain/balance.mjs";
import { makeDecideToken, readDecideToken, spendDecideToken } from "../server/decide.mjs";
import { maybeSendLastMonth, monthlyReport } from "../server/reports.mjs";
import { balanceFor, personRow } from "../server/store.mjs";
import { addDays, isoToday, weekday } from "../server/domain/dates.mjs";

process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

// ------------------------------------------------------------------ units --

const policy = { annual_days: 10, accrual: "front_loaded", carryover_cap: 5, start_date: "2025-01-01", sick_days: 5 };

test("sick time has its own balance: sick deducts and holds there, pto is untouched", () => {
  const requests = [
    { kind: "sick", status: "approved", start_date: "2026-03-02", end_date: "2026-03-03" },
    { kind: "sick", status: "pending", start_date: "2026-04-06", end_date: "2026-04-06" },
    { kind: "pto", status: "approved", start_date: "2026-05-04", end_date: "2026-05-04" },
    { kind: "unpaid", status: "approved", start_date: "2026-06-01", end_date: "2026-06-05" },
  ];
  const { pto, sick } = computeBalances({ policy, year: 2026, today: "2026-07-01", requests });
  assert.deepEqual([sick.allowance, sick.used, sick.pending, sick.available, sick.carried_over, sick.tracked], [5, 2, 1, 2, 0, true]);
  assert.equal(pto.used, 1);
  assert.equal(pto.available, 14); // 10 + 5 carried from an untouched 2025 - 1
  // Sick time never carries over, and an adjustment lands on its own balance.
  const adjusted = computeBalances({ policy, year: 2026, today: "2026-07-01", requests, adjustments: [{ year: 2026, days: 1, kind: "sick" }] });
  assert.equal(adjusted.sick.available, 3);
  assert.equal(adjusted.pto.available, 14);
});

test("sick time is prorated in the start year; no sick days means untracked", () => {
  const { sick } = computeBalances({ policy: { ...policy, start_date: "2026-07-01", sick_days: 10 }, year: 2026, today: "2026-08-01", requests: [] });
  assert.equal(sick.allowance, 5);
  assert.equal(computeBalances({ policy: { ...policy, sick_days: 0 }, year: 2026, today: "2026-08-01" }).sick.tracked, false);
  assert.equal(computeBalances({ policy: null, year: 2026, today: "2026-08-01" }).sick.tracked, false);
});

test("decide links: short random ids in a table; expiry, single use, nothing else accepted", async () => {
  const { openDb } = await import("../server/db.mjs");
  const db = openDb(":memory:");
  const token = makeDecideToken(db, { requestId: "req_aaaaaaaaaaaaaaaaaa", action: "approve", approverId: "per_bbbbbbbbbbbbbbbbbb" });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(readDecideToken(db, token), { requestId: "req_aaaaaaaaaaaaaaaaaa", action: "approve", approverId: "per_bbbbbbbbbbbbbbbbbb", expired: false, used: false });
  // Only the hash is stored.
  assert.equal(db.prepare("SELECT count(*) AS n FROM decide_links WHERE id_hash = ?").get(token).n, 0);
  // Single use.
  assert.equal(spendDecideToken(db, token), true);
  assert.equal(spendDecideToken(db, token), false);
  assert.equal(readDecideToken(db, token).used, true);
  // Expired after 14 days.
  const old = makeDecideToken(db, { requestId: "req_aaaaaaaaaaaaaaaaaa", action: "deny", approverId: "per_b", now: Date.now() - 15 * 24 * 60 * 60 * 1000 });
  assert.equal(readDecideToken(db, old).expired, true);
  // Unknown ids, wrong shapes and the old long signed format are not links.
  assert.equal(readDecideToken(db, "A".repeat(43)), null);
  assert.equal(readDecideToken(db, token.slice(0, 40)), null);
  assert.equal(readDecideToken(db, `${"x".repeat(120)}.${"y".repeat(43)}`), null);
});

// ------------------------------------------------------------------- HTTP --

const ADMIN = "admin@example.com";
let app;
let dataDir;
const people = {};
const sessions = {};
let MONDAY = addDays(isoToday(new Date()), 60);
while (weekday(MONDAY) !== 1) MONDAY = addDays(MONDAY, 1);
const week = (n, length = 3) => ({ start_date: addDays(MONDAY, 7 * n), end_date: addDays(MONDAY, 7 * n + length - 1) });

async function call(method, route, { cookie, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
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

const outbox = () => {
  try {
    return readdirSync(path.join(dataDir, "outbox")).map((name) => JSON.parse(readFileSync(path.join(dataDir, "outbox", name), "utf8")));
  } catch {
    return [];
  }
};
const linkIn = (text, action) => (text.match(new RegExp(`/${action}/([A-Za-z0-9_.-]+)`)) || [])[1];

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "timeoff-features-"));
  app = await startServer({ port: 0, host: "127.0.0.1", env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", DATA_DIR: dataDir, BOOTSTRAP_ADMIN_EMAIL: ADMIN } });
  sessions.admin = await signIn(ADMIN);
  const add = async (body) => (await call("POST", "/api/people", { cookie: sessions.admin, body })).json.person;
  people.morgan = await add({ email: "morgan.manager@example.com", name: "Morgan Manager", role: "manager", worker_type: "employee", team: "Ops" });
  people.nora = await add({ email: "nora.lead@example.com", name: "Nora Lead", role: "manager", worker_type: "employee", team: "Sales" });
  people.otto = await add({ email: "otto.other@example.com", name: "Otto Other", role: "manager", worker_type: "employee", team: "Support" });
  people.hana = await add({ email: "hana.hourly@example.com", name: "Hana Hourly", role: "employee", worker_type: "employee", manager_id: people.morgan.id, pay_basis: "hourly", hours_per_day: 6, team: "Ops" });
  people.max = await add({ email: "max.monthly@example.com", name: "Max Monthly", role: "employee", worker_type: "employee", manager_id: people.morgan.id, team: "Ops" });
  people.zed = await add({ email: "zed.zero@example.com", name: "Zed Zero", role: "employee", worker_type: "employee", manager_id: people.nora.id, team: "Sales" });
  for (const person of [people.hana, people.max]) {
    await call("PUT", `/api/people/${person.id}/policy`, { cookie: sessions.admin, body: { annual_days: 10, accrual: "front_loaded", carryover_cap: 0, sick_days: 5, start_date: "2026-01-01" } });
  }
  for (const key of ["morgan", "nora", "otto", "hana", "max"]) sessions[key] = await signIn(people[key].email);
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("people: pay basis, hours per day and team; the team list", async () => {
  assert.deepEqual([people.hana.pay_basis, people.hana.hours_per_day, people.hana.team], ["hourly", 6, "Ops"]);
  assert.deepEqual([people.max.pay_basis, people.max.hours_per_day], ["monthly", 8]);
  const list = (await call("GET", "/api/people", { cookie: sessions.admin })).json;
  assert.deepEqual(list.teams, ["Ops", "Sales", "Support"]);
  const listed = list.people.find((row) => row.id === people.hana.id);
  assert.equal(listed.policy.sick_days, 5);
  assert.equal(listed.balance.sick.available, 5);
  const bad = await call("PATCH", `/api/people/${people.max.id}`, { cookie: sessions.admin, body: { pay_basis: "weekly" } });
  assert.equal(bad.json.error.code, "invalid_pay_basis");
});

test("approvers: the picker lists managers and admins, defaulting to the manager", async () => {
  const picker = (await call("GET", "/api/approvers", { cookie: sessions.hana })).json;
  assert.equal(picker.default_id, people.morgan.id);
  assert.deepEqual(picker.approvers.map((row) => row.name).sort(), ["Admin", "Morgan Manager", "Nora Lead", "Otto Other"].sort());
  assert.deepEqual(Object.keys(picker.approvers[0]).sort(), ["id", "name", "team"]);
  const refused = await call("POST", "/api/requests", { cookie: sessions.hana, body: { ...week(0), kind: "pto", approver_id: people.max.id } });
  assert.equal(refused.json.error.code, "invalid_approver");
});

test("a chosen approver decides; an unrelated manager cannot; the manager and admins still can; hours counted", async () => {
  const asked = await call("POST", "/api/requests", { cookie: sessions.hana, body: { ...week(1), kind: "sick", approver_id: people.nora.id } });
  assert.equal(asked.status, 200);
  const request = asked.json.request;
  assert.deepEqual(request.approver, { id: people.nora.id, name: "Nora Lead" });
  assert.equal(request.days, 3);
  assert.equal(request.hours, 18);
  // Balances of the year the request falls in (60+ days out may be next year).
  const hanaYear = () => balanceFor(app.db, personRow(app.db, people.hana.id), { year: Number(request.start_date.slice(0, 4)), today: request.start_date });
  assert.equal(hanaYear().sick.pending, 3);
  assert.equal(hanaYear().pto.pending, 0);
  // The queue: Nora (approver) and Morgan (manager) see it; Otto does not.
  const queue = async (who) => (await call("GET", "/api/approvals", { cookie: sessions[who] })).json.pending.map((row) => row.request.id);
  assert.ok((await queue("nora")).includes(request.id));
  assert.ok((await queue("morgan")).includes(request.id));
  assert.equal((await queue("otto")).includes(request.id), false);
  const card = (await call("GET", "/api/approvals", { cookie: sessions.nora })).json.pending.find((row) => row.request.id === request.id);
  assert.deepEqual(card.balance_after, { pto: null, sick: 2 });
  // Otto is refused; Nora approves.
  assert.equal((await call("POST", `/api/requests/${request.id}/approve`, { cookie: sessions.otto, body: {} })).json.error.code, "not_your_report");
  assert.equal((await call("POST", `/api/requests/${request.id}/approve`, { cookie: sessions.nora, body: {} })).json.request.status, "approved");
  assert.equal(hanaYear().sick.used, 3);
  assert.equal(hanaYear().sick.available, 2);
  assert.equal(hanaYear().pto.used, 0);
  // The email went to Nora, not Morgan.
  const mail = outbox().filter((row) => /^Hana Hourly asked for Sick$/.test(row.subject));
  assert.deepEqual(mail.map((row) => row.to), ["nora.lead@example.com"]);
  // The audit shows hours for an hourly person.
  const audit = (await call("GET", "/api/audit?limit=200", { cookie: sessions.admin })).json.events.find((row) => row.action === "request.submit" && row.subject === request.id);
  assert.match(audit.detail, /18 hours/);

  const second = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(2), kind: "pto", approver_id: people.nora.id } })).json.request;
  assert.equal((await call("POST", `/api/requests/${second.id}/approve`, { cookie: sessions.morgan, body: {} })).json.request.status, "approved", "their own manager still can");
  assert.equal(second.hours, 24);
  const third = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(3), kind: "pto", approver_id: people.nora.id } })).json.request;
  assert.equal((await call("POST", `/api/requests/${third.id}/deny`, { cookie: sessions.admin, body: {} })).json.request.status, "denied", "an admin always can");
});

test("email links: Approve and Deny, GET never decides, once only, expiry, the wrong approver", async () => {
  const asked = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(4), kind: "pto", note: "Wedding" } })).json.request;
  const mail = outbox().find((row) => row.to === "morgan.manager@example.com" && row.text.includes("Wedding"));
  const approve = linkIn(mail.text, "approve");
  const deny = linkIn(mail.text, "deny");
  assert.ok(approve && deny && approve !== deny);

  const look = await call("GET", `/api/decide/${approve}`);
  assert.equal(look.status, 200);
  assert.equal(look.json.state, "pending");
  assert.equal(look.json.action, "approve");
  assert.equal(look.json.approver_name, "Morgan Manager");
  assert.deepEqual(Object.keys(look.json.request).sort(), ["days", "end_date", "id", "kind", "note", "person_name", "start_date", "status"]);
  assert.equal(look.json.request.person_name, "Max Monthly");
  await call("GET", `/api/decide/${approve}`);
  await call("GET", `/api/decide/${deny}`);
  assert.equal((await call("GET", "/api/approvals", { cookie: sessions.morgan })).json.pending.some((row) => row.request.id === asked.id), true, "looking changed nothing");

  const done = await call("POST", `/api/decide/${approve}`, { body: { note: "Congratulations" } });
  assert.equal(done.status, 200);
  assert.equal(done.json.request.status, "approved");
  assert.equal((await call("POST", `/api/decide/${approve}`, { body: {} })).json.error.code, "already_decided");
  assert.equal((await call("POST", `/api/decide/${deny}`, { body: {} })).json.error.code, "already_decided");
  assert.equal((await call("GET", `/api/decide/${deny}`)).json.state, "already_decided");
  const audit = (await call("GET", "/api/audit?limit=300", { cookie: sessions.admin })).json.events;
  assert.ok(audit.some((row) => row.action === "request.decided_by_link" && row.subject === asked.id && row.actor?.name === "Morgan Manager"));

  const next = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(5), kind: "pto" } })).json.request;
  const expired = makeDecideToken(app.db, { requestId: next.id, action: "approve", approverId: people.morgan.id, now: Date.now() - 15 * 24 * 60 * 60 * 1000 });
  assert.equal((await call("GET", `/api/decide/${expired}`)).json.state, "expired");
  assert.equal((await call("POST", `/api/decide/${expired}`, { body: {} })).json.error.code, "expired");
  const otto = makeDecideToken(app.db, { requestId: next.id, action: "approve", approverId: people.otto.id });
  const refused = await call("POST", `/api/decide/${otto}`, { body: {} });
  assert.equal(refused.json.error.code, "not_your_report");
  assert.equal((await call("GET", `/api/decide/${otto}`)).json.state, "pending", "a refused try does not spend the link");
  assert.equal((await call("GET", "/api/decide/not-a-real-token-at-all-xx")).json.state, "invalid");
  const pending = (await call("GET", "/api/approvals", { cookie: sessions.morgan })).json.pending.find((row) => row.request.id === next.id);
  assert.equal(pending.request.status, "pending");
});

// A past month seeded straight into the database: August 2026.
function seedAugust() {
  const insert = app.db.prepare(`INSERT INTO requests (id, person_id, kind, status, start_date, end_date, half_day_start, half_day_end, days, hours, note, calendar_state, created_at, updated_at)
                                VALUES (?, ?, ?, 'approved', ?, ?, ?, 0, ?, ?, '', 'none', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`);
  insert.run("req_aaaaaaaaaaaaaaaa01", people.hana.id, "pto", "2026-08-03", "2026-08-05", 0, 3, 18); // Mon-Wed
  insert.run("req_aaaaaaaaaaaaaaaa02", people.hana.id, "sick", "2026-08-10", "2026-08-10", 1, 0.5, 3); // half day
  insert.run("req_aaaaaaaaaaaaaaaa03", people.max.id, "unpaid", "2026-08-28", "2026-09-02", 0, 4, 32); // Fri, Mon 31 + 2 days of September
}

test("the monthly report: per team and person, zeros included, hours for hourly people", () => {
  seedAugust();
  const report = monthlyReport(app.db, { year: 2026, month: 8 });
  assert.equal(report.month, "2026-08");
  assert.deepEqual([report.from, report.to], ["2026-08-01", "2026-08-31"]);
  const ops = report.teams.find((team) => team.team === "Ops");
  const hana = ops.people.find((row) => row.id === people.hana.id);
  assert.deepEqual([hana.pto, hana.sick, hana.unpaid, hana.unavailable, hana.hours], [3, 0.5, 0, 0, 21]);
  const max = ops.people.find((row) => row.id === people.max.id);
  assert.deepEqual([max.unpaid, max.hours], [2, null]);
  assert.deepEqual(ops.totals, { pto: 3, sick: 0.5, unpaid: 2, loa: 0, unavailable: 0, hours: 21 });
  const zed = report.teams.find((team) => team.team === "Sales").people.find((row) => row.id === people.zed.id);
  assert.deepEqual([zed.pto, zed.sick, zed.unpaid, zed.unavailable], [0, 0, 0, 0]);
  assert.deepEqual(report.totals, { pto: 3, sick: 0.5, unpaid: 2, loa: 0, unavailable: 0, hours: 21 });
  assert.equal(report.teams.at(-1).team, null, "people without a team come last");
});

test("the monthly report job: bearer token, sends once per month; managers see their team", async () => {
  const jobToken = JSON.parse(readFileSync(path.join(dataDir, "keys.json"), "utf8")).job_token;
  assert.match(jobToken, /^[a-f0-9]{48}$/);
  assert.equal((await call("POST", "/api/jobs/monthly-report", { body: { year: 2026, month: 8 } })).status, 404);
  assert.equal((await call("POST", "/api/jobs/monthly-report", { body: { year: 2026, month: 8 }, headers: { authorization: "Bearer wrong" } })).status, 404);
  const first = await call("POST", "/api/jobs/monthly-report", { body: { year: 2026, month: 8 }, headers: { authorization: `Bearer ${jobToken}` } });
  assert.equal(first.json.sent, true);
  assert.equal(first.json.recipients, 4, "one admin and three managers");
  const again = await call("POST", "/api/jobs/monthly-report", { body: { year: 2026, month: 8 }, headers: { authorization: `Bearer ${jobToken}` } });
  assert.deepEqual(again.json, { sent: false, month: "2026-08", already: true });
  const reports = outbox().filter((row) => /^Time off for August 2026/.test(row.subject));
  assert.equal(reports.length, 4);
  const toMorgan = reports.find((row) => row.to === "morgan.manager@example.com");
  assert.match(toMorgan.text, /Hana Hourly/);
  assert.equal(/Zed Zero/.test(toMorgan.text), false, "a manager's email is their team only");
  assert.match(reports.find((row) => row.to === ADMIN).text, /Zed Zero/);

  const scoped = (await call("GET", "/api/reports/monthly?year=2026&month=8", { cookie: sessions.morgan })).json;
  assert.deepEqual(scoped.teams.map((team) => team.team), ["Ops"]);
  const whole = (await call("GET", "/api/reports/monthly?year=2026&month=8", { cookie: sessions.admin })).json;
  assert.ok(whole.teams.length >= 3);
  assert.equal((await call("GET", "/api/reports/monthly?year=2026&month=8", { cookie: sessions.hana })).status, 403);
});

test("the lazy trigger sends last month once, and not for a brand-new install", async () => {
  const ctx = { db: app.db, env: { ALLOW_FIXTURES: "1", MAIL_FIXTURE: "1", DATA_DIR: dataDir }, dataDir };
  const mailOptions = { env: ctx.env, origin: "http://127.0.0.1", outboxDir: path.join(dataDir, "outbox"), dataDir };
  // Everyone was added this month: nothing to report for a month before the app existed.
  assert.equal(await maybeSendLastMonth(ctx, { mailOptions, now: new Date("2026-08-05T15:00:00Z") }), null);
  app.db.prepare("UPDATE people SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(people.zed.id);
  const sent = await maybeSendLastMonth(ctx, { mailOptions, now: new Date("2026-08-05T15:00:00Z") });
  assert.deepEqual([sent.sent, sent.month], [true, "2026-07"]);
  assert.equal(await maybeSendLastMonth(ctx, { mailOptions, now: new Date("2026-08-06T15:00:00Z") }), null);
});

test("insights: company for an admin, the team for a manager", async () => {
  const company = (await call("GET", "/api/insights?year=2026", { cookie: sessions.admin })).json;
  assert.deepEqual(Object.keys(company).sort(), ["by_kind", "by_month", "by_person", "by_team", "out_next_30", "out_today", "pending", "unused_pto_total", "year"].sort());
  assert.equal(company.by_month.length, 12);
  assert.deepEqual(company.by_month[7], { month: "2026-08", pto: 3, sick: 0.5, unpaid: 2, loa: 0, unavailable: 0 });
  assert.equal(company.by_month[8].unpaid >= 2, true, "September carries the rest of Max's unpaid days");
  const hana = company.by_person.find((row) => row.id === people.hana.id);
  assert.deepEqual(Object.keys(hana).sort(), ["class", "hours", "id", "loa", "name", "pto", "pto_available", "sick", "sick_available", "team", "unavailable", "unpaid"]);
  assert.equal(hana.team, "Ops");
  assert.ok(hana.hours > 0);
  assert.equal(company.by_person.find((row) => row.id === people.zed.id).pto_available, null);
  assert.ok(company.by_team.every((row) => typeof row.people === "number" && "hours" in row));
  assert.equal(typeof company.out_today, "number");
  assert.ok(company.pending >= 1);
  assert.ok(company.unused_pto_total > 0);
  const team = (await call("GET", "/api/insights?year=2026", { cookie: sessions.morgan })).json;
  assert.ok(team.by_person.every((row) => row.team === "Ops"));
  assert.equal((await call("GET", "/api/insights?year=2026", { cookie: sessions.hana })).status, 403);
});

test("typed working days: validated, stored beside the count, and used for balance, hours, email and report", async () => {
  const olive = (await call("POST", "/api/people", { cookie: sessions.admin, body: { email: "olive.override@example.com", name: "Olive Override", role: "employee", worker_type: "employee", manager_id: people.morgan.id, pay_basis: "hourly", hours_per_day: 8 } })).json.person;
  await call("PUT", `/api/people/${olive.id}/policy`, { cookie: sessions.admin, body: { annual_days: 10, accrual: "front_loaded", carryover_cap: 0, start_date: "2026-01-01" } });
  const session = await signIn("olive.override@example.com");
  const span = week(12, 5); // Monday to Friday: the calendar counts 5
  for (const bad of [0, 0.3, 6, "x"]) {
    const refused = await call("POST", "/api/requests/preview", { cookie: session, body: { ...span, kind: "pto", days_requested: bad } });
    assert.equal(refused.json.error.code, "invalid_days_requested", String(bad));
  }
  const preview = (await call("POST", "/api/requests/preview", { cookie: session, body: { ...span, kind: "pto", days_requested: 3 } })).json;
  assert.deepEqual([preview.days, preview.days_computed, preview.days_overridden], [3, 5, true]);
  assert.deepEqual(preview.balance_after, { pto: 7, sick: null });
  const plain = (await call("POST", "/api/requests/preview", { cookie: session, body: { ...span, kind: "pto" } })).json;
  assert.deepEqual([plain.days, plain.days_computed, plain.days_overridden], [5, 5, false]);

  const startedAt = new Date().toISOString();
  const asked = await call("POST", "/api/requests", { cookie: session, body: { ...span, kind: "pto", days_requested: 3 } });
  const request = asked.json.request;
  assert.deepEqual([request.days, request.days_computed, request.days_overridden, request.hours], [3, 5, true, 24]);
  // The balance of the year the request falls in (it may be next year).
  const yearBalance = () => balanceFor(app.db, personRow(app.db, olive.id), { year: Number(span.start_date.slice(0, 4)), today: span.start_date }).pto;
  assert.equal(yearBalance().pending, 3);
  const mail = outbox().find((row) => row.at >= startedAt && row.to === "morgan.manager@example.com" && row.subject === "Olive Override asked for SMTO");
  assert.match(mail.text, /Type: SMTO\nDates: .+\nDays: 3 days \(counted 5\)/);
  assert.equal((await call("POST", `/api/requests/${request.id}/approve`, { cookie: sessions.morgan, body: {} })).json.request.status, "approved");
  assert.equal(yearBalance().used, 3);
  // The report counts 3 days (spread over the five dates), across one or two months.
  const months = [...new Set([span.start_date.slice(0, 7), span.end_date.slice(0, 7)])];
  const counted = months.map((month) => monthlyReport(app.db, { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) }))
    .flatMap((report) => report.teams.flatMap((team) => team.people)).filter((row) => row.id === olive.id);
  assert.equal(counted.reduce((sum, row) => sum + row.pto, 0), 3);
  assert.equal(counted.reduce((sum, row) => sum + row.hours, 0), 24);
});

test("LOA: approved like the rest, touches no balance, has its own report column", async () => {
  const span = week(13, 5);
  const yearBalances = () => balanceFor(app.db, personRow(app.db, people.max.id), { year: Number(span.start_date.slice(0, 4)), today: span.start_date });
  const before = yearBalances();
  const asked = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(13, 5), kind: "loa", note: "Family leave" } })).json;
  assert.equal(asked.request.kind, "loa");
  assert.deepEqual([yearBalances().pto.pending, yearBalances().sick.pending], [before.pto.pending, before.sick.pending]);
  assert.equal((await call("POST", `/api/requests/${asked.request.id}/approve`, { cookie: sessions.morgan, body: {} })).json.request.status, "approved");
  const after = yearBalances();
  assert.deepEqual([after.pto.available, after.pto.used, after.sick.available], [before.pto.available, before.pto.used, before.sick.available]);
  const month = week(13, 5).start_date.slice(0, 7);
  const report = monthlyReport(app.db, { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) });
  const max = report.teams.flatMap((team) => team.people).find((row) => row.id === people.max.id);
  assert.ok(max.loa > 0);
  assert.ok(report.totals.loa > 0);
});

test("manager scope: themselves, direct reports, and people who named them as approver; never the team label", async () => {
  // Same team label as Morgan, a different manager: not Morgan's to see.
  const tess = (await call("POST", "/api/people", { cookie: sessions.admin, body: { email: "tess.teamlabel@example.com", name: "Tess Teamlabel", role: "employee", worker_type: "employee", manager_id: people.nora.id, team: "Ops" } })).json.person;
  const year = Number(isoToday(new Date()).slice(0, 4));
  const morganPeople = (await call("GET", `/api/insights?year=${year}`, { cookie: sessions.morgan })).json.by_person.map((row) => row.id);
  assert.equal(morganPeople.includes(tess.id), false);
  assert.ok(morganPeople.includes(people.hana.id));
  // Nora was named approver for one of Hana's requests: Hana is in Nora's scope.
  const noraPeople = (await call("GET", `/api/insights?year=${year}`, { cookie: sessions.nora })).json.by_person.map((row) => row.id);
  assert.ok(noraPeople.includes(people.hana.id));
  assert.ok(noraPeople.includes(tess.id), "Tess reports to Nora");
  // Otto has no reports and was never named approver: only himself.
  const ottoPeople = (await call("GET", `/api/insights?year=${year}`, { cookie: sessions.otto })).json.by_person.map((row) => row.id);
  assert.deepEqual(ottoPeople, [people.otto.id]);
  const month = isoToday(new Date()).slice(0, 7);
  const calendar = (await call("GET", `/api/team/calendar?month=${month}`, { cookie: sessions.nora })).json.people.map((row) => row.id);
  assert.ok(calendar.includes(people.hana.id) && calendar.includes(tess.id) && calendar.includes(people.nora.id));
  const ottoCalendar = (await call("GET", `/api/team/calendar?month=${month}`, { cookie: sessions.otto })).json.people.map((row) => row.id);
  assert.deepEqual(ottoCalendar, [people.otto.id]);
  const report = (await call("GET", "/api/reports/monthly?year=2026&month=8", { cookie: sessions.morgan })).json;
  assert.equal(report.teams.flatMap((team) => team.people).some((row) => row.id === tess.id), false);
});

test("a decide link POSTed twice at once decides once", async () => {
  const asked = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(14, 2), kind: "pto" } })).json.request;
  const token = makeDecideToken(app.db, { requestId: asked.id, action: "approve", approverId: people.morgan.id });
  const [first, second] = await Promise.all([call("POST", `/api/decide/${token}`, { body: {} }), call("POST", `/api/decide/${token}`, { body: {} })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal([first, second].find((row) => row.status === 409).json.error.code, "already_decided");
  const decided = (await call("GET", "/api/audit?limit=500", { cookie: sessions.admin })).json.events.filter((row) => row.action === "request.approve" && row.subject === asked.id);
  assert.equal(decided.length, 1);
});

test("settings: self-enrollment is blocked until a company domain is set", async () => {
  const settings = (await call("GET", "/api/settings", { cookie: sessions.admin })).json;
  assert.equal(settings.slack.auto_enroll, true);
  assert.equal(settings.slack.auto_enroll_blocked_reason, "Set the company email domain on the Keys page first.");
  assert.equal(settings.slack.manager_pick, "confirm_every");
  assert.equal(settings.calendar.titles, "out");
});

// ------------------------------------------------------------ correctness --

test("monthly report: nobody reached gives the month back; a later run sends it", async () => {
  const { runMonthlyReport } = await import("../server/reports.mjs");
  const { getSetting } = await import("../server/store.mjs");
  const period = { year: 2026, month: 3 };
  const off = await runMonthlyReport({ db: app.db, env: {}, dataDir }, period, { mailOptions: { env: {}, origin: "http://127.0.0.1", outboxDir: path.join(dataDir, "outbox"), dataDir } });
  assert.deepEqual(off, { sent: false, month: "2026-03", recipients: 0, retry: true });
  assert.equal(getSetting(app.db, "monthly_report:2026-03", null), null, "the claim was released");
  const env = { ALLOW_FIXTURES: "1", MAIL_FIXTURE: "1", DATA_DIR: dataDir };
  const on = await runMonthlyReport({ db: app.db, env, dataDir }, period, { mailOptions: { env, origin: "http://127.0.0.1", outboxDir: path.join(dataDir, "outbox"), dataDir } });
  assert.equal(on.sent, true);
  assert.ok(on.recipients > 0);
});

test("insights: out today counts working days only, active people only; unused never goes below zero", async () => {
  const { insights: insightsOf } = await import("../server/reports.mjs");
  const admin = personRow(app.db, (await call("GET", "/api/me", { cookie: sessions.admin })).json.person.id);
  // Max's unpaid time runs Fri Aug 28 to Wed Sep 2: on Saturday he is not "out".
  const saturday = insightsOf(app.db, admin, { year: 2026, today: "2026-08-29" });
  const monday = insightsOf(app.db, admin, { year: 2026, today: "2026-08-31" });
  assert.equal(monday.out_today - saturday.out_today >= 1, true);
  assert.ok(saturday.out_next_30 >= 1, "Monday is inside the next 30 days");
  assert.equal(saturday.unused_pto_total, Math.round(saturday.by_person.reduce((sum, row) => sum + Math.max(0, row.pto_available ?? 0), 0) * 100) / 100);
  // Deactivated, Max no longer counts as out.
  await call("PATCH", `/api/people/${people.max.id}`, { cookie: sessions.admin, body: { active: false } });
  try {
    const later = insightsOf(app.db, admin, { year: 2026, today: "2026-08-31" });
    assert.equal(later.out_today, monday.out_today - 1);
  } finally {
    await call("PATCH", `/api/people/${people.max.id}`, { cookie: sessions.admin, body: { active: true } });
  }
});

test("sample people are never approvers and never get mail", async () => {
  const { addSample, removeSample } = await import("../scripts/seed-sample.mjs");
  const seeded = addSample(app.db);
  try {
    const picker = (await call("GET", "/api/approvers", { cookie: sessions.hana })).json.approvers.map((row) => row.name);
    assert.equal(picker.some((name) => name.startsWith("Sample ")), false);
    const startedAt = new Date().toISOString();
    const waiting = seeded.requests_by_case.waiting_1;
    assert.equal((await call("POST", `/api/requests/${waiting}/approve`, { cookie: sessions.admin, body: {} })).json.request.status, "approved");
    const mail = outbox().filter((row) => row.at >= startedAt && /^sample\./.test(row.to));
    assert.deepEqual(mail, []);
  } finally {
    removeSample(app.db);
  }
});

// ------------------------------------------------------- email and reminders --

test("the approval email has an HTML part: two big buttons, the links written out, typed text escaped", async () => {
  // An earlier test deactivated Max for a moment, which ended his session.
  sessions.max = await signIn(people.max.email);
  const startedAt = new Date().toISOString();
  const created = await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(21, 2), kind: "pto", note: "<b>bold</b> & \"quoted\"" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const asked = created.json.request;
  const mail = outbox().find((row) => row.at >= startedAt && row.to === "morgan.manager@example.com" && row.text.includes("bold"));
  assert.ok(mail.html, "an HTML part");
  // The plain text part is unchanged in kind: both links written out.
  const approve = linkIn(mail.text, "approve");
  const deny = linkIn(mail.text, "deny");
  assert.match(approve, /^[A-Za-z0-9_-]{43}$/, "a short link id");
  assert.match(mail.html, new RegExp(`<a href="[^"]+/approve/${approve}"[^>]*background:#1f7a4d[^>]*>Approve</a>`));
  assert.match(mail.html, new RegExp(`<a href="[^"]+/deny/${deny}"[^>]*background:#6b7280[^>]*>Deny</a>`));
  assert.match(mail.html, /min-height:44px/);
  assert.match(mail.html, /width:100%;max-width:360px/);
  assert.ok(mail.html.includes(`/approve/${approve}</p>`), "the link is written out under the button");
  assert.ok(mail.html.includes("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;"));
  assert.equal(mail.html.includes("<b>bold</b>"), false);
  // The link works.
  assert.equal((await call("GET", `/api/decide/${approve}`)).json.state, "pending");
  assert.equal(asked.status, "pending");
});

test("remind: the approver or an admin, pending only, not twice in ten minutes; fresh links", async () => {
  const asked = (await call("POST", "/api/requests", { cookie: sessions.max, body: { ...week(22, 2), kind: "pto" } })).json.request;
  const firstMail = outbox().filter((row) => row.to === "morgan.manager@example.com" && row.subject === "Max Monthly asked for SMTO");
  const before = firstMail.length;
  assert.equal((await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.max, body: {} })).status, 403, "the requester cannot");
  assert.equal((await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.otto, body: {} })).status, 403, "another manager cannot");
  const startedAt = new Date().toISOString();
  const sent = await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.morgan, body: {} });
  assert.equal(sent.status, 200);
  assert.ok(sent.json.last_reminded_at);
  const again = outbox().filter((row) => row.to === "morgan.manager@example.com" && row.subject === "Max Monthly asked for SMTO");
  assert.equal(again.length, before + 1);
  const fresh = again.find((row) => row.at >= startedAt);
  assert.equal((await call("GET", `/api/decide/${linkIn(fresh.text, "approve")}`)).json.state, "pending");
  const tooSoon = await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.admin, body: {} });
  assert.equal(tooSoon.status, 409);
  assert.equal(tooSoon.json.error.code, "too_soon");
  const card = (await call("GET", "/api/approvals", { cookie: sessions.morgan })).json.pending.find((row) => row.request.id === asked.id);
  assert.equal(card.last_reminded_at, sent.json.last_reminded_at);
  // Ten minutes on, an admin may.
  app.db.prepare("UPDATE requests SET last_reminded_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), asked.id);
  assert.equal((await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.admin, body: {} })).status, 200);
  const audit = (await call("GET", "/api/audit?limit=500", { cookie: sessions.admin })).json.events.filter((row) => row.action === "request.reminded" && row.subject === asked.id);
  assert.equal(audit.length, 2);
  // Not once decided.
  await call("POST", `/api/requests/${asked.id}/approve`, { cookie: sessions.morgan, body: {} });
  app.db.prepare("UPDATE requests SET last_reminded_at = NULL WHERE id = ?").run(asked.id);
  assert.equal((await call("POST", `/api/requests/${asked.id}/remind`, { cookie: sessions.admin, body: {} })).json.error.code, "not_pending");
});
