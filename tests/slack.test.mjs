// The Slack front door, end to end against the real server with the
// practice Slack (SLACK_FIXTURE=1): signatures, /timeoff, the request form,
// the manager's buttons, the roster gate, and the site and Slack updating
// the same message. Slack calls are read back from data/slack-fixture.json.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buttonClick, requestSubmission, runWalk, seedSlackUsers, slackCalls, slackClient, waitForCall } from "../scripts/qa-walk.mjs";
import { addDays, isoToday, weekday, yearOf } from "../server/domain/dates.mjs";
import { NOT_ON_ROSTER, SLACK_SLOW } from "../server/slack/identity.mjs";
import { announceRequest } from "../server/slack/messages.mjs";

process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

const ADMIN = "admin@example.com";
const SECRET = "test-signing-secret";
const ids = { admin: "U_ADMIN", manager: "U_MORGAN", employee: "U_ELLIOT", peer: "U_PAT", contractor: "U_CASEY", stranger: "U_STRANGER" };
let app;
let dataDir;
let slack;
const people = {};
let MONDAY = addDays(isoToday(new Date()), 60);
while (weekday(MONDAY) !== 1) MONDAY = addDays(MONDAY, 1);
const week = (n) => ({ start_date: addDays(MONDAY, 7 * n), end_date: addDays(MONDAY, 7 * n + 2) });

async function call(method, route, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(route, app.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const json = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : null;
  return { status: response.status, json, location: response.headers.get("location") };
}

async function signIn(email) {
  const start = await call("GET", "/api/auth/google/start");
  const state = new URL(start.location, app.url).searchParams.get("state");
  const response = await fetch(new URL(`/api/auth/google/callback?${new URLSearchParams({ state, code: "fixture", email })}`, app.url), { headers: { cookie: `timeoff_oauth=${state}` }, redirect: "manual" });
  return response.headers.getSetCookie().map((line) => line.split(";")[0]).find((pair) => /^timeoff_session=[a-f0-9]{64}$/.test(pair));
}

const requestRow = async (id) => (await call("GET", "/api/approvals", { cookie: people.adminSession })).json;
const statusOf = async (id) => {
  const approvals = await requestRow(id);
  const found = [...approvals.pending, ...approvals.recent].find((row) => row.request.id === id);
  return found?.request ?? null;
};

// The form requires a Manager: each test requester's own manager, else the admin.
const defaultManager = (user) => ({ U_ELLIOT: "U_MORGAN", U_PAT: "U_MORGAN", U_CASEY: "U_MORGAN" }[user] || "U_ADMIN");

/** Submit the form as `user` and return the new request id from the manager's message. */
async function askThroughSlack(user, dates, note = "") {
  const mark = slackCalls(dataDir).length;
  const answer = await slack.interact(requestSubmission(user, { manager: defaultManager(user), ...dates, note }));
  assert.equal(answer.status, 200);
  assert.equal(answer.text, "");
  const message = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && Array.isArray(row.body.blocks) && row.body.blocks.some((block) => block.type === "actions"), { from: mark });
  assert.ok(message, "manager message with buttons");
  return { id: message.body.blocks.find((block) => block.type === "actions").elements[0].value, message, mark };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "timeoff-slack-"));
  app = await startServer({
    port: 0,
    host: "127.0.0.1",
    env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", CALENDAR_FIXTURE: "1", SLACK_FIXTURE: "1", SLACK_SIGNING_SECRET: SECRET, DATA_DIR: dataDir, BOOTSTRAP_ADMIN_EMAIL: ADMIN, ALLOWED_EMAIL_DOMAIN: "example.com" },
  });
  slack = slackClient(app.url, SECRET);
  seedSlackUsers(dataDir, {
    [ids.admin]: ADMIN,
    [ids.manager]: "morgan.manager@example.com",
    [ids.employee]: "elliot.employee@example.com",
    [ids.peer]: "pat.peer@example.com",
    [ids.contractor]: "casey.contractor@example.com",
    [ids.stranger]: "stranger@example.com",
  });
  // The admin sets up the team and the practice calendar on the site.
  people.adminSession = await signIn(ADMIN);
  const add = async (body) => (await call("POST", "/api/people", { cookie: people.adminSession, body })).json.person;
  people.manager = await add({ email: "morgan.manager@example.com", name: "Morgan Manager", role: "manager", worker_type: "employee" });
  people.employee = await add({ email: "elliot.employee@example.com", name: "Elliot Employee", role: "employee", worker_type: "employee", manager_id: people.manager.id });
  people.peer = await add({ email: "pat.peer@example.com", name: "Pat Peer", role: "employee", worker_type: "employee", manager_id: people.manager.id });
  people.contractor = await add({ email: "casey.contractor@example.com", name: "Casey Contractor", role: "employee", worker_type: "contractor", pay_basis: "hourly", manager_id: people.manager.id });
  await call("PUT", `/api/people/${people.employee.id}/policy`, { cookie: people.adminSession, body: { annual_days: 15, accrual: "front_loaded", carryover_cap: 0, start_date: `${yearOf(isoToday(new Date()))}-01-01` } });
  const connect = await call("GET", "/api/settings/calendar/connect", { cookie: people.adminSession });
  await call("GET", connect.location, { cookie: people.adminSession });
  await call("PUT", "/api/settings/calendar", { cookie: people.adminSession, body: { calendar_id: "fixture-smto" } });
  // Most tests follow a pick of an existing manager straight to them; the
  // default "confirm_every" has its own test.
  await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "confirm_new" } });
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("signatures: valid passes, stale and wrong are refused before parsing", async () => {
  assert.equal((await slack.command(ids.peer, "help")).status, 200);
  const stale = await slack.post("/api/slack/commands", { command: "/timeoff", text: "help", user_id: ids.peer }, { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error.code, "bad_signature");
  const wrong = await slack.post("/api/slack/commands", { command: "/timeoff", text: "help", user_id: ids.peer }, { sign: "not-the-secret" });
  assert.equal(wrong.status, 401);
  const unsigned = await fetch(new URL("/api/slack/interactions", app.url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=%7B%7D" });
  assert.equal(unsigned.status, 401);
});

test("/timeoff opens the form with the balance line; hourly contractors get no Sick", async () => {
  let mark = slackCalls(dataDir).length;
  const answer = await slack.command(ids.employee, "");
  assert.equal(answer.status, 200);
  const opened = await waitForCall(dataDir, (row) => row.method === "views.open", { from: mark });
  assert.equal(opened.body.view.title.text, "Request time off");
  assert.equal(opened.body.view.blocks[0].elements[0].text, "15 days available");
  assert.deepEqual(opened.body.view.blocks[1].label.text, "Type");
  // Working days and Manager are required; no half-day boxes.
  const block = (id) => opened.body.view.blocks.find((row) => row.block_id === id);
  assert.equal(block("days").optional, undefined);
  assert.equal(block("days").element.placeholder.text, "0.0");
  assert.equal(block("days").hint.text, "Enter in 0.00 format, like 1.5 for a day and a half");
  assert.equal(block("manager").optional, undefined);
  assert.equal(block("manager").element.type, "users_select");
  assert.equal(block("halves"), undefined);
  // Both dates start at today in the requester's time zone, with placeholders.
  const { isoToday } = await import("../server/domain/dates.mjs");
  const today = isoToday(new Date(), "America/New_York");
  assert.deepEqual([block("start").element.initial_date, block("start").element.placeholder.text], [today, "First day"]);
  assert.deepEqual([block("end").element.initial_date, block("end").element.placeholder.text], [today, "Last day"]);
  assert.deepEqual(opened.body.view.blocks[1].element.options.map((option) => [option.value, option.text.text]), [["pto", "SMTO"], ["sick", "Sick"], ["unpaid", "Unpaid Time"], ["loa", "LOA"]]);

  mark = slackCalls(dataDir).length;
  await slack.command(ids.contractor, "request");
  const contractorForm = await waitForCall(dataDir, (row) => row.method === "views.open", { from: mark });
  assert.deepEqual(contractorForm.body.view.blocks[1].element.options.map((option) => option.value), ["pto", "unpaid", "loa"]);
  // The hourly class default: 15 SMTO a year (from the start date), no sick time.
  assert.match(contractorForm.body.view.blocks[0].elements[0].text, /^[0-9.]+ days? available$/);
});

test("a bad date range comes back on the field, and nothing is saved", async () => {
  const answer = await slack.interact(requestSubmission(ids.employee, { start_date: week(0).end_date, end_date: week(0).start_date }));
  assert.equal(answer.status, 200);
  assert.equal(answer.json.response_action, "errors");
  assert.match(answer.json.errors.end, /end date is before the start date/);
  const unavailable = await slack.interact(requestSubmission(ids.employee, { ...week(0), kind: "unavailable" }));
  assert.ok(unavailable.json.errors.kind);
});

test("submit, peer refused, manager approves: message updated, requester told, calendar event", async () => {
  const { id, message, mark } = await askThroughSlack(ids.employee, week(0), "Family visit");
  const toRequester = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && /^Sent to Morgan Manager for approval: SMTO \(3 days\), /.test(row.body.text), { from: mark });
  assert.ok(toRequester, "requester DM");
  assert.equal(message.body.channel, "D_MORGAN");
  const fields = JSON.stringify(message.body.blocks);
  assert.match(fields, /Balance after\*\\n12 days/);
  assert.match(fields, /Family visit/);
  assert.equal((await statusOf(id)).status, "pending");

  // A peer's click is refused only to them; nothing changes.
  let from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.peer, "approve", id));
  const refusal = await waitForCall(dataDir, (row) => row.method === "chat.postEphemeral", { from });
  assert.equal(refusal.body.user, ids.peer);
  assert.match(refusal.body.text, /Only their manager or an admin/);
  assert.equal((await statusOf(id)).status, "pending");
  assert.equal(slackCalls(dataDir).slice(from).some((row) => row.method === "chat.update"), false);

  from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "approve", id, { channel: message.body.channel }));
  const updated = await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
  assert.equal(updated.body.text, "Elliot Employee: Approved by Morgan Manager · on the team calendar");
  assert.equal(updated.body.blocks.some((block) => block.type === "actions"), false);
  const told = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && /^Morgan Manager approved your SMTO \(3 days\), /.test(row.body.text), { from });
  assert.ok(told, "requester told");
  const request = await statusOf(id);
  assert.equal(request.status, "approved");
  assert.equal(request.calendar.state, "added");
  const events = JSON.parse(readFileSync(path.join(dataDir, "calendar-fixture.json"), "utf8")).events;
  assert.ok(events.some((row) => row.description.includes(id)));
});

