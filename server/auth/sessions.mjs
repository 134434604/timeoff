// People and sessions. One session model for the whole app: a random
// token in an httpOnly, SameSite=Lax cookie; only its SHA-256 hash is
// stored. A session lasts 30 days unless signed out. Signing out revokes
// the row, so the same cookie replayed later opens nothing.
//
// Ported from an earlier project. Changes in the port:
// there are no self-made accounts. Google says who someone is; the roster
// (the people table, kept by the admin) decides whether they get in. A
// person is found by their Google subject, else by a verified email that
// is on the roster and active. Nobody else gets a session, with one
// exception: while the roster is empty, BOOTSTRAP_ADMIN_EMAIL becomes the
// first admin. A person set inactive loses every session at once (the
// join below), without waiting for them to sign out.

import { createHash, randomBytes } from "node:crypto";
import { nowIso } from "../db.mjs";
import { applyClassPolicy } from "../store.mjs";
import { normalizeEmail } from "./mail.mjs";
import { AUTH_WORDS, fail } from "./words.mjs";

export const COOKIE_NAME = "timeoff_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEZONE = "America/New_York";

export const hashToken = (token) => createHash("sha256").update(`session:${String(token ?? "")}`).digest("hex");
export const newId = (prefix) => `${prefix}_${randomBytes(9).toString("hex")}`;

// ------------------------------------------------------------ the roster --

/** The domain part must match ALLOWED_EMAIL_DOMAIN when that is set. */
export function domainAllowed(email, env = process.env) {
  const domain = String(env.ALLOWED_EMAIL_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!domain) return true;
  return String(email ?? "").toLowerCase().endsWith(`@${domain}`);
}

/**
 * Who this Google identity is on the roster. Returns { person_id, created }
 * or throws: not_on_roster (403, with .email), account_mismatch (403),
 * signin_failed (an address Google has not verified).
 */
export function personForGoogle(db, { sub, email, email_verified, name, hd = null }, { env = process.env, now = new Date() } = {}) {
  const clean = email_verified ? normalizeEmail(email) : null;
  if (!clean) throw fail(AUTH_WORDS.signin_failed, "signin_failed");
  const refuse = () => Object.assign(fail(AUTH_WORDS.not_on_roster, "not_on_roster", 403), { email: clean });
  if (!domainAllowed(clean, env)) throw refuse();
  // With a company domain set, the Google account must belong to that
  // Workspace (the id token's hd claim), not just carry an address there.
  const company = String(env.ALLOWED_EMAIL_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  if (company && String(hd ?? "").toLowerCase() !== company) throw refuse();
  const bySub = db.prepare("SELECT id, active FROM people WHERE google_sub = ?").get(String(sub));
  if (bySub) {
    if (bySub.active !== 1) throw refuse();
    db.prepare("UPDATE people SET last_signed_in = ? WHERE id = ?").run(nowIso(now), bySub.id);
    return { person_id: bySub.id, created: false };
  }
  const byEmail = db.prepare("SELECT id, active, google_sub FROM people WHERE email = ?").get(clean);
  if (byEmail) {
    if (byEmail.active !== 1) throw refuse();
    // An address already tied to a different Google subject is not reused:
    // that would hand one person's record to a second Google account.
    if (byEmail.google_sub) throw fail(AUTH_WORDS.account_mismatch, "account_mismatch", 403);
    db.prepare("UPDATE people SET google_sub = ?, last_signed_in = ? WHERE id = ?").run(String(sub), nowIso(now), byEmail.id);
    return { person_id: byEmail.id, created: false };
  }
  const bootstrap = normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  const empty = Number(db.prepare("SELECT count(*) AS n FROM people WHERE sample = 0").get().n) === 0;
  if (bootstrap && clean === bootstrap && empty) {
    const id = newId("per");
    const shown = String(name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || clean.split("@")[0];
    db.prepare("INSERT INTO people (id, email, name, role, worker_type, manager_id, active, timezone, google_sub, created_at, last_signed_in, enrolled_via) VALUES (?, ?, ?, 'admin', 'employee', NULL, 1, ?, ?, ?, ?, 'bootstrap')")
      .run(id, clean, shown, String(env.DEFAULT_TIMEZONE || DEFAULT_TIMEZONE), String(sub), nowIso(now), nowIso(now));
    applyClassPolicy(db, id, { reason: "First admin." });
    return { person_id: id, created: true };
  }
  throw refuse();
}

// ------------------------------------------------------------ sessions --

export function mintSession(db, personId, { via, now = new Date() }) {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, person_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(hashToken(token), personId, via, nowIso(now), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  return token;
}

export function readSession(db, token, { now = new Date() } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(token ?? ""))) return null;
  const row = db.prepare("SELECT sessions.person_id, sessions.via, sessions.expires_at, sessions.revoked_at, people.active FROM sessions JOIN people ON people.id = sessions.person_id WHERE sessions.token_hash = ?").get(hashToken(token));
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= now.getTime() || row.active !== 1) return null;
  return { person_id: row.person_id, via: row.via };
}

export function revokeSession(db, token, { now = new Date() } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(token ?? ""))) return false;
  const result = db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(nowIso(now), hashToken(token));
  return result.changes > 0;
}

export function revokeAllFor(db, personId, { now = new Date() } = {}) {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL").run(nowIso(now), personId);
}

// --------------------------------------------------------------- cookie --

export function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export const tokenFromRequest = (req) => cookieValue(req, COOKIE_NAME);

function secureFlag(env) {
  return /^https:\/\//.test(String(env.PUBLIC_ORIGIN || "")) ? "; Secure" : "";
}

export function sessionCookie(token, env = process.env) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureFlag(env)}`;
}

export function clearedCookie(env = process.env) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(env)}`;
}

// Google identified someone who is not on the roster: /api/me reports the
// address for ten minutes so the page can say "ask your admin to add you".
export const NOT_ON_ROSTER_COOKIE = "timeoff_not_on_roster";

export function notOnRosterCookie(email, env = process.env) {
  return `${NOT_ON_ROSTER_COOKIE}=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secureFlag(env)}`;
}

export function clearedNotOnRosterCookie(env = process.env) {
  return `${NOT_ON_ROSTER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(env)}`;
}
