// The keys an owner types into the setup page instead of a host's env file:
// the Google OAuth client, the Slack app's token and signing secret, the
// company email domain, the From address and the first admin's address. They live in
// <DATA_DIR>/keys.json (mode 600, written through tmp+rename, never served,
// never logged), and a value there wins over the same name in the env.
// A host that prefers .env.local still works: a name with no value in
// keys.json falls back to the env.
//
// Nothing restarts: the server hands every module one live env
// (liveEnv), which re-reads keys.json whenever the file changes (by its
// modification time and size; a save from this process resets the cache).
//
// Until a Google client is configured, a one-time setup token in
// <DATA_DIR>/setup-token (32 hex, mode 600) lets whoever can read the host's
// files open /setup. It is deleted the first time a Google client id is
// saved with it; after that only a signed-in admin changes keys.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Store name -> env name. */
export const KEY_NAMES = Object.freeze({
  google_client_id: "GOOGLE_CLIENT_ID",
  google_client_secret: "GOOGLE_CLIENT_SECRET",
  slack_bot_token: "SLACK_BOT_TOKEN",
  slack_signing_secret: "SLACK_SIGNING_SECRET",
  allowed_email_domain: "ALLOWED_EMAIL_DOMAIN",
  mail_from: "MAIL_FROM",
  // Who becomes the first admin; used only while the roster is empty (sessions.mjs).
  bootstrap_admin_email: "BOOTSTRAP_ADMIN_EMAIL",
  // The bearer token the host's cron sends for the monthly report (made at startup).
  job_token: "JOB_TOKEN",
});

export const keysFile = (dataDir) => path.join(dataDir, "keys.json");
export const setupTokenFile = (dataDir) => path.join(dataDir, "setup-token");

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  // writeFileSync applies mode only when it creates the file.
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows has no POSIX mode */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* as above */ }
}

// ------------------------------------------------------------- the store --

const cache = new Map(); // dataDir -> { stamp, keys }

function stampOf(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/** The saved keys ({ google_client_id, ..., updated_at }); {} when none. */
export function readKeys(dataDir) {
  const file = keysFile(dataDir);
  const stamp = stampOf(file);
  const hit = cache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.keys;
  let keys = {};
  if (stamp !== "missing") {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") keys = parsed;
    } catch {
      keys = {};
    }
  }
  cache.set(dataDir, { stamp, keys });
  return keys;
}

/**
 * Save the names present in `changes` (an empty string clears one; names
 * not listed are left alone). Returns the names saved.
 */
export function saveKeys(dataDir, changes, { now = new Date() } = {}) {
  const current = { ...readKeys(dataDir) };
  const saved = [];
  for (const name of Object.keys(KEY_NAMES)) {
    if (!Object.prototype.hasOwnProperty.call(changes, name)) continue;
    const value = String(changes[name] ?? "").trim();
    if (value) current[name] = value;
    else delete current[name];
    saved.push(name);
  }
  if (!saved.length) return [];
  current.updated_at = now.toISOString();
  writePrivate(keysFile(dataDir), JSON.stringify(current, null, 2));
  cache.delete(dataDir);
  return saved;
}

/** `baseEnv` with every saved key laid over its env name. */
export function effectiveEnv(baseEnv, dataDir) {
  const keys = readKeys(dataDir);
  const merged = { ...baseEnv };
  for (const [name, envName] of Object.entries(KEY_NAMES)) {
    if (typeof keys[name] === "string" && keys[name].trim()) merged[envName] = keys[name];
  }
  return merged;
}

/**
 * An env object that always answers with the current effective values, so
 * code handed it once (at startup) sees a key saved later without a restart.
 */
export function liveEnv(baseEnv, dataDir) {
  const current = () => effectiveEnv(baseEnv, dataDir);
  return new Proxy({}, {
    get: (_, name) => current()[name],
    has: (_, name) => name in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_, name) => {
      const merged = current();
      return Object.prototype.hasOwnProperty.call(merged, name) ? { value: merged[name], enumerable: true, configurable: true, writable: false } : undefined;
    },
  });
}

/** Is a Google client id configured (keys.json or env)? */
export const hasGoogleClient = (env) => Boolean(String(env?.GOOGLE_CLIENT_ID ?? "").trim());

/** The last four characters of the client id, for a screen that must not show it. */
export function clientIdHint(env) {
  const id = String(env?.GOOGLE_CLIENT_ID ?? "").trim();
  return id ? id.slice(-4) : null;
}

/** A Google OAuth client id has a known shape: digits-letters.apps.googleusercontent.com. */
export const googleClientIdLooksRight = (value) => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(value ?? "").trim());

// ------------------------------------------------------- the setup token --

/** Make the setup token if there is none; returns true when one exists now. */
export function ensureSetupToken(dataDir) {
  const file = setupTokenFile(dataDir);
  if (fs.existsSync(file)) return true;
  writePrivate(file, randomBytes(16).toString("hex"));
  return true;
}

function readSetupToken(dataDir) {
  try {
    const token = fs.readFileSync(setupTokenFile(dataDir), "utf8").trim();
    return /^[a-f0-9]{32}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Does `given` match the setup token? Constant time; false when there is none. */
export function setupTokenMatches(dataDir, given) {
  const token = readSetupToken(dataDir);
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(String(given ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deleteSetupToken(dataDir) {
  try { fs.unlinkSync(setupTokenFile(dataDir)); } catch { /* already gone */ }
}