test("deny with a note through the small form", async () => {
  const { id, message } = await askThroughSlack(ids.employee, week(1));
  let from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "deny", id, { channel: message.body.channel }));
  const form = await waitForCall(dataDir, (row) => row.method === "views.open" && row.body.view.callback_id === "timeoff_deny", { from });
  assert.ok(form, "deny form opened");
  from = slackCalls(dataDir).length;
  const answer = await slack.interact({ type: "view_submission", user: { id: ids.manager }, view: { callback_id: "timeoff_deny", private_metadata: form.body.view.private_metadata, state: { values: { note: { value: { value: "We're short that week" } } } } } });
  assert.equal(answer.status, 200);
  const updated = await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
  assert.equal(updated.body.text, "Elliot Employee: Denied by Morgan Manager: We're short that week");
  const request = await statusOf(id);
  assert.equal(request.status, "denied");
  assert.equal(request.decision_note, "We're short that week");
});

test("with auto-enroll off, someone not on the roster hears only that", async () => {
  const off = await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { auto_enroll: false } });
  assert.equal(off.json.settings.slack.auto_enroll, false);
  const from = slackCalls(dataDir).length;
  const answer = await slack.command(ids.stranger, "balance");
  assert.equal(answer.status, 200);
  const reply = await waitForCall(dataDir, (row) => row.method === "response_url", { from });
  assert.equal(reply.body.text, NOT_ON_ROSTER);
  assert.equal(reply.body.response_type, "ephemeral");
  const roster = (await call("GET", "/api/people", { cookie: people.adminSession })).json.people;
  assert.equal(roster.some((row) => row.email === "stranger@example.com"), false);
  assert.equal((await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { auto_enroll: true } })).json.settings.slack.auto_enroll, true);
});

test("auto-enroll: a new Slack member is added, the admins are told, their request goes to the admins", async () => {
  const roster = async () => (await call("GET", "/api/people", { cookie: people.adminSession })).json.people;
  const admin = (await roster()).find((row) => row.email === ADMIN);
  assert.equal(admin.enrolled_via, "bootstrap");
  assert.equal((await roster()).find((row) => row.id === people.employee.id).enrolled_via, "admin");
  await call("PATCH", `/api/people/${admin.id}`, { cookie: people.adminSession, body: { slack_user_id: ids.admin } });
  seedSlackUsers(dataDir, { U_NINA: { email: "nina.new@example.com", real_name: "Nina New" }, U_OUTSIDE: { email: "oscar.outside@example.com", is_stranger: true } });
  const startedAt = new Date().toISOString();
  const from = slackCalls(dataDir).length;
  await slack.command("U_NINA", "");
  assert.ok(await waitForCall(dataDir, (row) => row.method === "views.open", { from }), "the form opens for the new person");
  const nina = (await roster()).find((row) => row.email === "nina.new@example.com");
  assert.deepEqual(
    { name: nina.name, role: nina.role, worker_type: nina.worker_type, pay_basis: nina.pay_basis, manager: nina.manager, team: nina.team, active: nina.active, slack_user_id: nina.slack_user_id, enrolled_via: nina.enrolled_via, needs_setup: nina.needs_setup },
    { name: "Nina New", role: "employee", worker_type: "employee", pay_basis: "monthly", manager: null, team: null, active: true, slack_user_id: "U_NINA", enrolled_via: "slack", needs_setup: true },
  );
  const told = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /^Nina New just asked for time off from Slack and was added to the roster\. Set their manager and allowance on the People page: http/.test(row.body.text), { from });
  assert.ok(told, "the admin's DM");
  let mail = [];
  for (let tries = 0; tries < 50 && !mail.length; tries += 1) {
    mail = readdirSync(path.join(dataDir, "outbox")).map((name) => JSON.parse(readFileSync(path.join(dataDir, "outbox", name), "utf8"))).filter((row) => row.at >= startedAt && row.subject === "Nina New was added to Time Off from Slack");
    if (!mail.length) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.deepEqual(mail.map((row) => row.to), [ADMIN]);
  assert.match(mail[0].text, /\/people\n$/);
  const audit = (await call("GET", "/api/audit?limit=500", { cookie: people.adminSession })).json.events.find((row) => row.action === "person.auto_enrolled");
  assert.equal(audit.detail, "Nina New added themselves from Slack.");

  // Their first request goes to the admins: they have no manager yet.
  const { message } = await askThroughSlack("U_NINA", week(9));
  assert.equal(message.body.channel, "D_ADMIN");

  // A stranger from a shared channel is still turned away, and not added.
  const before = slackCalls(dataDir).length;
  await slack.command("U_OUTSIDE", "balance");
  const refused = await waitForCall(dataDir, (row) => row.method === "response_url", { from: before });
  assert.equal(refused.body.text, NOT_ON_ROSTER);
  assert.equal((await roster()).some((row) => row.email === "oscar.outside@example.com"), false);
});

