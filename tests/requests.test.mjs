import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, findOverlaps, previewWarnings, transition } from "../server/domain/requests.mjs";

const owner = { id: "per_owner", role: "employee" };
const manager = { id: "per_manager", role: "manager" };
const otherManager = { id: "per_other", role: "manager" };
const admin = { id: "per_admin", role: "admin" };
const peer = { id: "per_peer", role: "employee" };
const context = { managerId: "per_manager", today: "2026-10-14" };
const request = (status, start_date = "2026-10-19") => ({ id: "req_1", person_id: "per_owner", status, start_date, end_date: start_date });

// [status, action, actor, expected status or refusal code, start_date?]
const table = [
  ["pending", "approve", manager, "approved"],
  ["pending", "approve", admin, "approved"],
  ["pending", "deny", manager, "denied"],
  ["pending", "deny", admin, "denied"],
  ["pending", "approve", owner, "own_request"],
  ["pending", "deny", owner, "own_request"],
  ["pending", "approve", otherManager, "not_your_report"],
  ["pending", "approve", peer, "not_your_report"],
  ["approved", "approve", manager, "not_pending"],
  ["approved", "deny", manager, "not_pending"],
  ["denied", "approve", admin, "not_pending"],
  ["cancelled", "approve", manager, "not_pending"],
  ["pending", "cancel", owner, "cancelled"],
  ["pending", "cancel", manager, "deny_instead"],
  ["pending", "cancel", admin, "deny_instead"],
  ["pending", "cancel", peer, "not_allowed"],
  ["approved", "cancel", owner, "cancelled"],
  ["approved", "cancel", owner, "already_started", "2026-10-14"],
  ["approved", "cancel", owner, "already_started", "2026-10-01"],
  ["approved", "cancel", manager, "cancelled", "2026-10-01"],
  ["approved", "cancel", admin, "cancelled", "2026-10-01"],
  ["approved", "cancel", otherManager, "not_allowed"],
  ["denied", "cancel", owner, "not_pending"],
  ["cancelled", "cancel", owner, "not_pending"],
  ["pending", "explode", admin, "invalid_action"],
];

for (const [status, action, actor, expected, start] of table) {
  test(`transition: ${status} --${action}--> by ${actor.id.slice(4)}${start ? ` (starts ${start})` : ""}`, () => {
    const run = () => transition(request(status, start), action, actor, context);
    if (["approved", "denied", "cancelled"].includes(expected)) assert.equal(run(), expected);
    else assert.throws(run, (error) => error.code === expected && typeof error.message === "string" && error.status >= 400);
  });
}

test("transition: an admin cannot approve their own request, even with no manager", () => {
  const own = { ...request("pending"), person_id: admin.id };
  assert.throws(() => transition(own, "approve", admin, { managerId: null, today: "2026-10-14" }), (error) => error.code === "own_request");
});

test("transition: a manager who is also the requester's manager cannot approve their own", () => {
  const own = { ...request("pending"), person_id: manager.id };
  assert.throws(() => transition(own, "approve", manager, { managerId: manager.id, today: "2026-10-14" }), (error) => error.code === "own_request");
});

const person = { worker_type: "employee" };
const draftCases = [
  ["end before start", { start_date: "2026-10-20", end_date: "2026-10-19", kind: "pto" }, "end_before_start"],
  ["not a date", { start_date: "2026-02-30", end_date: "2026-03-01", kind: "pto" }, "invalid_dates"],
  ["bad kind", { start_date: "2026-10-19", end_date: "2026-10-19", kind: "vacation" }, "invalid_kind"],
  ["unavailable is no longer offered", { start_date: "2026-10-19", end_date: "2026-10-19", kind: "unavailable" }, "kind_not_offered"],
  ["more than 30 days back", { start_date: "2026-09-01", end_date: "2026-09-01", kind: "pto" }, "too_far_back"],
  ["only a weekend", { start_date: "2026-10-24", end_date: "2026-10-25", kind: "pto" }, "no_working_days"],
  ["longer than a year", { start_date: "2026-10-19", end_date: "2027-10-30", kind: "unpaid" }, "too_long"],
  ["overlaps my own approved time off", { start_date: "2026-10-20", end_date: "2026-10-22", kind: "sick" }, "overlaps_own"],
];
const own = [{ id: "req_a", status: "approved", start_date: "2026-10-21", end_date: "2026-10-23" }, { id: "req_b", status: "denied", start_date: "2026-11-02", end_date: "2026-11-03" }];

for (const [name, body, code] of draftCases) {
  test(`checkDraft refuses: ${name}`, () => {
    assert.throws(() => checkDraft(body, { person, today: "2026-10-14", own }), (error) => error.code === code);
  });
}

test("checkDraft accepts a good request and counts it", () => {
  const draft = checkDraft({ start_date: "2026-11-02", end_date: "2026-11-04", kind: "pto", half_day_end: true, note: "  trip  " }, { person, today: "2026-10-14", own });
  assert.equal(draft.days, 2.5);
  assert.equal(draft.note, "trip");
  assert.deepEqual(draft.byYear, { 2026: 2.5 });
});

