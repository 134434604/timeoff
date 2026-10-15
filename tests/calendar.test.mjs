// The calendar client's idempotent insert, offline and against a stubbed
// Google; and two small guards from the review (return paths, mail subjects).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eventIdFor, insertAllDayEvent } from "../server/google/calendar.mjs";
import { readFixture, tokenFile, writeFixture } from "../server/google/calendar-grant.mjs";
import { safeReturn } from "../server/auth/google.mjs";
import { encodeHeader } from "../server/auth/mail.mjs";

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-cal-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const event = (eventId) => ({ eventId, calendarId: "fixture-smto", summary: "Pat Lee — Time off", description: "x", start_date: "2026-10-19", end_date: "2026-10-21" });

test("eventIdFor is fixed per request and base32hex", () => {
  assert.equal(eventIdFor("req_0123456789abcdef01"), "timeoff0123456789abcdef01");
  assert.match(eventIdFor("req_ffffffffffffffffff"), /^[0-9a-v]{5,1024}$/);
});

test("the practice calendar writes one event per id, however often it is asked", async () => {
  const dataDir = tempDir();
  const env = { ALLOW_FIXTURES: "1", CALENDAR_FIXTURE: "1", DATA_DIR: dataDir };
  writeFixture(dataDir, { ...readFixture(dataDir), account_email: "calendar-fixture@example.com" });
  const id = eventIdFor("req_0123456789abcdef01");
  assert.deepEqual(await insertAllDayEvent(event(id), { env, dataDir }), { id, existed: false });
  assert.deepEqual(await insertAllDayEvent(event(id), { env, dataDir }), { id, existed: true });
  const events = readFixture(dataDir).events;
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].start.date, events[0].end.date], ["2026-10-19", "2026-10-22"]);
});

test("Google's 409 for an id already there counts as added", async () => {
  const dataDir = tempDir();
  const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", PUBLIC_ORIGIN: "https://timeoff.example.com", DATA_DIR: dataDir };
  writeFileSync(tokenFile(dataDir), JSON.stringify({ refreshToken: "1//stub-refresh", accountEmail: null, scopes: [] }));
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), body: init.body });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.stub", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: { code: 409, message: "The requested identifier already exists." } }), { status: 409, headers: { "Content-Type": "application/json" } });
  };
  const id = eventIdFor("req_0123456789abcdef02");
  assert.deepEqual(await insertAllDayEvent(event(id), { env, dataDir, fetchImpl }), { id, existed: true });
  const insert = seen.find((row) => row.url.includes("/events"));
  assert.equal(JSON.parse(insert.body).id, id);
});

test("safeReturn keeps only a printable path on this site", () => {
  assert.equal(safeReturn("/approvals?x=1"), "/approvals?x=1");
  for (const bad of ["//evil.example.com", "/\\evil.example.com", "/a b", "https://evil.example.com", "/café", "/a\u0000b"]) assert.equal(safeReturn(bad), "/", bad);
});

test("a mail subject with non-ASCII is RFC 2047 encoded", () => {
  assert.equal(encodeHeader("Pat asked for time off"), "Pat asked for time off");
  const encoded = encodeHeader("Zoë Lee asked for time off");
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8"), "Zoë Lee asked for time off");
  const long = encodeHeader("é".repeat(60));
  for (const word of long.split("\r\n ")) assert.ok(word.length <= 75, word);
});
