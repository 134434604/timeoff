// The admin's one Google grant, for the shared calendar and for sending the
// notification email from her Workspace account: authorization code + PKCE,
// one refresh token on disk under DATA_DIR, access tokens only ever in
// memory. Ported from an earlier project. Changes in the port:
// the one-shot state lives in oauth_states (purpose 'calendar') and is
// bound to the admin who started it, so a grant begun by one admin cannot
// be finished in another browser; the scopes are the calendar's two plus
// gmail.send; and CALENDAR_FIXTURE stands in for all of it.
//
// The scopes Google actually granted are stored with the token. A grant
// made before email was added has no gmail.send: it keeps working for the
// calendar, and status reports gmail: false so Settings can say "Reconnect
// to enable email" (mail.mjs then falls through to SMTP or off).
//
// The refresh token is the one long-lived secret in this app. It is written
// 0600 through tmp+rename, never logged, never returned by any exported
// function, and stripped out of any error text Google hands back.
//
// The account's address is read from the calendar list (the primary
// calendar's id is the address), so no openid/email scope is asked for.
//
// CALENDAR_FIXTURE=1 (through fixture-guard.mjs) stands in: "connect" goes
// straight back to the callback, the connection is recorded in
// <DATA_DIR>/calendar-fixture.json as calendar-fixture@example.com, and
// calendar.mjs writes events into that same file. Nothing leaves the box.
// The practice grant has every scope unless the file lists "scopes" (a test
// plays an old calendar-only grant that way).

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixtureFlag } from "../fixture-guard.mjs";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GRANT_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  GMAIL_SEND_SCOPE,
]);
export const CALLBACK_PATH = "/api/settings/calendar/callback";
export const FIXTURE_ACCOUNT = "calendar-fixture@example.com";
export const FIXTURE_CALENDARS = Object.freeze([{ id: "fixture-smto", name: "SMTO (sample)", writable: true }]);

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_LIST = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_EXPIRES_IN = 3600;
const TIMEOUT_MS = 15000;
const SCHEMA = "timeoff-google-calendar-v1";

export const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });

// Google's own error bodies quote the credential that failed. Strip access
// tokens (ya29.*) and refresh tokens (1//*) before any of it reaches a log.
export function safeErrorBody(value) {
  return String(value || "")
    .replace(/ya29\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/1\/\/[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 500);
}

const b64url = (buffer) => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const trimmed = (value) => String(value ?? "").trim();

// Real keys always win over the stand-in, as for sign-in.
export function calendarSwitch(env = process.env) {
  const keys = Boolean(trimmed(env.GOOGLE_CLIENT_ID) && trimmed(env.GOOGLE_CLIENT_SECRET));
  const fixture = fixtureFlag(env, "CALENDAR_FIXTURE") && !keys;
  const origin = trimmed(env.PUBLIC_ORIGIN).replace(/\/+$/, "") || null;
  return { configured: fixture || (keys && Boolean(origin)), fixture, origin };
}

const dataDirOf = (env) => trimmed(env.DATA_DIR) || "data";
export const tokenFile = (dataDir) => path.join(dataDir, "google-calendar.json");
export const fixtureFile = (dataDir) => path.join(dataDir, "calendar-fixture.json");

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFileSync applies mode only when it creates the file.
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows has no POSIX mode */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* as above */ }
}

// ----------------------------------------------------------- the stand-in --

export function readFixture(dataDir) {
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(fixtureFile(dataDir), "utf8")); } catch { parsed = null; }
  return {
    account_email: typeof parsed?.account_email === "string" ? parsed.account_email : null,
    calendars: Array.isArray(parsed?.calendars) ? parsed.calendars : FIXTURE_CALENDARS.map((row) => ({ ...row })),
    events: Array.isArray(parsed?.events) ? parsed.events : [],
    scopes: Array.isArray(parsed?.scopes) ? parsed.scopes.map(String) : null,
  };
}

export function writeFixture(dataDir, data) {
  writePrivate(fixtureFile(dataDir), data);
}

// ------------------------------------------------------------- token file --