test("balance and cancel answer at once for a linked member; Cancel cancels", async () => {
  const balance = await slack.command(ids.employee, "balance");
  assert.equal(balance.json.response_type, "ephemeral");
  assert.match(balance.json.text, /12 days available/);
  const { id } = await askThroughSlack(ids.employee, week(2));
  const list = await slack.command(ids.employee, "cancel");
  const button = list.json.blocks.map((block) => block.accessory).find((accessory) => accessory?.value === id);
  assert.equal(button.action_id, "cancel");
  const from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.employee, "cancel", id));
  const replaced = await waitForCall(dataDir, (row) => row.method === "response_url" && row.body.replace_original === true, { from });
  assert.match(replaced.body.text, /^Cancelled:/);
  const settled = await waitForCall(dataDir, (row) => row.method === "chat.update" && /Cancelled by Elliot Employee/.test(row.body.text), { from });
  assert.ok(settled);
});

test("approving on the site updates the Slack message too", async () => {
  const { id } = await askThroughSlack(ids.employee, week(3));
  const morgan = await signIn("morgan.manager@example.com");
  const from = slackCalls(dataDir).length;
  const approved = await call("POST", `/api/requests/${id}/approve`, { cookie: morgan, body: {} });
  assert.equal(approved.json.request.status, "approved");
  const updated = slackCalls(dataDir).slice(from).find((row) => row.method === "chat.update");
  assert.ok(updated, "site approval updated the message before answering");
  assert.match(updated.body.text, /Approved by Morgan Manager/);
});

test("settings and /api/me report Slack", async () => {
  const settings = (await call("GET", "/api/settings", { cookie: people.adminSession })).json;
  assert.equal(settings.slack.on, true);
  assert.equal(settings.slack.fixture, true);
  assert.equal(settings.slack.team_name, "Practice Workspace");
  assert.ok(settings.slack.linked_people >= 3);
  assert.equal((await call("GET", "/api/me")).json.slack_available, true);
  assert.equal((await call("GET", "/api/me", { cookie: people.adminSession })).json.slack_available, true);
  const listed = (await call("GET", "/api/people", { cookie: people.adminSession })).json.people.find((row) => row.id === people.employee.id);
  assert.equal(listed.slack_user_id, ids.employee);
});

test("the QA walk's Slack leg passes", async () => {
  const receipt = await runWalk({ base: app.url, adminEmail: ADMIN, dataDir, slackSecret: SECRET });
  for (const row of receipt.checks) assert.equal(row.ok, true, `${row.name}: ${JSON.stringify(row)}`);
  assert.equal(receipt.checks.filter((row) => row.name.startsWith("slack:")).length, 3);
});

