// The one database: SQLite through Node's built-in node:sqlite, a single
// file under DATA_DIR (data/ by default, never committed, never deployed).
// Opened once per server and migrated forward on open.
//
//   people          the roster: who may sign in, their role, their manager
//   policies        one per person: allowance, accrual rule, carryover cap
//   adjustments     an admin's plus or minus days for one person and year
//   requests        every time-off request, its decision, and where its
//                   calendar event stands (calendar_id is the calendar the
//                   event was written to, so a later cancel removes it
//                   there even after the admin picks another calendar)
//   holidays        company holidays; never counted as days off
//   audit           one row per change anyone made, with who and when
//   settings        small JSON values (the chosen shared calendar)
//   sessions        a hash of each session token, never the token
//   oauth_states    a Google leg out (sign-in or the calendar grant),
//                   10 minutes, read once
//   throttle_hits   the sign-in throttle, shared by every process
//   throttle_log    each throttle hit, keys hashed
//
// Pragmas from a hardened SQLite runtime of an earlier project: WAL so
// readers never wait on the writer, a busy timeout so two worker processes
// queue instead of failing, and synchronous FULL because a decided request
// is a record someone was promised.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DATA_DIR = process.env.DATA_DIR || "data";
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "timeoff.sqlite");
const BUSY_TIMEOUT_MS = 5000;

