// Boots the real server on port 0 in practice mode with a temporary
// DATA_DIR and walks it end to end (scripts/qa-walk.mjs), then checks the
// edges the walk does not: the roster gate, the CSRF guard, a calendar
// write that fails without failing the approval, and its retry.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWalk } from "../scripts/qa-walk.mjs";
import { addDays, isoToday, weekday } from "../server/domain/dates.mjs";

// A Monday about two months out: inside the two-year limit, clear of the walk's week.
let MONDAY = addDays(isoToday(new Date()), 60);
while (weekday(MONDAY) !== 1) MONDAY = addDays(MONDAY, 1);
const day = (n) => addDays(MONDAY, n);

// The server starts itself on import unless told not to; set that before
// loading it (a static import would run first).
process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

const ADMIN = "admin@example.com";
let app;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "timeoff-test-"));
  app = await startServer({
    port: 0,
    host: "127.0.0.1",
    env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", CALENDAR_FIXTURE: "1", DATA_DIR: dataDir, BOOTSTRAP_ADMIN_EMAIL: ADMIN, DEFAULT_TIMEZONE: "America/New_York" },
  });
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, route, { cookie, body, type = "application/json" } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = type;
  const response = await fetch(new URL(route, app.url), { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const json = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : null;
  return { status: response.status, json, location: response.headers.get("location"), cookies: response.headers.getSetCookie() };
}

async function signIn(email) {
  const start = await call("GET", "/api/auth/google/start");
  const state = new URL(start.location, app.url).searchParams.get("state");
  const back = await call("GET", `/api/auth/google/callback?${new URLSearchParams({ state, code: "fixture", email })}`, { cookie: `timeoff_oauth=${state}` });
  const session = back.cookies.map((line) => line.split(";")[0]).find((pair) => /^timeoff_session=[a-f0-9]{64}$/.test(pair));
  return { back, session };
}

test("the practice walk: sign in, set up, ask, approve, calendar, email", async () => {
  // Someone not on the roster cannot get in before the admin exists.
  const early = await signIn("stranger@example.com");
  assert.equal(early.session, undefined);
  // No address in the URL; it rides in the short-lived cookie.
  assert.equal(early.back.location, "/?not_on_roster=1");
  assert.ok(early.back.cookies.some((line) => line.startsWith("timeoff_not_on_roster=stranger%40example.com;")));

  const receipt = await runWalk({ base: app.url, adminEmail: ADMIN, dataDir });
  for (const row of receipt.checks) assert.equal(row.ok, true, `${row.name}: ${JSON.stringify(row)}`);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.checks.length, 14);
});

test("a production-like server with a practice flag refuses to start", async () => {
  await assert.rejects(startServer({ port: 0, env: { GOOGLE_FIXTURE: "1", PUBLIC_ORIGIN: "https://timeoff.example.com", DATA_DIR: dataDir } }), /Refusing to start: GOOGLE_FIXTURE/);
});