test("the live Slack client posts form-encoded with the token, and errors never carry it", async () => {
  const { slackCall } = await import("../server/slack/api.mjs");
  const env = { SLACK_BOT_TOKEN: "xoxb-secret-token", SLACK_SIGNING_SECRET: "s" };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(seen.length === 1 ? { ok: true, ts: "1.2" } : { ok: false, error: "channel_not_found" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const ok = await slackCall({ env, fetchImpl }, "chat.postMessage", { channel: "D1", text: "hi", blocks: [{ type: "divider" }] });
  assert.equal(ok.ts, "1.2");
  assert.equal(seen[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(seen[0].init.headers.Authorization, "Bearer xoxb-secret-token");
  assert.equal(new URLSearchParams(seen[0].init.body).get("blocks"), JSON.stringify([{ type: "divider" }]));
  await assert.rejects(slackCall({ env, fetchImpl }, "chat.update", { channel: "D1" }), (error) => error.slackError === "channel_not_found" && !String(error.message).includes("xoxb") && !JSON.stringify(error).includes("xoxb"));
});

// ------------------------------------------------------------ security review --

const addPerson = async (body) => (await call("POST", "/api/people", { cookie: people.adminSession, body })).json.person;
const auditActions = async () => (await call("GET", "/api/audit?limit=500", { cookie: people.adminSession })).json.events.map((row) => row.action);
const personById = async (id) => (await call("GET", "/api/people", { cookie: people.adminSession })).json.people.find((row) => row.id === id);

test("review 1: a demoted manager's report goes to the admins, by Slack and email", async () => {
  const lead = await addPerson({ email: "quinn.lead@example.com", name: "Quinn Lead", role: "manager", worker_type: "employee" });
  const report = await addPerson({ email: "robin.report@example.com", name: "Robin Report", role: "employee", worker_type: "employee", manager_id: lead.id });
  // Off the roster for a moment, so the lead can be made an employee, then back.
  await call("PATCH", `/api/people/${report.id}`, { cookie: people.adminSession, body: { active: false } });
  assert.equal((await call("PATCH", `/api/people/${lead.id}`, { cookie: people.adminSession, body: { role: "employee" } })).json.person.role, "employee");
  await call("PATCH", `/api/people/${report.id}`, { cookie: people.adminSession, body: { active: true } });
  seedSlackUsers(dataDir, { U_ROBIN: "robin.report@example.com", U_QUINN: "quinn.lead@example.com" });
  const startedAt = new Date().toISOString();
  const { message } = await askThroughSlack("U_ROBIN", week(4));
  assert.equal(message.body.channel, "D_ADMIN");
  const mail = readdirSync(path.join(dataDir, "outbox")).map((name) => JSON.parse(readFileSync(path.join(dataDir, "outbox", name), "utf8"))).filter((row) => row.at >= startedAt && /Robin Report asked/.test(row.subject));
  assert.deepEqual(mail.map((row) => row.to), [ADMIN]);
});

test("review 2: strangers, bots, other workspaces and unconfirmed emails are not linked; guests are", async () => {
  const sky = await addPerson({ email: "sky.someone@example.com", name: "Sky Someone", role: "employee", worker_type: "employee" });
  seedSlackUsers(dataDir, {
    U_STRANGE: { email: "sky.someone@example.com", is_stranger: true },
    U_OTHERTEAM: { email: "sky.someone@example.com", team_id: "TOTHER" },
    U_ABOT: { email: "sky.someone@example.com", is_bot: true },
    U_UNCONF: { email: "sky.someone@example.com", is_email_confirmed: false },
  });
  for (const member of ["U_STRANGE", "U_OTHERTEAM", "U_ABOT", "U_UNCONF"]) {
    const from = slackCalls(dataDir).length;
    await slack.command(member, "balance");
    const reply = await waitForCall(dataDir, (row) => row.method === "response_url", { from });
    assert.equal(reply.body.text, NOT_ON_ROSTER, member);
  }
  assert.equal((await personById(sky.id)).slack_user_id, null);

  await addPerson({ email: "gale.guest@example.com", name: "Gale Guest", role: "employee", worker_type: "contractor" });
  seedSlackUsers(dataDir, { U_GALE: { email: "gale.guest@example.com", is_restricted: true } });
  const from = slackCalls(dataDir).length;
  await slack.command("U_GALE", "balance");
  const reply = await waitForCall(dataDir, (row) => row.method === "response_url", { from });
  // A monthly contractor: the class default, SMTO and sick days.
  assert.match(reply.body.text, /^\*Your balance for [0-9]{4}:\*.*\n\*Sick time for/);
});

test("review 2: a signed payload from another workspace or app is refused to the clicker", async () => {
  const otherTeam = await slack.command(ids.employee, "balance", { team_id: "TOTHER" });
  assert.equal(otherTeam.status, 403);
  assert.equal(otherTeam.json.response_type, "ephemeral");
  const otherApp = await slack.command(ids.employee, "balance", { api_app_id: "AOTHER" });
  assert.equal(otherApp.status, 403);
  const click = await slack.interact({ ...buttonClick(ids.manager, "approve", "req_000000000000000000"), team: { id: "TOTHER" } });
  assert.equal(click.status, 403);
  assert.ok((await auditActions()).includes("slack.refused"));
});

test("review 2: an existing link is never moved to another member id", async () => {
  seedSlackUsers(dataDir, { U_ELLIOT_TWO: "elliot.employee@example.com" });
  const from = slackCalls(dataDir).length;
  await slack.command("U_ELLIOT_TWO", "balance");
  const reply = await waitForCall(dataDir, (row) => row.method === "response_url", { from });
  assert.equal(reply.body.text, NOT_ON_ROSTER);
  assert.equal((await personById(people.employee.id)).slack_user_id, ids.employee);
  assert.ok((await auditActions()).includes("slack.link_refused"));
});

test("review 3: a note with Slack markup is shown as typed, never as a link", async () => {
  const { id, message } = await askThroughSlack(ids.employee, week(5));
  let from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "deny", id, { channel: message.body.channel }));
  const form = await waitForCall(dataDir, (row) => row.method === "views.open" && row.body.view.callback_id === "timeoff_deny", { from });
  from = slackCalls(dataDir).length;
  await slack.interact({ type: "view_submission", user: { id: ids.manager }, view: { callback_id: "timeoff_deny", private_metadata: form.body.view.private_metadata, state: { values: { note: { value: { value: "<https://evil.example|click> <!channel>" } } } } } });
  const toRequester = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && /did not approve/.test(row.body.text), { from });
  assert.match(toRequester.body.text, /Their note: &lt;https:\/\/evil\.example\|click&gt; &lt;!channel&gt;/);
  const updated = await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
  for (const text of [updated.body.text, JSON.stringify(updated.body.blocks)]) assert.equal(/<https:\/\/evil|<!channel>/.test(text), false);
});

test("review 4: a slow Slack gets 'try again' inside the budget, and no request is made", async () => {
  const slow = await addPerson({ email: "sam.slow@example.com", name: "Sam Slow", role: "employee", worker_type: "employee", manager_id: people.manager.id });
  seedSlackUsers(dataDir, { U_SLOW: { email: "sam.slow@example.com", delay_ms: 2600 } });
  const started = Date.now();
  const answer = await slack.interact(requestSubmission("U_SLOW", week(6)));
  assert.ok(Date.now() - started < 2900, `answered in ${Date.now() - started} ms`);
  assert.equal(answer.json.response_action, "errors");
  assert.equal(answer.json.errors.start, SLACK_SLOW);
  const approvals = (await call("GET", "/api/approvals", { cookie: people.adminSession })).json;
  assert.equal([...approvals.pending, ...approvals.recent].some((row) => row.person.id === slow.id), false);
});

test("review 5: the rewritten message keeps Balance after and Also out then; no 'Not tracked'", async () => {
  const pat = await signIn("pat.peer@example.com");
  const patAsk = await call("POST", "/api/requests", { cookie: pat, body: { ...week(7), kind: "sick" } });
  const morgan = await signIn("morgan.manager@example.com");
  await call("POST", `/api/requests/${patAsk.json.request.id}/approve`, { cookie: morgan, body: {} });
  const { id, message } = await askThroughSlack(ids.employee, week(7));
  assert.match(JSON.stringify(message.body.blocks), /Also out then: Pat Peer/);
  const from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "approve", id, { channel: message.body.channel }));
  const updated = await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
  const blocks = JSON.stringify(updated.body.blocks);
  assert.match(blocks, /Balance after/);
  assert.match(blocks, /Also out then: Pat Peer/);
  const contractorAsk = await askThroughSlack(ids.contractor, { ...week(8), kind: "unpaid" });
  assert.equal(/Not tracked|Balance after/.test(JSON.stringify(contractorAsk.message.body.blocks)), false);
});

test("review 6: a decision that lands before the DM is stored settles the message at once", async () => {
  const row = app.db.prepare("SELECT * FROM requests WHERE status = 'approved' AND person_id = ? AND slack_ts IS NOT NULL ORDER BY created_at DESC").get(people.employee.id);
  app.db.prepare("UPDATE requests SET slack_ts = NULL, slack_channel = NULL WHERE id = ?").run(row.id);
  const from = slackCalls(dataDir).length;
  const ctx = { db: app.db, env: { ALLOW_FIXTURES: "1", SLACK_FIXTURE: "1", DATA_DIR: dataDir }, dataDir };
  const manager = app.db.prepare("SELECT * FROM people WHERE id = ?").get(people.manager.id);
  const person = app.db.prepare("SELECT * FROM people WHERE id = ?").get(people.employee.id);
  await announceRequest(ctx, { request: row, person, approvers: [manager], balanceAfter: 10, overlaps: [] });
  const calls = slackCalls(dataDir).slice(from);
  const posted = calls.findIndex((item) => item.method === "chat.postMessage" && Array.isArray(item.body.blocks));
  const settled = calls.findIndex((item) => item.method === "chat.update" && /Approved by Morgan Manager/.test(item.body.text));
  assert.ok(posted >= 0 && settled > posted, "posted, then settled");
});

// ---------------------------------------------- Type labels, LOA, @Manager --

