// Sign in with Google. Google identifies the person; this app then issues
// its own session (sessions.mjs) as an httpOnly cookie. This module is the
// whole sign-in conversation with Google: the authorization redirect, the
// code-for-token exchange, and the key set that signs id tokens. Scope is
// `openid email profile` (profile only so the first admin's name comes
// from Google); nothing is posted or read on the person's behalf. The
// admin's calendar grant is a separate leg (server/google/calendar-grant.mjs).
//
// Ported from an earlier project. Changes in this port: the state row carries a
// purpose, so a calendar-grant state can never finish a sign-in; and the
// stand-in's consent page takes any email address, so QA can sign in as
// any person on the roster.
//
// The state is also bound to the browser that started the sign-in: the
// leg out sets a short-lived httpOnly cookie holding it (STATE_COOKIE),
// and the callback refuses a state that browser did not start, so a
// sign-in begun elsewhere cannot be finished in someone else's browser.
// Live state rows are capped (MAX_LIVE_STATES) and expired ones pruned on
// every start, so signed-out visits cannot fill the table.
//
// Checks, in order, on the way back: the browser's state cookie, the state
// we issued (10 minutes, once), PKCE, the id token's signature against Google's published keys,
// its issuer, audience (our client id), expiry, and the nonce we issued.
//
// GOOGLE_FIXTURE=1 stands in for Google offline: the start URL points at
// a page on this server that acts as the consent screen, the token
// exchange is answered locally, and the id token is signed with a key pair
// made at boot and served like Google's key set. Nothing leaves the box.

import { createHash, createSign, generateKeyPairSync, randomBytes, subtle, timingSafeEqual } from "node:crypto";
import { AUTH_WORDS, fail } from "./words.mjs";
import { fixtureFlag } from "../fixture-guard.mjs";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CALLBACK_PATH = "/api/auth/google/callback";
const FIXTURE_PATH = "/api/auth/google/fixture";
const STATE_TTL_MS = 10 * 60 * 1000;
const FIXTURE_EMAIL = "fixture@example.com";
const FIXTURE_SUB = "fixture-sub-000000000000000000001";
const DEFAULT_RETURN = "/";
export const STATE_COOKIE = "timeoff_oauth";
export const MAX_LIVE_STATES = 500;

const b64url = (buffer) => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ----------------------------------------------------------- the switch --

// Real keys always win: with a client id and secret set, the stand-in is
// off even when GOOGLE_FIXTURE=1, so a real sign-in never lands in the
// stand-in's one shared account. The stand-in is also off on a
// production-like server (fixture-guard.mjs).
export function googleSwitch(env = process.env) {
  const has = (name) => Boolean(String(env[name] ?? "").trim());
  const keys = has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET");
  const fixture = fixtureFlag(env, "GOOGLE_FIXTURE") && !keys;
  const on = fixture || (keys && has("PUBLIC_ORIGIN"));
  return { on, fixture, origin: String(env.PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "") || null };
}

// A path on this site only: printable ASCII, one leading slash, no "//"
// (another host) and no backslash (which some browsers read as a slash).
export function safeReturn(value) {
  return typeof value === "string" && /^\/(?!\/)[\x21-\x7e]*$/.test(value) && !value.includes("\\") ? value : DEFAULT_RETURN;
}

// ------------------------------------------------------------- the leg out --

export function startSignIn({ db, env = process.env, returnTo = DEFAULT_RETURN, now = Date.now() } = {}) {
  const sw = googleSwitch(env);
  if (!sw.on) throw fail(AUTH_WORDS.google_off, "google_off", 503);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const nonce = b64url(randomBytes(18));
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
  if (Number(db.prepare("SELECT count(*) AS n FROM oauth_states").get().n) >= MAX_LIVE_STATES) throw fail(AUTH_WORDS.too_many, "signin_busy", 429);
  db.prepare("INSERT INTO oauth_states (state, purpose, verifier, nonce, return_to, expires_at) VALUES (?, 'signin', ?, ?, ?, ?)").run(state, verifier, nonce, safeReturn(returnTo), now + STATE_TTL_MS);
  if (sw.fixture) return { url: `${FIXTURE_PATH}?state=${encodeURIComponent(state)}`, state };
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    client_id: String(env.GOOGLE_CLIENT_ID).trim(),
    redirect_uri: `${sw.origin}${CALLBACK_PATH}`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: `${GOOGLE_AUTH}?${params}`, state };
}

