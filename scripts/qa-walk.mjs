// The end-to-end walk, against a running server in practice mode
// (ALLOW_FIXTURES=1 GOOGLE_FIXTURE=1 MAIL_FIXTURE=1 CALENDAR_FIXTURE=1):
// the admin signs in, adds a manager and an employee, sets the employee's
// allowance, connects the practice calendar; the employee previews and
// asks for three days; the manager approves. Prints a JSON receipt of what
// each step answered and exits 1 when any check fails.
//
//   node scripts/qa-walk.mjs [--base http://127.0.0.1:5610] [--admin admin@example.com] [--data data]
//
// The admin address must be the server's BOOTSTRAP_ADMIN_EMAIL (or an admin
// already on the roster). The manager and employee are new @example.com
// people each run, so the walk can run again against the same database.
// With --data (the server's DATA_DIR) it also reads the practice outbox and
// calendar file, and, when the practice Slack is on, walks a second request
// through Slack: /timeoff, the form, the manager's Approve button. tests/http.test.mjs runs this same walk on a fresh server.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addDays, isoToday, weekday, workingDays, yearOf } from "../server/domain/dates.mjs";
import { FIXTURE_APP_ID, FIXTURE_SIGNING_SECRET, FIXTURE_TEAM_ID, fixtureUsersFile, readSlackFixture } from "../server/slack/api.mjs";
import { slackSignature } from "../server/slack/verify.mjs";

// ------------------------------------------------------------- Slack leg --