test("checkDraft lets a contractor ask for SMTO, and lets a preview skip the submit-only checks", () => {
  assert.equal(checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind: "pto" }, { person: { worker_type: "contractor" }, today: "2026-10-14" }).days, 1);
  assert.equal(checkDraft({ start_date: "2026-10-24", end_date: "2026-10-25" }, { person, today: "2026-10-14", own, preview: true }).kind, "pto");
});

test("findOverlaps ignores denied, cancelled and the request itself", () => {
  const rows = [
    { id: "a", status: "approved", start_date: "2026-10-19", end_date: "2026-10-20" },
    { id: "b", status: "pending", start_date: "2026-10-23", end_date: "2026-10-23" },
    { id: "c", status: "denied", start_date: "2026-10-19", end_date: "2026-10-30" },
    { id: "d", status: "approved", start_date: "2026-10-24", end_date: "2026-10-30" },
  ];
  assert.deepEqual(findOverlaps({ start_date: "2026-10-20", end_date: "2026-10-23" }, rows).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(findOverlaps({ start_date: "2026-10-20", end_date: "2026-10-23" }, rows, { excludeId: "a" }).map((row) => row.id), ["b"]);
});

test("previewWarnings are plain sentences", () => {
  const draft = { start_date: "2026-10-19", end_date: "2026-10-21", days: 3 };
  const warnings = previewWarnings({ draft, balanceAfter: -1.5, teamOverlaps: [{ name: "Pat Lee" }], ownOverlaps: [], holidaysInRange: [{ date: "2026-10-20", name: "Founders Day" }], today: "2026-10-14" });
  assert.deepEqual(warnings, [
    "This takes you 1.5 days below your balance.",
    "Pat Lee is also out during these dates.",
    "Founders Day is a company holiday, so it is not counted.",
  ]);
  assert.deepEqual(previewWarnings({ draft, balanceAfter: 2, teamOverlaps: [{ name: "A" }, { name: "B" }], today: "2026-10-14" }), ["2 people on your team are also out during these dates."]);
  assert.deepEqual(previewWarnings({ draft: { ...draft, days: 0 }, balanceAfter: null, today: "2026-10-14" }), ["These dates are all weekends or holidays, so no days would be used."]);
  assert.equal(previewWarnings({ draft, balanceAfter: -1, today: "2026-10-14" })[0], "This takes you 1 day below your balance.");
});

test("transition: a manager demoted to employee can no longer decide for old reports", () => {
  const demoted = { id: "per_manager", role: "employee" };
  assert.throws(() => transition(request("pending"), "approve", demoted, context), (error) => error.code === "not_your_report");
  assert.throws(() => transition(request("approved", "2026-10-01"), "cancel", demoted, context), (error) => error.code === "not_allowed");
});

test("checkDraft refuses a start more than two years ahead, in a preview too", () => {
  for (const preview of [false, true]) {
    assert.throws(() => checkDraft({ start_date: "9999-12-30", end_date: "9999-12-31", kind: "pto" }, { person, today: "2026-10-14", preview }), (error) => error.code === "too_far_ahead");
  }
  assert.equal(checkDraft({ start_date: "2028-10-13", end_date: "2028-10-13", kind: "pto" }, { person, today: "2026-10-14" }).days, 1);
});

test("checkDraft offers each person only their Types: hourly contractors no Sick, nobody Unavailable", () => {
  const hourly = { worker_type: "contractor", pay_basis: "hourly" };
  const monthly = { worker_type: "contractor", pay_basis: "monthly" };
  for (const who of [person, hourly, monthly]) {
    assert.throws(() => checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind: "unavailable" }, { person: who, today: "2026-10-14" }), (error) => error.code === "kind_not_offered");
  }
  assert.throws(() => checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind: "sick" }, { person: hourly, today: "2026-10-14" }), (error) => error.code === "kind_not_offered" && /SMTO, Unpaid Time, LOA/.test(error.message));
  for (const kind of ["pto", "unpaid", "loa"]) assert.equal(checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind }, { person: hourly, today: "2026-10-14" }).kind, kind);
  assert.equal(checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind: "sick" }, { person: monthly, today: "2026-10-14" }).kind, "sick");
  assert.equal(checkDraft({ start_date: "2026-10-19", end_date: "2026-10-19", kind: "loa" }, { person, today: "2026-10-14" }).kind, "loa");
});

test("transition: the only admin may decide their own request, nobody else may", () => {
  const own = { ...request("pending"), person_id: admin.id };
  assert.equal(transition(own, "approve", admin, { managerId: null, today: "2026-10-14", soleAdmin: true }), "approved");
  assert.equal(transition(own, "deny", admin, { managerId: null, today: "2026-10-14", soleAdmin: true }), "denied");
  assert.throws(() => transition(own, "approve", admin, { managerId: null, today: "2026-10-14", soleAdmin: false }), (error) => error.code === "own_request");
  const managerOwn = { ...request("pending"), person_id: manager.id };
  assert.throws(() => transition(managerOwn, "approve", manager, { managerId: null, today: "2026-10-14", soleAdmin: true }), (error) => error.code === "own_request");
});