function readTokenRecord(dataDir) {
  const file = tokenFile(dataDir);
  if (!fs.existsSync(file)) return null;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { parsed = null; }
  if (parsed && typeof parsed === "object" && trimmed(parsed.refreshToken)) {
    return { accountEmail: parsed.accountEmail ? String(parsed.accountEmail) : null, refreshToken: String(parsed.refreshToken), scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : [], grantedAt: parsed.grantedAt ? String(parsed.grantedAt) : null };
  }
  // Keep a corrupt file for a look later rather than overwrite a grant we cannot read.
  try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* already moved */ }
  return null;
}

/**
 * { configured, fixture, connected, account_email, scopes, gmail }; never the
 * token. gmail is true when the grant includes gmail.send.
 */
export function calendarStatus({ env = process.env, dataDir = dataDirOf(env) } = {}) {
  const sw = calendarSwitch(env);
  if (sw.fixture) {
    const data = readFixture(dataDir);
    const scopes = data.account_email ? data.scopes ?? [...GRANT_SCOPES] : [];
    return { configured: true, fixture: true, connected: Boolean(data.account_email), account_email: data.account_email, scopes, gmail: scopes.includes(GMAIL_SEND_SCOPE) };
  }
  const record = readTokenRecord(dataDir);
  const scopes = record?.scopes ?? [];
  return { configured: sw.configured, fixture: false, connected: Boolean(record), account_email: record?.accountEmail ?? null, scopes, gmail: Boolean(record) && scopes.includes(GMAIL_SEND_SCOPE) };
}

/** The grant's status (an alias that reads better from mail code). */
export const grantStatus = calendarStatus;

// ------------------------------------------------------- the leg out --