function takeState(db, state, now) {
  const clean = String(state ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clean)) return null;
  // One statement takes and spends the state, so two callbacks racing on
  // the same state cannot both read it before either deletes it.
  const row = db.prepare("DELETE FROM oauth_states WHERE state = ? AND purpose = 'signin' RETURNING *").get(clean);
  return row && row.expires_at > now ? row : null;
}

// ------------------------------------------------------------ the leg back --

let certsCache = { keys: null, expires_at: 0 };
async function googleKeys({ env, fetchImpl, now }) {
  if (googleSwitch(env).fixture) return fixtureKeys().jwks.keys;
  if (certsCache.keys && certsCache.expires_at > now) return certsCache.keys;
  const response = await fetchImpl(GOOGLE_CERTS);
  if (!response.ok) throw fail(AUTH_WORDS.signin_failed, "signin_failed", 502);
  const payload = await response.json();
  const maxAge = Number((String(response.headers?.get?.("cache-control") || "").match(/max-age=(\d+)/) || [])[1]) || 3600;
  certsCache = { keys: payload.keys || [], expires_at: now + maxAge * 1000 };
  return certsCache.keys;
}

/** RS256 signature against one of the keys, then the claims we rely on. */
export async function verifyIdToken(idToken, { keys, clientId, nonce = null, now = Date.now() }) {
  const parts = String(idToken ?? "").split(".");
  if (parts.length !== 3) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
    payload = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  } catch {
    throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  if (header.alg !== "RS256") throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  const jwk = (keys || []).find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  const key = await subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, fromB64url(parts[2]), Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"));
  if (!ok) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  if (!GOOGLE_ISSUERS.has(String(payload.iss))) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(clientId)) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) throw fail(AUTH_WORDS.signin_expired, "signin_expired");
  if (nonce && payload.nonce !== nonce) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  if (typeof payload.sub !== "string" || !payload.sub) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  return payload;
}

const secureFlag = (env) => (String(env.PUBLIC_ORIGIN || "").trim().toLowerCase().startsWith("https://") ? "; Secure" : "");

/** The cookie that binds a started sign-in to this browser. */
export function stateCookie(state, env = process.env) {
  const secure = secureFlag(env);
  return `${STATE_COOKIE}=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(STATE_TTL_MS / 1000)}${secure}`;
}