const outboxNow = () => readdirSync(path.join(dataDir, "outbox")).map((name) => JSON.parse(readFileSync(path.join(dataDir, "outbox", name), "utf8")));
async function waitForMail(match) {
  for (let tries = 0; tries < 75; tries += 1) {
    const found = outboxNow().filter(match);
    if (found.length) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return [];
}
const rosterNow = async () => (await call("GET", "/api/people", { cookie: people.adminSession })).json.people;

test("LOA from Slack: the calendar title says LOA and no balance moves", async () => {
  const elliot = await signIn("elliot.employee@example.com");
  const before = (await call("GET", "/api/home", { cookie: elliot })).json.balance;
  const { id, message } = await askThroughSlack(ids.employee, { ...week(10), kind: "loa" });
  assert.match(JSON.stringify(message.body.blocks), /\*Type\*\\nLOA/);
  const from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "approve", id, { channel: message.body.channel }));
  await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
  const events = JSON.parse(readFileSync(path.join(dataDir, "calendar-fixture.json"), "utf8")).events;
  // The default titles say Out for LOA (the Type stays off the shared calendar).
  assert.equal(events.find((row) => row.description.includes(id)).summary, "Elliot Employee — Out");
  const after = (await call("GET", "/api/home", { cookie: elliot })).json.balance;
  assert.deepEqual([after.pto.available, after.pto.pending, after.sick.available], [before.pto.available, before.pto.pending, before.sick.available]);
});

test("the form's required fields: working days and Manager", async () => {
  const noDays = await slack.interact(requestSubmission(ids.employee, { ...week(25), manager: ids.manager, days: null }));
  assert.equal(noDays.json.errors.days, "Enter the number of working days, like 1.5");
  const noManager = await slack.interact(requestSubmission(ids.employee, { ...week(25) }));
  assert.equal(noManager.json.errors.manager, "Pick your manager");
  // A day and a half, typed: no half-day boxes needed.
  const { message } = await askThroughSlack(ids.employee, { ...week(25), days: 1.5 });
  assert.match(JSON.stringify(message.body.blocks), /\*Days\*\\n1\.5 days \(counted 3\)/);
});

test("typed days from the Slack form: shown as counted and typed", async () => {
  const { message } = await askThroughSlack(ids.employee, { ...week(11), days: 2 });
  assert.match(JSON.stringify(message.body.blocks), /\*Days\*\\n2 days \(counted 3\)/);
  const bad = await slack.interact(requestSubmission(ids.employee, { ...week(12), days: 9 }));
  assert.match(bad.json.errors.days, /half-day steps, from 0\.5 to 3/);
});

test("@Manager: an employee picked is promoted and gets the request; admins are told", async () => {
  // These two run with "anyone"; the default "confirm" is tested further down.
  await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "anyone" } });
  const startedAt = new Date().toISOString();
  const { id, message } = await askThroughSlack(ids.employee, { ...week(13), manager: ids.peer });
  assert.equal(message.body.channel, "D_PAT");
  const pat = (await rosterNow()).find((row) => row.id === people.peer.id);
  assert.equal(pat.role, "manager");
  assert.equal((await rosterNow()).find((row) => row.id === people.employee.id).manager.id, people.manager.id, "Elliot already had a manager");
  const audit = (await call("GET", "/api/audit?limit=500", { cookie: people.adminSession })).json.events;
  assert.ok(audit.some((row) => row.action === "person.promoted_by_request" && row.subject === people.peer.id));
  const toPat = await waitForMail((row) => row.at >= startedAt && row.to === "pat.peer@example.com" && /asked for SMTO/.test(row.subject));
  assert.match(toPat[0].text, /\/approve\//);
  const toAdmin = await waitForMail((row) => row.at >= startedAt && row.to === ADMIN && row.subject === "Elliot Employee picked Pat Peer as their manager");
  assert.match(toAdmin[0].text, /the request is waiting with them and in Approvals/);
  // Pat may now decide it.
  const from = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.peer, "approve", id, { channel: message.body.channel }));
  assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.update" && /Approved by Pat Peer/.test(row.body.text), { from }));
});

test("@Manager: a member not on the roster is added as a manager and becomes the requester's manager", async () => {
  // A requester with no manager yet: Noah adds himself on this first request.
  seedSlackUsers(dataDir, { U_MAYA: { email: "maya.mgr@example.com", real_name: "Maya Mgr" }, U_NOAH: { email: "noah.new@example.com", real_name: "Noah New" } });
  const startedAt = new Date().toISOString();
  const { message } = await askThroughSlack("U_NOAH", { ...week(14), manager: "U_MAYA" });
  assert.equal(message.body.channel, "D_MAYA");
  const roster = await rosterNow();
  const maya = roster.find((row) => row.email === "maya.mgr@example.com");
  assert.deepEqual([maya.name, maya.role, maya.enrolled_via, maya.slack_user_id], ["Maya Mgr", "manager", "slack", "U_MAYA"]);
  assert.equal(roster.find((row) => row.email === "noah.new@example.com").manager.id, maya.id);
  assert.ok((await waitForMail((row) => row.at >= startedAt && row.to === "maya.mgr@example.com" && /Noah New asked for SMTO/.test(row.subject))).length);
  assert.ok((await waitForMail((row) => row.at >= startedAt && row.to === ADMIN && row.subject === "Noah New picked Maya Mgr as their manager")).length);
});

test("@Manager: self, a guest and someone outside the company domain are refused on the picker; nobody is added", async () => {
  const self = await slack.interact(requestSubmission(ids.employee, { ...week(15), manager: ids.employee }));
  assert.equal(self.json.errors.manager, "Pick someone other than yourself.");
  seedSlackUsers(dataDir, { U_GUESTY: { email: "gus.guest@example.com", is_restricted: true }, U_OFFDOM: { email: "olga@elsewhere.org", real_name: "Olga Elsewhere" } });
  const guest = await slack.interact(requestSubmission(ids.employee, { ...week(15), manager: "U_GUESTY" }));
  assert.equal(guest.json.errors.manager, "Pick someone from your company's workspace.");
  await call("PUT", "/api/setup/keys", { cookie: people.adminSession, body: { allowed_email_domain: "example.com" } });
  try {
    const off = await slack.interact(requestSubmission(ids.employee, { ...week(15), manager: "U_OFFDOM" }));
    assert.equal(off.json.errors.manager, "Pick someone from your company's workspace.");
  } finally {
    await call("PUT", "/api/setup/keys", { cookie: people.adminSession, body: { allowed_email_domain: "" } });
  }
  const roster = await rosterNow();
  assert.equal(roster.some((row) => row.email === "gus.guest@example.com" || row.email === "olga@elsewhere.org"), false);
});

// ------------------------------------------------------ security review 2 --

test("sec: a guest cannot add themselves; with no company domain nobody can", async () => {
  seedSlackUsers(dataDir, { U_GUESTNEW: { email: "gwen.guest@example.com", is_restricted: true }, U_NODOMAIN: { email: "nell.nodomain@example.com" } });
  const from = slackCalls(dataDir).length;
  await slack.command("U_GUESTNEW", "balance");
  const reply = await waitForCall(dataDir, (row) => row.method === "response_url", { from });
  assert.equal(reply.body.text, NOT_ON_ROSTER);
  // The same lookup with no company domain set: blocked, nothing created.
  const { resolveMember } = await import("../server/slack/identity.mjs");
  const ctx = { db: app.db, env: { ALLOW_FIXTURES: "1", SLACK_FIXTURE: "1", DATA_DIR: dataDir }, dataDir };
  assert.equal((await resolveMember(ctx, "U_NODOMAIN")).reason, "not_on_roster");
  const roster = (await call("GET", "/api/people", { cookie: people.adminSession })).json.people;
  assert.equal(roster.some((row) => row.email === "gwen.guest@example.com" || row.email === "nell.nodomain@example.com"), false);
  const settings = (await call("GET", "/api/settings", { cookie: people.adminSession })).json.slack;
  assert.equal(settings.auto_enroll_blocked_reason, null);
});

