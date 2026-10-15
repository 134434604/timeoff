import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, isDate, isoToday, monthsElapsed, weekday, workingDays } from "../server/domain/dates.mjs";

// 2026-10-19 is a Monday.
const cases = [
  { name: "one weekday", input: { start_date: "2026-10-19", end_date: "2026-10-19" }, days: 1 },
  { name: "Monday to Friday", input: { start_date: "2026-10-19", end_date: "2026-10-23" }, days: 5 },
  { name: "Friday to Monday skips the weekend", input: { start_date: "2026-10-23", end_date: "2026-10-26" }, days: 2, dates: ["2026-10-23", "2026-10-26"] },
  { name: "a weekend alone is nothing", input: { start_date: "2026-10-24", end_date: "2026-10-25" }, days: 0, dates: [] },
  { name: "a holiday is skipped", input: { start_date: "2026-10-19", end_date: "2026-10-23", holidays: new Set(["2026-10-21"]) }, days: 4 },
  { name: "half day at the start", input: { start_date: "2026-10-19", end_date: "2026-10-21", half_day_start: true }, days: 2.5 },
  { name: "half day at the end", input: { start_date: "2026-10-19", end_date: "2026-10-21", half_day_end: true }, days: 2.5 },
  { name: "half days at both ends", input: { start_date: "2026-10-19", end_date: "2026-10-21", half_day_start: true, half_day_end: true }, days: 2 },
  { name: "single day with both halves is half a day", input: { start_date: "2026-10-19", end_date: "2026-10-19", half_day_start: true, half_day_end: true }, days: 0.5 },
  { name: "single day with one half", input: { start_date: "2026-10-19", end_date: "2026-10-19", half_day_end: true }, days: 0.5 },
  { name: "half day lands on the first counted date, past a weekend", input: { start_date: "2026-10-24", end_date: "2026-10-27", half_day_start: true }, days: 1.5, dates: ["2026-10-26", "2026-10-27"] },
  { name: "half day lands on the last counted date, before a holiday", input: { start_date: "2026-10-19", end_date: "2026-10-21", half_day_end: true, holidays: new Set(["2026-10-21"]) }, days: 1.5 },
  { name: "across New Year splits by year", input: { start_date: "2026-12-30", end_date: "2027-01-05", holidays: new Set(["2027-01-01"]) }, days: 4, byYear: { 2026: 2, 2027: 2 } },
  { name: "across New Year with half days", input: { start_date: "2026-12-31", end_date: "2027-01-04", half_day_start: true, half_day_end: true }, days: 2, byYear: { 2026: 0.5, 2027: 1.5 } },
  { name: "leap day counts", input: { start_date: "2028-02-28", end_date: "2028-03-01" }, days: 3 },
];

for (const row of cases) {
  test(`workingDays: ${row.name}`, () => {
    const result = workingDays(row.input);
    assert.equal(result.days, row.days);
    if (row.dates) assert.deepEqual(result.dates, row.dates);
    if (row.byYear) assert.deepEqual(result.byYear, row.byYear);
    assert.equal(Object.values(result.byYear).reduce((a, b) => a + b, 0), result.days);
  });
}

test("dates: validity, weekdays, arithmetic", () => {
  assert.equal(isDate("2026-02-29"), false);
  assert.equal(isDate("2028-02-29"), true);
  assert.equal(isDate("2026-13-01"), false);
  assert.equal(isDate("26-01-01"), false);
  assert.equal(weekday("2026-10-19"), 1);
  assert.equal(weekday("1970-01-01"), 4);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
});

test("monthsElapsed counts both end months", () => {
  assert.equal(monthsElapsed("2026-01-20", "2026-03-02"), 3);
  assert.equal(monthsElapsed("2026-01-01", "2026-01-31"), 1);
  assert.equal(monthsElapsed("2026-11-01", "2027-02-01"), 4);
  assert.equal(monthsElapsed("2026-05-01", "2026-04-30"), 0);
});

test("isoToday reads the date in the given zone", () => {
  const instant = new Date("2026-10-15T02:30:00Z");
  assert.equal(isoToday(instant, "UTC"), "2026-10-15");
  assert.equal(isoToday(instant, "America/New_York"), "2026-10-14");
  assert.equal(isoToday(instant, "Not/AZone"), "2026-10-15");
});
