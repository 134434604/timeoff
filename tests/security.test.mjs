// The security review's fixes that need a server of their own or none:
// the Workspace (hd) check on sign-in, the setup token's lifetime and
// header, the response headers, and the failure throttle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../server/db.mjs";
import { personForGoogle } from "../server/auth/sessions.mjs";
import { failuresIn, recordFailure } from "../server/auth/throttle.mjs";
import { setupTokenFile } from "../server/keys.mjs";
import { calendarTitleWord } from "../server/domain/kinds.mjs";

process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

const temp = () => mkdtempSync(path.join(tmpdir(), "timeoff-sec-"));

test("sign-in: with a company domain set, the Google account must be in that Workspace (hd)", () => {
  const db = openDb(":memory:");
  const env = { ALLOWED_EMAIL_DOMAIN: "example.com", BOOTSTRAP_ADMIN_EMAIL: "owner@example.com" };
  const google = { sub: "sub-1", email: "owner@example.com", email_verified: true, name: "Owner" };
  assert.throws(() => personForGoogle(db, { ...google, hd: null }, { env }), (error) => error.code === "not_on_roster");
  assert.throws(() => personForGoogle(db, { ...google, hd: "other.com" }, { env }), (error) => error.code === "not_on_roster");
  assert.equal(personForGoogle(db, { ...google, hd: "Example.com" }, { env }).created, true);
  // No company domain: hd is not asked for.
  const open = openDb(":memory:");
  assert.equal(personForGoogle(open, { ...google, hd: null }, { env: { BOOTSTRAP_ADMIN_EMAIL: "owner@example.com" } }).created, true);
});

test("the failure throttle counts only what is recorded", () => {
  const db = openDb(":memory:");
  const key = { kind: "slack_bad_signature", key: "198.51.100.7" };
  assert.equal(failuresIn(db, { ...key, windowMs: 60_000 }), 0);
  for (let i = 0; i < 3; i += 1) recordFailure(db, key);
  assert.equal(failuresIn(db, { ...key, windowMs: 60_000 }), 3);
  assert.equal(failuresIn(db, { kind: "slack_bad_signature", key: "203.0.113.9", windowMs: 60_000 }), 0);
});

test("calendar titles: Out for the private types unless the admin chose the Type", () => {
  assert.deepEqual(["pto", "sick", "unpaid", "loa", "unavailable"].map((kind) => calendarTitleWord(kind)), ["SMTO", "Out", "Out", "Out", "Unavailable"]);
  assert.deepEqual(["pto", "sick", "unpaid", "loa", "unavailable"].map((kind) => calendarTitleWord(kind, "type")), ["SMTO", "Sick", "Unpaid Time", "LOA", "Unavailable"]);
});

test("setup token: gone at startup once a Google client exists, and refused even if it reappears", async () => {
  const dataDir = temp();
  writeFileSync(setupTokenFile(dataDir), "0123456789abcdef0123456789abcdef");
  const app = await startServer({ port: 0, host: "127.0.0.1", env: { DATA_DIR: dataDir, GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" } });
  try {
    assert.equal(existsSync(setupTokenFile(dataDir)), false);
    writeFileSync(setupTokenFile(dataDir), "0123456789abcdef0123456789abcdef");
    const byHeader = await fetch(new URL("/api/setup/status", app.url), { headers: { "x-setup-token": "0123456789abcdef0123456789abcdef" } });
    assert.equal(byHeader.status, 404);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("setup token: accepted from the X-Setup-Token header while no Google client exists", async () => {
  const dataDir = temp();
  const app = await startServer({ port: 0, host: "127.0.0.1", env: { DATA_DIR: dataDir } });
  try {
    const token = (await import("node:fs")).readFileSync(setupTokenFile(dataDir), "utf8");
    const ok = await fetch(new URL("/api/setup/status", app.url), { headers: { "x-setup-token": token } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    assert.equal((await fetch(new URL("/api/setup/status", app.url), { headers: { "x-setup-token": "f".repeat(32) } })).status, 404);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("every response carries the security headers; HSTS only on https", async () => {
  const dataDir = temp();
  const app = await startServer({ port: 0, host: "127.0.0.1", env: { DATA_DIR: dataDir, PUBLIC_ORIGIN: "https://timeoff.example.com" } });
  const local = await startServer({ port: 0, host: "127.0.0.1", env: { DATA_DIR: temp() } });
  try {
    for (const route of ["/healthz", "/api/me", "/api/nothing-here", "/approvals"]) {
      const response = await fetch(new URL(route, app.url));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", route);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", route);
      assert.equal(response.headers.get("x-frame-options"), "DENY", route);
      assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'", route);
      assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000", route);
    }
    const plain = await fetch(new URL("/healthz", local.url));
    assert.equal(plain.headers.get("strict-transport-security"), null);
    assert.equal(plain.headers.get("x-frame-options"), "DENY");
  } finally {
    await app.close();
    await local.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