test("sec: calendar titles can show the Type; the default says Out", async () => {
  const set = await call("PUT", "/api/settings/calendar", { cookie: people.adminSession, body: { titles: "type" } });
  assert.equal(set.json.settings.calendar.titles, "type");
  assert.equal((await call("PUT", "/api/settings/calendar", { cookie: people.adminSession, body: { titles: "secret" } })).json.error.code, "invalid_titles");
  try {
    const { id, message } = await askThroughSlack(ids.employee, { ...week(16), kind: "sick" });
    const from = slackCalls(dataDir).length;
    await slack.interact(buttonClick(ids.manager, "approve", id, { channel: message.body.channel }));
    await waitForCall(dataDir, (row) => row.method === "chat.update", { from });
    const events = JSON.parse(readFileSync(path.join(dataDir, "calendar-fixture.json"), "utf8")).events;
    assert.equal(events.find((row) => row.description.includes(id)).summary, "Elliot Employee — Sick");
  } finally {
    await call("PUT", "/api/settings/calendar", { cookie: people.adminSession, body: { titles: "out" } });
  }
});

test("sec: managers-only picks; a pick that makes someone a manager DMs the linked admins", async () => {
  const only = await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "managers_only" } });
  assert.equal(only.json.settings.slack.manager_pick, "managers_only");
  try {
    const refused = await slack.interact(requestSubmission(ids.employee, { ...week(17), manager: "U_QUINN" }));
    assert.equal(refused.json.errors.manager, "Pick one of your company's managers");
    seedSlackUsers(dataDir, { U_NEWCOMER: { email: "nico.newcomer@example.com", real_name: "Nico Newcomer" } });
    const stranger = await slack.interact(requestSubmission(ids.employee, { ...week(17), manager: "U_NEWCOMER" }));
    assert.equal(stranger.json.errors.manager, "Pick one of your company's managers");
    assert.equal((await rosterNow()).some((row) => row.email === "nico.newcomer@example.com"), false);
  } finally {
    await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "anyone" } });
  }
  // "anyone": Quinn (an employee now) is promoted, and the linked admin hears at once.
  const from = slackCalls(dataDir).length;
  await askThroughSlack(ids.employee, { ...week(17), manager: "U_QUINN" });
  const told = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /picked Quinn Lead as their manager in Slack, so Quinn Lead was made a manager/.test(row.body.text), { from });
  assert.ok(told);
});

// ------------------------------------------- the Manager pick, "confirm" --

test("confirm_every: even an existing manager picked goes to the admins first; Yes sends it on to them", async () => {
  const set = await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "confirm_every" } });
  assert.equal(set.json.settings.slack.manager_pick, "confirm_every");
  try {
    const from = slackCalls(dataDir).length;
    await slack.interact(requestSubmission(ids.employee, { ...week(23), manager: ids.manager }));
    const asked = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /named Morgan Manager as their manager\. Is that right\?/.test(row.body.text), { from });
    assert.ok(asked, "the admins are asked about Morgan, who is already a manager");
    const id = asked.body.blocks.find((block) => block.block_id === "manager_pick").elements[0].value;
    // Nothing went to Morgan yet, and it is not in Morgan's queue.
    assert.equal(slackCalls(dataDir).slice(from).some((row) => row.method === "chat.postMessage" && row.body.channel === "D_MORGAN"), false);
    const morgan = await signIn("morgan.manager@example.com");
    assert.equal((await call("GET", "/api/approvals", { cookie: morgan })).json.pending.some((row) => row.request.id === id), false);
    const waiting = (await call("GET", "/api/approvals", { cookie: people.adminSession })).json.pending.find((row) => row.request.id === id).request;
    assert.deepEqual([waiting.approver, waiting.pending_manager.person_id], [null, people.manager.id]);
    // Yes: on to Morgan with buttons; Morgan stays a manager.
    const mark = slackCalls(dataDir).length;
    await slack.interact(buttonClick(ids.admin, "confirm_manager", id, { channel: asked.body.channel }));
    assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_MORGAN" && Array.isArray(row.body.blocks) && row.body.blocks.some((block) => block.type === "actions"), { from: mark }));
    const now = (await call("GET", "/api/approvals", { cookie: morgan })).json.pending.find((row) => row.request.id === id).request;
    assert.deepEqual([now.approver.id, now.pending_manager], [people.manager.id, null]);
    assert.equal((await rosterNow()).find((row) => row.id === people.manager.id).role, "manager");
    // Requests from the site still go straight to the chosen manager.
    const elliot = await signIn("elliot.employee@example.com");
    const web = (await call("POST", "/api/requests", { cookie: elliot, body: { ...week(24), kind: "pto", approver_id: people.manager.id } })).json.request;
    assert.deepEqual([web.approver.id, web.pending_manager], [people.manager.id, null]);
  } finally {
    await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "confirm_new" } });
  }
});

