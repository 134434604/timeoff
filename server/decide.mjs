// The links in the emails an approver or admin gets: Approve / Deny, and,
// for an admin asked about a Manager pick, Yes / No. A link carries only a
// random id (32 bytes, base64url: 43 characters), short enough that no mail
// client wraps or cuts it. What the link means lives in the decide_links
// table, keyed by the id's SHA-256 hash (a copy of the database never holds
// a working link): the request, the action, the person it was sent to, when
// it expires (14 days), when it was used, and its pair: the two links of
// one choice (Approve/Deny, or Yes/No) share a pair_id and are spent
// together.
//
// Opening a link (GET) never changes anything: mail scanners fetch links on
// their own. Only the POST from the page acts, once: the pair is spent in
// the same transaction as the action.

import { createHash, randomBytes } from "node:crypto";

export const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DECIDE_ACTIONS = Object.freeze(["approve", "deny", "confirm_manager", "reject_manager"]);
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const tokenHash = (token) => createHash("sha256").update(`decide:${token}`).digest("hex");

/** A new link id for one person to take one action on one request. */
export function makeDecideToken(db, { requestId, action, approverId, pairId = null, now = Date.now(), ttlMs = LINK_TTL_MS }) {
  if (!DECIDE_ACTIONS.includes(action)) throw new Error("not a link action");
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO decide_links (id_hash, request_id, action, approver_id, pair_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
    .run(tokenHash(token), requestId, action, approverId, pairId, new Date(now + ttlMs).toISOString(), new Date(now).toISOString());
  return token;
}

/** The two links of one choice, spent together: { [first]: token, [second]: token }. */
export function makeDecidePair(db, { requestId, actions, approverId, now = Date.now(), ttlMs = LINK_TTL_MS }) {
  const pairId = randomBytes(12).toString("hex");
  return Object.fromEntries(actions.map((action) => [action, makeDecideToken(db, { requestId, action, approverId, pairId, now, ttlMs })]));
}

/**
 * What a link means: null when it is not one of ours (wrong shape, or no
 * such link), else { requestId, action, approverId, expired, used }.
 */
export function readDecideToken(db, token, { now = Date.now() } = {}) {
  if (!SHAPE.test(String(token ?? ""))) return null;
  const row = db.prepare("SELECT * FROM decide_links WHERE id_hash = ?").get(tokenHash(token));
  if (!row) return null;
  return { requestId: row.request_id, action: row.action, approverId: row.approver_id, expired: Date.parse(row.expires_at) <= now, used: Boolean(row.used_at) };
}

/** Spend a link and its pair: true the first time, false when it was already used. */
export function spendDecideToken(db, token, { now = Date.now() } = {}) {
  const hash = tokenHash(token);
  const at = new Date(now).toISOString();
  if (db.prepare("UPDATE decide_links SET used_at = ? WHERE id_hash = ? AND used_at IS NULL").run(at, hash).changes !== 1) return false;
  db.prepare("UPDATE decide_links SET used_at = ? WHERE pair_id IS NOT NULL AND pair_id = (SELECT pair_id FROM decide_links WHERE id_hash = ?) AND used_at IS NULL").run(at, hash);
  return true;
}