const MIGRATIONS = [
  `CREATE TABLE people (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('employee', 'manager', 'admin')),
     worker_type TEXT NOT NULL CHECK (worker_type IN ('employee', 'contractor')),
     manager_id TEXT REFERENCES people(id),
     active INTEGER NOT NULL DEFAULT 1,
     timezone TEXT NOT NULL,
     slack_user_id TEXT,
     google_sub TEXT UNIQUE,
     created_at TEXT NOT NULL,
     last_signed_in TEXT
   );
   CREATE INDEX people_by_manager ON people(manager_id);
   CREATE TABLE policies (
     person_id TEXT PRIMARY KEY REFERENCES people(id),
     annual_days REAL NOT NULL,
     accrual TEXT NOT NULL CHECK (accrual IN ('front_loaded', 'monthly')),
     carryover_cap REAL NOT NULL,
     start_date TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE adjustments (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id),
     year INTEGER NOT NULL,
     days REAL NOT NULL,
     note TEXT NOT NULL,
     actor_id TEXT REFERENCES people(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX adjustments_by_person ON adjustments(person_id, year);
   CREATE TABLE requests (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id),
     kind TEXT NOT NULL CHECK (kind IN ('pto', 'sick', 'unpaid', 'unavailable')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     half_day_start INTEGER NOT NULL DEFAULT 0,
     half_day_end INTEGER NOT NULL DEFAULT 0,
     days REAL NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     decided_by TEXT REFERENCES people(id),
     decided_at TEXT,
     decision_note TEXT NOT NULL DEFAULT '',
     calendar_state TEXT NOT NULL DEFAULT 'none' CHECK (calendar_state IN ('none', 'added', 'pending', 'failed', 'removed')),
     calendar_event_id TEXT,
     calendar_id TEXT,
     calendar_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX requests_by_person ON requests(person_id, start_date);
   CREATE INDEX requests_by_status ON requests(status, start_date);
   CREATE INDEX requests_by_calendar ON requests(calendar_state);
   CREATE TABLE holidays (
     date TEXT PRIMARY KEY,
     name TEXT NOT NULL
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor_id TEXT,
     action TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX audit_by_time ON audit(at);
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id),
     via TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE TABLE oauth_states (
     state TEXT PRIMARY KEY,
     purpose TEXT NOT NULL DEFAULT 'signin',
     person_id TEXT,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     return_to TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE throttle_hits (
     key TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX throttle_hits_by_key ON throttle_hits(key, at);
   CREATE TABLE throttle_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     key_hash TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  // Slack: where each request's approval message lives, so a decision made
  // anywhere (Slack or the site) updates it. slack_channel/slack_ts is the
  // manager's message; slack_extra is a JSON list of {channel, ts} for the
  // other copies (every admin gets one when there is no manager). A Slack
  // member id belongs to one person at most.
  `ALTER TABLE requests ADD COLUMN slack_channel TEXT;
   ALTER TABLE requests ADD COLUMN slack_ts TEXT;
   ALTER TABLE requests ADD COLUMN slack_extra TEXT;
   CREATE UNIQUE INDEX people_by_slack ON people(slack_user_id);`,
  // A separate sick allowance (front-loaded, no carryover; 0 = not tracked),
  // pay basis and hours per day (hours are counted for hourly people), a
  // free-text team, the approver the requester chose, the hours a request
  // came to when it was asked for, an adjustment's kind (time off or sick),
  // and the email Approve/Deny links already used.
  `ALTER TABLE policies ADD COLUMN sick_days REAL NOT NULL DEFAULT 0;
   ALTER TABLE people ADD COLUMN pay_basis TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_basis IN ('hourly', 'monthly'));
   ALTER TABLE people ADD COLUMN hours_per_day REAL NOT NULL DEFAULT 8;
   ALTER TABLE people ADD COLUMN team TEXT;
   ALTER TABLE requests ADD COLUMN approver_id TEXT REFERENCES people(id);
   ALTER TABLE requests ADD COLUMN hours REAL;
   ALTER TABLE adjustments ADD COLUMN kind TEXT NOT NULL DEFAULT 'pto' CHECK (kind IN ('pto', 'sick'));
   UPDATE requests SET hours = days * 8;
   CREATE INDEX requests_by_approver ON requests(approver_id, status);
   CREATE TABLE decide_links_used (
     token_hash TEXT PRIMARY KEY,
     request_id TEXT NOT NULL,
     used_at TEXT NOT NULL
   );`,
  // How each person came onto the roster: added by an admin, the first admin
  // (BOOTSTRAP_ADMIN_EMAIL), or enrolled on their own from Slack.
  `ALTER TABLE people ADD COLUMN enrolled_via TEXT NOT NULL DEFAULT 'admin' CHECK (enrolled_via IN ('admin', 'bootstrap', 'slack'));`,
  // A new type, "loa" (leave of absence), and typed working days: days is
  // what applies, days_computed what the calendar math said, and
  // days_overridden whether the requester typed their own number. SQLite
  // cannot widen a CHECK in place, so the table is rebuilt (nothing points
  // at requests with a foreign key).
  `CREATE TABLE requests_v5 (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id),
     kind TEXT NOT NULL CHECK (kind IN ('pto', 'sick', 'unpaid', 'loa', 'unavailable')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     half_day_start INTEGER NOT NULL DEFAULT 0,
     half_day_end INTEGER NOT NULL DEFAULT 0,
     days REAL NOT NULL,
     days_computed REAL,
     days_overridden INTEGER NOT NULL DEFAULT 0,
     hours REAL,
     approver_id TEXT REFERENCES people(id),
     note TEXT NOT NULL DEFAULT '',
     decided_by TEXT REFERENCES people(id),
     decided_at TEXT,
     decision_note TEXT NOT NULL DEFAULT '',
     calendar_state TEXT NOT NULL DEFAULT 'none' CHECK (calendar_state IN ('none', 'added', 'pending', 'failed', 'removed')),
     calendar_event_id TEXT,
     calendar_id TEXT,
     calendar_error TEXT,
     slack_channel TEXT,
     slack_ts TEXT,
     slack_extra TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   INSERT INTO requests_v5 (id, person_id, kind, status, start_date, end_date, half_day_start, half_day_end, days, days_computed, days_overridden, hours, approver_id, note,
                            decided_by, decided_at, decision_note, calendar_state, calendar_event_id, calendar_id, calendar_error, slack_channel, slack_ts, slack_extra, created_at, updated_at)
     SELECT id, person_id, kind, status, start_date, end_date, half_day_start, half_day_end, days, days, 0, hours, approver_id, note,
            decided_by, decided_at, decision_note, calendar_state, calendar_event_id, calendar_id, calendar_error, slack_channel, slack_ts, slack_extra, created_at, updated_at
     FROM requests;
   DROP TABLE requests;
   ALTER TABLE requests_v5 RENAME TO requests;
   CREATE INDEX requests_by_person ON requests(person_id, start_date);
   CREATE INDEX requests_by_status ON requests(status, start_date);
   CREATE INDEX requests_by_calendar ON requests(calendar_state);
   CREATE INDEX requests_by_approver ON requests(approver_id, status);`,
  // Sample data for a demo (scripts/seed-sample.mjs): every seeded person is
  // marked, so the whole set can be found and removed again.
  `ALTER TABLE people ADD COLUMN sample INTEGER NOT NULL DEFAULT 0;`,
  // A Manager pick an admin has yet to confirm (slack.manager_pick "confirm"):
  // JSON { slack_user_id, email, name, person_id, rejected? }. Until it is
  // confirmed the request waits with the admins.
  `ALTER TABLE requests ADD COLUMN pending_manager TEXT;`,
  // Email Approve/Deny links as short random ids (decide.mjs): what a link
  // means is kept here, keyed by the id's hash. Links of the old signed
  // format are simply not found. And when an approver was last reminded.
  `CREATE TABLE decide_links (
     id_hash TEXT PRIMARY KEY,
     request_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('approve', 'deny')),
     approver_id TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX decide_links_by_request ON decide_links(request_id);
   ALTER TABLE requests ADD COLUMN last_reminded_at TEXT;`,
  // Email links for the Manager question too (confirm_manager /
  // reject_manager, admins only), and pairs: the two links of one email
  // choice share a pair_id and are spent together. SQLite cannot widen the
  // CHECK in place, so the table is rebuilt.
  `CREATE TABLE decide_links_v9 (
     id_hash TEXT PRIMARY KEY,
     request_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('approve', 'deny', 'confirm_manager', 'reject_manager')),
     approver_id TEXT NOT NULL,
     pair_id TEXT,
     expires_at TEXT NOT NULL,
     used_at TEXT,
     created_at TEXT NOT NULL
   );
   INSERT INTO decide_links_v9 (id_hash, request_id, action, approver_id, pair_id, expires_at, used_at, created_at)
     SELECT id_hash, request_id, action, approver_id, NULL, expires_at, used_at, created_at FROM decide_links;
   DROP TABLE decide_links;
   ALTER TABLE decide_links_v9 RENAME TO decide_links;
   CREATE INDEX decide_links_by_request ON decide_links(request_id);
   CREATE INDEX decide_links_by_pair ON decide_links(pair_id);`,
  // Unlimited allowances and whether company holidays are taken out of a
  // person's day counts. Existing policies keep their numbers, limited, with
  // holidays taken out (as before); only people added from now on get their
  // class's defaults (store.mjs, CLASS_DEFAULTS).
  `ALTER TABLE policies ADD COLUMN pto_unlimited INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE policies ADD COLUMN sick_unlimited INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE policies ADD COLUMN holidays_apply INTEGER NOT NULL DEFAULT 1;`,
];

// The lock comes first and the version is read inside it: two worker
// workers opening a fresh file at once queue on BEGIN IMMEDIATE, and the
// second sees the first's version instead of running the same migration
// again. schema_version holds exactly one row (id = 1).
function migrate(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)").run();
    let version = Number(db.prepare("SELECT version FROM schema_version WHERE id = 1").get().version);
    while (version < MIGRATIONS.length) {
      db.exec(MIGRATIONS[version]);
      version += 1;
    }
    db.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(version);
    db.exec("COMMIT");
    return version;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDb(file = DB_FILE) {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  // busy_timeout first: switching to WAL needs a lock, and another worker
  // may hold it.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
  migrate(db);
  return db;
}

let shared = null;
export function getDb() {
  if (!shared) shared = openDb();
  return shared;
}

// Re-entrant BEGIN IMMEDIATE (from sqlite-runtime.mjs, trimmed): a nested
// call joins the outer transaction, and an error anywhere inside rolls the
// whole thing back. The work must be synchronous; a promise would let other
// requests interleave inside the open transaction.
const active = new WeakMap();
export function transaction(db, fn) {
  if (active.get(db)) return fn();
  db.exec("BEGIN IMMEDIATE");
  active.set(db, true);
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new Error("transaction work must be synchronous");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back by SQLite */ }
    throw error;
  } finally {
    active.delete(db);
  }
}

export const nowIso = (now = new Date()) => now.toISOString();
export const parseJson = (text, fallback) => {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
