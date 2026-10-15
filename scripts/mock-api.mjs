// A stand-in for the real server, for walking every screen of the client
// with `npm run dev`. Implements enough of docs/API.md with in-memory sample
// people (all @example.com), requests in every status, holidays, and a
// connected calendar. Nothing leaves this process: no Google, no email, no
// files. Data resets when it restarts.
//
//   node scripts/mock-api.mjs          (port 5610, loopback only)
//
// Two routes exist only here, for the client's dev-only "sign in as" bar:
//   GET  /api/mock/roles               -> { roles, current }
//   POST /api/mock/signin-as { role }  -> { ok: true }
// and one for testing error handling:
//   POST /api/mock/fail-next           -> the next change (POST/PUT/PATCH) fails
//   POST /api/mock/slack { on, fixture } -> switch the Slack connection
//   POST /api/mock/mail { transport, needs_reconnect } -> switch how email goes out
//   POST /api/mock/setup { google, slack } -> mark the keys as set or not set
// The setup link's token here is "mock-setup-token": /setup?token=mock-setup-token
// Email decide links: /approve/demo-approve, /deny/demo-deny, /approve/demo-expired, /approve/demo-used,
// /confirm-manager/demo-confirm, /reject-manager/demo-reject

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 5610);
const HOST = "127.0.0.1";

// ------------------------------------------------------------------ dates --

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const YEAR = Number(TODAY.slice(0, 4));
const isWeekend = (s) => [0, 6].includes(utc(s).getUTCDay());
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(utc(s)) === s;
/** today + n days, moved forward off a weekend */
const day = (n) => {
  let s = addDays(TODAY, n);
  while (isWeekend(s)) s = addDays(s, 1);
  return s;
};
const stamp = (daysAgo, hour = 15) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
};

// --------------------------------------------------------------- holidays --

const holidays = new Map([
  [
    YEAR,
    [
      [`${YEAR}-01-01`, "New Year’s Day"],
      [`${YEAR}-05-25`, "Memorial Day"],
      [`${YEAR}-07-03`, "Independence Day (observed)"],
      [`${YEAR}-09-07`, "Labor Day"],
      [`${YEAR}-11-26`, "Thanksgiving"],
      [`${YEAR}-11-27`, "Day after Thanksgiving"],
      [`${YEAR}-12-24`, "Christmas Eve"],
      [`${YEAR}-12-25`, "Christmas Day"],
    ].map(([date, name]) => ({ date, name })),
  ],
  [
    YEAR + 1,
    [
      [`${YEAR + 1}-01-01`, "New Year’s Day"],
      [`${YEAR + 1}-05-31`, "Memorial Day"],
      [`${YEAR + 1}-07-05`, "Independence Day (observed)"],
      [`${YEAR + 1}-09-06`, "Labor Day"],
      [`${YEAR + 1}-11-25`, "Thanksgiving"],
      [`${YEAR + 1}-11-26`, "Day after Thanksgiving"],
      [`${YEAR + 1}-12-24`, "Christmas Day (observed)"],
    ].map(([date, name]) => ({ date, name })),
  ],
]);
const allHolidays = () => [...holidays.values()].flat();
const holidayOn = (s) => allHolidays().find((h) => h.date === s) ?? null;

function workingDays(start, end, halfStart = false, halfEnd = false) {
  let total = 0;
  for (let s = start; s <= end; s = addDays(s, 1)) {
    if (isWeekend(s) || holidayOn(s)) continue;
    let value = 1;
    if (s === start && halfStart) value = 0.5;
    if (s === end && halfEnd && end !== start) value = 0.5;
    total += value;
  }
  return total;
}

// ------------------------------------------------------------------ people --

const people = [
  { id: "p_admin", email: "morgan.lee@example.com", name: "Morgan Lee", role: "admin", worker_type: "employee", manager_id: null, active: true, timezone: "America/Chicago", slack_user_id: null, team: "Operations", pay_basis: "monthly", hours_per_day: 8 },
  { id: "p_mgr", email: "jordan.reyes@example.com", name: "Jordan Reyes", role: "manager", worker_type: "employee", manager_id: "p_admin", active: true, timezone: "America/Chicago", slack_user_id: "U01MGR0001", team: "Support", pay_basis: "monthly", hours_per_day: 8 },
  { id: "p_sam", email: "sam.carter@example.com", name: "Sam Carter", role: "employee", worker_type: "employee", manager_id: "p_mgr", active: true, timezone: "America/New_York", slack_user_id: "U01SAM0002", team: "Support", pay_basis: "monthly", hours_per_day: 8 },
  { id: "p_priya", email: "priya.shah@example.com", name: "Priya Shah", role: "employee", worker_type: "employee", manager_id: "p_mgr", active: true, timezone: "America/Denver", slack_user_id: "U01PRI0003", team: "Support", pay_basis: "monthly", hours_per_day: 8 },
  { id: "p_leo", email: "leo.park@example.com", name: "Leo Park", role: "employee", worker_type: "employee", manager_id: "p_mgr", active: true, timezone: "America/Los_Angeles", slack_user_id: null, team: "Operations", pay_basis: "hourly", hours_per_day: 8 },
  { id: "p_riley", email: "riley.chen@example.com", name: "Riley Chen", role: "employee", worker_type: "contractor", manager_id: "p_mgr", active: true, timezone: "Asia/Manila", slack_user_id: null, team: "Operations", pay_basis: "hourly", hours_per_day: 6 },
  { id: "p_avery", email: "avery.brooks@example.com", name: "Avery Brooks", role: "employee", worker_type: "employee", manager_id: null, active: true, timezone: "America/Chicago", slack_user_id: "U01AVE0004", team: null, pay_basis: "monthly", hours_per_day: 8, enrolled_via: "slack" },
  { id: "p_noor", email: "noor.haddad@example.com", name: "Noor Haddad", role: "employee", worker_type: "contractor", manager_id: "p_mgr", active: true, timezone: "America/Chicago", slack_user_id: null, team: "Operations", pay_basis: "monthly", hours_per_day: 8 },
  { id: "p_casey", email: "casey.doyle@example.com", name: "Casey Doyle", role: "employee", worker_type: "employee", manager_id: "p_mgr", active: false, timezone: "America/New_York", slack_user_id: null, team: "Support", pay_basis: "monthly", hours_per_day: 8 },
];