export function beginConnect({ db, personId, env = process.env, now = Date.now() }) {
  const sw = calendarSwitch(env);
  if (!sw.configured) throw fail("The shared calendar cannot be connected here yet. The Google sign-in keys are not set.", "calendar_off", 503);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO oauth_states (state, purpose, person_id, verifier, nonce, return_to, expires_at) VALUES (?, 'calendar', ?, ?, '', '/settings', ?)").run(state, personId, verifier, now + STATE_TTL_MS);
  if (sw.fixture) return { url: `${CALLBACK_PATH}?${new URLSearchParams({ state, code: "fixture" })}`, state };
  const params = new URLSearchParams({
    client_id: trimmed(env.GOOGLE_CLIENT_ID),
    redirect_uri: `${sw.origin}${CALLBACK_PATH}`,
    response_type: "code",
    scope: GRANT_SCOPES.join(" "),
    state,
    // offline + consent is what produces a refresh token at all; without the
    // prompt Google silently reuses an existing grant and returns none.
    access_type: "offline",
    prompt: "consent",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return { url: `${AUTH_ENDPOINT}?${params}`, state };
}

// ------------------------------------------------------ the leg back --

async function postForm(fetchImpl, url, body) {
  const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[calendar] token endpoint ${response.status}: ${safeErrorBody(text)}`);
    throw fail("Google did not accept the calendar connection. Try connecting again.", "calendar_grant_failed", 502);
  }
  return response.json();
}

async function primaryAddress(fetchImpl, accessToken) {
  try {
    const response = await fetchImpl(`${CALENDAR_LIST}?minAccessRole=owner&maxResults=250`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const payload = await response.json();
    const primary = (payload?.items || []).find((item) => item.primary === true);
    return primary ? String(primary.id).toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function finishConnect({ db, code, state, personId, env = process.env, dataDir = dataDirOf(env), fetchImpl = globalThis.fetch, now = Date.now() }) {
  const sw = calendarSwitch(env);
  if (!sw.configured) throw fail("The shared calendar cannot be connected here yet.", "calendar_off", 503);
  const clean = trimmed(state);
  // Taken and spent in one statement, as for sign-in.
  const row = /^[A-Za-z0-9_-]{8,128}$/.test(clean) ? db.prepare("DELETE FROM oauth_states WHERE state = ? AND purpose = 'calendar' RETURNING *").get(clean) : null;
  if (!row || row.expires_at <= now || row.person_id !== personId) throw fail("That calendar connection took too long or was started elsewhere. Start again.", "calendar_state_invalid");
  if (!trimmed(code)) throw fail("Google did not finish the calendar connection. Start again.", "calendar_grant_failed");
  if (sw.fixture) {
    if (code !== "fixture") throw fail("Google did not finish the calendar connection. Start again.", "calendar_grant_failed");
    // A fresh practice grant has every scope, as a fresh real one would.
    writeFixture(dataDir, { ...readFixture(dataDir), account_email: FIXTURE_ACCOUNT, scopes: null });
    return calendarStatus({ env, dataDir });
  }
  const payload = await postForm(fetchImpl, TOKEN_ENDPOINT, new URLSearchParams({
    code: trimmed(code),
    client_id: trimmed(env.GOOGLE_CLIENT_ID),
    client_secret: trimmed(env.GOOGLE_CLIENT_SECRET),
    redirect_uri: `${sw.origin}${CALLBACK_PATH}`,
    grant_type: "authorization_code",
    code_verifier: row.verifier,
  }));
  const refreshToken = trimmed(payload?.refresh_token);
  if (!refreshToken) {
    // No refresh token comes back when the grant already exists and consent
    // was skipped. Only the Google account's owner can clear that.
    throw fail("Google did not hand over a lasting connection. Remove Time Off at myaccount.google.com/permissions and connect again.", "calendar_no_refresh", 502);
  }
  const accessToken = trimmed(payload?.access_token);
  writePrivate(tokenFile(dataDir), {
    schemaVersion: SCHEMA,
    accountEmail: accessToken ? await primaryAddress(fetchImpl, accessToken) : null,
    refreshToken,
    // What Google granted, which may be less than asked (an unticked box on
    // the consent screen): status reads gmail.send from here.
    scopes: payload?.scope ? String(payload.scope).split(/\s+/).filter(Boolean) : [...GRANT_SCOPES],
    grantedAt: new Date(now).toISOString(),
  });
  accessCache = accessToken ? { token: accessToken, expiresAt: now + (Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : DEFAULT_EXPIRES_IN) * 1000, refreshToken } : null;
  return calendarStatus({ env, dataDir });
}

// ------------------------------------------------------ the access token --

// One access token in memory per process, plus one in-flight refresh so a
// burst of approvals after a restart makes one token call, not many.
let accessCache = null;
let inFlight = null;

export async function getAccessToken({ env = process.env, dataDir = dataDirOf(env), fetchImpl = globalThis.fetch, force = false } = {}) {
  const record = readTokenRecord(dataDir);
  if (!record) {
    accessCache = null;
    throw fail("The shared calendar is not connected.", "calendar_not_connected", 409);
  }
  if (!force && accessCache && accessCache.refreshToken === record.refreshToken && accessCache.expiresAt - EXPIRY_SKEW_MS > Date.now()) return accessCache.token;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const payload = await postForm(fetchImpl, TOKEN_ENDPOINT, new URLSearchParams({
      client_id: trimmed(env.GOOGLE_CLIENT_ID),
      client_secret: trimmed(env.GOOGLE_CLIENT_SECRET),
      refresh_token: record.refreshToken,
      grant_type: "refresh_token",
    }));
    const token = trimmed(payload?.access_token);
    if (!token) throw fail("Google did not hand over calendar access. Reconnect the calendar.", "calendar_grant_failed", 502);
    const expiresIn = Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : DEFAULT_EXPIRES_IN;
    accessCache = { token, expiresAt: Date.now() + expiresIn * 1000, refreshToken: record.refreshToken };
    return token;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Revoke (best effort) and forget the grant. */
export async function disconnect({ env = process.env, dataDir = dataDirOf(env), fetchImpl = globalThis.fetch } = {}) {
  if (calendarSwitch(env).fixture) {
    writeFixture(dataDir, { ...readFixture(dataDir), account_email: null });
    return calendarStatus({ env, dataDir });
  }
  const record = readTokenRecord(dataDir);
  if (record && typeof fetchImpl === "function") {
    // A revoke that fails must not leave the token on disk.
    try {
      await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(record.refreshToken)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      /* the grant can also be removed at myaccount.google.com/permissions */
    }
  }
  try { fs.unlinkSync(tokenFile(dataDir)); } catch { /* nothing to remove */ }
  accessCache = null;
  inFlight = null;
  return calendarStatus({ env, dataDir });
}