export function clearedStateCookie(env = process.env) {
  const secure = secureFlag(env);
  return `${STATE_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function sameState(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The callback: check this browser started it, check the state, trade the
 * code for an id token, verify it.
 * Returns { sub, email, email_verified, name, return_to }. In the stand-in,
 * `fixtureEmail` is the address typed on its consent page.
 */
export async function finishSignIn({ db, code, state, browserState, fixtureEmail = null, env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const sw = googleSwitch(env);
  if (!sw.on) throw fail(AUTH_WORDS.google_off, "google_off", 503);
  if (!sameState(state, browserState)) throw fail(AUTH_WORDS.signin_failed, "signin_not_this_browser");
  const pending = takeState(db, state, now);
  if (!pending) throw fail(AUTH_WORDS.signin_expired, "signin_expired");
  if (!code) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  let idToken;
  let clientId;
  if (sw.fixture) {
    if (code !== "fixture") throw fail(AUTH_WORDS.signin_failed, "signin_failed");
    clientId = "fixture-client";
    const email = fixtureEmail === null || fixtureEmail === "" ? FIXTURE_EMAIL : String(fixtureEmail).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw fail(AUTH_WORDS.invalid_email, "invalid_email");
    idToken = fixtureIdToken({ nonce: pending.nonce, now, email, sub: fixtureSub(email), name: fixtureName(email) });
  } else {
    clientId = String(env.GOOGLE_CLIENT_ID).trim();
    const body = new URLSearchParams({
      code: String(code),
      client_id: clientId,
      client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
      redirect_uri: `${sw.origin}${CALLBACK_PATH}`,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    });
    const response = await fetchImpl(GOOGLE_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!response.ok) {
      // Google's own reason goes to the log, never to a browser.
      const reason = await response.text().catch(() => "");
      console.error(`[google] token exchange ${response.status}: ${reason.slice(0, 300)}`);
      throw fail(AUTH_WORDS.signin_failed, "signin_failed", 502);
    }
    const payload = await response.json();
    idToken = payload.id_token;
  }
  const keys = await googleKeys({ env, fetchImpl, now });
  const claims = await verifyIdToken(idToken, { keys, clientId, nonce: pending.nonce, now });
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    email_verified: claims.email_verified === true,
    // The Google Workspace domain of the account (absent for consumer accounts).
    hd: typeof claims.hd === "string" ? claims.hd.toLowerCase() : null,
    name: typeof claims.name === "string" ? claims.name : "",
    return_to: pending.return_to,
  };
}

// ---------------------------------------------------------------- fixture --

let fixture = null;
function fixtureKeys() {
  if (fixture) return fixture;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  fixture = { privateKey, jwks: { keys: [{ ...jwk, kid: "fixture-kid", alg: "RS256", use: "sig" }] } };
  return fixture;
}

// Each address typed on the stand-in's page is its own Google identity, so
// two QA people never share a subject.
export const fixtureSub = (email) => `fixture-sub-${createHash("sha256").update(String(email)).digest("hex").slice(0, 24)}`;

// "pat.lee@example.com" -> "Pat Lee", the name Google would have sent.
export const fixtureName = (email) => String(email).split("@")[0].split(/[._-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") || "Sample Person";

// The stand-in plays a Google Workspace account: hd is the email's domain.
export function fixtureIdToken({ nonce, now = Date.now(), sub = FIXTURE_SUB, email = FIXTURE_EMAIL, name = "Sample Person", hd = String(email).split("@")[1] || null, aud = "fixture-client", iss = "https://accounts.google.com", expiresInMs = 5 * 60 * 1000 } = {}) {
  const { privateKey } = fixtureKeys();
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iss, aud, sub, email, email_verified: true, name, ...(hd ? { hd } : {}), nonce, iat: Math.floor(now / 1000), exp: Math.floor((now + expiresInMs) / 1000) })));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

export function fixtureJwks() {
  return fixtureKeys().jwks;
}

export const FIXTURE = Object.freeze({ path: FIXTURE_PATH, email: FIXTURE_EMAIL, sub: FIXTURE_SUB, callback: CALLBACK_PATH });

/**
 * The stand-in's consent page: an email field, because QA signs in as each
 * person on the roster in turn. Submitting sends the browser back the way
 * Google would, and the address arrives verified.
 */
export function fixtureConsentPage(state) {
  const safe = String(state ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in (practice)</title></head><body style="font-family:system-ui;padding:2rem;max-width:32rem">
<h1>Choose an account</h1><p>This practice page stands in for Google on this computer. Type the email address of the person you want to sign in as.</p>
<form method="get" action="${CALLBACK_PATH}"><input type="hidden" name="state" value="${safe}"><input type="hidden" name="code" value="fixture">
<p><label>Email address<br><input type="email" name="email" required autocomplete="off" placeholder="name@example.com" style="font:inherit;padding:.5rem;width:100%;box-sizing:border-box"></label></p>
<button type="submit" style="font:inherit;padding:.6rem 1rem">Continue</button></form>
</body></html>`;
}