test("confirm: an employee picked is not promoted; the admins are asked, with Yes / No and Approve / Deny", async () => {
  await call("PUT", "/api/settings/slack", { cookie: people.adminSession, body: { manager_pick: "confirm_new" } });
  const vera = (await call("POST", "/api/people", { cookie: people.adminSession, body: { email: "vera.veteran@example.com", name: "Vera Veteran", role: "employee", worker_type: "employee" } })).json.person;
  seedSlackUsers(dataDir, { U_VERA: "vera.veteran@example.com" });
  const startedAt = new Date().toISOString();
  const from = slackCalls(dataDir).length;
  const answer = await slack.interact(requestSubmission(ids.employee, { ...week(18), manager: "U_VERA" }));
  assert.equal(answer.status, 200);
  const asked = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /named Vera Veteran as their manager\. Is that right\?/.test(row.body.text), { from });
  assert.ok(asked, "the admin was asked");
  const buttons = asked.body.blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements.map((element) => element.action_id));
  assert.deepEqual(buttons, ["confirm_manager", "reject_manager", "approve", "deny"]);
  const id = asked.body.blocks.find((block) => block.block_id === "manager_pick").elements[0].value;
  assert.equal((await rosterNow()).find((row) => row.id === vera.id).role, "employee", "not promoted yet");
  const approvals = (await call("GET", "/api/approvals", { cookie: people.adminSession })).json.pending.find((row) => row.request.id === id);
  assert.deepEqual(approvals.request.pending_manager, { slack_user_id: "U_VERA", email: "vera.veteran@example.com", name: "Vera Veteran", person_id: vera.id });
  assert.equal(approvals.request.approver, null);
  // Not in Elliot's own manager's queue: it waits with the admins.
  const morgan = await signIn("morgan.manager@example.com");
  assert.equal((await call("GET", "/api/approvals", { cookie: morgan })).json.pending.some((row) => row.request.id === id), false);
  const mail = await waitForMail((row) => row.at >= startedAt && row.to === ADMIN && row.subject === "Elliot Employee named Vera Veteran as their manager");
  assert.match(mail[0].text, /\/approve\//);

  // A non-admin's Yes is refused (Slack and the site), and nothing changes.
  let mark = slackCalls(dataDir).length;
  await slack.interact(buttonClick(ids.manager, "confirm_manager", id));
  const refused = await waitForCall(dataDir, (row) => row.method === "chat.postEphemeral", { from: mark });
  assert.equal(refused.body.text, "Only an admin can confirm a manager.");
  assert.equal((await call("POST", `/api/requests/${id}/confirm-manager`, { cookie: morgan, body: {} })).status, 403);
  assert.equal((await rosterNow()).find((row) => row.id === vera.id).role, "employee");

  // The admin's Yes: promoted, approver, forwarded with buttons; the admin message closes.
  mark = slackCalls(dataDir).length;
  const mailFrom = new Date().toISOString();
  await slack.interact(buttonClick(ids.admin, "confirm_manager", id, { channel: asked.body.channel }));
  const settled = await waitForCall(dataDir, (row) => row.method === "chat.update" && /Confirmed by Admin: Vera Veteran is a manager/.test(row.body.text), { from: mark });
  assert.ok(settled);
  const forwarded = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_VERA" && Array.isArray(row.body.blocks) && row.body.blocks.some((block) => block.type === "actions"), { from: mark });
  assert.ok(forwarded, "the new manager gets it with buttons");
  assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && /^Sent to Vera Veteran for approval/.test(row.body.text), { from: mark }));
  assert.ok((await waitForMail((row) => row.at >= mailFrom && row.to === "vera.veteran@example.com" && /Elliot Employee asked for/.test(row.subject))).length);
  const veraNow = (await rosterNow()).find((row) => row.id === vera.id);
  assert.equal(veraNow.role, "manager");
  const request = (await call("GET", "/api/approvals", { cookie: people.adminSession })).json.pending.find((row) => row.request.id === id).request;
  assert.deepEqual([request.approver.id, request.pending_manager], [vera.id, null]);
  assert.equal((await rosterNow()).find((row) => row.id === people.employee.id).manager.id, people.manager.id, "Elliot already had a manager");
  const audit = (await call("GET", "/api/audit?limit=500", { cookie: people.adminSession })).json.events;
  assert.ok(audit.some((row) => row.action === "person.manager_confirmed" && row.subject === vera.id));

  // A second pick of Vera, now a manager, goes straight to her.
  const { message } = await askThroughSlack(ids.employee, { ...week(19), manager: "U_VERA" });
  assert.equal(message.body.channel, "D_VERA");
});

test("confirm: a member not on the roster is only named; No keeps the request with the admins", async () => {
  seedSlackUsers(dataDir, { U_WALT: { email: "walt.named@example.com", real_name: "Walt Named" } });
  const from = slackCalls(dataDir).length;
  await slack.interact(requestSubmission(ids.employee, { ...week(20), manager: "U_WALT" }));
  const asked = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /named Walt Named as their manager/.test(row.body.text), { from });
  const id = asked.body.blocks.find((block) => block.block_id === "manager_pick").elements[0].value;
  assert.equal((await rosterNow()).some((row) => row.email === "walt.named@example.com"), false, "nobody added before a yes");
  // No, from the site this time.
  const mark = slackCalls(dataDir).length;
  const no = await call("POST", `/api/requests/${id}/reject-manager`, { cookie: people.adminSession, body: {} });
  assert.equal(no.json.request.pending_manager.rejected, true);
  assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.text === "Walt Named isn't set up as a manager; an admin will handle this one.", { from: mark }));
  const updated = await waitForCall(dataDir, (row) => row.method === "chat.update" && /not confirmed as manager/.test(row.body.text), { from: mark });
  assert.deepEqual(updated.body.blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements.map((element) => element.action_id)), ["approve", "deny"]);
  assert.equal((await rosterNow()).some((row) => row.email === "walt.named@example.com"), false);
  assert.equal((await call("POST", `/api/requests/${id}/confirm-manager`, { cookie: people.adminSession, body: {} })).json.error.code, "no_pending_manager");
  // Still with the admins, who can decide it.
  assert.equal((await call("POST", `/api/requests/${id}/approve`, { cookie: people.adminSession, body: {} })).json.request.status, "approved");
});

test("remind: the Slack message is posted again once the last one is over ten minutes old", async () => {
  const { id, message } = await askThroughSlack(ids.employee, { ...week(21) });
  const morgan = await signIn("morgan.manager@example.com");
  // Fresh message: the reminder is email only.
  let from = slackCalls(dataDir).length;
  assert.equal((await call("POST", `/api/requests/${id}/remind`, { cookie: morgan, body: {} })).status, 200);
  assert.equal(slackCalls(dataDir).slice(from).some((row) => row.method === "chat.postMessage"), false);
  // An hour-old message: posted again, and both close on the decision.
  app.db.prepare("UPDATE requests SET slack_ts = ?, last_reminded_at = NULL WHERE id = ?").run(String(Math.floor(Date.now() / 1000) - 3600) + ".000001", id);
  from = slackCalls(dataDir).length;
  assert.equal((await call("POST", `/api/requests/${id}/remind`, { cookie: morgan, body: {} })).status, 200);
  const again = slackCalls(dataDir).slice(from).find((row) => row.method === "chat.postMessage" && row.body.channel === message.body.channel);
  assert.ok(again && /^Reminder: Elliot Employee asked for SMTO/.test(again.body.text));
  from = slackCalls(dataDir).length;
  await call("POST", `/api/requests/${id}/approve`, { cookie: morgan, body: {} });
  assert.equal(slackCalls(dataDir).slice(from).filter((row) => row.method === "chat.update").length, 2);
});

// ------------------------------------------------ Yes / No from the email --

const emailLink = (text, path) => (String(text).match(new RegExp(`/${path}/([A-Za-z0-9_-]{43})`)) || [])[1];

/** Elliot names `member` as manager; returns the request id and the admin's email. */
async function nameManager(member, entry, week_) {
  seedSlackUsers(dataDir, { [member]: entry });
  const startedAt = new Date().toISOString();
  const from = slackCalls(dataDir).length;
  await slack.interact(requestSubmission(ids.employee, { ...week(week_), manager: member }));
  const asked = await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_ADMIN" && /as their manager\. Is that right\?/.test(row.body.text), { from });
  const id = asked.body.blocks.find((block) => block.block_id === "manager_pick").elements[0].value;
  const [mail] = await waitForMail((row) => row.at >= startedAt && row.to === ADMIN && / named .+ as their manager$/.test(row.subject));
  return { id, mail };
}

