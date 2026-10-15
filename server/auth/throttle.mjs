// Who is asking, and how often. Ported from an earlier project unchanged
// but for these words.
//
// Behind a reverse proxy (a shared host's web server) every
// request reaches this process from the proxy's address, so a throttle
// keyed on the socket would make every visitor one client, and after a few
// sign-ins nobody could start one. So:
//   TRUST_PROXY unset or "off" (the default): the client is the socket
//     address, and X-Forwarded-For is never read.
//   TRUST_PROXY=<n> (1 to 5): n proxies in front are trusted; the client is
//     the address n places from the right of [X-Forwarded-For..., socket].
//   TRUST_PROXY=<address>,<address>: only these proxy addresses are
//     trusted; walking right to left, the first address that is not one of
//     them is the client. A request whose socket is not a listed proxy is
//     read from the socket alone, so nobody else can choose their address.
//
// The throttles live in SQLite (throttle_hits), so every process on the
// host shares them, and each hit is logged (throttle_log) with its kind and
// a hash of its key, never the address or the email.

import { createHash } from "node:crypto";
import { nowIso } from "../db.mjs";

const strip = (value) => String(value ?? "").trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");

/** How TRUST_PROXY reads: { mode: "off" } | { mode: "hops", hops } | { mode: "list", list }. */
export function proxyTrust(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? "").trim();
  if (!raw || /^(?:off|0|false|no)$/i.test(raw)) return { mode: "off" };
  if (/^\d+$/.test(raw)) return { mode: "hops", hops: Math.min(5, Math.max(1, Number(raw))) };
  const list = raw.split(",").map(strip).filter(Boolean);
  return list.length ? { mode: "list", list } : { mode: "off" };
}

/** The client's address for this request, by the TRUST_PROXY setting. */
export function clientAddress(req, env = process.env) {
  const socket = strip(req?.socket?.remoteAddress) || "unknown";
  const trust = proxyTrust(env);
  if (trust.mode === "off") return socket;
  const header = req?.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : String(header ?? "")).split(",").map(strip).filter(Boolean);
  const chain = [...forwarded, socket];
  if (trust.mode === "hops") return chain[Math.max(0, chain.length - 1 - trust.hops)];
  if (!trust.list.includes(socket)) return socket;
  for (let index = chain.length - 1; index >= 0; index -= 1) if (!trust.list.includes(chain[index])) return chain[index];
  return chain[0];
}

const keyHash = (key) => createHash("sha256").update(`throttle:${key}`).digest("hex");

/**
 * One ask against a limit: true when it is over (and the hit is logged),
 * false when it counts and may go on. The check and the count are one
 * transaction, so two processes cannot both slip under the limit.
 */
export function throttled(db, { kind, key, max, windowMs, now = new Date() }) {
  const hashed = keyHash(`${kind}:${key}`);
  const at = now.getTime();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM throttle_hits WHERE at < ?").run(at - 24 * 60 * 60_000);
    const used = Number(db.prepare("SELECT count(*) AS n FROM throttle_hits WHERE key = ? AND at > ?").get(hashed, at - windowMs).n);
    const over = used >= max;
    if (over) db.prepare("INSERT INTO throttle_log (kind, key_hash, created_at) VALUES (?, ?, ?)").run(kind, hashed, nowIso(now));
    else db.prepare("INSERT INTO throttle_hits (key, at) VALUES (?, ?)").run(hashed, at);
    db.exec("COMMIT");
    return over;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Failures only (a bad Slack signature): how many this key has had in the
 * window, without counting this ask. Pair with recordFailure.
 */
export function failuresIn(db, { kind, key, windowMs, now = new Date() }) {
  return Number(db.prepare("SELECT count(*) AS n FROM throttle_hits WHERE key = ? AND at > ?").get(keyHash(`${kind}:${key}`), now.getTime() - windowMs).n);
}

export function recordFailure(db, { kind, key, now = new Date() }) {
  db.prepare("INSERT INTO throttle_hits (key, at) VALUES (?, ?)").run(keyHash(`${kind}:${key}`), now.getTime());
}

/** For the owner page: throttle hits in the last day and in all, by kind. */
export function throttleSummary(db, { now = new Date() } = {}) {
  const since = nowIso(new Date(now.getTime() - 24 * 60 * 60_000));
  const rows = db.prepare("SELECT kind, count(*) AS n, sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS day FROM throttle_log GROUP BY kind").all(since);
  return {
    last_day: rows.reduce((sum, row) => sum + Number(row.day || 0), 0),
    total: rows.reduce((sum, row) => sum + Number(row.n), 0),
    by_kind: Object.fromEntries(rows.map((row) => [row.kind, { last_day: Number(row.day || 0), total: Number(row.n) }])),
    trust_proxy: proxyTrust().mode,
  };
}

/** Log a refusal that a cap other than throttled() made (the Google start's live-state cap). */
export function logThrottleHit(db, { kind, key, now = new Date() }) {
  try {
    db.prepare("INSERT INTO throttle_log (kind, key_hash, created_at) VALUES (?, ?, ?)").run(kind, keyHash(`${kind}:${key}`), nowIso(now));
  } catch {
    /* a log line never blocks an answer */
  }
}