const policies = new Map([
  ["p_admin", { annual_days: 20, accrual: "front_loaded", carryover_cap: 5, start_date: "2019-03-04", sick_days: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
  ["p_mgr", { annual_days: 20, accrual: "front_loaded", carryover_cap: 5, start_date: "2021-06-14", sick_days: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
  ["p_sam", { annual_days: 15, accrual: "front_loaded", carryover_cap: 5, start_date: "2023-01-09", sick_days: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
  ["p_priya", { annual_days: 15, accrual: "front_loaded", carryover_cap: 5, start_date: "2024-08-19", sick_days: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
  ["p_leo", { annual_days: 12, accrual: "monthly", carryover_cap: 3, start_date: `${YEAR}-02-02`, sick_days: 0, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
  ["p_riley", { annual_days: 15, accrual: "front_loaded", carryover_cap: 0, start_date: "2025-05-01", sick_days: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false }],
  ["p_noor", { annual_days: 10, accrual: "monthly", carryover_cap: 0, start_date: "2024-03-01", sick_days: 5, pto_unlimited: false, sick_unlimited: false, holidays_apply: true }],
  ["p_casey", { annual_days: 15, accrual: "front_loaded", carryover_cap: 5, start_date: "2022-04-11", sick_days: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true }],
]);
const carried = new Map([["p_sam", 2], ["p_admin", 5], ["p_mgr", 3]]);
const adjustments = []; // { person_id, days, note, at }
adjustments.push({ person_id: "p_priya", days: 1, note: "Worked the holiday weekend", at: stamp(50) });

// The roster above stands in for a company's demo data; people added later are real.
const SAMPLE_IDS = new Set(people.map((p) => p.id));
const byId = (id) => people.find((p) => p.id === id) ?? null;
const ref = (p) => (p ? { id: p.id, name: p.name } : null);
const personOut = (p) => ({
  id: p.id, email: p.email, name: p.name, role: p.role, worker_type: p.worker_type,
  manager: ref(byId(p.manager_id)), active: p.active, timezone: p.timezone, slack_user_id: p.slack_user_id,
  team: p.team ?? null, pay_basis: p.pay_basis ?? "monthly", hours_per_day: p.hours_per_day ?? 8,
  enrolled_via: p.enrolled_via ?? "admin", needs_setup: !policies.has(p.id) && !p.manager_id, class: classOf(p),
  sample: p.sample ?? SAMPLE_IDS.has(p.id),
});
const classOf = (p) => (p.worker_type !== "contractor" ? "employee" : p.pay_basis === "hourly" ? "contractor_hourly" : "contractor_monthly");
const CLASS_DEFAULTS = {
  employee: { annual_days: 15, sick_days: 5, carryover_cap: 5, pto_unlimited: true, sick_unlimited: true, holidays_apply: true },
  contractor_monthly: { annual_days: 10, sick_days: 5, carryover_cap: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false },
  contractor_hourly: { annual_days: 15, sick_days: 0, carryover_cap: 0, pto_unlimited: false, sick_unlimited: false, holidays_apply: false },
};
// Types each person may ask for (the server sends these on /api/me).
const kindsFor = (p) => (classOf(p) === "contractor_hourly" ? ["pto", "unpaid", "loa"] : ["pto", "sick", "unpaid", "loa"]);
const teamsList = () => [...new Set(people.map((q) => q.team).filter(Boolean))].sort();

// --------------------------------------------------------------- requests --

let seq = 100;
const requests = [];
const mgr = { id: "p_mgr", name: "Jordan Reyes" };
const adm = { id: "p_admin", name: "Morgan Lee" };
const reqId = () => `req_${(++seq).toString(16).padStart(18, "0")}`;
function seed(person_id, kind, status, start, end, extra = {}) {
  const r = {
    id: reqId(), person_id, kind, status, start_date: start, end_date: end,
    half_day_start: false, half_day_end: false, days: 0, note: "",
    decided_by: null, decided_at: null, decision_note: "",
    approver: ref(byId(byId(person_id)?.manager_id)),
    calendar: { state: "none", event_id: null, error: null },
    created_at: stamp(12), updated_at: stamp(12), ...extra,
  };
  r.days_computed = workingDays(r.start_date, r.end_date, r.half_day_start, r.half_day_end);
  r.days_overridden = typeof extra.days_requested === "number";
  r.days = r.days_overridden ? extra.days_requested : r.days_computed;
  delete r.days_requested;
  r.hours = r.days * (byId(person_id)?.hours_per_day ?? 8);
  requests.push(r);
  return r;
}
const added = () => ({ state: "added", event_id: `evt_${++seq}`, error: null });

seed("p_sam", "pto", "pending", day(6), addDays(day(6), 2), { note: "Cousin’s wedding in Denver", created_at: stamp(1) });
seed("p_sam", "pto", "approved", day(20), addDays(day(20), 2), { decided_by: mgr, decided_at: stamp(4), decision_note: "Have fun!", calendar: added() });
seed("p_sam", "pto", "denied", day(-38), addDays(day(-38), 4), { note: "Beach week", decided_by: mgr, decided_at: stamp(25), decision_note: "We’re short that week with the launch. Could you move it?" });
seed("p_sam", "sick", "cancelled", day(-20), day(-20), { created_at: stamp(21) });
seed("p_priya", "pto", "pending", day(7), addDays(day(7), 3), { note: "Visiting family", created_at: stamp(2) });
seed("p_priya", "pto", "approved", addDays(TODAY, -2), addDays(TODAY, 2), { decided_by: mgr, decided_at: stamp(10), calendar: added() });
seed("p_leo", "pto", "approved", day(13), day(13), { half_day_start: true, decided_by: mgr, decided_at: stamp(1), calendar: { state: "pending", event_id: null, error: "Google Calendar didn’t answer. It will be tried again." } });
seed("p_leo", "unpaid", "pending", day(27), addDays(day(27), 2), { note: "Moving apartments", created_at: stamp(0, 9) });
seed("p_avery", "pto", "pending", day(16), addDays(day(16), 1), { note: "First trip home this year", approver: null, pending_manager: { name: "Pat Quinn", email: "pat.quinn@example.com" }, created_at: stamp(0, 10) });
seed("p_mgr", "loa", "pending", day(55), addDays(day(55), 3), { note: "Family leave, back on the Monday after", days_requested: 2, created_at: stamp(1, 11) });
seed("p_riley", "unavailable", "pending", day(14), addDays(day(14), 4), { created_at: stamp(3) });
seed("p_riley", "unavailable", "approved", day(-10), addDays(day(-10), 2), { decided_by: mgr, decided_at: stamp(15), calendar: added() });
seed("p_mgr", "pto", "pending", day(30), addDays(day(30), 4), { note: "Fall trip", created_at: stamp(2) });
seed("p_mgr", "pto", "approved", day(-60), addDays(day(-60), 1), { decided_by: adm, decided_at: stamp(70), calendar: added() });
seed("p_admin", "pto", "approved", day(40), addDays(day(40), 4), { decided_by: adm, decided_at: stamp(5), calendar: added() });

// Earlier this year, both teams, every kind (approved), so reports and charts have shape.
const firstWeekday = (month, dayOfMonth) => {
  let d = `${YEAR}-${pad(month)}-${pad(dayOfMonth)}`;
  while (isWeekend(d) || holidayOn(d)) d = addDays(d, 1);
  return d;
};
const HISTORY = [
  ["p_sam", "pto", 1, 12, 2], ["p_priya", "sick", 1, 20, 1], ["p_leo", "pto", 2, 9, 3], ["p_riley", "unavailable", 2, 16, 2],
  ["p_mgr", "pto", 3, 2, 4], ["p_sam", "sick", 3, 18, 1], ["p_priya", "pto", 3, 23, 4], ["p_leo", "sick", 4, 7, 2],
  ["p_admin", "pto", 4, 13, 3], ["p_riley", "unavailable", 5, 4, 4], ["p_sam", "pto", 5, 18, 4], ["p_priya", "unpaid", 5, 26, 2], ["p_admin", "loa", 6, 1, 5], ["p_priya", "loa", 8, 3, 3],
  ["p_leo", "pto", 6, 15, 4], ["p_mgr", "sick", 6, 22, 1], ["p_sam", "pto", 7, 6, 4], ["p_priya", "pto", 7, 13, 4],
  ["p_admin", "pto", 7, 20, 4], ["p_riley", "unavailable", 7, 27, 3], ["p_leo", "unpaid", 8, 3, 2], ["p_mgr", "pto", 8, 10, 4],
  ["p_priya", "sick", 8, 24, 2], ["p_sam", "sick", 9, 14, 1], ["p_admin", "sick", 9, 28, 1],
];
for (const [who, kind, month, dom, len] of HISTORY) {
  const start = firstWeekday(month, dom);
  if (start >= addDays(TODAY, -14)) continue; // keep the recent sample above as written
  let end = start;
  for (let n = 1; n < len; n++) {
    end = addDays(end, 1);
    while (isWeekend(end) || holidayOn(end)) end = addDays(end, 1);
  }
  seed(who, kind, "approved", start, end, { decided_by: who === "p_mgr" || who === "p_admin" ? adm : mgr, decided_at: `${start}T15:00:00.000Z`, created_at: `${addDays(start, -10)}T15:00:00.000Z`, calendar: added() });
}

// --------------------------------------------------------------- settings --

const settings = {
  calendar: {
    connected: true, account_email: "calendar@example.com", calendar_id: "team-time-off@group.calendar.example.com",
    calendar_name: "Team time off", last_error: "Google Calendar didn’t answer yesterday. One entry is waiting to be added.",
    pending_writes: 0, fixture: false, titles: "out",
  },
  // Email goes out through the admin's Google grant (the calendar connection).
  mail: { on: true, transport: "gmail", from: null, account_email: "calendar@example.com", needs_reconnect: false },
  slack: { on: true, fixture: false, team_name: "Example Co", linked_people: 0, auto_enroll: true, auto_enroll_blocked_reason: null, manager_pick: "confirm_every" },
  google_signin: { on: true, fixture: false },
};
// Keys pasted on /setup. Values are kept only to say "set"; nothing reads them back.
const SETUP_TOKEN = "mock-setup-token";
const setup = { google: true, slack: true, admin_email: true, allowed_email_domain: null, mail_from: null };
const setupStatus = () => ({
  ok: true, has_google: setup.google, has_slack: setup.slack, has_admin_email: setup.admin_email,
  has_allowed_domain: !!setup.allowed_email_domain, has_mail_from: !!setup.mail_from, public_origin: "http://localhost:5611",
});

const CALENDARS = [
  { id: "team-time-off@group.calendar.example.com", name: "Team time off", writable: true },
  { id: "calendar@example.com", name: "calendar@example.com", writable: true },
  { id: "office@group.calendar.example.com", name: "Office events", writable: true },
  { id: "holidays@group.calendar.example.com", name: "Holidays in United States", writable: false },
];
const settingsOut = () => {
  settings.calendar.pending_writes = requests.filter((r) => r.calendar.state === "pending").length;
  settings.slack.linked_people = settings.slack.on ? people.filter((p) => p.active && p.slack_user_id).length : 0;
  settings.sample_people = people.filter((p) => SAMPLE_IDS.has(p.id) && p.active).length;
  if (!settings.slack.on) Object.assign(settings.slack, { fixture: false, team_name: null });
  if (settings.mail.transport === "gmail" || settings.mail.transport === "off") {
    const linked = settings.calendar.connected;
    Object.assign(settings.mail, { on: linked && !settings.mail.needs_reconnect, transport: linked ? "gmail" : "off", account_email: linked ? settings.calendar.account_email : null });
  }
  return structuredClone(settings);
};

const audit = [];
function log(actor, action, subject, detail = "") {
  audit.unshift({ at: new Date().toISOString(), actor: ref(actor), action, subject, detail });
}
audit.push(
  { at: stamp(1), actor: mgr, action: "request.approve", subject: "req_000000000000000071", detail: "pending to approved" },
  { at: stamp(4), actor: mgr, action: "request.approve", subject: "req_000000000000000066", detail: "pending to approved with a note" },
  { at: stamp(6), actor: adm, action: "holidays.set", subject: String(YEAR), detail: "8 holidays" },
  { at: stamp(50), actor: adm, action: "adjustment.add", subject: "p_priya", detail: `+1 days for ${YEAR}.` },
  { at: stamp(90), actor: adm, action: "calendar.connect", subject: "calendar", detail: "Connected the shared calendar." },
);

// ---------------------------------------------------------------- balance --

function balanceFor(p) {
  return { pto: ptoBalance(p), sick: sickBalance(p) };
}

// Sick days: a fresh set each year (prorated in the start year), no carryover.
function sickBalance(p) {
  const policy = policies.get(p.id) ?? null;
  if (policy?.sick_unlimited) {
    const mine = requests.filter((r) => r.person_id === p.id && r.kind === "sick" && r.start_date.slice(0, 4) === String(YEAR));
    return {
      unit: "days", year: YEAR, allowance: null, accrued: null, carried_over: 0, adjustments: 0,
      used: mine.filter((r) => r.status === "approved").reduce((sum, r) => sum + r.days, 0),
      pending: mine.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.days, 0),
      available: null, tracked: true, unlimited: true,
    };
  }
  const annual = policy?.sick_days ?? 0;
  const tracked = annual > 0;
  let allowance = annual;
  if (policy && Number(policy.start_date.slice(0, 4)) === YEAR) {
    allowance = Math.round(((annual * (13 - Number(policy.start_date.slice(5, 7)))) / 12) * 2) / 2;
  }
  const mine = requests.filter((r) => r.person_id === p.id && r.kind === "sick" && r.start_date.slice(0, 4) === String(YEAR));
  const used = mine.filter((r) => r.status === "approved").reduce((sum, r) => sum + r.days, 0);
  const pending = mine.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.days, 0);
  const adj = tracked ? adjustments.filter((a) => a.person_id === p.id && a.kind === "sick").reduce((sum, a) => sum + a.days, 0) : 0;
  return {
    unit: "days", year: YEAR, allowance: tracked ? allowance : 0, accrued: tracked ? allowance : 0, carried_over: 0,
    adjustments: adj, used, pending, available: tracked ? Math.round((allowance + adj - used - pending) * 100) / 100 : 0, tracked,
  };
}

function ptoBalance(p) {
  const policy = policies.get(p.id) ?? null;
  if (policy?.pto_unlimited) {
    const mine = requests.filter((r) => r.person_id === p.id && r.kind === "pto" && r.start_date.slice(0, 4) === String(YEAR));
    return {
      unit: "days", year: YEAR, allowance: null, accrued: null, carried_over: 0, adjustments: 0,
      used: mine.filter((r) => r.status === "approved").reduce((sum, r) => sum + r.days, 0),
      pending: mine.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.days, 0),
      available: null, tracked: true, unlimited: true,
    };
  }
  const annual = policy?.annual_days ?? 0;
  const tracked = annual > 0;
  let allowance = annual;
  let startMonth = 1;
  if (policy && Number(policy.start_date.slice(0, 4)) === YEAR) {
    startMonth = Number(policy.start_date.slice(5, 7));
    allowance = Math.round(((annual * (13 - startMonth)) / 12) * 2) / 2;
  }
  if (policy && Number(policy.start_date.slice(0, 4)) > YEAR) allowance = 0;
  let accrued = allowance;
  if (policy?.accrual === "monthly") {
    const month = Number(TODAY.slice(5, 7));
    accrued = Math.round(((annual * Math.max(0, month - startMonth + 1)) / 12) * 100) / 100;
    accrued = Math.min(accrued, allowance);
  }
  const mine = requests.filter((r) => r.person_id === p.id && r.kind === "pto" && r.start_date.slice(0, 4) === String(YEAR));
  const used = mine.filter((r) => r.status === "approved").reduce((s, r) => s + r.days, 0);
  const pending = mine.filter((r) => r.status === "pending").reduce((s, r) => s + r.days, 0);
  const carried_over = tracked ? (carried.get(p.id) ?? 0) : 0;
  const adj = tracked ? adjustments.filter((a) => a.person_id === p.id && (a.kind ?? "pto") === "pto").reduce((s, a) => s + a.days, 0) : 0;
  const available = tracked ? Math.round((accrued + carried_over + adj - used - pending) * 100) / 100 : 0;
  return {
    unit: "days", year: YEAR, allowance: tracked ? allowance : 0, accrued: tracked ? accrued : 0, carried_over,
    adjustments: adj, used, pending, available, tracked,
  };
}

// --------------------------------------------------------------- overlaps --

const overlap = (a1, a2, b1, b2) => a1 <= b2 && a2 >= b1;
function teamOf(p) {
  // same manager, my reports, and my manager
  return people.filter((q) => q.active && q.id !== p.id && ((p.manager_id && q.manager_id === p.manager_id) || q.manager_id === p.id || q.id === p.manager_id));
}
// Staff who aren't managers see teammates as just "out", never the kind.
const overlapOut = (r, viewer = null) => ({
  person_id: r.person_id, name: byId(r.person_id)?.name ?? "", start_date: r.start_date, end_date: r.end_date,
  kind: viewer && viewer.role === "employee" ? "out" : r.kind, status: r.status,
});
function overlapsFor(p, start, end, exceptId = null, viewer = p) {
  const ids = new Set(teamOf(p).map((q) => q.id));
  return requests
    .filter((r) => r.id !== exceptId && ids.has(r.person_id) && ["approved", "pending"].includes(r.status) && overlap(r.start_date, r.end_date, start, end))
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .map((r) => overlapOut(r, viewer));
}

// ---------------------------------------------------------------- session --

const ROLES = [
  { id: "admin", label: "Admin", person: "p_admin" },
  { id: "manager", label: "Manager", person: "p_mgr" },
  { id: "employee", label: "Employee", person: "p_sam" },
  { id: "contractor", label: "Contractor", person: "p_riley" },
  { id: "signed_out", label: "Signed out", person: null },
  { id: "not_on_roster", label: "Not on roster", person: null },
];
let current = "employee";
let failNext = false;
const me = () => {
  const role = ROLES.find((r) => r.id === current);
  return role?.person ? byId(role.person) : null;
};

// --------------------------------------------- approvers, links, reports --

function approversFor(p) {
  const list = people
    .filter((q) => q.active && q.id !== p.id && (q.role === "manager" || q.role === "admin"))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((q) => ({ id: q.id, name: q.name, team: q.team ?? null }));
  const boss = byId(p.manager_id);
  const default_id = boss && boss.active && (boss.role === "manager" || boss.role === "admin") ? boss.id : null;
  return { approvers: list, default_id };
}

// Email decide links. Sample links to try:
//   /approve/demo-approve   /deny/demo-deny   /approve/demo-expired   /approve/demo-used   /approve/anything-else
const decideTokens = new Map();
{
  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.find((r) => r.status === "approved");
  const hour = 3600 * 1000;
  decideTokens.set("demo-approve", { request_id: pending.find((r) => r.person_id === "p_sam").id, action: "approve", expires: Date.now() + 72 * hour });
  decideTokens.set("demo-deny", { request_id: pending.find((r) => r.person_id === "p_priya").id, action: "deny", expires: Date.now() + 72 * hour });
  decideTokens.set("demo-expired", { request_id: pending.find((r) => r.person_id === "p_leo").id, action: "approve", expires: Date.now() - hour });
  decideTokens.set("demo-used", { request_id: decided.id, action: "approve", expires: Date.now() + 72 * hour });
  const named = requests.find((r) => r.pending_manager);
  decideTokens.set("demo-confirm", { request_id: named.id, action: "confirm_manager", expires: Date.now() + 72 * hour });
  decideTokens.set("demo-reject", { request_id: named.id, action: "reject_manager", expires: Date.now() + 72 * hour });
}
// Confirm (or not) the manager a requester named in Slack.
function settleManager(r, actor, yes) {
  const owner = byId(r.person_id);
  const named = r.pending_manager;
  if (yes) {
    let boss = people.find((q) => q.email === named.email);
    if (!boss) {
      boss = { id: `p_${++seq}`, email: named.email, name: named.name, role: "manager", worker_type: "employee", manager_id: null, active: true, timezone: "America/Chicago", slack_user_id: null, team: owner.team ?? null, pay_basis: "monthly", hours_per_day: 8, enrolled_via: "slack" };
      people.push(boss);
    } else if (boss.role === "employee") boss.role = "manager";
    owner.manager_id = boss.id;
    r.approver = ref(boss);
    log(actor, "manager.confirmed", owner.id, `${boss.name} confirmed as manager.`);
  } else {
    r.approver = null;
    log(actor, "manager.rejected", owner.id, `${named.name} not confirmed; the request goes to the admins.`);
  }
  r.manager_named = named.name; // remembered so a spent link can still say who it was about
  r.pending_manager = null;
  r.updated_at = new Date().toISOString();
}

const decideSubset = (r) => ({
  id: r.id, person_name: byId(r.person_id)?.name ?? "", kind: r.kind, start_date: r.start_date, end_date: r.end_date, days: r.days, note: r.note, status: r.status,
});
function decideState(token) {
  const t = decideTokens.get(token);
  if (!t) return { t: null, r: null, state: "invalid" };
  const r = requests.find((x) => x.id === t.request_id) ?? null;
  if (!r) return { t, r: null, state: "invalid" };
  if (t.expires < Date.now()) return { t, r, state: "expired" };
  if (r.status !== "pending") return { t, r, state: "already_decided" };
  if ((t.action === "confirm_manager" || t.action === "reject_manager") && !r.pending_manager) return { t, r, state: "already_decided" };
  return { t, r, state: "pending" };
}

/** Working days of a request that fall inside [from, to], halves honored at its own ends. */
function daysWithin(r, from, to) {
  const a = r.start_date > from ? r.start_date : from;
  const b = r.end_date < to ? r.end_date : to;
  if (a > b) return 0;
  const counted = workingDays(a, b, r.half_day_start && a === r.start_date, r.half_day_end && b === r.end_date && r.end_date !== r.start_date);
  // A typed day count is spread over the same working days in proportion (as the server does).
  if (r.days_overridden && r.days_computed > 0) return Math.round(((r.days * counted) / r.days_computed) * 100) / 100;
  if (r.days_overridden && r.days_computed === 0) {
    const span = (utc(r.end_date) - utc(r.start_date)) / 86400000 + 1;
    const inside = (utc(b) - utc(a)) / 86400000 + 1;
    return Math.round(((r.days * inside) / span) * 100) / 100;
  }
  return counted;
}

// The time-based tiles: today, the next 30 days (approved, counted days), or
// everything waiting, whatever year is picked on the page.
function windowRequests(actor, win) {
  if (!["today", "next_30", "pending"].includes(win)) refuse(400, "invalid_window", "Pick today, the next 30 days, or waiting.");
  const ids = new Set(scopeFor(actor).filter((p) => p.active).map((p) => p.id));
  const until = win === "today" ? TODAY : addDays(TODAY, 30);
  const rows = [];
  for (const r of requests) {
    if (!ids.has(r.person_id)) continue;
    if (win === "pending" ? r.status !== "pending" : r.status !== "approved") continue;
    const inWindow = win === "pending" ? r.days : daysWithin(r, TODAY, until);
    if (inWindow <= 0) continue;
    const p = byId(r.person_id);
    rows.push({
      id: r.id, person: { id: p.id, name: p.name, class: classOf(p), team: p.team ?? null },
      kind: r.kind, status: r.status, start_date: r.start_date, end_date: r.end_date,
      days: r.days, days_in_window: inWindow, days_computed: r.days_computed, days_overridden: !!r.days_overridden,
      hours: r.hours ?? null, approver: r.approver ?? null, decided_at: r.decided_at ?? null,
    });
  }
  rows.sort((x, y) => y.start_date.localeCompare(x.start_date));
  return {
    filters: { window: win, from: win === "pending" ? null : TODAY, to: win === "pending" ? null : until, year: null, month: null, team: null, person_id: null, kind: null, class: null, status: win === "pending" ? "pending" : "approved" },
    total_days: Math.round(rows.reduce((sum, x) => sum + x.days_in_window, 0) * 100) / 100,
    total_requests: rows.length,
    total_people: new Set(rows.map((x) => x.person.id)).size,
    truncated: rows.length > 500,
    requests: rows.slice(0, 500),
  };
}

// GET /api/insights/requests: the requests behind an Insights number, each
// with its share of the window (month, or year) so the sums match.
function insightRequests(actor, q) {
  const scope = scopeFor(actor);
  const ids = new Set(scope.map((p) => p.id));
  const win = q.get("window");
  if (win) return windowRequests(actor, win);
  const year = Number(q.get("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, "invalid_year", "Pick a year.");
  const monthText = q.get("month");
  if (monthText && !new RegExp(`^${year}-(0[1-9]|1[0-2])$`).test(monthText)) refuse(400, "invalid_month", "Pick a month in that year.");
  const month = monthText ? Number(monthText.slice(5, 7)) : null;
  const from = month ? `${year}-${pad(month)}-01` : `${year}-01-01`;
  const to = month ? monthEnd(year, month) : `${year}-12-31`;
  const team = q.has("team") ? q.get("team") : null;
  const personId = q.get("person_id");
  const kind = q.get("kind");
  const cls = q.get("class");
  const status = q.get("status") || "approved";
  if (!["approved", "pending"].includes(status)) refuse(400, "invalid_status", "Pick approved or pending.");
  if (kind && !["pto", "sick", "unpaid", "loa", "unavailable"].includes(kind)) refuse(400, "invalid_kind", "Pick a Type.");
  if (cls && !["employee", "contractor_monthly", "contractor_hourly"].includes(cls)) refuse(400, "invalid_class", "Pick a class.");
  const rows = [];
  for (const r of requests) {
    if (!ids.has(r.person_id)) continue;
    const p = byId(r.person_id);
    if (status && r.status !== status) continue;
    if (kind && r.kind !== kind) continue;
    if (personId && r.person_id !== personId) continue;
    if (team !== null && (p.team ?? "") !== team) continue;
    if (cls && classOf(p) !== cls) continue;
    if (!overlap(r.start_date, r.end_date, from, to)) continue;
    const inWindow = daysWithin(r, from, to);
    if (inWindow <= 0) continue; // no days inside the window
    rows.push({
      id: r.id,
      person: { id: p.id, name: p.name, class: classOf(p), team: p.team ?? null },
      kind: r.kind,
      status: r.status,
      start_date: r.start_date,
      end_date: r.end_date,
      days: r.days,
      days_in_window: inWindow,
      days_computed: r.days_computed,
      days_overridden: !!r.days_overridden,
      hours: r.hours ?? null, // the whole request's hours, as stored
      approver: r.approver ?? null,
      decided_at: r.decided_at ?? null,
    });
  }
  rows.sort((x, y) => y.start_date.localeCompare(x.start_date)); // newest start first
  return {
    filters: { year, month: monthText || null, team, person_id: personId, kind, class: cls, status },
    total_days: Math.round(rows.reduce((sum, x) => sum + x.days_in_window, 0) * 100) / 100,
    truncated: rows.length > 500,
    requests: rows.slice(0, 500),
  };
}

// An admin sees everyone; a manager sees themselves, their reports, and their team.
function scopeFor(actor) {
  return people.filter((q) => actor.role === "admin" || q.id === actor.id || q.manager_id === actor.id || (actor.team && q.team === actor.team));
}

const KINDS = ["pto", "sick", "unpaid", "unavailable", "loa"];
const zero = () => ({ pto: 0, sick: 0, unpaid: 0, unavailable: 0, loa: 0 });
const monthEnd = (year, month) => addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`, -1);
const personDays = (q, from, to) => {
  const row = zero();
  for (const r of requests) if (r.person_id === q.id && r.status === "approved") row[r.kind] += daysWithin(r, from, to);
  return row;
};
const sumDays = (row) => KINDS.reduce((sum, k) => sum + row[k], 0);

function monthlyReport(actor, year, month) {
  const from = `${year}-${pad(month)}-01`;
  const to = monthEnd(year, month);
  const byTeam = new Map();
  for (const q of scopeFor(actor)) {
    const days = personDays(q, from, to);
    if (!q.active && sumDays(days) === 0) continue; // inactive people only when they were out
    const hourly = q.pay_basis === "hourly";
    const row = { id: q.id, name: q.name, pay_basis: q.pay_basis ?? "monthly", class: classOf(q), ...days, hours: hourly ? sumDays(days) * (q.hours_per_day ?? 8) : null };
    const key = q.team ?? null;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(row);
  }
  const teams = [...byTeam.entries()]
    .sort(([x], [y]) => (x === null ? 1 : y === null ? -1 : x.localeCompare(y)))
    .map(([team, rows]) => {
      rows.sort((x, y) => x.name.localeCompare(y.name));
      const totals = { ...zero(), hours: 0 };
      for (const r of rows) {
        for (const k of KINDS) totals[k] += r[k];
        totals.hours += r.hours ?? 0;
      }
      return { team, people: rows, totals };
    });
  const totals = { ...zero(), hours: 0 };
  for (const t of teams) {
    for (const k of KINDS) totals[k] += t.totals[k];
    totals.hours += t.totals.hours;
  }
  return { year, month: `${year}-${pad(month)}`, from, to, teams, totals };
}

function insightsFor(actor, year) {
  const scope = scopeFor(actor).filter((q) => q.active);
  const ids = new Set(scope.map((q) => q.id));
  const mine = requests.filter((r) => ids.has(r.person_id));
  const approved = mine.filter((r) => r.status === "approved");
  const until = addDays(TODAY, 30);
  // Out means an approved, counted day (weekends and holidays aren't out).
  const outToday = new Set(approved.filter((r) => daysWithin(r, TODAY, TODAY) > 0).map((r) => r.person_id));
  const outSoon = new Set(approved.filter((r) => daysWithin(r, TODAY, until) > 0).map((r) => r.person_id));
  const by_month = [];
  for (let m = 1; m <= 12; m++) {
    const row = { month: `${year}-${pad(m)}`, ...zero() };
    for (const q of scope) {
      const d = personDays(q, `${year}-${pad(m)}-01`, monthEnd(year, m));
      for (const k of KINDS) row[k] += d[k];
    }
    by_month.push(row);
  }
  const by_person = scope.map((q) => {
    const d = personDays(q, `${year}-01-01`, `${year}-12-31`);
    const b = balanceFor(q);
    return {
      id: q.id, name: q.name, team: q.team ?? null, class: classOf(q), ...d,
      hours: q.pay_basis === "hourly" ? sumDays(d) * (q.hours_per_day ?? 8) : null,
      pto_available: b.pto.tracked ? b.pto.available : null,
      sick_available: b.sick.tracked ? b.sick.available : null,
    };
  });
  const teamMap = new Map();
  for (const r of by_person) {
    const t = teamMap.get(r.team) ?? { team: r.team, people: 0, ...zero(), hours: 0 };
    t.people += 1;
    for (const k of KINDS) t[k] += r[k];
    t.hours += r.hours ?? 0;
    teamMap.set(r.team, t);
  }
  const by_kind = zero();
  for (const r of by_person) for (const k of KINDS) by_kind[k] += r[k];
  return {
    year,
    by_month,
    by_team: [...teamMap.values()],
    by_person,
    by_kind,
    out_today: outToday.size,
    out_next_30: outSoon.size,
    pending: mine.filter((r) => r.status === "pending").length,
    unused_pto_total: by_person.reduce((sum, r) => sum + Math.max(0, r.pto_available ?? 0), 0),
  };
}

function teamMonth(actor, month) {
  const from = `${month}-01`;
  const to = addDays(iso(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))), -1);
  const scope = people.filter((p) => p.active && (actor.role === "admin" || p.manager_id === actor.id || p.id === actor.id));
  const ids = new Set(scope.map((p) => p.id));
  return {
    month,
    entries: requests.filter((r) => ids.has(r.person_id) && ["approved", "pending"].includes(r.status) && overlap(r.start_date, r.end_date, from, to)).map((r) => overlapOut(r)),
    holidays: allHolidays().filter((h) => h.date >= from && h.date <= to),
    people: scope.map((q) => ({ ...ref(q), class: classOf(q) })),
  };
}

// The manager/admin part of Home.
function homeTeam(actor) {
  const scope = scopeFor(actor).filter((q) => q.active && q.id !== actor.id);
  const ids = new Set(scope.map((q) => q.id));
  const mine = requests.filter((r) => ids.has(r.person_id));
  const approved = mine.filter((r) => r.status === "approved");
  const until = addDays(TODAY, 30);
  return {
    scope: actor.role === "admin" ? "everyone" : "reports",
    out_today: new Set(approved.filter((r) => daysWithin(r, TODAY, TODAY) > 0).map((r) => r.person_id)).size,
    out_next_30: new Set(approved.filter((r) => daysWithin(r, TODAY, until) > 0).map((r) => r.person_id)).size,
    pending: requests.filter((r) => r.status === "pending" && canDecide(actor, byId(r.person_id), r)).length,
    unused_pto_total: scope.reduce((sum, q) => {
      const b = ptoBalance(q);
      return sum + (b.tracked && !b.unlimited ? Math.max(b.available, 0) : 0);
    }, 0),
    month: teamMonth(actor, TODAY.slice(0, 7)),
    out_soon: mine
      .filter((r) => r.status === "approved" && overlap(r.start_date, r.end_date, TODAY, addDays(TODAY, 60)))
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .map((r) => overlapOut(r)),
  };
}

// Approved stretches this year, per balance, for the "used this year" lists.
function usedDays(p) {
  const spans = (kind) =>
    requests
      .filter((r) => r.person_id === p.id && r.kind === kind && r.status === "approved" && r.start_date.slice(0, 4) === String(YEAR))
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .map((r) => ({ request_id: r.id, start_date: r.start_date, end_date: r.end_date, days: r.days }));
  return { pto: spans("pto"), sick: spans("sick") };
}

// ------------------------------------------------------------------- http --

class Refusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => {
  throw new Refusal(status, code, message);
};

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    refuse(400, "bad_json", "That didn’t come through right. Try again.");
  }
}

const needPerson = () => me() ?? refuse(401, "signin_required", "Sign in first.");
const rank = { employee: 0, manager: 1, admin: 2 };
function needRole(role) {
  const p = needPerson();
  if (rank[p.role] < rank[role]) refuse(403, "not_allowed", role === "admin" ? "Only admins can do that." : "Only managers can do that.");
  return p;
}
const soleAdmin = (actor) => actor.role === "admin" && people.filter((q) => q.active && q.role === "admin").length === 1;
const canDecide = (actor, target, request) =>
  (actor.id !== target.id || soleAdmin(actor)) &&
  (actor.role === "admin" || target.manager_id === actor.id || request?.approver?.id === actor.id);
const findRequest = (id) => requests.find((r) => r.id === id) ?? refuse(404, "not_found", "That request isn’t here anymore.");
const pendingItem = (r) => {
  const p = byId(r.person_id);
  const balance = balanceFor(p);
  // This request is already held, so "after" is what's available now.
  const balance_after = {
    pto: r.kind === "pto" && balance.pto.tracked ? balance.pto.available : null,
    sick: r.kind === "sick" && balance.sick.tracked ? balance.sick.available : null,
  };
  const { pending_manager = null, last_reminded_at = null, ...request } = r;
  return { request, person: personOut(p), balance, balance_after, overlaps: overlapsFor(p, r.start_date, r.end_date, r.id, null), pending_manager, last_reminded_at };
};

// Preview skips the submit-only refusals (too far back, no working days,
// overlaps my own) and returns them as warnings instead (docs/API.md).
function validateDraft(p, body, forPreview) {
  const warnings = [];
  const soft = (status, code, message) => (forPreview ? warnings.push(message) : refuse(status, code, message));
  const { start_date, end_date } = body;
  if (!isDate(start_date) || !isDate(end_date)) refuse(400, "invalid_dates", "Choose a start date and an end date.");
  if (end_date < start_date) refuse(400, "end_before_start", "The end date is before the start date.");
  if (end_date > addDays(start_date, 365)) refuse(400, "too_long", "One request can cover at most a year. Split it into two.");
  if (start_date > addDays(TODAY, 730)) refuse(400, "too_far_ahead", "Time off can be asked for up to two years ahead.");
  if (start_date < addDays(TODAY, -30)) soft(400, "too_far_back", "Time off can be asked for up to 30 days back, not earlier.");
  const kind = body.kind ?? "pto";
  if (!["pto", "sick", "unpaid", "unavailable", "loa"].includes(kind)) refuse(400, "invalid_kind", "Choose a Type.");
  if (!kindsFor(p).includes(kind)) refuse(400, "invalid_kind", "Choose a Type from the list.");
  const days_computed = workingDays(start_date, end_date, !!body.half_day_start, !!body.half_day_end);
  let days = days_computed;
  const days_overridden = body.days_requested !== undefined && body.days_requested !== null;
  if (days_overridden) {
    const asked = Number(body.days_requested);
    const calendarDays = (utc(end_date) - utc(start_date)) / 86400000 + 1;
    if (!Number.isFinite(asked) || asked < 0.5 || !Number.isInteger(asked * 2) || asked > calendarDays) {
      refuse(400, "invalid_days_requested", `Type the working days in half-day steps, from 0.5 to ${calendarDays}.`);
    }
    days = asked;
  }
  if (days <= 0) soft(400, "no_working_days", "Those dates are all weekends or holidays, so there is nothing to ask for. Type how many days you will work less, or pick other dates.");
  const clash = requests.find((r) => r.person_id === p.id && ["pending", "approved"].includes(r.status) && overlap(r.start_date, r.end_date, start_date, end_date));
  if (clash) {
    soft(409, "overlaps_own", `You already have ${clash.status === "approved" ? "approved time off" : "a request waiting"} for ${clash.start_date === clash.end_date ? fmt(clash.start_date) : `${fmt(clash.start_date)} to ${fmt(clash.end_date)}`}.`);
  }
  return { kind, days, days_computed, days_overridden, warnings };
}

const fmt = (s) => utc(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : {};

  if (failNext && ["POST", "PUT", "PATCH"].includes(method) && !pathname.startsWith("/api/mock/")) {
    failNext = false;
    refuse(503, "busy", "Time Off is busy for a moment. Try again.");
  }

  // ---- mock-only
  if (pathname === "/api/mock/roles" && method === "GET") return { roles: ROLES.map(({ id, label }) => ({ id, label })), current };
  if (pathname === "/api/mock/signin-as" && method === "POST") {
    if (!ROLES.some((r) => r.id === body.role)) refuse(400, "bad_role", "Unknown role.");
    current = body.role;
    return { ok: true };
  }
  if (pathname === "/api/mock/slack" && method === "POST") {
    Object.assign(settings.slack, { on: !!body.on, fixture: !!body.fixture, team_name: body.on ? "Example Co" : null });
    return settingsOut().slack;
  }
  if (pathname === "/api/mock/mail" && method === "POST") {
    const transport = ["gmail", "smtp", "fixture", "off"].includes(body.transport) ? body.transport : "gmail";
    Object.assign(settings.mail, {
      transport, on: transport !== "off" && !body.needs_reconnect, needs_reconnect: !!body.needs_reconnect,
      from: transport === "smtp" ? "Time Off <timeoff@example.com>" : null,
    });
    return settingsOut().mail;
  }
  if (pathname === "/api/mock/slack-block" && method === "POST") {
    settings.slack.auto_enroll_blocked_reason = typeof body.reason === "string" && body.reason ? body.reason : null;
    if (settings.slack.auto_enroll_blocked_reason) settings.slack.auto_enroll = false;
    return settingsOut().slack;
  }
  if (pathname === "/api/mock/setup" && method === "POST") {
    if ("google" in body) setup.google = !!body.google;
    if ("slack" in body) setup.slack = !!body.slack;
    if ("admin_email" in body) setup.admin_email = !!body.admin_email;
    return setupStatus();
  }
  if (pathname === "/api/mock/fail-next" && method === "POST") {
    failNext = true;
    return { ok: true };
  }

  // ---- setup (private link, or a signed-in admin)
  const setupAllowed = () => req.headers["x-setup-token"] === SETUP_TOKEN || me()?.role === "admin";
  if (pathname === "/api/setup/status" && method === "GET") {
    if (!setupAllowed()) refuse(404, "not_found", "That isn’t here.");
    return setupStatus();
  }
  if (pathname === "/api/setup/keys" && method === "PUT") {
    if (!setupAllowed()) refuse(404, "not_found", "That isn’t here.");
    const saved = [];
    const text = (k) => (typeof body[k] === "string" && body[k].trim() ? body[k].trim() : null);
    const id = text("google_client_id");
    if (id && !id.endsWith(".apps.googleusercontent.com")) refuse(400, "bad_google_id", "That doesn’t look like a Google client ID. It ends with .apps.googleusercontent.com.");
    const bot = text("slack_bot_token");
    if (bot && !bot.startsWith("xoxb-")) refuse(400, "bad_slack_token", "That isn’t a Slack bot token. It starts with xoxb- and is under OAuth & Permissions.");
    const adminEmail = text("bootstrap_admin_email");
    if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) refuse(400, "bad_email", "Type a full email address, like owner@yourcompany.com.");
    const domain = text("allowed_email_domain");
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) refuse(400, "bad_domain", "Type just the domain, like yourcompany.com.");
    for (const k of ["google_client_id", "google_client_secret", "slack_bot_token", "slack_signing_secret", "allowed_email_domain", "mail_from", "bootstrap_admin_email"]) if (text(k)) saved.push(k);
    if (adminEmail) setup.admin_email = true;
    if (saved.includes("google_client_id") && saved.includes("google_client_secret")) setup.google = true;
    if (saved.includes("slack_bot_token") && saved.includes("slack_signing_secret")) setup.slack = true;
    if (domain) setup.allowed_email_domain = domain;
    if (text("mail_from")) setup.mail_from = text("mail_from");
    log(me(), "setup.keys", "setup", `Saved ${saved.join(", ")}.`);
    // The real server tries a new bot token against Slack; "xoxb-revoked…" plays a token Slack turns down.
    const slack = !bot
      ? { checked: false, ok: setup.slack, team_name: null }
      : bot.startsWith("xoxb-revoked")
        ? { checked: true, ok: false, team_name: null, message: "Saved, but Slack says that token was revoked. Reinstall the app and copy the new bot token." }
        : { checked: true, ok: true, team_name: "Example Co" };
    if (slack.checked && !slack.ok) setup.slack = false;
    return { saved, slack, google: { ok: setup.google } };
  }

  // ---- session
  if (pathname === "/api/me" && method === "GET") {
    const p = me();
    const slack_available = settings.slack.on && setup.slack;
    const needs_setup = !setup.google;
    if (p) return { signedIn: true, person: personOut(p), app: { name: "Time Off" }, slack_available, needs_setup, kinds: kindsFor(p) };
    return { signedIn: false, google: { on: settings.google_signin.on, fixture: settings.google_signin.fixture }, slack_available, needs_setup, ...(current === "not_on_roster" ? { notOnRoster: { email: "new.hire@example.com" } } : {}) };
  }
  if (pathname === "/api/auth/google/start" && method === "GET") {
    const back = url.searchParams.get("return_to") || "/";
    if (current === "not_on_roster") {
      res.writeHead(302, { Location: "/?not_on_roster=1" });
      res.end();
      return null;
    }
    current = "employee";
    res.writeHead(302, { Location: /^\/(?!\/)/.test(back) ? back : "/" });
    res.end();
    return null;
  }
  if (pathname === "/api/auth/signout" && method === "POST") {
    current = "signed_out";
    return { ok: true };
  }

  // ---- everyone
  if (pathname === "/api/home" && method === "GET") {
    const p = needPerson();
    const ids = new Set(teamOf(p).map((q) => q.id));
    const until = addDays(TODAY, 60);
    return {
      person: personOut(p),
      balance: balanceFor(p),
      requests: requests.filter((r) => r.person_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
      holidays: allHolidays().filter((h) => Number(h.date.slice(0, 4)) >= YEAR),
      team_out: requests
        .filter((r) => ids.has(r.person_id) && r.status === "approved" && overlap(r.start_date, r.end_date, TODAY, until))
        .map((r) => overlapOut(r, p)),
      used_days: usedDays(p),
      team: p.role === "manager" || p.role === "admin" ? homeTeam(p) : null,
    };
  }
  if (pathname === "/api/requests/preview" && method === "POST") {
    const p = needPerson();
    const { kind, days, days_computed, days_overridden, warnings } = validateDraft(p, body, true);
    const balance = balanceFor(p);
    const balance_after = {
      pto: kind === "pto" && balance.pto.tracked && !balance.pto.unlimited ? balance.pto.available - days : null,
      sick: kind === "sick" && balance.sick.tracked && !balance.sick.unlimited ? balance.sick.available - days : null,
    };
    const over = kind === "pto" ? balance_after.pto : kind === "sick" ? balance_after.sick : null;
    if (over !== null && over < 0) warnings.push(`This takes you ${Math.abs(over)} ${Math.abs(over) === 1 ? "day" : "days"} below your ${kind === "sick" ? "sick days" : "balance"}.`);
    if (body.start_date < TODAY) warnings.push("Some of these days are in the past. That’s fine for sick days you forgot to log.");
    for (const h of allHolidays()) if (h.date >= body.start_date && h.date <= body.end_date) warnings.push(`${h.name} (${fmt(h.date)}) is a company holiday, so it isn’t counted.`);
    return { days, days_computed, days_overridden, balance_after, overlaps: overlapsFor(p, body.start_date, body.end_date), warnings };
  }
  if (pathname === "/api/requests" && method === "POST") {
    const p = needPerson();
    const { kind, days, days_computed, days_overridden } = validateDraft(p, body, false);
    const options = approversFor(p).approvers;
    const pick = body.approver_id ? options.find((a) => a.id === body.approver_id) ?? refuse(400, "invalid_approver", "Pick someone from the list to approve this.") : null;
    const approver = pick ? ref(pick) : ref(byId(p.manager_id));
    const r = {
      id: reqId(), person_id: p.id, kind, status: "pending", start_date: body.start_date, end_date: body.end_date,
      half_day_start: !!body.half_day_start, half_day_end: !!body.half_day_end && body.end_date !== body.start_date, days,
      note: String(body.note ?? "").slice(0, 500), decided_by: null, decided_at: null, decision_note: "", approver, hours: days * (p.hours_per_day ?? 8),
      days_computed, days_overridden,
      calendar: { state: "none", event_id: null, error: null }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    requests.push(r);
    log(p, "request.submit", r.id, `${kind}, ${r.start_date} to ${r.end_date}, ${days} days`);
    return { request: r, balance: balanceFor(p) };
  }
  const nudge = pathname.match(/^\/api\/requests\/([^/]+)\/remind$/);
  if (nudge && method === "POST") {
    const actor = needPerson();
    const r = findRequest(decodeURIComponent(nudge[1]));
    if (actor.role !== "admin" && r.approver?.id !== actor.id) refuse(403, "not_allowed", "Only an admin or the approver can send this again.");
    if (r.status !== "pending") refuse(409, "not_pending", "This request isn’t waiting anymore.");
    if (r.last_reminded_at && Date.now() - Date.parse(r.last_reminded_at) < 60 * 60 * 1000) {
      refuse(409, "too_soon", `A reminder went out at ${new Date(r.last_reminded_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. You can send another an hour after that.`);
    }
    r.last_reminded_at = new Date().toISOString();
    log(actor, "request.remind", r.id, `Reminded ${r.approver?.name ?? "the admins"}.`);
    return { last_reminded_at: r.last_reminded_at };
  }
  const pm = pathname.match(/^\/api\/requests\/([^/]+)\/(confirm-manager|reject-manager)$/);
  if (pm && method === "POST") {
    const actor = needRole("admin");
    const r = findRequest(decodeURIComponent(pm[1]));
    if (!r.pending_manager) refuse(409, "no_pending_manager", "There’s no manager waiting to be confirmed on this request.");
    settleManager(r, actor, pm[2] === "confirm-manager");
    const { pending_manager, ...request } = r;
    return { request };
  }
  let m = pathname.match(/^\/api\/requests\/([^/]+)\/(cancel|approve|deny)$/);
  if (m && method === "POST") {
    const actor = needPerson();
    const r = findRequest(decodeURIComponent(m[1]));
    const owner = byId(r.person_id);
    const action = m[2];
    if (action === "cancel") {
      const own = owner.id === actor.id;
      const boss = actor.role === "admin" || owner.manager_id === actor.id;
      if (!own && boss && r.status === "pending") refuse(409, "deny_instead", "This request is still waiting. Deny it instead of cancelling.");
      const ok = (own && (r.status === "pending" || (r.status === "approved" && TODAY < r.start_date))) || (boss && !own && r.status === "approved");
      if (!ok) refuse(409, "cannot_cancel", r.status === "approved" ? "This time off has already started, so ask your manager to cancel it." : "This request can’t be cancelled anymore.");
      r.status = "cancelled";
      if (r.calendar.state === "added" || r.calendar.state === "pending") r.calendar = { state: "removed", event_id: null, error: null };
      r.updated_at = new Date().toISOString();
      log(actor, "request.cancel", r.id, "to cancelled");
      return { request: r, balance: balanceFor(owner) };
    }
    if (r.status !== "pending") refuse(409, "already_decided", "Someone already decided this request.");
    if (!canDecide(actor, owner, r)) refuse(403, owner.id === actor.id ? "own_request" : "not_your_report", owner.id === actor.id ? "You cannot approve or deny your own time off." : "Only their manager or an admin can decide this.");
    r.status = action === "approve" ? "approved" : "denied";
    r.decided_by = ref(actor);
    r.decided_at = new Date().toISOString();
    r.decision_note = String(body.note ?? "").slice(0, 500);
    r.updated_at = r.decided_at;
    if (action === "approve") {
      r.calendar = settings.calendar.connected && settings.calendar.calendar_id ? added() : { state: "none", event_id: null, error: null };
    }
    log(actor, `request.${action}`, r.id, `pending to ${r.status}${r.decision_note ? " with a note" : ""}`);
    return { request: r };
  }

  // ---- who can approve, decide-by-link, reports, insights
  if (pathname === "/api/approvers" && method === "GET") {
    const p = needPerson();
    return approversFor(p);
  }
  m = pathname.match(/^\/api\/decide\/([^/]+)$/);
  if (m) {
    const { t, r, state } = decideState(decodeURIComponent(m[1]));
    const actor = r ? byId(r.approver?.id) ?? byId(byId(r.person_id)?.manager_id) ?? byId("p_admin") : null;
    if (method === "GET") {
      return {
        request: r ? decideSubset(r) : null, action: t?.action ?? null, approver_name: actor?.name ?? null, state,
        manager_name: r ? (r.pending_manager?.name ?? r.manager_named ?? null) : null,
      };
    }
    if (method === "POST") {
      if (state === "invalid") refuse(404, "invalid", "This link isn’t valid.");
      if (state === "already_decided") refuse(409, "already_decided", "This request was already handled.");
      if (state === "expired") refuse(409, "expired", "This link has expired. Open Time Off to decide.");
      if (t.action === "confirm_manager" || t.action === "reject_manager") {
        settleManager(r, byId("p_admin"), t.action === "confirm_manager");
        return { ok: true, action: t.action, request: decideSubset(r) };
      }
      r.status = t.action === "approve" ? "approved" : "denied";
      r.decided_by = ref(actor);
      r.decided_at = new Date().toISOString();
      r.decision_note = String(body.note ?? "").slice(0, 500);
      r.updated_at = r.decided_at;
      if (r.status === "approved") r.calendar = settings.calendar.connected && settings.calendar.calendar_id ? added() : { state: "none", event_id: null, error: null };
      log(actor, `request.${t.action}`, r.id, `pending to ${r.status} from an email link`);
      return { ok: true, action: t.action, request: decideSubset(r) };
    }
  }
  if (pathname === "/api/reports/monthly" && method === "GET") {
    const actor = needRole("manager");
    const last = (() => { const [y, mo] = TODAY.split("-").map(Number); return mo === 1 ? [y - 1, 12] : [y, mo - 1]; })();
    const year = url.searchParams.has("year") ? Number(url.searchParams.get("year")) : last[0];
    const month = url.searchParams.has("month") ? Number(url.searchParams.get("month")) : last[1];
    if (!Number.isInteger(year) || !(month >= 1 && month <= 12)) refuse(400, "bad_month", "Pick a month.");
    return monthlyReport(actor, year, month);
  }
  if (pathname === "/api/insights/requests" && method === "GET") {
    const actor = needRole("manager");
    return insightRequests(actor, url.searchParams);
  }
  if (pathname === "/api/insights" && method === "GET") {
    const actor = needRole("manager");
    const year = Number(url.searchParams.get("year") ?? YEAR);
    return insightsFor(actor, year);
  }

  // ---- managers
  if (pathname === "/api/approvals" && method === "GET") {
    const actor = needRole("manager");
    const mine = (r) => canDecide(actor, byId(r.person_id), r);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    return {
      pending: requests.filter((r) => r.status === "pending" && mine(r)).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(pendingItem),
      recent: requests
        .filter((r) => ["approved", "denied", "cancelled"].includes(r.status) && r.decided_at && r.decided_at >= since && mine(r))
        .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))
        .map((r) => ({ request: r, person: personOut(byId(r.person_id)) })),
    };
  }
  if (pathname === "/api/team/calendar" && method === "GET") {
    const actor = needRole("manager");
    const month = url.searchParams.get("month") ?? TODAY.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) refuse(400, "bad_month", "Pick a month.");
    return teamMonth(actor, month);
  }

  // ---- admins
  if (pathname === "/api/people" && method === "GET") {
    needRole("admin");
    return { people: people.map((p) => ({ ...personOut(p), policy: policies.get(p.id) ?? null, balance: balanceFor(p) })), teams: teamsList() };
  }
  if (pathname === "/api/people" && method === "POST") {
    const actor = needRole("admin");
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse(400, "bad_email", "Type a full email address, like name@example.com.");
    if (!name) refuse(400, "bad_name", "Add a name.");
    if (people.some((p) => p.email === email)) refuse(409, "email_taken", "Someone on the roster already uses that email.");
    if (!["employee", "manager", "admin"].includes(body.role)) refuse(400, "bad_role", "Pick a role.");
    if (!["employee", "contractor"].includes(body.worker_type)) refuse(400, "bad_type", "Pick employee or contractor.");
    const p = { id: `p_${++seq}`, email, name, role: body.role, worker_type: body.worker_type, manager_id: body.manager_id || null, active: true, timezone: body.timezone || "America/Chicago", slack_user_id: null, team: body.team || null, pay_basis: body.pay_basis === "hourly" ? "hourly" : "monthly", hours_per_day: Number(body.hours_per_day) || 8 };
    people.push(p);
    log(actor, "person.create", p.id, `Added as ${p.role} (${p.worker_type}).`);
    return { person: personOut(p) };
  }
  m = pathname.match(/^\/api\/people\/([^/]+)(\/policy|\/adjustments)?$/);
  if (m) {
    const actor = needRole("admin");
    const p = byId(decodeURIComponent(m[1])) ?? refuse(404, "not_found", "That person isn’t on the roster.");
    if (!m[2] && method === "PATCH") {
      if ("manager_id" in body && body.manager_id === p.id) refuse(400, "self_manager", "A person can’t be their own manager.");
      if ("role" in body && body.role !== "admin" && p.role === "admin" && people.filter((q) => q.role === "admin" && q.active).length <= 1) {
        refuse(409, "last_admin", "There has to be at least one admin. Make someone else an admin first.");
      }
      if (body.active === false && p.id === actor.id) refuse(409, "self_deactivate", "You can’t deactivate yourself.");
      if ("hours_per_day" in body && !(Number(body.hours_per_day) >= 0.5 && Number(body.hours_per_day) <= 24)) refuse(400, "bad_hours", "Hours in a work day should be between 0.5 and 24.");
      const before = classOf(p);
      for (const key of ["name", "role", "worker_type", "manager_id", "timezone", "slack_user_id", "active", "team", "pay_basis", "hours_per_day"]) if (key in body) p[key] = body[key];
      if (classOf(p) !== before) {
        const old = policies.get(p.id);
        policies.set(p.id, { accrual: "front_loaded", start_date: old?.start_date ?? TODAY, ...CLASS_DEFAULTS[classOf(p)] });
      }
      log(actor, "person.update", p.id, `Changed ${Object.keys(body).join(", ")}.`);
      return { person: personOut(p) };
    }
    if (m[2] === "/policy" && method === "PUT") {
      const annual = Number(body.annual_days);
      const cap = Number(body.carryover_cap);
      if (!Number.isFinite(annual) || annual < 0 || annual > 366) refuse(400, "bad_policy", "Days per year should be a number from 0 to 366.");
      if (!Number.isFinite(cap) || cap < 0) refuse(400, "bad_policy", "The carryover limit should be 0 or more.");
      if (!["front_loaded", "monthly"].includes(body.accrual)) refuse(400, "bad_policy", "Pick how days are given.");
      if (!isDate(body.start_date)) refuse(400, "bad_policy", "Pick a start date.");
      const sick = Number(body.sick_days ?? 0);
      if (!Number.isFinite(sick) || sick < 0 || sick > 366) refuse(400, "bad_policy", "Sick days should be a number from 0 to 366.");
      policies.set(p.id, {
        annual_days: annual, accrual: body.accrual, carryover_cap: cap, start_date: body.start_date, sick_days: sick,
        pto_unlimited: body.pto_unlimited === true, sick_unlimited: body.sick_unlimited === true, holidays_apply: body.holidays_apply !== false,
      });
      log(actor, "policy.set", p.id, `${annual} days a year, ${body.accrual === "monthly" ? "monthly" : "all at once"}`);
      return { person: personOut(p), balance: balanceFor(p) };
    }
    if (m[2] === "/adjustments" && method === "POST") {
      const days = Number(body.days);
      if (!Number.isFinite(days) || days === 0) refuse(400, "bad_days", "Enter how many days, like 1 or −0.5.");
      if (!String(body.note ?? "").trim()) refuse(400, "note_required", "Add a short note saying why.");
      const kind = body.kind === "sick" ? "sick" : "pto";
      adjustments.push({ person_id: p.id, days, note: String(body.note).trim(), at: new Date().toISOString(), kind });
      log(actor, "adjustment.add", p.id, `${days > 0 ? "+" : ""}${days} days for ${YEAR}.`);
      return { balance: balanceFor(p) };
    }
  }
  if (pathname === "/api/holidays" && method === "GET") {
    needRole("admin");
    const year = Number(url.searchParams.get("year") ?? YEAR);
    return { holidays: holidays.get(year) ?? [] };
  }
  if (pathname === "/api/holidays" && method === "PUT") {
    const actor = needRole("admin");
    const year = Number(body.year);
    if (!Number.isInteger(year)) refuse(400, "bad_year", "Pick a year.");
    const list = Array.isArray(body.holidays) ? body.holidays : refuse(400, "bad_holidays", "Send the list of holidays.");
    for (const h of list) {
      if (!isDate(h?.date) || Number(h.date.slice(0, 4)) !== year || !String(h?.name ?? "").trim()) refuse(400, "bad_holidays", `Every holiday needs a ${year} date and a name.`);
    }
    holidays.set(year, list.map((h) => ({ date: h.date, name: String(h.name).trim() })).sort((a, b) => a.date.localeCompare(b.date)));
    log(actor, "holidays.set", String(year), `${list.length} holidays for ${year}.`);
    return { holidays: holidays.get(year) };
  }
  if (pathname === "/api/settings" && method === "GET") {
    needRole("admin");
    return settingsOut();
  }
  if (pathname === "/api/settings/calendar/connect" && method === "GET") {
    const actor = needRole("admin");
    Object.assign(settings.calendar, { connected: true, account_email: "calendar@example.com", calendar_id: null, calendar_name: null, last_error: null });
    settings.mail.needs_reconnect = false; // a fresh grant includes sending email
    log(actor, "calendar.connect", "calendar", "Connected the shared calendar.");
    res.writeHead(302, { Location: "/settings" });
    res.end();
    return null;
  }
  if (pathname === "/api/settings/calendars" && method === "GET") {
    needRole("admin");
    if (!settings.calendar.connected) refuse(409, "calendar_not_connected", "Connect Google Calendar first.");
    return { calendars: CALENDARS };
  }
  if (pathname === "/api/settings/calendar" && method === "PUT" && "titles" in body && !("calendar_id" in body)) {
    const actor = needRole("admin");
    if (!["type", "out"].includes(body.titles)) refuse(400, "bad_setting", "Pick what calendar entries show.");
    settings.calendar.titles = body.titles;
    log(actor, "calendar.titles", "calendar", body.titles === "out" ? "Calendar entries say Out." : "Calendar entries name the type.");
    return { settings: settingsOut() };
  }
  if (pathname === "/api/settings/calendar" && method === "PUT") {
    const actor = needRole("admin");
    const pick = CALENDARS.find((c) => c.id === body.calendar_id && c.writable) ?? refuse(400, "bad_calendar", "Pick a calendar this account can add events to.");
    Object.assign(settings.calendar, { calendar_id: pick.id, calendar_name: pick.name });
    log(actor, "calendar.choose", "calendar", `Time off now goes on ${pick.name}.`);
    return { settings: settingsOut() };
  }
  if (pathname === "/api/settings/slack" && method === "PUT") {
    const actor = needRole("admin");
    if ("auto_enroll" in body) {
      if (typeof body.auto_enroll !== "boolean") refuse(400, "bad_setting", "Choose on or off.");
      if (body.auto_enroll && settings.slack.auto_enroll_blocked_reason) refuse(409, "auto_enroll_blocked", settings.slack.auto_enroll_blocked_reason);
      settings.slack.auto_enroll = body.auto_enroll;
      log(actor, "settings.slack", "slack", body.auto_enroll ? "Anyone in the workspace can ask for time off." : "Only people on the roster can ask.");
    }
    if ("manager_pick" in body) {
      if (!["confirm_every", "confirm_new", "managers_only", "anyone"].includes(body.manager_pick)) refuse(400, "bad_setting", "Pick who can be chosen as a manager.");
      settings.slack.manager_pick = body.manager_pick;
      log(actor, "settings.slack", "slack", { confirm_every: "Anyone can be picked as manager in Slack; an admin confirms each request’s manager first.", confirm_new: "Anyone can be picked as manager in Slack; an admin confirms new ones.", managers_only: "Only existing managers can be picked in Slack.", anyone: "Anyone can be picked as manager in Slack." }[body.manager_pick]);
    }
    return { settings: settingsOut() };
  }
  if (pathname === "/api/settings/calendar/disconnect" && method === "POST") {
    const actor = needRole("admin");
    Object.assign(settings.calendar, { connected: false, account_email: null, calendar_id: null, calendar_name: null, last_error: null });
    log(actor, "calendar.disconnect", "calendar", "Disconnected the shared calendar.");
    return { settings: settingsOut() };
  }
  if (pathname === "/api/settings/calendar/retry" && method === "POST") {
    const actor = needRole("admin");
    const waiting = requests.filter((r) => r.status === "approved" && r.calendar.state === "pending");
    for (const r of waiting) r.calendar = added();
    settings.calendar.last_error = null;
    log(actor, "calendar.retry", "calendar", `Tried ${waiting.length} waiting calendar changes; 0 still waiting.`);
    return { retried: waiting.length, failed: 0 };
  }
  if (pathname === "/api/audit" && method === "GET") {
    needRole("admin");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
    return { events: [...audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit) };
  }
  if (pathname === "/healthz") return { ok: true };

  refuse(404, "not_found", "That isn’t here.");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  // A short pause so loading states are visible, like a real network.
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 120));
  try {
    const answer = await route(req, res, url);
    if (answer !== null) send(res, 200, answer);
  } catch (error) {
    if (error instanceof Refusal) send(res, error.status, { error: { code: error.code, message: error.message } });
    else {
      console.error(error);
      send(res, 500, { error: { code: "server", message: "Something went wrong on our side. Try again." } });
    }
  }
  console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Time Off sample API on http://${HOST}:${PORT} (sample data, signed in as "${current}")`);
});