test("email: the manager question carries Yes, No, Approve anyway and Deny; Yes promotes and forwards, and spends the pair", async () => {
  const xavi = (await call("POST", "/api/people", { cookie: people.adminSession, body: { email: "xavi.employee@example.com", name: "Xavi Employee", role: "employee", worker_type: "employee" } })).json.person;
  const { id, mail } = await nameManager("U_XAVI", "xavi.employee@example.com", 26);
  const yes = emailLink(mail.text, "confirm-manager");
  const no = emailLink(mail.text, "reject-manager");
  const approve = emailLink(mail.text, "approve");
  const deny = emailLink(mail.text, "deny");
  assert.ok(yes && no && approve && deny, "all four links in the text part");
  // HTML: in order Yes (green), No (grey), Approve anyway, Deny.
  const order = ["Yes, Xavi Employee is their manager", ">No<", "Approve anyway", ">Deny<"].map((label) => mail.html.indexOf(label));
  assert.ok(order.every((at) => at > 0) && order.every((at, index) => index === 0 || at > order[index - 1]), JSON.stringify(order));
  assert.match(mail.html, new RegExp(`<a href="[^"]+/confirm-manager/${yes}"[^>]*background:#1f7a4d`));
  assert.match(mail.html, new RegExp(`<a href="[^"]+/reject-manager/${no}"[^>]*background:#6b7280`));
  assert.match(mail.html, new RegExp(`<a href="[^"]+/approve/${approve}"[^>]*max-width:240px[^>]*background:#6b7280`));

  const look = (await call("GET", `/api/decide/${yes}`)).json;
  assert.deepEqual([look.state, look.action, look.manager_name, look.approver_name], ["pending", "confirm_manager", "Xavi Employee", "Admin"]);
  const mark = slackCalls(dataDir).length;
  const done = await call("POST", `/api/decide/${yes}`, { body: {} });
  assert.equal(done.status, 200);
  assert.equal((await rosterNow()).find((row) => row.id === xavi.id).role, "manager");
  assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.channel === "D_XAVI" && row.body.blocks?.some((block) => block.type === "actions"), { from: mark }), "forwarded to Xavi with buttons");
  // Both links of the pair are spent; the approve/deny pair still works for the admin.
  assert.equal((await call("GET", `/api/decide/${no}`)).json.state, "already_decided");
  assert.equal((await call("POST", `/api/decide/${yes}`, { body: {} })).json.error.code, "already_decided");
  assert.equal((await call("GET", `/api/decide/${approve}`)).json.state, "pending");
  // Deciding with one of a pair spends the other.
  assert.equal((await call("POST", `/api/decide/${approve}`, { body: {} })).json.request.status, "approved");
  assert.equal((await call("GET", `/api/decide/${deny}`)).json.state, "already_decided");
  const pair = app.db.prepare("SELECT count(*) AS n FROM decide_links WHERE request_id = ? AND used_at IS NOT NULL").get(id).n;
  assert.ok(pair >= 4);
});

test("email: No keeps the request with the admins; only admins ever get Yes / No links", async () => {
  const { id, mail } = await nameManager("U_YARA", { email: "yara.named@example.com", real_name: "Yara Named" }, 27);
  const no = emailLink(mail.text, "reject-manager");
  const yes = emailLink(mail.text, "confirm-manager");
  const mark = slackCalls(dataDir).length;
  assert.equal((await call("POST", `/api/decide/${no}`, { body: {} })).status, 200);
  const waiting = (await call("GET", "/api/approvals", { cookie: people.adminSession })).json.pending.find((row) => row.request.id === id).request;
  assert.equal(waiting.pending_manager.rejected, true);
  assert.equal(waiting.approver, null);
  assert.ok(await waitForCall(dataDir, (row) => row.method === "chat.postMessage" && row.body.text === "Yara Named isn't set up as a manager; an admin will handle this one.", { from: mark }));
  assert.equal((await rosterNow()).some((row) => row.email === "yara.named@example.com"), false);
  assert.equal((await call("GET", `/api/decide/${yes}`)).json.state, "already_decided");
  // Every Yes / No link ever made went to an admin.
  const holders = app.db.prepare("SELECT DISTINCT people.role FROM decide_links JOIN people ON people.id = decide_links.approver_id WHERE action IN ('confirm_manager', 'reject_manager')").all().map((row) => row.role);
  assert.deepEqual(holders, ["admin"]);
});

test("email: a Yes link on a request already decided answers already_decided", async () => {
  const { id, mail } = await nameManager("U_ZORA", { email: "zora.named@example.com", real_name: "Zora Named" }, 28);
  const yes = emailLink(mail.text, "confirm-manager");
  assert.equal((await call("POST", `/api/requests/${id}/deny`, { cookie: people.adminSession, body: {} })).json.request.status, "denied");
  assert.equal((await call("GET", `/api/decide/${yes}`)).json.state, "already_decided");
  const tried = await call("POST", `/api/decide/${yes}`, { body: {} });
  assert.equal(tried.status, 409);
  assert.equal(tried.json.error.code, "already_decided");
  assert.equal((await rosterNow()).some((row) => row.email === "zora.named@example.com"), false);
});

// Last: it leaves this address throttled for the Slack door.
test("sec: 20 bad signatures from one address, then 429 before the body is read; one audit row a minute", async () => {
  let status = 0;
  let sent = 0;
  while (status !== 429 && sent < 30) {
    status = (await slack.post("/api/slack/commands", { command: "/timeoff", text: "help", user_id: ids.peer }, { sign: "wrong-secret" })).status;
    sent += 1;
  }
  assert.equal(status, 429);
  // A properly signed request from the same address is now turned away too.
  assert.equal((await slack.command(ids.peer, "help")).status, 429);
  const rows = (await call("GET", "/api/audit?limit=500", { cookie: people.adminSession })).json.events.filter((row) => row.action === "slack.bad_signature");
  assert.equal(rows.length, 1);
});

test("fix: nothing is created after the request's deadline; a linked pick needs no Slack lookup", async () => {
  const { resolveMember } = await import("../server/slack/identity.mjs");
  seedSlackUsers(dataDir, { U_LATE: { email: "lou.late@example.com" } });
  const ctx = { db: app.db, env: { ALLOW_FIXTURES: "1", SLACK_FIXTURE: "1", DATA_DIR: dataDir, ALLOWED_EMAIL_DOMAIN: "example.com" }, dataDir, deadline: Date.now() - 1 };
  assert.equal((await resolveMember(ctx, "U_LATE")).reason, "slow");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await call("GET", "/api/people", { cookie: people.adminSession })).json.people.some((row) => row.email === "lou.late@example.com"), false);

  // Two lookups of a new member at once make one person.
  seedSlackUsers(dataDir, { U_TWICE: { email: "tia.twice@example.com" } });
  const live = { ...ctx, deadline: null };
  const [a, b] = await Promise.all([resolveMember(live, "U_TWICE"), resolveMember(live, "U_TWICE")]);
  assert.equal(a.person.id, b.person.id);
  assert.equal((await call("GET", "/api/people", { cookie: people.adminSession })).json.people.filter((row) => row.email === "tia.twice@example.com").length, 1);
});

test("fix: picking someone already linked asks Slack nothing", async () => {
  const { resolveManagerPick } = await import("../server/slack/identity.mjs");
  const ctx = { db: app.db, env: { ALLOW_FIXTURES: "1", SLACK_FIXTURE: "1", DATA_DIR: dataDir, ALLOWED_EMAIL_DOMAIN: "example.com" }, dataDir };
  const requester = app.db.prepare("SELECT * FROM people WHERE id = ?").get(people.employee.id);
  const from = slackCalls(dataDir).length;
  const found = await resolveManagerPick(ctx, ids.manager, requester);
  assert.equal(found.person.id, people.manager.id);
  assert.equal(slackCalls(dataDir).slice(from).some((row) => row.method === "users.info"), false);
});
