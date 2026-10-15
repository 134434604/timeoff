import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBalance } from "../server/domain/balance.mjs";

const policy = (over = {}) => ({ annual_days: 15, accrual: "front_loaded", carryover_cap: 5, start_date: "2020-01-01", ...over });
const pto = (start_date, end_date, status = "approved", extra = {}) => ({ kind: "pto", status, start_date, end_date, ...extra });

const cases = [
  {
    name: "front-loaded: the whole year on Jan 1",
    input: { policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-01-01" },
    expect: { allowance: 15, accrued: 15, carried_over: 0, used: 0, pending: 0, available: 15, tracked: true },
  },
  {
    name: "monthly mid-year: 10 months by October",
    input: { policy: policy({ accrual: "monthly", annual_days: 12, carryover_cap: 0 }), year: 2026, today: "2026-10-14" },
    expect: { allowance: 12, accrued: 10, available: 10 },
  },
  {
    name: "monthly, start year: from the start month only",
    input: { policy: policy({ accrual: "monthly", annual_days: 12, start_date: "2026-04-20" }), year: 2026, today: "2026-06-01" },
    expect: { allowance: 9, accrued: 3, carried_over: 0, available: 3 },
  },
  {
    name: "monthly, before the start date nothing accrues",
    input: { policy: policy({ accrual: "monthly", annual_days: 12, start_date: "2026-04-20" }), year: 2026, today: "2026-04-01" },
    expect: { accrued: 0, available: 0 },
  },
  {
    name: "front-loaded start year prorated to the nearest half day",
    // 15 x 5/12 = 6.25 -> 6.5
    input: { policy: policy({ start_date: "2026-08-10" }), year: 2026, today: "2026-09-01" },
    expect: { allowance: 6.5, accrued: 6.5, available: 6.5 },
  },
  {
    name: "front-loaded start year, before the start date",
    input: { policy: policy({ start_date: "2026-08-10" }), year: 2026, today: "2026-08-01" },
    expect: { allowance: 6.5, accrued: 0, available: 0 },
  },
  {
    name: "carryover is capped",
    // 2025: 15, 3 used -> 12 left; cap 5
    input: { policy: policy({ start_date: "2025-01-01" }), year: 2026, today: "2026-02-01", requests: [pto("2025-03-02", "2025-03-04")] },
    expect: { carried_over: 5, accrued: 15, used: 0, available: 20 },
  },
  {
    name: "carryover below the cap carries what was left",
    // 2025: 15 - 12 used = 3
    input: { policy: policy({ start_date: "2025-01-01" }), year: 2026, today: "2026-02-01", requests: [pto("2025-03-02", "2025-03-18")] },
    expect: { carried_over: 3, available: 18 },
  },
  {
    name: "a negative year carries nothing",
    input: { policy: policy({ start_date: "2025-01-01" }), year: 2026, today: "2026-02-01", requests: [pto("2025-03-02", "2025-04-03")], adjustments: [] },
    expect: { carried_over: 0, available: 15 },
  },
  {
    name: "carryover chains back to the start year",
    // 2024 start in July: 15 x 6/12 = 7.5, none used -> 5 carried; 2025: 15 + 5 = 20, 18 used -> 2; 2026 carries 2.
    input: { policy: policy({ start_date: "2024-07-01" }), year: 2026, today: "2026-01-05", requests: [pto("2025-02-02", "2025-02-26")] },
    expect: { carried_over: 2, available: 17 },
  },
  {
    name: "adjustments count only in their year",
    input: { policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-05-01", adjustments: [{ year: 2026, days: 2 }, { year: 2026, days: -0.5 }, { year: 2025, days: 9 }] },
    expect: { adjustments: 1.5, available: 16.5 },
  },
  {
    name: "pending pto is held",
    input: { policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-05-01", requests: [pto("2026-10-19", "2026-10-20", "pending"), pto("2026-06-01", "2026-06-01")] },
    expect: { used: 1, pending: 2, available: 12 },
  },
  {
    name: "sick, unpaid, denied and cancelled never touch the balance",
    input: {
      policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-05-01",
      requests: [
        { kind: "sick", status: "approved", start_date: "2026-03-02", end_date: "2026-03-03" },
        { kind: "unpaid", status: "pending", start_date: "2026-03-09", end_date: "2026-03-10" },
        pto("2026-04-06", "2026-04-07", "denied"),
        pto("2026-04-13", "2026-04-14", "cancelled"),
      ],
    },
    expect: { used: 0, pending: 0, available: 15 },
  },
  {
    name: "a request across New Year is charged per date",
    input: { policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-12-01", requests: [pto("2026-12-30", "2027-01-05")] },
    expect: { used: 2, available: 13 },
  },
  {
    name: "half days and holidays follow workingDays",
    input: { policy: policy({ carryover_cap: 0 }), year: 2026, today: "2026-05-01", holidays: new Set(["2026-05-25"]), requests: [pto("2026-05-22", "2026-05-26", "approved", { half_day_start: true })] },
    expect: { used: 1.5, available: 13.5 },
  },
  {
    name: "untracked when annual_days is 0",
    input: { policy: policy({ annual_days: 0 }), year: 2026, today: "2026-05-01", requests: [pto("2026-03-02", "2026-03-03")], adjustments: [{ year: 2026, days: 3 }] },
    expect: { tracked: false, allowance: 0, accrued: 0, carried_over: 0, adjustments: 0, used: 2, available: 0 },
  },
  {
    name: "untracked with no policy at all",
    input: { policy: null, year: 2026, today: "2026-05-01" },
    expect: { tracked: false, available: 0 },
  },
  {
    name: "a year before the start has nothing",
    input: { policy: policy({ start_date: "2027-01-04" }), year: 2026, today: "2026-05-01" },
    expect: { allowance: 0, accrued: 0, available: 0, tracked: true },
  },
  {
    name: "outputs round to two decimals",
    // 10/12 per month x 7 months = 5.8333
    input: { policy: policy({ accrual: "monthly", annual_days: 10, carryover_cap: 0 }), year: 2026, today: "2026-07-31" },
    expect: { accrued: 5.83, available: 5.83 },
  },
];

for (const row of cases) {
  test(`computeBalance: ${row.name}`, () => {
    const balance = computeBalance(row.input);
    assert.equal(balance.unit, "days");
    assert.equal(balance.year, row.input.year);
    for (const [key, value] of Object.entries(row.expect)) assert.equal(balance[key], value, `${key}`);
    if (balance.tracked) assert.equal(balance.available, Math.round((balance.accrued + balance.carried_over + balance.adjustments - balance.used - balance.pending) * 100) / 100);
  });
}

test("computeBalance: a start decades back walks carryover in a loop, not recursion", () => {
  const balance = computeBalance({ policy: { annual_days: 10, accrual: "monthly", carryover_cap: 3, start_date: "1990-01-01" }, year: 2026, today: "2026-01-15" });
  assert.equal(balance.carried_over, 3);
  assert.equal(balance.accrued, 0.83);
  // A far year still answers (the server refuses such dates before here).
  assert.equal(computeBalance({ policy: { annual_days: 10, accrual: "front_loaded", carryover_cap: 0, start_date: "2000-01-01" }, year: 9999, today: "9999-12-31" }).available, 10);
});