test("the roster gate and the session", async () => {
  const stranger = await signIn("nobody@example.com");
  assert.equal(stranger.session, undefined);
  const roster = stranger.back.cookies.find((line) => line.startsWith("timeoff_not_on_roster="));
  const me = await call("GET", "/api/me", { cookie: roster.split(";")[0] });
  assert.deepEqual(me.json, { signedIn: false, google: { on: true, fixture: true }, kinds: [], slack_available: false, needs_setup: false, notOnRoster: { email: "nobody@example.com" } });

  const admin = (await signIn(ADMIN)).session;
  assert.equal((await call("GET", "/api/me", { cookie: admin })).json.person.role, "admin");
  // The consent page has the email field.
  const page = await fetch(new URL("/api/auth/google/fixture?state=abc", app.url)).then((response) => response.text());
  assert.match(page, /name="email"/);

  // CSRF guard: a mutation that is not JSON is refused.
  const form = await call("POST", "/api/people", { cookie: admin, body: "email=x%40example.com", type: "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  assert.equal(form.json.error.code, "json_required");

  // Errors are { error: { code, message } }; unknown API paths are JSON 404s.
  const missing = await call("GET", "/api/nothing-here", { cookie: admin });
  assert.equal(missing.status, 404);
  assert.deepEqual(Object.keys(missing.json.error).sort(), ["code", "message"]);

  // Signed out, then the same cookie opens nothing.
  assert.equal((await call("POST", "/api/auth/signout", { cookie: admin, body: {} })).json.ok, true);
  assert.equal((await call("GET", "/api/home", { cookie: admin })).status, 401);
});

test("people rules: last admin, own manager, duplicate email, roles", async () => {
  const admin = (await signIn(ADMIN)).session;
  const me = (await call("GET", "/api/me", { cookie: admin })).json.person;
  const demote = await call("PATCH", `/api/people/${me.id}`, { cookie: admin, body: { role: "employee" } });
  assert.equal(demote.json.error.code, "last_admin");
  const self = await call("PATCH", `/api/people/${me.id}`, { cookie: admin, body: { manager_id: me.id } });
  assert.equal(self.json.error.code, "own_manager");
  const dup = await call("POST", "/api/people", { cookie: admin, body: { email: ADMIN, name: "Again", role: "employee", worker_type: "employee" } });
  assert.equal(dup.status, 409);

  const worker = await call("POST", "/api/people", { cookie: admin, body: { email: "casey.contractor@example.com", name: "Casey Contractor", role: "employee", worker_type: "contractor" } });
  assert.equal(worker.status, 200);
  const casey = (await signIn("casey.contractor@example.com")).session;
  assert.equal((await call("GET", "/api/approvals", { cookie: casey })).status, 403);
  assert.equal((await call("GET", "/api/people", { cookie: casey })).status, 403);
  const home = await call("GET", "/api/home", { cookie: casey });
  // Added as a contractor (paid monthly): the class default, limited SMTO and sick days.
  assert.equal(worker.json.person.class, "contractor_monthly");
  assert.deepEqual([home.json.balance.pto.tracked, home.json.balance.pto.unlimited, home.json.balance.sick.tracked, home.json.balance.sick.unlimited], [true, false, true, false]);
  assert.equal(home.json.team, null);

  // Deactivated: the open session stops working at once.
  await call("PATCH", `/api/people/${worker.json.person.id}`, { cookie: admin, body: { active: false } });
  assert.equal((await call("GET", "/api/home", { cookie: casey })).status, 401);
});

test("a calendar write that fails keeps the approval and is retried", async () => {
  const admin = (await signIn(ADMIN)).session;
  const boss = await call("POST", "/api/people", { cookie: admin, body: { email: "riley.boss@example.com", name: "Riley Boss", role: "manager", worker_type: "employee" } });
  await call("POST", "/api/people", { cookie: admin, body: { email: "sam.worker@example.com", name: "Sam Worker", role: "employee", worker_type: "employee", manager_id: boss.json.person.id } });
  const sam = (await signIn("sam.worker@example.com")).session;
  const riley = (await signIn("riley.boss@example.com")).session;

  // Self-approval is refused for an admin while another admin exists...
  const adminMe = (await call("GET", "/api/me", { cookie: admin })).json.person;
  const second = (await call("POST", "/api/people", { cookie: admin, body: { email: "ada.second@example.com", name: "Ada Second", role: "admin", worker_type: "employee" } })).json.person;
  const own = await call("POST", "/api/requests", { cookie: admin, body: { start_date: day(0), end_date: day(0), kind: "sick" } });
  assert.equal(own.json.request.person_id, adminMe.id);
  assert.equal((await call("POST", `/api/requests/${own.json.request.id}/approve`, { cookie: admin, body: {} })).json.error.code, "own_request");
  // ...and allowed for the only admin, who sees it in Approvals; the audit says so.
  await call("PATCH", `/api/people/${second.id}`, { cookie: admin, body: { active: false } });
  assert.ok((await call("GET", "/api/approvals", { cookie: admin })).json.pending.some((row) => row.request.id === own.json.request.id));
  assert.equal((await call("POST", `/api/requests/${own.json.request.id}/approve`, { cookie: admin, body: {} })).json.request.status, "approved");
  const selfAudit = (await call("GET", "/api/audit?limit=300", { cookie: admin })).json.events.find((row) => row.action === "request.self_decided" && row.subject === own.json.request.id);
  assert.ok(selfAudit);

  // The chosen calendar disappears on the calendar's side.
  const file = path.join(dataDir, "calendar-fixture.json");
  const saved = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), calendars: [] }));

  const asked = await call("POST", "/api/requests", { cookie: sam, body: { start_date: day(1), end_date: day(2), kind: "unpaid" } });
  assert.equal(asked.status, 200);
  const approved = await call("POST", `/api/requests/${asked.json.request.id}/approve`, { cookie: riley, body: {} });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.request.status, "approved");
  assert.equal(approved.json.request.calendar.state, "pending");
  assert.match(approved.json.request.calendar.error, /not found/);
  const settings = (await call("GET", "/api/settings", { cookie: admin })).json;
  assert.equal(settings.calendar.pending_writes, 1);
  assert.equal(settings.slack.on, false);
  // Mail goes to the practice outbox here; it would go through the Google grant.
  assert.deepEqual(settings.mail, { on: true, transport: "fixture", from: "Time Off <calendar-fixture@example.com>", account_email: "calendar-fixture@example.com", needs_reconnect: false });
  // A grant from before email was added: Settings asks for a reconnect.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), calendars: [], scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"] }));
  assert.equal((await call("GET", "/api/settings", { cookie: admin })).json.mail.needs_reconnect, true);

  writeFileSync(file, saved);
  const retry = await call("POST", "/api/settings/calendar/retry", { cookie: admin, body: {} });
  assert.deepEqual(retry.json, { retried: 1, failed: 0 });
  const events = JSON.parse(readFileSync(file, "utf8")).events;
  const event = events.find((row) => row.description.includes(asked.json.request.id));
  // Default titles keep the Type private: Unpaid Time shows as Out.
  assert.equal(event.summary, "Sam Worker — Out");
  assert.deepEqual([event.start.date, event.end.date], [day(1), day(3)]);
  assert.equal(event.id, `timeoff${asked.json.request.id.slice(4)}`);
  assert.match(event.description, /Manager: Riley Boss/);

  // The manager cancels it: the event comes off, the balance is returned.
  const cancelled = await call("POST", `/api/requests/${asked.json.request.id}/cancel`, { cookie: riley, body: {} });
  assert.equal(cancelled.json.request.status, "cancelled");
  assert.equal(cancelled.json.request.calendar.state, "removed");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).events.some((row) => row.id === event.id), false);
  assert.ok(cancelled.json.balance.pto && cancelled.json.balance.sick);
  const audit = (await call("GET", "/api/audit?limit=200", { cookie: admin })).json.events.map((row) => row.action);
  for (const action of ["request.submit", "request.approve", "request.cancel", "calendar.write_failed", "calendar.retry", "person.create", "policy.set", "calendar.connect", "calendar.choose"]) assert.ok(audit.includes(action), action);
});