/** Posts signed the way Slack signs them: a /timeoff command, or an interaction payload. */
export function slackClient(base, secret = FIXTURE_SIGNING_SECRET) {
  async function post(route, form, { timestamp = Math.floor(Date.now() / 1000), sign = secret } = {}) {
    const raw = new URLSearchParams(form).toString();
    const response = await fetch(new URL(route, base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(timestamp), "x-slack-signature": slackSignature(sign, timestamp, raw) },
      body: raw,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  }
  return {
    post,
    // The practice workspace and app unless a test says otherwise.
    command: (user, text = "", extra = {}) => post("/api/slack/commands", { command: "/timeoff", text, user_id: user, team_id: FIXTURE_TEAM_ID, api_app_id: FIXTURE_APP_ID, trigger_id: `trigger.${Date.now()}`, response_url: "https://hooks.slack.com/commands/practice", ...extra }),
    interact: (payload, options) => post("/api/slack/interactions", { payload: JSON.stringify({ team: { id: FIXTURE_TEAM_ID }, api_app_id: FIXTURE_APP_ID, ...payload }) }, options),
  };
}

/** The practice Slack's captured calls, newest last. */
export const slackCalls = (dataDir) => readSlackFixture(dataDir).calls;

/** Wait (up to ms) for a captured call after index "from" that matches; returns it or null. */
export async function waitForCall(dataDir, match, { from = 0, ms = 4000 } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const found = slackCalls(dataDir).slice(from).find(match);
    if (found || Date.now() > until) return found ?? null;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Seed who is who in the practice Slack ({ member id: email }), keeping what is there. */
export function seedSlackUsers(dataDir, users) {
  let current = {};
  try { current = JSON.parse(readFileSync(fixtureUsersFile(dataDir), "utf8")); } catch { current = {}; }
  writeFileSync(fixtureUsersFile(dataDir), JSON.stringify({ ...current, ...users }, null, 2));
}

/**
 * The view_submission Slack sends for the Request time off form. The form
 * requires the working days and the Manager: `days` defaults to the
 * Monday–Friday count of the span (pass null to leave it empty), `manager`
 * to none (the caller names one).
 */
export function requestSubmission(user, { kind = "pto", start_date, end_date, note = "", manager = null, days }) {
  if (days === undefined) days = start_date && end_date && end_date >= start_date ? workingDays({ start_date, end_date }).days : null;
  return {
    type: "view_submission",
    user: { id: user },
    view: {
      callback_id: "timeoff_request",
      state: { values: {
        kind: { value: { type: "static_select", selected_option: { value: kind } } },
        start: { value: { type: "datepicker", selected_date: start_date } },
        end: { value: { type: "datepicker", selected_date: end_date } },
        note: { value: { type: "plain_text_input", value: note } },
        days: { value: { type: "number_input", value: days === null ? null : String(days) } },
        manager: { value: { type: "users_select", selected_user: manager } },
      } },
    },
  };
}

/** A button click on a message (approve, deny, cancel). */
export const buttonClick = (user, actionId, requestId, { channel = "DPRACTICE", ts = "1.000001" } = {}) => ({
  type: "block_actions",
  user: { id: user },
  trigger_id: `trigger.${Date.now()}`,
  response_url: "https://hooks.slack.com/actions/practice",
  channel: { id: channel },
  message: { ts },
  actions: [{ action_id: actionId, value: requestId }],
});

function check(receipt, name, ok, detail = {}) {
  receipt.checks.push({ name, ok: Boolean(ok), ...detail });
  if (!ok) receipt.ok = false;
  return ok;
}

/** Monday to Wednesday of the first week that starts at least a week from now. */
export function walkDates(now = new Date()) {
  let start = addDays(isoToday(now), 7);
  while (weekday(start) !== 1) start = addDays(start, 1);
  return { start_date: start, end_date: addDays(start, 2) };
}

function client(base) {
  async function call(method, route, { cookie, body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(route, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const type = response.headers.get("content-type") || "";
    const json = type.includes("application/json") ? await response.json() : null;
    return { status: response.status, json, location: response.headers.get("location"), cookies: response.headers.getSetCookie?.() || [] };
  }

  // The practice sign-in, the way a browser walks it: start, the consent
  // page's form (state, code, email), the callback with the state cookie.
  async function signIn(email) {
    const start = await call("GET", "/api/auth/google/start?return_to=/");
    const consent = start.location ? new URL(start.location, base) : null;
    if (start.status !== 302 || !consent || consent.pathname !== "/api/auth/google/fixture") throw new Error(`sign-in did not reach the practice page (status ${start.status}); is GOOGLE_FIXTURE on?`);
    const state = consent.searchParams.get("state");
    const back = await call("GET", `/api/auth/google/callback?${new URLSearchParams({ state, code: "fixture", email })}`, { cookie: `timeoff_oauth=${state}` });
    const session = back.cookies.map((line) => line.split(";")[0]).find((pair) => /^timeoff_session=[a-f0-9]{64}$/.test(pair));
    if (!session) throw new Error(`sign-in did not open a session (went to ${back.location})`);
    return session;
  }

  return { call, signIn };
}

export async function runWalk({ base, adminEmail, dataDir = null, now = new Date(), slackSecret = process.env.SLACK_SIGNING_SECRET || FIXTURE_SIGNING_SECRET }) {
  const startedAt = new Date().toISOString();
  const receipt = { ok: true, base, started_at: startedAt, checks: [] };
  const { call, signIn } = client(base);
  const stamp = Date.now().toString(36);
  const managerEmail = `qa-manager-${stamp}@example.com`;
  const employeeEmail = `qa-employee-${stamp}@example.com`;
  const year = yearOf(isoToday(now));

  const health = await call("GET", "/healthz");
  check(receipt, "healthz", health.status === 200 && health.json?.ok === true, { status: health.status });

  // ---- the admin sets up the team
  const admin = await signIn(adminEmail);
  const me = await call("GET", "/api/me", { cookie: admin });
  check(receipt, "admin signed in", me.json?.signedIn === true && me.json.person.role === "admin", { role: me.json?.person?.role ?? null });

  const manager = await call("POST", "/api/people", { cookie: admin, body: { email: managerEmail, name: "Morgan Manager", role: "manager", worker_type: "employee" } });
  check(receipt, "manager added", manager.status === 200 && manager.json.person.role === "manager", { status: manager.status });
  const employee = await call("POST", "/api/people", { cookie: admin, body: { email: employeeEmail, name: "Elliot Employee", role: "employee", worker_type: "employee", manager_id: manager.json?.person?.id } });
  check(receipt, "employee added under the manager", employee.status === 200 && employee.json.person.manager?.id === manager.json?.person?.id, { status: employee.status });
  const employeeId = employee.json?.person?.id;

  const policy = await call("PUT", `/api/people/${employeeId}/policy`, { cookie: admin, body: { annual_days: 15, accrual: "front_loaded", carryover_cap: 5, sick_days: 5, start_date: `${year}-01-01` } });
  check(receipt, "policy set", policy.status === 200 && policy.json.balance.pto.allowance === 15 && policy.json.balance.pto.available === 15 && policy.json.balance.sick.available === 5, { balance: policy.json?.balance ?? null });

  const connect = await call("GET", "/api/settings/calendar/connect", { cookie: admin });
  const callback = connect.location ? await call("GET", new URL(connect.location, base).pathname + new URL(connect.location, base).search, { cookie: admin }) : null;
  check(receipt, "practice calendar connected", callback?.status === 302 && callback.location === "/settings", { went_to: callback?.location ?? connect.location });
  const calendars = await call("GET", "/api/settings/calendars", { cookie: admin });
  const writable = (calendars.json?.calendars || []).find((row) => row.writable);
  const chosen = writable ? await call("PUT", "/api/settings/calendar", { cookie: admin, body: { calendar_id: writable.id } }) : null;
  check(receipt, "calendar chosen", chosen?.status === 200 && chosen.json.settings.calendar.calendar_id === writable.id, { calendar_id: writable?.id ?? null });

  // ---- the employee asks
  const dates = walkDates(now);
  const elliot = await signIn(employeeEmail);
  const preview = await call("POST", "/api/requests/preview", { cookie: elliot, body: { ...dates, kind: "pto" } });
  check(receipt, "preview counts three days", preview.status === 200 && preview.json.days === 3, { days: preview.json?.days, balance_after: preview.json?.balance_after, warnings: preview.json?.warnings });
  const submitted = await call("POST", "/api/requests", { cookie: elliot, body: { ...dates, kind: "pto", note: "Family visit" } });
  const requestId = submitted.json?.request?.id;
  check(receipt, "request submitted and held", submitted.status === 200 && submitted.json.request.status === "pending", { status: submitted.status, pending: submitted.json?.balance?.pto?.pending });

  // ---- the manager approves
  const morgan = await signIn(managerEmail);
  const approvals = await call("GET", "/api/approvals", { cookie: morgan });
  check(receipt, "manager sees it waiting", (approvals.json?.pending || []).some((row) => row.request.id === requestId), { waiting: approvals.json?.pending?.length ?? null });
  const approved = await call("POST", `/api/requests/${requestId}/approve`, { cookie: morgan, body: { note: "Enjoy" } });
  check(receipt, "approved and on the calendar", approved.status === 200 && approved.json.request.status === "approved" && approved.json.request.calendar.state === "added", { calendar: approved.json?.request?.calendar ?? null });

  const home = await call("GET", "/api/home", { cookie: elliot });
  const usedThisYear = yearOf(dates.start_date) === year ? 3 : 0;
  check(receipt, "balance shows the days used", home.json?.balance?.pto?.used === usedThisYear && home.json.balance.pto.available === 15 - usedThisYear && home.json.balance.pto.pending === 0, { balance: home.json?.balance ?? null });

  if (dataDir) {
    let events = [];
    try { events = JSON.parse(readFileSync(path.join(dataDir, "calendar-fixture.json"), "utf8")).events || []; } catch { events = []; }
    const event = events.find((row) => String(row.description || "").includes(requestId));
    check(receipt, "practice calendar has the event", Boolean(event) && event.summary === "Elliot Employee — SMTO" && event.start.date === dates.start_date && event.end.date === addDays(dates.end_date, 1), { event: event ? { summary: event.summary, start: event.start.date, end: event.end.date } : null });
    let mail = [];
    try {
      const dir = path.join(dataDir, "outbox");
      mail = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"))).filter((row) => row.at >= startedAt && (row.to === managerEmail || row.to === employeeEmail));
    } catch { mail = []; }
    check(receipt, "two emails in the practice outbox", mail.length === 2 && mail.some((row) => row.to === managerEmail) && mail.some((row) => row.to === employeeEmail), { subjects: mail.map((row) => row.subject) });
  }

  // ---- the same cycle through Slack, when the practice Slack is on
  const settings = await call("GET", "/api/settings", { cookie: admin });
  if (dataDir && settings.json?.slack?.fixture) {
    const slack = slackClient(base, slackSecret);
    const upper = stamp.toUpperCase();
    const [elliotSlack, morganSlack] = [`UE${upper}`, `UM${upper}`];
    seedSlackUsers(dataDir, { [elliotSlack]: employeeEmail, [morganSlack]: managerEmail });
    let mark = slackCalls(dataDir).length;
    const opened = await slack.command(elliotSlack, "");
    const view = await waitForCall(dataDir, (row) => row.method === "views.open", { from: mark });
    check(receipt, "slack: /timeoff opens the form with the balance", opened.status === 200 && Boolean(view) && /available/.test(view.body.view.blocks[0].elements[0].text), { line: view?.body?.view?.blocks?.[0]?.elements?.[0]?.text ?? null });

    const next = { start_date: addDays(dates.start_date, 7), end_date: addDays(dates.end_date, 7) };
    mark = slackCalls(dataDir).length;
    // The walk shows the plain path: a pick of an existing manager goes straight to them.
    const before = settings.json.slack.manager_pick;
    await call("PUT", "/api/settings/slack", { cookie: admin, body: { manager_pick: "confirm_new" } });
    const sent = await slack.interact(requestSubmission(elliotSlack, { ...next, note: "From Slack", manager: morganSlack }));
    const toManager = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && Array.isArray(row.body.blocks) && row.body.blocks.some((block) => block.type === "actions"), { from: mark });
    const slackRequest = toManager?.body.blocks.find((block) => block.type === "actions").elements[0].value;
    check(receipt, "slack: the request reaches the manager with buttons", sent.status === 200 && Boolean(slackRequest), { request_id: slackRequest ?? null });

    mark = slackCalls(dataDir).length;
    await slack.interact(buttonClick(morganSlack, "approve", slackRequest, { channel: toManager?.body.channel, ts: "1" }));
    const updated = await waitForCall(dataDir, (row) => row.method === "chat.update" && /Approved by Morgan Manager/.test(row.body.text), { from: mark });
    const after = await call("GET", "/api/home", { cookie: elliot });
    const row = (after.json?.requests || []).find((item) => item.id === slackRequest);
    check(receipt, "slack: approving from Slack updates the message and the calendar", Boolean(updated) && row?.status === "approved" && row.calendar.state === "added", { status: row?.status ?? null, calendar: row?.calendar?.state ?? null });
    if (before && before !== "confirm_new") await call("PUT", "/api/settings/slack", { cookie: admin, body: { manager_pick: before } });
  }

  receipt.request_id = requestId ?? null;
  receipt.dates = dates;
  receipt.finished_at = new Date().toISOString();
  return receipt;
}

const runDirectly = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url; } catch { return false; }
})();
if (runDirectly) {
  const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const base = arg("base") || process.env.QA_BASE_URL || "http://127.0.0.1:5610";
  const adminEmail = arg("admin") || process.env.QA_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@example.com";
  const dataDir = arg("data") || process.env.DATA_DIR || null;
  // The Slack leg signs with SLACK_SIGNING_SECRET, or the stand-in's own secret.
  runWalk({ base, adminEmail, dataDir }).then((receipt) => {
    console.log(JSON.stringify(receipt, null, 2));
    if (!receipt.ok) process.exit(1);
  }).catch((error) => {
    console.log(JSON.stringify({ ok: false, base, error: error.message }, null, 2));
    process.exit(1);
  });
}
