// Keys typed into the setup page: the store, the env they lay over, the
// one-time setup token, and the routes, with no secret ever echoed back or
// written to the audit table.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { effectiveEnv, ensureSetupToken, keysFile, liveEnv, readKeys, saveKeys, setupTokenFile, setupTokenMatches, deleteSetupToken } from "../server/keys.mjs";

process.env.TIMEOFF_NO_AUTOSTART = "1";
const { startServer } = await import("../server/index.mjs");

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-keys-"));
  dirs.push(dir);
  return dir;
};
const privateFile = (file) => process.platform === "win32" || (statSync(file).mode & 0o777) === 0o600;

const SECRETS = {
  google_client_id: "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
  google_client_secret: "GOCSPX-very-secret-value",
  slack_bot_token: "xoxb-good-token-value",
  slack_signing_secret: "0123456789abcdef0123456789abcdef",
};
const ADMIN = "admin@example.com";

test("the store: round trip, clearing, unknown names ignored, private file", () => {
  const dir = tempDir();
  assert.deepEqual(readKeys(dir), {});
  assert.deepEqual(saveKeys(dir, { google_client_id: " id-1 ", slack_bot_token: "xoxb-1", nonsense: "x" }), ["google_client_id", "slack_bot_token"]);
  const saved = readKeys(dir);
  assert.equal(saved.google_client_id, "id-1");
  assert.equal(saved.slack_bot_token, "xoxb-1");
  assert.equal(saved.nonsense, undefined);
  assert.match(saved.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(privateFile(keysFile(dir)));
  saveKeys(dir, { slack_bot_token: "" });
  assert.equal(readKeys(dir).slack_bot_token, undefined);
  assert.equal(readKeys(dir).google_client_id, "id-1");
});

test("precedence: a saved key wins over the env, and the env fills the rest; no restart needed", () => {
  const dir = tempDir();
  const base = { GOOGLE_CLIENT_ID: "from-env", MAIL_FROM: "Env <env@example.com>", PORT: "5610" };
  const live = liveEnv(base, dir);
  assert.equal(live.GOOGLE_CLIENT_ID, "from-env");
  saveKeys(dir, { google_client_id: "from-keys" });
  assert.equal(live.GOOGLE_CLIENT_ID, "from-keys");
  assert.equal(live.MAIL_FROM, "Env <env@example.com>");
  assert.equal(live.PORT, "5610");
  assert.equal(effectiveEnv(base, dir).GOOGLE_CLIENT_ID, "from-keys");
  saveKeys(dir, { google_client_id: "" });
  assert.equal(live.GOOGLE_CLIENT_ID, "from-env");
});

test("the setup token: 32 hex, private, constant-time match, deleted for good", () => {
  const dir = tempDir();
  ensureSetupToken(dir);
  const token = readFileSync(setupTokenFile(dir), "utf8");
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.ok(privateFile(setupTokenFile(dir)));
  ensureSetupToken(dir);
  assert.equal(readFileSync(setupTokenFile(dir), "utf8"), token, "generated once");
  assert.equal(setupTokenMatches(dir, token), true);
  assert.equal(setupTokenMatches(dir, token.replace(/.$/, "0") === token ? token.replace(/.$/, "1") : token.replace(/.$/, "0")), false);
  assert.equal(setupTokenMatches(dir, ""), false);
  deleteSetupToken(dir);
  assert.equal(setupTokenMatches(dir, token), false);
});

// ------------------------------------------------------------------- HTTP --

let app;
let dataDir;
const responses = [];

async function call(method, route, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(route, app.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await response.text();
  responses.push(text);
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

// Slack's auth.test, stubbed: the good token is accepted, anything else is not.
const slackStub = async (url, init = {}) => {
  if (String(url) === "https://slack.com/api/auth.test") {
    const good = init.headers?.Authorization === `Bearer ${SECRETS.slack_bot_token}`;
    return new Response(JSON.stringify(good ? { ok: true, team: "Acme Workspace", team_id: "TACME" } : { ok: false, error: "invalid_auth" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

before(async () => {
  dataDir = tempDir();
  app = await startServer({ port: 0, host: "127.0.0.1", fetchImpl: slackStub, env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", MAIL_FIXTURE: "1", DATA_DIR: dataDir, BOOTSTRAP_ADMIN_EMAIL: ADMIN } });
});

after(async () => {
  await app?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a server with no Google client says so and makes the setup token", async () => {
  const bare = tempDir();
  const other = await startServer({ port: 0, host: "127.0.0.1", env: { DATA_DIR: bare } });
  try {
    const me = await fetch(new URL("/api/me", other.url)).then((response) => response.json());
    assert.equal(me.needs_setup, true);
    assert.equal(me.google.on, false);
    assert.ok(existsSync(setupTokenFile(bare)));
  } finally {
    await other.close();
  }
});

test("setup routes: wrong or missing token is a 404, the right one works once, then admins only", async () => {
  const admin = await signIn(ADMIN);
  assert.ok(admin, "the admin signs in through the practice Google first");
  const token = readFileSync(setupTokenFile(dataDir), "utf8");
  assert.equal((await call("GET", "/api/me")).json.needs_setup, false, "the practice sign-in counts as set up");

  assert.equal((await call("GET", "/api/setup/status")).status, 404);
  assert.equal((await call("GET", "/api/setup/status?token=0123456789abcdef0123456789abcdef")).status, 404);
  const status = await call("GET", `/api/setup/status?token=${token}`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { ok: true, has_google: false, google_client_id_last4: null, has_slack: false, has_admin_email: true, has_allowed_domain: false, has_mail_from: false, public_origin: null });

  assert.equal((await call("PUT", "/api/setup/keys", { body: { token: "nope", ...SECRETS } })).status, 404);
  assert.equal((await call("PUT", "/api/setup/keys", { body: { token, google_client_id: "not-a-client-id" } })).json.error.code, "invalid_google_client_id");
  assert.ok(existsSync(setupTokenFile(dataDir)), "a refused save does not spend the token");

  const saved = await call("PUT", "/api/setup/keys", { body: { token, ...SECRETS, allowed_email_domain: "example.com", mail_from: "Time Off <timeoff@example.com>" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.saved, ["google_client_id", "google_client_secret", "slack_bot_token", "slack_signing_secret", "allowed_email_domain", "mail_from"]);
  assert.deepEqual(saved.json.slack, { checked: true, ok: true, team_name: "Acme Workspace" });
  assert.deepEqual(saved.json.google, { ok: true });
  assert.equal(existsSync(setupTokenFile(dataDir)), false, "the token is gone after the first Google save");
  assert.equal((await call("GET", `/api/setup/status?token=${token}`)).status, 404);

  // The saved keys are live at once: real Google keys turn the practice sign-in off.
  const me = (await call("GET", "/api/me")).json;
  assert.equal(me.google.fixture, false);
  assert.equal(me.needs_setup, false);

  // A signed-in admin needs no token (Settings → Keys), and sees only booleans and four characters.
  const adminStatus = await call("GET", "/api/setup/status", { cookie: admin });
  assert.equal(adminStatus.json.has_google, true);
  assert.equal(adminStatus.json.has_slack, true);
  assert.equal(adminStatus.json.google_client_id_last4, ".com");
  // A value of the wrong shape is refused before anything is stored.
  const shape = await call("PUT", "/api/setup/keys", { cookie: admin, body: { slack_signing_secret: "not-a-signing-secret" } });
  assert.equal(shape.status, 400);
  assert.equal(shape.json.error.code, "invalid_slack_signing_secret");
  const bad = await call("PUT", "/api/setup/keys", { cookie: admin, body: { slack_bot_token: "xoxb-wrong-token" } });
  assert.deepEqual(bad.json.slack, { checked: true, ok: false, team_name: null, message: "The Slack token was not accepted." });
  // Put the good one back.
  await call("PUT", "/api/setup/keys", { cookie: admin, body: { slack_bot_token: SECRETS.slack_bot_token } });

  // Audit rows name the keys, never their values.
  const events = (await call("GET", "/api/audit?limit=500", { cookie: admin })).json.events.filter((row) => row.action === "keys.updated");
  assert.ok(events.length >= 2);
  assert.match(events.at(-1).detail, /google_client_id, google_client_secret, slack_bot_token, slack_signing_secret/);

  // No secret anywhere in anything the server said.
  for (const text of responses) {
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (name === "google_client_id") continue; // only its last four characters are shown
      assert.equal(text.includes(secret), false, `${name} leaked`);
    }
    assert.equal(text.includes(SECRETS.google_client_id), false, "client id leaked");
    assert.equal(text.includes("xoxb-wrong-token"), false);
  }
  const stored = JSON.parse(readFileSync(keysFile(dataDir), "utf8"));
  assert.equal(stored.slack_bot_token, SECRETS.slack_bot_token);
});

test("the first admin's address from the setup page: bootstraps once, never a second time", async () => {
  const dir = tempDir();
  const other = await startServer({ port: 0, host: "127.0.0.1", env: { ALLOW_FIXTURES: "1", GOOGLE_FIXTURE: "1", DATA_DIR: dir } });
  const base = other.url;
  const ask = async (method, route, { cookie, body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(route, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, location: response.headers.get("location"), cookies: response.headers.getSetCookie() };
  };
  const signInHere = async (email) => {
    const start = await ask("GET", "/api/auth/google/start");
    const state = new URL(start.location, base).searchParams.get("state");
    const back = await ask("GET", `/api/auth/google/callback?${new URLSearchParams({ state, code: "fixture", email })}`, { cookie: `timeoff_oauth=${state}` });
    return { location: back.location, session: back.cookies.map((line) => line.split(";")[0]).find((pair) => /^timeoff_session=[a-f0-9]{64}$/.test(pair)) };
  };
  try {
    const token = readFileSync(setupTokenFile(dir), "utf8");
    assert.equal((await ask("GET", `/api/setup/status?token=${token}`)).json.has_admin_email, false);
    assert.equal((await ask("PUT", "/api/setup/keys", { body: { token, bootstrap_admin_email: "not an email" } })).json.error.code, "invalid_email");
    const saved = await ask("PUT", "/api/setup/keys", { body: { token, bootstrap_admin_email: "Owner@Example.com" } });
    assert.deepEqual(saved.json.saved, ["bootstrap_admin_email"]);
    assert.ok(existsSync(setupTokenFile(dir)), "no Google client saved yet, so the token stays");
    assert.equal((await ask("GET", `/api/setup/status?token=${token}`)).json.has_admin_email, true);

    // That address becomes the first admin, with no restart.
    const owner = await signInHere("owner@example.com");
    assert.ok(owner.session);
    assert.equal((await ask("GET", "/api/me", { cookie: owner.session })).json.person.role, "admin");

    // Changing it later makes nobody else an admin: the roster is no longer empty.
    await ask("PUT", "/api/setup/keys", { cookie: owner.session, body: { bootstrap_admin_email: "second@example.com" } });
    const second = await signInHere("second@example.com");
    assert.equal(second.session, undefined);
    assert.equal(second.location, "/?not_on_roster=1");
  } finally {
    await other.close();
  }
});