test("review fixes: limits, demotion, privacy, retry without a calendar", async () => {
  const admin = (await signIn(ADMIN)).session;
  const people = (await call("GET", "/api/people", { cookie: admin })).json.people;
  const riley = people.find((row) => row.email === "riley.boss@example.com");
  const sam = people.find((row) => row.email === "sam.worker@example.com");

  // A far-future date and an ancient start date are refused, not crashed on.
  const samSession = (await signIn("sam.worker@example.com")).session;
  const far = await call("POST", "/api/requests/preview", { cookie: samSession, body: { start_date: "9999-12-30", end_date: "9999-12-31" } });
  assert.equal(far.status, 400);
  assert.equal(far.json.error.code, "too_far_ahead");
  const old = await call("PUT", `/api/people/${sam.id}/policy`, { cookie: admin, body: { annual_days: 10, accrual: "monthly", carryover_cap: 2, start_date: "1990-01-01" } });
  assert.equal(old.json.error.code, "invalid_start_date");

  // A manager with reports cannot be made an employee; the message counts them.
  const demote = await call("PATCH", `/api/people/${riley.id}`, { cookie: admin, body: { role: "employee" } });
  assert.equal(demote.status, 409);
  assert.equal(demote.json.error.code, "has_reports");
  assert.match(demote.json.error.message, /Riley Boss still manages 1 person/);

  // A teammate's approved sick time shows to Sam as "out", to Riley as "sick".
  const jo = await call("POST", "/api/people", { cookie: admin, body: { email: "jo.peer@example.com", name: "Jo Peer", role: "employee", worker_type: "employee", manager_id: riley.id } });
  const joSession = (await signIn("jo.peer@example.com")).session;
  const rileySession = (await signIn("riley.boss@example.com")).session;
  const sick = await call("POST", "/api/requests", { cookie: joSession, body: { start_date: addDays(isoToday(new Date()), 1), end_date: addDays(isoToday(new Date()), 7), kind: "sick" } });
  assert.equal((await call("POST", `/api/requests/${sick.json.request.id}/approve`, { cookie: rileySession, body: {} })).json.request.status, "approved");
  const samHome = (await call("GET", "/api/home", { cookie: samSession })).json;
  const seen = samHome.team_out.find((row) => row.person_id === jo.json.person.id);
  assert.equal(seen.kind, "out");
  const preview = (await call("POST", "/api/requests/preview", { cookie: samSession, body: { start_date: sick.json.request.start_date, end_date: sick.json.request.end_date } })).json;
  assert.ok(preview.overlaps.length && preview.overlaps.every((row) => row.kind === "out"));
  const rileyHome = (await call("GET", "/api/home", { cookie: rileySession })).json;
  assert.equal(rileyHome.team_out.find((row) => row.person_id === jo.json.person.id).kind, "sick");

  // Retry with no calendar connected leaves the write waiting and counts it failed.
  const file = path.join(dataDir, "calendar-fixture.json");
  const saved = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), calendars: [] }));
  const asked = await call("POST", "/api/requests", { cookie: samSession, body: { start_date: day(7), end_date: day(8), kind: "pto" } });
  const approved = await call("POST", `/api/requests/${asked.json.request.id}/approve`, { cookie: rileySession, body: {} });
  assert.equal(approved.json.request.calendar.state, "pending");
  writeFileSync(file, saved);
  await call("POST", "/api/settings/calendar/disconnect", { cookie: admin, body: {} });
  assert.deepEqual((await call("POST", "/api/settings/calendar/retry", { cookie: admin, body: {} })).json, { retried: 1, failed: 1 });
  const still = (await call("GET", "/api/home", { cookie: samSession })).json.requests.find((row) => row.id === asked.json.request.id);
  assert.equal(still.calendar.state, "pending");
  assert.match(still.calendar.error, /not connected/);

  // Reconnect, choose, retry: it lands once.
  const connect = await call("GET", "/api/settings/calendar/connect", { cookie: admin });
  await call("GET", connect.location, { cookie: admin });
  await call("PUT", "/api/settings/calendar", { cookie: admin, body: { calendar_id: "fixture-smto" } });
  assert.deepEqual((await call("POST", "/api/settings/calendar/retry", { cookie: admin, body: {} })).json, { retried: 1, failed: 0 });
  const events = JSON.parse(readFileSync(file, "utf8")).events.filter((row) => row.description.includes(asked.json.request.id));
  assert.equal(events.length, 1);

  // Signed out, the calendar callback goes back to Settings with a reason.
  const out = await call("GET", "/api/settings/calendar/callback?state=abcdefgh&code=fixture");
  assert.equal(out.status, 302);
  assert.equal(out.location, "/settings?calendar_error=not_signed_in");
});
