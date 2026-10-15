// Time Off server: plain node:http, no framework, so it runs on any host
// with Node and nothing to install. Serves the built client
// from dist/ with a fallback to index.html for client routes, the JSON API
// under /api/ (docs/API.md, route by route), /healthz, and nothing else.
//
// Sign-in is Google, then the roster: a session cookie (auth/sessions.mjs)
// is issued only to an active person on the people table. Every /api route
// past sign-in reads the person from that cookie; manager and admin routes
// check the role, and every rule about who may act on a request lives in
// domain/requests.mjs. Every change writes an audit row. Asking, approving,
// denying and cancelling go through actions.mjs, the same path Slack uses.
//
// /api/slack/commands and /api/slack/interactions are Slack's door
// (server/slack/): form posts checked by Slack's signature instead of the
// JSON-only rule, answered at once, with the slower work run after.
//
// startServer({ port, env }) builds one server around its own database,
// so tests and scripts/qa-walk.mjs can boot it on port 0 with a temporary
// DATA_DIR. Run any other way it starts itself unless TIMEOFF_NO_AUTOSTART=1.
// At startup it refuses to run with any fixture flag set on a server that
// is not local (fixture-guard.mjs), and it binds 127.0.0.1 unless HOST
// says otherwise.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR, nowIso, openDb, parseJson, transaction } from "./db.mjs";
import { approveRequest, balanceAfter, cancelRequest, cleanText, confirmManager, createRequest, defaultApprover, denyRequest, eligibleApprovers, rejectManager, remindRequest, retryCalendar } from "./actions.mjs";
import { readDecideToken, spendDecideToken } from "./decide.mjs";
import { companyToday, insightRequests, insights, maybeSendLastMonth, monthlyReport, previousMonth, runMonthlyReport, scopeFor } from "./reports.mjs";
import { DEFAULT_HOST, assertNoFixturesInProduction, fixturesOn, requestRefusedByStandIns } from "./fixture-guard.mjs";
import { APP_NAME, AUTH_WORDS } from "./auth/words.mjs";
import { FIXTURE as GOOGLE_FIXTURE, STATE_COOKIE, clearedStateCookie, finishSignIn, fixtureConsentPage, googleSwitch, safeReturn, startSignIn, stateCookie } from "./auth/google.mjs";
import { normalizeEmail } from "./auth/mail.mjs";
import { mailRoute } from "./mail.mjs";
import { NOT_ON_ROSTER_COOKIE, clearedCookie, clearedNotOnRosterCookie, cookieValue, domainAllowed, mintSession, newId, notOnRosterCookie, personForGoogle, readSession, revokeAllFor, revokeSession, sessionCookie, tokenFromRequest } from "./auth/sessions.mjs";
import { clientAddress, failuresIn, logThrottleHit, proxyTrust, recordFailure, throttled } from "./auth/throttle.mjs";
import { addDays, isDate, isWeekend, validTimeZone, yearOf } from "./domain/dates.mjs";
import { checkDraft, fail, findOverlaps, previewWarnings } from "./domain/requests.mjs";
import { requestDayWeights } from "./domain/balance.mjs";
import { KINDS, classOf, kindsFor } from "./domain/kinds.mjs";
import { CALLBACK_PATH as CALENDAR_CALLBACK, beginConnect, calendarStatus, disconnect as disconnectCalendar, finishConnect } from "./google/calendar-grant.mjs";
import { calendarErrorWords, listCalendars } from "./google/calendar.mjs";
import { ourWorkspace, signingSecret, slackCall, slackSwitch, withinBudget } from "./slack/api.mjs";
import { handleCommand } from "./slack/commands.mjs";
import { MANAGER_PICK_MODES, SLACK_ID, SLACK_SLOW, autoEnrollBlockedReason, autoEnrollSetting, managerPickMode } from "./slack/identity.mjs";
import { handleInteraction } from "./slack/interactions.mjs";
import { verifySlackRequest } from "./slack/verify.mjs";
import * as store from "./store.mjs";
import { KEY_NAMES, clientIdHint, deleteSetupToken, ensureSetupToken, googleClientIdLooksRight, hasGoogleClient, keysFile, liveEnv, saveKeys, setupTokenFile, setupTokenMatches } from "./keys.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = path.resolve(ROOT, "dist");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
export const MAX_BODY_BYTES = 32_000;
// Slack's form payloads (a whole modal's state) run larger than the site's.
const MAX_SLACK_BYTES = 256_000;
const ROLES = ["employee", "manager", "admin"];
const ROLE_RANK = { employee: 0, manager: 1, admin: 2 };
const WORKER_TYPES = ["employee", "contractor"];

// ---------------------------------------------------------------- replies --

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

// A JSON object body, only as JSON: a cross-site form cannot send this
// content type without a preflight, which is the CSRF guard for cookie
// sessions. Every mutation reads its body through here, even an empty one.
// Bytes are counted as they arrive; past the limit the request is cut off
// and answered 413, not buffered.
function readBody(req) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return Promise.reject(fail("Send JSON.", "json_required", 415));
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(Object.assign(fail("That is too much to send at once.", "too_large", 413), { destroy: true }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        req.pause();
        reject(Object.assign(fail("That is too much to send at once.", "too_large", 413), { destroy: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { return reject(fail("That could not be read. Try again.", "invalid_json")); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject(fail("That could not be read. Try again.", "invalid_json"));
      resolve(parsed);
    });
    req.on("error", reject);
  });
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The raw body, for Slack: its signature covers the exact bytes, so nothing
// is parsed until verifySlackRequest has passed. Capped like readBody.
function readRaw(req, max = MAX_SLACK_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        req.pause();
        reject(Object.assign(fail("That is too much to send at once.", "too_large", 413), { destroy: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// ------------------------------------------------------------- the client --

function serveClient(res, url) {
  let requested;
  try { requested = decodeURIComponent(url.pathname); } catch { requested = "/"; }
  // Resolved first, then held inside dist/ with the separator, so a
  // sibling such as dist.zip or dist-old/ is never served.
  const resolved = path.resolve(DIST, `.${path.sep}${requested.replace(/^[/\\]+/, "")}`);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) return sendHtml(res, 404, "<p>Not found.</p>");
  const isFile = existsSync(resolved) && statSync(resolved).isFile();
  // A client route (no file extension) gets the app's page; a missing asset is a 404.
  const target = isFile ? resolved : path.extname(requested) ? null : path.join(DIST, "index.html");
  if (!target || !existsSync(target)) {
    return sendHtml(res, target ? 503 : 404, target ? `<!doctype html><title>${APP_NAME}</title><p>The app is not built yet. Run npm run build:client.</p>` : "<p>Not found.</p>");
  }
  const hashed = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(target);
  res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream", "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
  // A file that vanishes mid-read (a deploy swapping dist/) ends this
  // response instead of throwing out of the stream.
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}

// Only an error this app raised on purpose (fail(...), with an integer HTTP
// status) is shown to a browser. Anything else (SQLite, a bug, a Google
// body) is logged without its message, which can quote data, and answered
// with a generic sentence.
const userFacing = (error) => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;

function logInternal(where, error) {
  const frames = String(error?.stack || "").split("\n").slice(1, 6).join("\n");
  console.error(`[error] ${where}: ${error?.name || "Error"}${error?.code ? ` (${error.code})` : ""}\n${frames}`);
}

/** The code a redirect may carry in its URL: a user-facing one, else `fallback`. */
function redirectCode(error, fallback, where) {
  if (userFacing(error) && /^[a-z_]{2,40}$/.test(String(error.code || ""))) return error.code;
  logInternal(where, error);
  return fallback;
}

// ------------------------------------------------------------- the server --

export async function startServer({ port, host, env: baseEnv = process.env, fetchImpl = globalThis.fetch } = {}) {
  assertNoFixturesInProduction(baseEnv);
  const dataDir = String(baseEnv.DATA_DIR ?? "").trim() || DATA_DIR;
  // Every module reads its settings from this one env: the host's env, with
  // the keys saved on the setup page (keys.mjs) laid over it, re-read when
  // they change, so a saved key takes effect without a restart.
  const env = liveEnv(baseEnv, dataDir);
  const db = openDb(String(env.DB_FILE ?? "").trim() || path.join(dataDir, "timeoff.sqlite"));
  const outboxDir = String(env.OUTBOX_DIR ?? "").trim() || path.join(dataDir, "outbox");
  const listenHost = host || String(env.HOST ?? "").trim() || DEFAULT_HOST;
  const listenPort = port ?? Number(env.PORT || 5610);
  // Links in emails: PUBLIC_ORIGIN, or this server's own address on a local run.
  // ctx is what actions.mjs and the Slack modules work with; origin is
  // filled in once the port is known.
  const ctx = { db, env, dataDir, fetchImpl, outboxDir, origin: String(env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "") };
  const calendarOptions = { env, dataDir, fetchImpl };

  const log = (action, subject, detail, actorId = null) => store.audit(db, { actorId, action, subject, detail });

  // ------------------------------------------------------------ who is it --

  function currentPerson(req) {
    const session = readSession(db, tokenFromRequest(req));
    return session ? store.personRow(db, session.person_id) : null;
  }

  function requirePerson(req) {
    const person = currentPerson(req);
    if (!person) throw fail(AUTH_WORDS.sign_in_first, "not_signed_in", 401);
    lazyMonthlyReport();
    return person;
  }

  // Last month's report, if it has not gone out (reports.mjs claims the
  // month in a transaction, so this and the cron cannot both send). Checked
  // at most once a minute per process, and never in the way of the answer.
  let lastLazyCheck = 0;
  function lazyMonthlyReport() {
    if (Date.now() - lastLazyCheck < 60_000) return;
    lastLazyCheck = Date.now();
    setImmediate(() => {
      maybeSendLastMonth(ctx, { mailOptions: reportMailOptions() }).catch((error) => {
        logInternal("monthly report", error);
        log("report.failed", "monthly", `The monthly report did not finish (${error?.code || error?.name || "error"}).`);
      });
    });
  }

  const reportMailOptions = () => ({ env, origin: ctx.origin, outboxDir, dataDir, fetchImpl, audit: (action, subject, detail) => log(action, subject, detail) });

  // The job token for the host's cron: JOB_TOKEN in the env, or job_token
  // saved in keys.json (made at startup when neither exists).
  function jobAuthorized(req) {
    const configured = String(env.JOB_TOKEN ?? "").trim();
    const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (configured.length < 32 || !given) return false;
    const a = createHash("sha256").update(configured).digest();
    const b = createHash("sha256").update(given).digest();
    return timingSafeEqual(a, b);
  }

  function requireRole(req, role) {
    const person = requirePerson(req);
    if (ROLE_RANK[person.role] < ROLE_RANK[role]) throw fail(AUTH_WORDS.not_allowed, "forbidden", 403);
    return person;
  }

  let lastBadSignatureAudit = 0;

  // ------------------------------------------------------------- setup --

  /**
   * The setup routes answer the setup token or a signed-in admin; anyone
   * else gets the same 404 as a path that does not exist.
   */
  function setupAccess(req, token) {
    const person = currentPerson(req);
    if (person?.role === "admin") return { admin: person, byToken: false };
    // The token opens setup only while there is no Google client; it can come
    // in the X-Setup-Token header (preferred: never in a URL or a log) or the query.
    const given = req.headers["x-setup-token"] || token;
    if (given && !hasGoogleClient(env) && setupTokenMatches(dataDir, given)) return { admin: null, byToken: true };
    throw fail("Not found.", "not_found", 404);
  }

  // Each key a sensible string; an empty string clears it.
  function cleanKeyChanges(body) {
    const changes = {};
    for (const name of Object.keys(KEY_NAMES)) {
      if (!Object.prototype.hasOwnProperty.call(body, name)) continue;
      const value = body[name] === null ? "" : body[name];
      if (typeof value !== "string" || value.length > 500 || /[\r\n]/.test(value)) throw fail("Paste each key on one line.", "invalid_key");
      changes[name] = value.trim();
    }
    if (changes.allowed_email_domain && !/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(changes.allowed_email_domain)) throw fail("Type the company email domain, like example.com.", "invalid_domain");
    if (changes.bootstrap_admin_email && !normalizeEmail(changes.bootstrap_admin_email)) throw fail(AUTH_WORDS.invalid_email, "invalid_email");
    if (changes.mail_from && !/@[^@\s>]+\.[^@\s>]+/.test(changes.mail_from)) throw fail("Type the From address, like Time Off <timeoff@example.com>.", "invalid_mail_from");
    if (changes.google_client_id && !googleClientIdLooksRight(changes.google_client_id)) throw fail("That does not look like a Google client ID. It ends in .apps.googleusercontent.com.", "invalid_google_client_id");
    if (changes.slack_signing_secret && !/^[0-9a-f]{32}$/.test(changes.slack_signing_secret.trim())) throw fail("That does not look like a Slack signing secret. It is 32 letters and numbers, under Basic Information → App Credentials → Signing Secret (not the Client Secret or Verification Token).", "invalid_slack_signing_secret");
    if (changes.slack_bot_token && !/^xoxb-[A-Za-z0-9-]+$/.test(changes.slack_bot_token.trim())) throw fail("That does not look like a bot token. It starts with xoxb- and is on the Install App page.", "invalid_slack_bot_token");
    return changes;
  }

  // A new Slack token is tried once (auth.test, which changes nothing).
  async function checkSlack(changes) {
    if (!changes.slack_bot_token) return { checked: false, ok: null, team_name: null };
    try {
      const answer = await slackCall({ ...ctx, env: { ...baseEnvFor(), SLACK_BOT_TOKEN: changes.slack_bot_token, SLACK_FIXTURE: "" } }, "auth.test", {});
      return { checked: true, ok: true, team_name: String(answer.team || "") || null };
    } catch {
      return { checked: true, ok: false, team_name: null, message: "The Slack token was not accepted." };
    }
  }

  // A plain copy of the effective env (for one call that overrides a name).
  const baseEnvFor = () => Object.fromEntries(Object.keys(env).map((name) => [name, env[name]]));

  // ---------------------------------------------------------- settings --

  async function settingsView() {
    const status = calendarStatus({ env, dataDir });
    const chosen = store.getSetting(db, "calendar", {});
    const mail = mailRoute({ env, dataDir });
    const google = googleSwitch(env);
    const slack = slackSwitch(env);
    return {
      calendar: {
        connected: status.connected,
        account_email: status.account_email,
        calendar_id: status.connected ? chosen.calendar_id ?? null : null,
        calendar_name: status.connected ? chosen.calendar_name ?? null : null,
        last_error: chosen.last_error ?? null,
        pending_writes: Number(db.prepare("SELECT count(*) AS n FROM requests WHERE calendar_state = 'pending'").get().n),
        fixture: status.fixture,
        titles: chosen.titles === "type" ? "type" : "out",
      },
      mail: { on: mail.on, transport: mail.transport, from: mail.from, account_email: mail.account_email, needs_reconnect: mail.needs_reconnect },
      slack: {
        on: slack.on,
        fixture: slack.fixture,
        team_name: slack.on ? (await withinBudget(ourWorkspace(ctx), 1500))?.team_name ?? null : null,
        linked_people: Number(db.prepare("SELECT count(*) AS n FROM people WHERE active = 1 AND slack_user_id IS NOT NULL").get().n),
        auto_enroll: autoEnrollSetting(db),
        auto_enroll_blocked_reason: autoEnrollBlockedReason(env),
        manager_pick: managerPickMode(db),
      },
      google_signin: { on: google.on, fixture: google.fixture },
      // Sample people from scripts/seed-sample.mjs: the client shows a banner while there are any.
      sample_people: Number(db.prepare("SELECT count(*) AS n FROM people WHERE sample = 1").get().n),
    };
  }

  // A teammate's absence without its reason: an employee sees that someone
  // is out, not whether it is Sick, Unpaid Time or LOA. Managers and
  // admins keep the real kind.
  const forViewer = (viewer, rows) => (viewer.role === "employee" ? rows.map((row) => ({ ...row, kind: "out" })) : rows);

  // --------------------------------------------------------- people rules --

  function checkManager(personId, managerId) {
    if (managerId === null) return null;
    const manager = store.personRow(db, managerId);
    if (!manager || manager.active !== 1) throw fail("Choose a manager who is on the roster.", "invalid_manager");
    if (manager.role === "employee") throw fail("A manager has to have the manager or admin role.", "invalid_manager");
    if (personId && managerId === personId) throw fail("A person cannot be their own manager.", "own_manager");
    // No loops: walking up from the new manager must never reach this person.
    let cursor = manager;
    for (let hops = 0; cursor && hops < 100; hops += 1) {
      if (personId && cursor.manager_id === personId) throw fail("That would make a loop of managers.", "manager_loop");
      cursor = cursor.manager_id ? store.personRow(db, cursor.manager_id) : null;
    }
    return manager.id;
  }

  function personFields(body, { partial, existing = null }) {
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    if (!partial || has("name")) {
      const name = cleanText(body.name, 120);
      if (!name) throw fail("Type the person's name.", "invalid_name");
      out.name = name;
    }
    if (!partial || has("role")) {
      if (!ROLES.includes(body.role)) throw fail("Choose employee, manager or admin.", "invalid_role");
      out.role = body.role;
    }
    if (!partial || has("worker_type")) {
      if (!WORKER_TYPES.includes(body.worker_type)) throw fail("Choose employee or contractor.", "invalid_worker_type");
      out.worker_type = body.worker_type;
    }
    if (has("manager_id")) {
      const value = body.manager_id === "" ? null : body.manager_id ?? null;
      if (value !== null && typeof value !== "string") throw fail("Choose a manager who is on the roster.", "invalid_manager");
      out.manager_id = checkManager(existing?.id ?? null, value);
    } else if (!partial) out.manager_id = null;
    if (has("timezone") || !partial) {
      const zone = has("timezone") && body.timezone !== null && body.timezone !== "" ? String(body.timezone).trim() : partial ? null : String(env.DEFAULT_TIMEZONE || "America/New_York");
      if (zone === null || !validTimeZone(zone)) throw fail("Choose a time zone like America/New_York.", "invalid_timezone");
      out.timezone = zone;
    }
    if (partial && has("slack_user_id")) {
      const slack = body.slack_user_id === null || body.slack_user_id === "" ? null : String(body.slack_user_id).trim();
      if (slack !== null && !SLACK_ID.test(slack)) throw fail("A Slack member ID looks like U012AB3CD.", "invalid_slack_user");
      if (slack !== null && db.prepare("SELECT 1 FROM people WHERE slack_user_id = ? AND id != ?").get(slack, existing?.id ?? "")) throw fail("That Slack member is already linked to someone else.", "slack_user_taken", 409);
      out.slack_user_id = slack;
    }
    if (partial && has("active")) {
      if (typeof body.active !== "boolean") throw fail("Choose active or not active.", "invalid_active");
      out.active = body.active ? 1 : 0;
    }
    if (has("pay_basis") || !partial) {
      const basis = has("pay_basis") ? body.pay_basis : "monthly";
      if (!["hourly", "monthly"].includes(basis)) throw fail("Choose paid hourly or paid monthly.", "invalid_pay_basis");
      out.pay_basis = basis;
    }
    if (has("hours_per_day") || !partial) {
      const hours = has("hours_per_day") ? body.hours_per_day : 8;
      if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0.5 || hours > 24) throw fail("Hours in a workday has to be a number from 0.5 to 24.", "invalid_hours_per_day");
      out.hours_per_day = round2(hours);
    }
    if (has("team") || !partial) {
      const team = has("team") && body.team !== null ? cleanText(body.team, 60) : "";
      out.team = team || null;
    }
    return out;
  }

  /**
   * Home's team summary for a manager (their own team) or an admin (the
   * company), scoped like Insights; null for everyone else.
   */
  function teamSummary(me, { year, today }) {
    if (me.role !== "manager" && me.role !== "admin") return null;
    const numbers = insights(db, me, { year, today });
    const month = today.slice(0, 7);
    const from = `${month}-01`;
    const to = addDays(Number(month.slice(5, 7)) === 12 ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5, 7)) + 1).padStart(2, "0")}-01`, -1);
    const people = scopeFor(db, me).filter((row) => row.active === 1).map((row) => ({ id: row.id, name: row.name, class: classOf(row) }));
    const ids = people.map((row) => row.id);
    return {
      scope: me.role === "admin" ? "everyone" : "reports",
      out_today: numbers.out_today,
      out_next_30: numbers.out_next_30,
      pending: numbers.pending,
      unused_pto_total: numbers.unused_pto_total,
      // The GET /api/team/calendar shape, for this month.
      month: { month, entries: store.overlapsFor(db, ids, { from, to }), holidays: store.holidaysBetween(db, from, to), people },
      // Approved time off from today through the next 60 days.
      out_soon: store.overlapsFor(db, ids, { from: today, to: addDays(today, 60), statuses: ["approved"] }),
    };
  }

  function peopleWithBalances() {
    const holidays = store.holidaySet(db);
    return db.prepare("SELECT * FROM people ORDER BY active DESC, name COLLATE NOCASE").all()
      .map((row) => ({ ...store.personView(db, row), policy: store.policyFor(db, row.id), balance: store.balanceFor(db, row, { holidays }) }));
  }

  // ------------------------------------------------------------ the API --

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // ---- setup: the keys typed in a browser (keys.mjs)
    if (pathname === "/api/setup/status" && method === "GET") {
      setupAccess(req, url.searchParams.get("token"));
      const slack = slackSwitch(env);
      return sendJson(res, 200, {
        ok: true,
        has_google: hasGoogleClient(env) && Boolean(String(env.GOOGLE_CLIENT_SECRET ?? "").trim()),
        google_client_id_last4: clientIdHint(env),
        has_slack: slack.on && !slack.fixture,
        has_admin_email: Boolean(String(env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim()) || Boolean(db.prepare("SELECT 1 FROM people WHERE role = 'admin' AND active = 1").get()),
        has_allowed_domain: Boolean(String(env.ALLOWED_EMAIL_DOMAIN ?? "").trim()),
        has_mail_from: Boolean(String(env.MAIL_FROM ?? "").trim()),
        public_origin: String(env.PUBLIC_ORIGIN ?? "").trim() || null,
      });
    }
    if (pathname === "/api/setup/keys" && method === "PUT") {
      const body = await readBody(req);
      const access = setupAccess(req, body.token);
      const changes = cleanKeyChanges(body);
      const saved = saveKeys(dataDir, changes);
      if (saved.some((name) => name.startsWith("slack_"))) store.setSetting(db, "slack", {});
      if (saved.length) log("keys.updated", "keys", `Saved ${saved.join(", ")}.`, access.admin?.id ?? null);
      // The token opens the door once: the first Google client id saved
      // with it closes it, and from then on only an admin changes keys.
      if (access.byToken && changes.google_client_id) {
        deleteSetupToken(dataDir);
        log("keys.setup_token_used", "keys", "The setup page was used; the setup token is gone.");
      }
      return sendJson(res, 200, { saved, slack: await checkSlack(changes), google: { ok: googleClientIdLooksRight(env.GOOGLE_CLIENT_ID) } });
    }

    // ---- Slack: signed form posts, answered within Slack's three seconds
    if ((pathname === "/api/slack/commands" || pathname === "/api/slack/interactions") && method === "POST") {
      if (!slackSwitch(env).on) throw fail("Slack is not switched on here.", "slack_off", 404);
      // One deadline from arrival; every Slack step below gets what is left
      // of it (2.5 s, leaving room to answer inside Slack's 3).
      const slackCtx = { ...ctx, deadline: Date.now() + 2500 };
      // An address that keeps sending unsigned posts is turned away before
      // its body is read: 20 bad signatures in 10 minutes, then 429.
      const address = clientAddress(req, env);
      if (failuresIn(db, { kind: "slack_bad_signature", key: address, windowMs: 10 * 60_000 }) >= 20) throw fail("Too many unsigned requests from here.", "too_many", 429);
      const raw = await readRaw(req);
      if (!verifySlackRequest({ secret: signingSecret(env), timestamp: req.headers["x-slack-request-timestamp"], signature: req.headers["x-slack-signature"], rawBody: raw })) {
        recordFailure(db, { kind: "slack_bad_signature", key: address });
        // Recorded so an admin can tell a wrong signing secret from a quiet
        // Slack; one audit row a minute at most, however many arrive.
        if (Date.now() - lastBadSignatureAudit >= 60_000) {
          lastBadSignatureAudit = Date.now();
          const stamp = Number(req.headers["x-slack-request-timestamp"]);
          const skew = Number.isFinite(stamp) ? Math.round(Math.abs(Date.now() / 1000 - stamp)) : null;
          store.audit(db, { action: "slack.bad_signature", subject: pathname.slice(11), detail: signingSecret(env) ? `A request to ${pathname.slice(11)} did not match the signing secret${skew !== null ? ` (clock difference ${skew}s)` : ""}. Check the Signing Secret on the Keys page.` : "No signing secret is set." });
        }
        throw fail("That request was not signed by Slack.", "bad_signature", 401);
      }
      const form = Object.fromEntries(new URLSearchParams(raw));
      const isCommand = pathname === "/api/slack/commands";
      let payload = null;
      if (!isCommand) {
        try { payload = JSON.parse(form.payload || "null"); } catch { payload = null; }
        if (!payload || typeof payload !== "object") throw fail("That could not be read.", "invalid_payload");
      }
      // Signed by our app's secret is not the whole story: the payload must
      // also come from our own workspace (and our app, when it says), as
      // auth.test reports them. Anything else is refused to the clicker only.
      const ours = await withinBudget(ourWorkspace(slackCtx), Math.max(0, slackCtx.deadline - Date.now()));
      if (!ours || ours.timedOut || !ours.team_id) return sendJson(res, 503, { response_type: "ephemeral", text: SLACK_SLOW });
      const teamId = isCommand ? form.team_id : payload.team?.id ?? payload.user?.team_id;
      const appId = isCommand ? form.api_app_id : payload.api_app_id;
      const ourApp = String(env.SLACK_APP_ID ?? "").trim() || ours.app_id;
      if (teamId !== ours.team_id || (appId && ourApp && appId !== ourApp)) {
        store.audit(db, { action: "slack.refused", subject: pathname.slice(11), detail: "A signed request came from another workspace or app." });
        return sendJson(res, 403, { response_type: "ephemeral", text: "This Slack workspace is not connected to Time Off." });
      }
      const outcome = isCommand ? handleCommand(slackCtx, form) : await handleInteraction(slackCtx, payload);
      if (outcome.reply) sendJson(res, 200, outcome.reply);
      else {
        res.writeHead(200, { "Cache-Control": "no-store" });
        res.end();
      }
      if (outcome.later) {
        setImmediate(() => {
          Promise.resolve().then(outcome.later).catch((error) => {
            logInternal("slack later", error);
            store.audit(db, { action: "slack.failed", subject: pathname.slice(11), detail: `Slack work after the reply did not finish (${error?.slackError || error?.code || error?.name || "error"}).` });
          });
        });
      }
      return;
    }

    // ---- session
    if (pathname === "/api/me" && method === "GET") {
      const person = currentPerson(req);
      // slack_available lets any page point people to /timeoff without reading settings;
      // needs_setup sends a first visitor to /setup while no Google client exists.
      const slackAvailable = slackSwitch(env).on;
      const needsSetup = !hasGoogleClient(env) && !googleSwitch(env).fixture;
      if (person) return sendJson(res, 200, { signedIn: true, person: store.personView(db, person), kinds: kindsFor(person), app: { name: APP_NAME }, slack_available: slackAvailable, needs_setup: needsSetup });
      const google = googleSwitch(env);
      const payload = { signedIn: false, google: { on: google.on, fixture: google.fixture }, kinds: [], slack_available: slackAvailable, needs_setup: needsSetup };
      let refused = null;
      try { refused = normalizeEmail(decodeURIComponent(cookieValue(req, NOT_ON_ROSTER_COOKIE) || "")); } catch { refused = null; }
      if (refused) payload.notOnRoster = { email: refused };
      return sendJson(res, 200, payload);
    }

    if (pathname === "/api/auth/google/start" && method === "GET") {
      const ip = clientAddress(req, env);
      try {
        if (throttled(db, { kind: "google_start", key: ip, max: 20, windowMs: 10 * 60_000 })) throw fail(AUTH_WORDS.too_many, "signin_busy", 429);
        const started = startSignIn({ db, env, returnTo: url.searchParams.get("return_to") || "/" });
        return redirect(res, started.url, { "Set-Cookie": stateCookie(started.state, env) });
      } catch (error) {
        if (error.code === "signin_busy") logThrottleHit(db, { kind: "google_start_cap", key: ip });
        return redirect(res, `/?signin_error=${redirectCode(error, "signin_failed", "signin start")}`);
      }
    }
    if (pathname === GOOGLE_FIXTURE.callback && method === "GET") {
      try {
        const back = await finishSignIn({ db, env, fetchImpl, code: url.searchParams.get("code"), state: url.searchParams.get("state"), browserState: cookieValue(req, STATE_COOKIE), fixtureEmail: url.searchParams.get("email") });
        const found = transaction(db, () => {
          const result = personForGoogle(db, back, { env });
          log(result.created ? "person.bootstrap_admin" : "session.sign_in", result.person_id, result.created ? "The first admin signed in and was added to the roster." : "Signed in.", result.person_id);
          return result;
        });
        const token = mintSession(db, found.person_id, { via: googleSwitch(env).fixture ? "google_fixture" : "google" });
        return redirect(res, safeReturn(back.return_to), { "Set-Cookie": [sessionCookie(token, env), clearedStateCookie(env), clearedNotOnRosterCookie(env)] });
      } catch (error) {
        if (error.code === "not_on_roster") {
          // The address rides in the short-lived cookie (read by /api/me), not
          // the URL, so it never lands in an access log or the browser history.
          return redirect(res, "/?not_on_roster=1", { "Set-Cookie": [clearedStateCookie(env), notOnRosterCookie(error.email, env)] });
        }
        return redirect(res, `/?signin_error=${redirectCode(error, "signin_failed", "signin callback")}`, { "Set-Cookie": clearedStateCookie(env) });
      }
    }
    if (pathname === GOOGLE_FIXTURE.path && method === "GET" && googleSwitch(env).fixture) return sendHtml(res, 200, fixtureConsentPage(url.searchParams.get("state") || ""));
    if (pathname === "/api/auth/signout" && method === "POST") {
      await readBody(req);
      const person = currentPerson(req);
      if (revokeSession(db, tokenFromRequest(req)) && person) log("session.sign_out", person.id, "Signed out.", person.id);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie(env) });
    }

    // ---- everyone signed in
    if (pathname === "/api/home" && method === "GET") {
      const person = requirePerson(req);
      const today = store.todayFor(person);
      const holidays = store.holidaysFor(db, person);
      const year = yearOf(today);
      const own = store.requestsFor(db, person.id);
      // Which days this year's approved requests took, per balance: what
      // Home lists for an unlimited allowance (and may show for any other).
      const usedDays = (kind) => own.filter((row) => row.kind === kind && row.status === "approved")
        .map((row) => ({ request_id: row.id, start_date: row.start_date, end_date: row.end_date, days: requestDayWeights(row, holidays).byYear[year] || 0 }))
        .filter((row) => row.days > 0);
      return sendJson(res, 200, {
        person: store.personView(db, person),
        balance: store.balanceFor(db, person, { today }),
        used_days: { pto: usedDays("pto"), sick: usedDays("sick") },
        requests: own.map((row) => store.requestView(db, row)),
        holidays: store.holidaysBetween(db, `${year}-01-01`, `${year + 1}-12-31`),
        team_out: forViewer(person, store.overlapsFor(db, store.teamIds(db, person), { from: today, to: addDays(today, 60), statuses: ["approved"] })),
        team: teamSummary(person, { year, today }),
      });
    }

    if (pathname === "/api/requests/preview" && method === "POST") {
      const person = requirePerson(req);
      const body = await readBody(req);
      const today = store.todayFor(person);
      const holidays = store.holidaysFor(db, person);
      const own = store.requestsFor(db, person.id);
      const draft = checkDraft(body, { person, today, holidays, own, preview: true });
      const overlaps = forViewer(person, store.overlapsFor(db, store.teamIds(db, person), { from: draft.start_date, to: draft.end_date }));
      const after = balanceAfter(ctx, person, { kind: draft.kind, start_date: draft.start_date, extra: draft.byYear[yearOf(draft.start_date)] || 0 }, holidays);
      // Only the holidays that come out of this person's count (none for someone who works them).
      const holidaysInRange = store.holidaysBetween(db, draft.start_date, draft.end_date).filter((row) => !isWeekend(row.date) && holidays.has(row.date));
      return sendJson(res, 200, {
        days: draft.days,
        days_computed: draft.days_computed,
        days_overridden: draft.days_overridden,
        balance_after: after,
        overlaps,
        warnings: previewWarnings({ draft, balanceAfter: after[draft.kind] ?? null, teamOverlaps: overlaps, ownOverlaps: findOverlaps(draft, own), holidaysInRange, today }),
      });
    }

    if (pathname === "/api/requests" && method === "POST") {
      const person = requirePerson(req);
      const body = await readBody(req);
      const out = createRequest({ ...ctx, actor: person, body });
      await out.followUp();
      return sendJson(res, 200, { request: store.requestView(db, store.requestRow(db, out.request.id)), balance: store.balanceFor(db, person) });
    }

    const remindMatch = pathname.match(/^\/api\/requests\/(req_[a-f0-9]{18})\/remind$/);
    if (remindMatch && method === "POST") {
      const me = requirePerson(req);
      await readBody(req);
      const out = remindRequest({ ...ctx, actor: me, id: remindMatch[1] });
      await out.followUp();
      return sendJson(res, 200, { request: store.requestView(db, store.requestRow(db, remindMatch[1])), last_reminded_at: out.request.last_reminded_at });
    }

    const pickMatch = pathname.match(/^\/api\/requests\/(req_[a-f0-9]{18})\/(confirm-manager|reject-manager)$/);
    if (pickMatch && method === "POST") {
      const admin = requireRole(req, "admin");
      await readBody(req);
      const out = (pickMatch[2] === "confirm-manager" ? confirmManager : rejectManager)({ ...ctx, actor: admin, id: pickMatch[1] });
      await out.followUp();
      return sendJson(res, 200, { request: store.requestView(db, store.requestRow(db, pickMatch[1])) });
    }

    const actMatch = pathname.match(/^\/api\/requests\/(req_[a-f0-9]{18})\/(cancel|approve|deny)$/);
    if (actMatch && method === "POST") {
      const actor = requirePerson(req);
      const body = await readBody(req);
      const [, id, action] = actMatch;
      const act = { approve: approveRequest, deny: denyRequest, cancel: cancelRequest }[action];
      const out = act({ ...ctx, actor, id, note: body.note });
      await out.followUp();
      const request = store.requestView(db, store.requestRow(db, id));
      return sendJson(res, 200, action === "cancel" ? { request, balance: store.balanceFor(db, out.requester) } : { request });
    }

    if (pathname === "/api/approvers" && method === "GET") {
      const me = requirePerson(req);
      const fallback = defaultApprover(db, me);
      return sendJson(res, 200, {
        approvers: eligibleApprovers(db, me).map((row) => ({ id: row.id, name: row.name, team: row.team ?? null })),
        default_id: fallback?.id ?? null,
      });
    }

    // ---- the Approve / Deny links in email: no session, the link's random id is the key
    const decideMatch = pathname.match(/^\/api\/decide\/([A-Za-z0-9_.-]{20,500})$/);
    if (decideMatch && (method === "GET" || method === "POST")) {
      if (throttled(db, { kind: "decide_link", key: clientAddress(req, env), max: 30, windowMs: 10 * 60_000 })) throw fail("Too many tries from here. Wait a few minutes.", "too_many", 429);
      const token = decideMatch[1];
      const link = readDecideToken(db, token);
      const row = link ? store.requestRow(db, link.requestId) : null;
      const approver = link ? store.personRow(db, link.approverId) : null;
      const view = row ? { id: row.id, person_name: store.personRow(db, row.person_id)?.name ?? null, kind: row.kind, start_date: row.start_date, end_date: row.end_date, days: Number(row.days), note: row.note || "", status: row.status } : null;
      // Yes / No links are about the Manager pick: done once it is answered.
      const managerAction = link?.action === "confirm_manager" || link?.action === "reject_manager";
      const pick = row ? parseJson(row.pending_manager, null) : null;
      const open = row && row.status === "pending" && (!managerAction || (pick && !pick.rejected));
      const state = !link || !row || !approver ? "invalid" : link.expired ? "expired" : link.used || !open ? "already_decided" : "pending";
      if (method === "GET") {
        // Looking never decides: mail scanners open links by themselves.
        return sendJson(res, 200, { request: state === "invalid" ? null : view, action: link?.action ?? null, approver_name: approver?.name ?? null, manager_name: pick?.name ?? null, state });
      }
      const body = await readBody(req);
      if (state !== "pending") throw fail(state === "expired" ? "This link has expired. Open Time Off to decide." : state === "invalid" ? "This link does not work." : "This request was already decided.", state, state === "invalid" ? 404 : 409);
      if (approver.active !== 1) throw fail("This link does not work.", "invalid", 404);
      const act = { approve: approveRequest, deny: denyRequest, confirm_manager: confirmManager, reject_manager: rejectManager }[link.action];
      // The link (and its pair) is spent in the same transaction as the action.
      const out = transaction(db, () => {
        if (!spendDecideToken(db, token)) throw fail("This request was already decided.", "already_decided", 409);
        return act({ ...ctx, actor: approver, id: row.id, note: body.note });
      });
      log("request.decided_by_link", row.id, `${{ approve: "Approved", deny: "Denied", confirm_manager: "Manager confirmed", reject_manager: "Manager not confirmed" }[link.action]} from the email link.`, approver.id);
      await out.followUp();
      const after = store.requestRow(db, row.id);
      return sendJson(res, 200, { ok: true, action: link.action, request: { ...view, status: after.status } });
    }

    // ---- the monthly report and insights
    if (pathname === "/api/jobs/monthly-report" && method === "POST") {
      if (!jobAuthorized(req)) throw fail("Not found.", "not_found", 404);
      const body = req.headers["content-type"] ? await readBody(req) : {};
      const period = body.year && body.month ? { year: Number(body.year), month: Number(body.month) } : previousMonth(companyToday(env));
      if (!Number.isInteger(period.year) || !Number.isInteger(period.month) || period.month < 1 || period.month > 12) throw fail("Choose a year and a month.", "invalid_month");
      return sendJson(res, 200, await runMonthlyReport(ctx, period, { mailOptions: reportMailOptions() }));
    }
    if (pathname === "/api/reports/monthly" && method === "GET") {
      const me = requireRole(req, "manager");
      const fallback = previousMonth(companyToday(env));
      const year = Number(url.searchParams.get("year") || fallback.year);
      const month = Number(url.searchParams.get("month") || fallback.month);
      if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw fail("Choose a year and a month.", "invalid_month");
      return sendJson(res, 200, monthlyReport(db, { year, month, people: scopeFor(db, me) }));
    }
    if (pathname === "/api/insights" && method === "GET") {
      const me = requireRole(req, "manager");
      const today = companyToday(env);
      const year = Number(url.searchParams.get("year") || yearOf(today));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw fail("Choose a year like 2026.", "invalid_year");
      return sendJson(res, 200, insights(db, me, { year, today }));
    }
    if (pathname === "/api/insights/requests" && method === "GET") {
      const me = requireRole(req, "manager");
      const params = url.searchParams;
      // window: the Insights tiles (today, next 30 days, waiting), in place of year/month.
      const window = params.get("window") || null;
      if (window !== null && !["today", "next_30", "pending"].includes(window)) throw fail("Choose today, next_30 or pending.", "invalid_window");
      const year = params.get("year") ? Number(params.get("year")) : null;
      if ((year === null && !window) || (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100))) throw fail("Choose a year like 2026.", "invalid_year");
      const month = window ? null : params.get("month") || null;
      if (month !== null && (!/^\d{4}-\d{2}$/.test(month) || !isDate(`${month}-01`) || Number(month.slice(0, 4)) !== year)) throw fail(`Choose a month of ${year}, like ${year}-03.`, "invalid_month");
      const kind = params.get("kind") || null;
      if (kind !== null && !KINDS.includes(kind)) throw fail("Choose a Type.", "invalid_kind");
      const cls = params.get("class") || null;
      if (cls !== null && !["employee", "contractor_monthly", "contractor_hourly"].includes(cls)) throw fail("Choose employee, contractor_monthly or contractor_hourly.", "invalid_class");
      const status = params.get("status") || "approved";
      if (!["approved", "pending"].includes(status)) throw fail("Choose approved or pending.", "invalid_status");
      // team: left out = any team; "" = people with no team.
      const team = params.has("team") ? String(params.get("team")).trim() : null;
      const personId = params.get("person_id") || null;
      return sendJson(res, 200, insightRequests(db, me, { year, month, window, today: companyToday(env), team, person_id: personId, kind, class: cls, status }));
    }

    // ---- managers and admins
    if (pathname === "/api/approvals" && method === "GET") {
      const me = requireRole(req, "manager");
      // Admins: everyone's but their own. Managers: requests that name them
      // as approver, and their direct reports' requests.
      const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      const mine = me.role === "admin"
        ? (store.soleAdmin(db, me) ? "(requests.person_id = ? OR 1 = 1)" : "requests.person_id != ?")
        : "requests.person_id != ? AND (requests.approver_id = ? OR (requests.pending_manager IS NULL AND requests.person_id IN (SELECT id FROM people WHERE manager_id = ?)))";
      const args = me.role === "admin" ? [me.id] : [me.id, me.id, me.id];
      const pendingRows = db.prepare(`SELECT requests.* FROM requests WHERE status = 'pending' AND ${mine} ORDER BY start_date, created_at`).all(...args);
      const recentRows = db.prepare(`SELECT requests.* FROM requests WHERE decided_at IS NOT NULL AND decided_at >= ? AND ${mine} ORDER BY decided_at DESC LIMIT 200`).all(since, ...args);
      const people = new Map();
      const personOf = (id) => {
        if (!people.has(id)) people.set(id, store.personRow(db, id));
        return people.get(id);
      };
      return sendJson(res, 200, {
        pending: pendingRows.map((row) => {
          const person = personOf(row.person_id);
          const balance = store.balanceFor(db, person);
          // Unlimited: nothing to run down, so the days used this year instead.
          const unlimited = (row.kind === "pto" || row.kind === "sick") && balance[row.kind].unlimited;
          return {
            request: store.requestView(db, row),
            person: store.personView(db, person),
            balance,
            balance_after: balanceAfter(ctx, person, { kind: row.kind, start_date: row.start_date }),
            used_this_year: unlimited ? balance[row.kind].used : null,
            overlaps: store.overlapsFor(db, store.teamIds(db, person), { from: row.start_date, to: row.end_date }),
            last_reminded_at: row.last_reminded_at ?? null,
          };
        }),
        recent: recentRows.map((row) => ({ request: store.requestView(db, row), person: store.personView(db, personOf(row.person_id)) })),
      });
    }

    if (pathname === "/api/team/calendar" && method === "GET") {
      const me = requireRole(req, "manager");
      const month = String(url.searchParams.get("month") || store.todayFor(me).slice(0, 7));
      if (!/^\d{4}-\d{2}$/.test(month) || !isDate(`${month}-01`)) throw fail("Choose a month like 2026-10.", "invalid_month");
      const from = `${month}-01`;
      const next = Number(month.slice(5, 7)) === 12 ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5, 7)) + 1).padStart(2, "0")}-01`;
      const to = addDays(next, -1);
      const people = me.role === "admin"
        ? db.prepare("SELECT id, name, worker_type, pay_basis FROM people WHERE active = 1 ORDER BY name COLLATE NOCASE").all()
        : scopeFor(db, me).filter((row) => row.active === 1).map((row) => ({ id: row.id, name: row.name, class: classOf(row) }));
      return sendJson(res, 200, {
        month,
        entries: store.overlapsFor(db, people.map((row) => row.id), { from, to }),
        holidays: store.holidaysBetween(db, from, to),
        people: people.map((row) => ({ id: row.id, name: row.name, class: row.class ?? classOf(row) })),
      });
    }

    // ---- admins: people
    if (pathname === "/api/people" && method === "GET") {
      requireRole(req, "admin");
      const teams = db.prepare("SELECT DISTINCT team FROM people WHERE team IS NOT NULL ORDER BY team COLLATE NOCASE").all().map((row) => row.team);
      return sendJson(res, 200, { people: peopleWithBalances(), teams });
    }
    if (pathname === "/api/people" && method === "POST") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      const id = transaction(db, () => {
        const email = normalizeEmail(body.email);
        if (!email) throw fail(AUTH_WORDS.invalid_email, "invalid_email");
        if (!domainAllowed(email, env)) throw fail(`Only ${String(env.ALLOWED_EMAIL_DOMAIN).replace(/^@/, "")} addresses can be added.`, "wrong_domain");
        if (db.prepare("SELECT 1 FROM people WHERE email = ?").get(email)) throw fail("Someone with that email address is already on the roster.", "email_taken", 409);
        const fields = personFields(body, { partial: false });
        const personId = newId("per");
        db.prepare("INSERT INTO people (id, email, name, role, worker_type, manager_id, active, timezone, pay_basis, hours_per_day, team, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)")
          .run(personId, email, fields.name, fields.role, fields.worker_type, fields.manager_id, fields.timezone, fields.pay_basis, fields.hours_per_day, fields.team, nowIso());
        log("person.create", personId, `Added as ${fields.role} (${fields.worker_type}).`, admin.id);
        store.applyClassPolicy(db, personId, { actorId: admin.id, reason: "New person." });
        return personId;
      });
      return sendJson(res, 200, { person: store.personView(db, store.personRow(db, id)) });
    }
    const personMatch = pathname.match(/^\/api\/people\/(per_[a-f0-9]{18})(\/policy|\/adjustments)?$/);
    if (personMatch && !personMatch[2] && method === "PATCH") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      const id = personMatch[1];
      transaction(db, () => {
        const existing = store.personRow(db, id);
        if (!existing) throw fail("That person was not found.", "not_found", 404);
        const fields = personFields(body, { partial: true, existing });
        const losesAdmin = existing.role === "admin" && existing.active === 1 && ((fields.role && fields.role !== "admin") || fields.active === 0);
        if (losesAdmin && Number(db.prepare("SELECT count(*) AS n FROM people WHERE role = 'admin' AND active = 1 AND id != ?").get(id).n) === 0) {
          throw fail("There has to be at least one admin. Make someone else an admin first.", "last_admin", 409);
        }
        if (fields.role === "employee" && existing.role !== "employee") {
          const reports = Number(db.prepare("SELECT count(*) AS n FROM people WHERE manager_id = ? AND active = 1").get(id).n);
          if (reports) throw fail(`${existing.name} still manages ${reports} ${reports === 1 ? "person" : "people"}. Give ${reports === 1 ? "them" : "each of them"} a new manager first.`, "has_reports", 409);
        }
        const keys = Object.keys(fields);
        if (keys.length) db.prepare(`UPDATE people SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => fields[key]), id);
        if (fields.active === 0) revokeAllFor(db, id);
        log("person.update", id, keys.length ? `Changed ${keys.join(", ")}.` : "No changes.", admin.id);
        // A new class (worker type, or a contractor's pay basis) brings that
        // class's policy, unless the admin keeps the one they have.
        const before = classOf(existing);
        const after = classOf(store.personRow(db, id));
        if (after !== before) {
          if (body.keep_policy === true) log("policy.kept", id, `Class changed from ${before} to ${after}; policy kept.`, admin.id);
          else {
            store.applyClassPolicy(db, id, { actorId: admin.id, reason: `Class changed from ${before}.` });
            store.recountDays(db, { from: "2000-01-01", to: "2100-12-31", personId: id });
          }
        }
      });
      return sendJson(res, 200, { person: store.personView(db, store.personRow(db, id)) });
    }
    if (personMatch && personMatch[2] === "/policy" && method === "PUT") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      const id = personMatch[1];
      const person = store.personRow(db, id);
      if (!person) throw fail("That person was not found.", "not_found", 404);
      const annual = Number(body.annual_days);
      const cap = Number(body.carryover_cap);
      if (typeof body.annual_days !== "number" || !Number.isFinite(annual) || annual < 0 || annual > 366) throw fail("Days per year has to be a number from 0 to 366.", "invalid_annual_days");
      if (!["front_loaded", "monthly"].includes(body.accrual)) throw fail("Choose all at once at the start of the year, or monthly.", "invalid_accrual");
      if (typeof body.carryover_cap !== "number" || !Number.isFinite(cap) || cap < 0 || cap > 366) throw fail("Days that roll over has to be a number from 0 to 366.", "invalid_carryover_cap");
      if (!isDate(body.start_date) || yearOf(body.start_date) < 2000 || yearOf(body.start_date) > 2100) throw fail("Choose the date this person started, from 2000 on.", "invalid_start_date");
      // Sick days: optional (0 = not tracked), all at once on Jan 1, never carried over.
      const sick = body.sick_days === undefined ? 0 : Number(body.sick_days);
      if ((body.sick_days !== undefined && typeof body.sick_days !== "number") || !Number.isFinite(sick) || sick < 0 || sick > 366) throw fail("Sick days per year has to be a number from 0 to 366.", "invalid_sick_days");
      // Optional switches; left out, time off and sick days are limited and
      // company holidays come out of the count (the whole policy is replaced).
      const flag = (key, fallback) => {
        if (body[key] === undefined) return fallback;
        if (typeof body[key] !== "boolean") throw fail("Choose yes or no for unlimited time off, unlimited sick days and holidays.", "invalid_policy_flag");
        return body[key];
      };
      const flags = { pto_unlimited: flag("pto_unlimited", false), sick_unlimited: flag("sick_unlimited", false), holidays_apply: flag("holidays_apply", true) };
      transaction(db, () => {
        const holidaysBefore = store.policyFor(db, id)?.holidays_apply ?? true;
        store.writePolicy(db, id, { annual_days: annual, accrual: body.accrual, carryover_cap: cap, start_date: body.start_date, sick_days: sick, ...flags });
        const ptoWords = flags.pto_unlimited ? "unlimited time off" : `${annual} days a year, ${body.accrual === "monthly" ? "monthly" : "all at once"}, up to ${cap} roll over`;
        log("policy.set", id, `${ptoWords}, ${flags.sick_unlimited ? "unlimited" : sick} sick days, holidays ${flags.holidays_apply ? "taken out" : "counted as working days"}, starting ${body.start_date}.`, admin.id);
        // Whether holidays count changes this person's open and approved day counts.
        if (holidaysBefore !== flags.holidays_apply) store.recountDays(db, { from: "2000-01-01", to: "2100-12-31", personId: id });
      });
      return sendJson(res, 200, { person: store.personView(db, person), balance: store.balanceFor(db, person) });
    }
    if (personMatch && personMatch[2] === "/adjustments" && method === "POST") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      const id = personMatch[1];
      const person = store.personRow(db, id);
      if (!person) throw fail("That person was not found.", "not_found", 404);
      const days = Number(body.days);
      if (typeof body.days !== "number" || !Number.isFinite(days) || days === 0 || Math.abs(days) > 366) throw fail("Type the days to add or take away, like 2 or -1.5.", "invalid_days");
      const note = cleanText(body.note, 500, { lines: true });
      if (!note) throw fail("Add a note saying why.", "note_required");
      const kind = body.kind === undefined ? "pto" : body.kind;
      if (kind !== "pto" && kind !== "sick") throw fail("Choose time off or sick days.", "invalid_kind");
      const year = yearOf(store.todayFor(person));
      transaction(db, () => {
        db.prepare("INSERT INTO adjustments (id, person_id, year, days, note, actor_id, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(newId("adj"), id, year, round2(days), note, admin.id, nowIso(), kind);
        log("adjustment.add", id, `${days > 0 ? "+" : ""}${round2(days)} ${kind === "sick" ? "sick " : ""}days for ${year}.`, admin.id);
      });
      return sendJson(res, 200, { balance: store.balanceFor(db, person) });
    }

    // ---- admins: holidays
    if (pathname === "/api/holidays" && method === "GET") {
      const admin = requireRole(req, "admin");
      const year = Number(url.searchParams.get("year") || yearOf(store.todayFor(admin)));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw fail("Choose a year like 2026.", "invalid_year");
      return sendJson(res, 200, { holidays: store.holidaysBetween(db, `${year}-01-01`, `${year}-12-31`) });
    }
    if (pathname === "/api/holidays" && method === "PUT") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      const year = Number(body.year);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw fail("Choose a year like 2026.", "invalid_year");
      if (!Array.isArray(body.holidays) || body.holidays.length > 100) throw fail("Send the year's holidays as a list.", "invalid_holidays");
      const seen = new Set();
      const holidays = body.holidays.map((row) => {
        const date = String(row?.date ?? "");
        const name = cleanText(row?.name, 80);
        if (!isDate(date) || yearOf(date) !== year) throw fail(`Every holiday has to be a date in ${year}.`, "invalid_holiday_date");
        if (!name) throw fail("Give every holiday a name.", "invalid_holiday_name");
        if (seen.has(date)) throw fail(`${date} is listed twice.`, "duplicate_holiday");
        seen.add(date);
        return { date, name };
      });
      transaction(db, () => {
        db.prepare("DELETE FROM holidays WHERE date >= ? AND date <= ?").run(`${year}-01-01`, `${year}-12-31`);
        const insert = db.prepare("INSERT INTO holidays (date, name) VALUES (?, ?)");
        for (const row of holidays) insert.run(row.date, row.name);
        // A request's days follow the holiday list: recount the live ones that touch this year.
        store.recountDays(db, { from: `${year}-01-01`, to: `${year}-12-31` });
        log("holidays.set", String(year), `${holidays.length} holidays for ${year}.`, admin.id);
      });
      return sendJson(res, 200, { holidays: store.holidaysBetween(db, `${year}-01-01`, `${year}-12-31`) });
    }

    // ---- admins: settings
    if (pathname === "/api/settings" && method === "GET") {
      requireRole(req, "admin");
      return sendJson(res, 200, await settingsView());
    }
    if (pathname === "/api/settings/calendar/connect" && method === "GET") {
      try {
        const admin = requireRole(req, "admin");
        return redirect(res, beginConnect({ db, env, personId: admin.id }).url);
      } catch (error) {
        return redirect(res, `/settings?calendar_error=${redirectCode(error, "calendar_failed", "calendar connect")}`);
      }
    }
    if (pathname === CALENDAR_CALLBACK && method === "GET") {
      try {
        // Inside the try: a browser landing here signed out (or not an admin)
        // goes back to Settings with a reason, not to a page of JSON.
        const admin = requireRole(req, "admin");
        if (url.searchParams.get("error")) throw fail("Google did not finish the calendar connection.", "calendar_grant_failed");
        const status = await finishConnect({ db, env, dataDir, fetchImpl, personId: admin.id, code: url.searchParams.get("code"), state: url.searchParams.get("state") });
        store.setSetting(db, "calendar", { ...store.getSetting(db, "calendar", {}), last_error: null });
        log("calendar.connect", "calendar", `Connected ${status.fixture ? "the practice Google account" : "Google"} (${status.gmail ? "calendar and email" : "calendar only"}).`, admin.id);
        return redirect(res, "/settings");
      } catch (error) {
        return redirect(res, `/settings?calendar_error=${redirectCode(error, "calendar_failed", "calendar callback")}`);
      }
    }
    if (pathname === "/api/settings/calendars" && method === "GET") {
      requireRole(req, "admin");
      if (!calendarStatus({ env, dataDir }).connected) throw fail("Connect the shared calendar first.", "calendar_not_connected", 409);
      try {
        return sendJson(res, 200, { calendars: await listCalendars(calendarOptions) });
      } catch (error) {
        if (error.code === "calendar_not_connected") throw fail("Connect the shared calendar first.", "calendar_not_connected", 409);
        console.warn(`[calendar] list failed (status ${error.googleStatus ?? error.name ?? "unknown"})`);
        throw fail(calendarErrorWords(error), "calendar_unavailable", 502);
      }
    }
    if (pathname === "/api/settings/calendar" && method === "PUT") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      if (body.titles !== undefined && body.titles !== "type" && body.titles !== "out") throw fail("Choose titles that show the Type, or that say Out.", "invalid_titles");
      if (body.calendar_id === undefined && body.titles === undefined) throw fail("Nothing to change.", "nothing_to_change");
      if (body.titles !== undefined) {
        // New events only; ones already on the calendar keep their titles.
        store.setSetting(db, "calendar", { ...store.getSetting(db, "calendar", {}), titles: body.titles });
        log("calendar.titles", "calendar", body.titles === "type" ? "Calendar titles show the Type." : "Calendar titles say Out for Sick, Unpaid Time and LOA.", admin.id);
      }
      if (body.calendar_id === undefined) return sendJson(res, 200, { settings: await settingsView() });
      if (!calendarStatus({ env, dataDir }).connected) throw fail("Connect the shared calendar first.", "calendar_not_connected", 409);
      let calendars;
      try {
        calendars = await listCalendars(calendarOptions);
      } catch (error) {
        console.warn(`[calendar] list failed (status ${error.googleStatus ?? error.name ?? "unknown"})`);
        throw fail(calendarErrorWords(error), "calendar_unavailable", 502);
      }
      const chosen = calendars.find((row) => row.id === String(body.calendar_id ?? ""));
      if (!chosen) throw fail("Choose one of the calendars in the list.", "invalid_calendar");
      if (!chosen.writable) throw fail("That calendar cannot be written to by the connected account. Choose another.", "calendar_read_only");
      store.setSetting(db, "calendar", { ...store.getSetting(db, "calendar", {}), calendar_id: chosen.id, calendar_name: chosen.name, last_error: null });
      log("calendar.choose", "calendar", `Time off now goes on ${chosen.name}.`, admin.id);
      return sendJson(res, 200, { settings: await settingsView() });
    }
    if (pathname === "/api/settings/slack" && method === "PUT") {
      const admin = requireRole(req, "admin");
      const body = await readBody(req);
      if (body.auto_enroll === undefined && body.manager_pick === undefined) throw fail("Nothing to change.", "nothing_to_change");
      if (body.auto_enroll !== undefined && typeof body.auto_enroll !== "boolean") throw fail("Choose on or off.", "invalid_auto_enroll");
      if (body.manager_pick !== undefined && !MANAGER_PICK_MODES.includes(body.manager_pick)) throw fail("Choose confirm every pick, confirm new managers, anyone or managers only.", "invalid_manager_pick");
      if (body.auto_enroll !== undefined) {
        store.setSetting(db, "slack_auto_enroll", body.auto_enroll);
        log("settings.slack", "slack", body.auto_enroll ? "People not on the roster are added when they use Slack." : "People not on the roster are turned away in Slack.", admin.id);
      }
      if (body.manager_pick !== undefined) {
        store.setSetting(db, "slack_manager_pick", body.manager_pick);
        log("settings.slack", "slack", { confirm_every: "Every Manager pick in Slack waits for an admin to confirm it.", confirm_new: "A Manager pick of someone who is not a manager waits for an admin to confirm it.", anyone: "The Manager picker in Slack takes anyone in the workspace.", managers_only: "The Manager picker in Slack takes managers only." }[body.manager_pick], admin.id);
      }
      return sendJson(res, 200, { settings: await settingsView() });
    }
    if (pathname === "/api/settings/calendar/disconnect" && method === "POST") {
      const admin = requireRole(req, "admin");
      await readBody(req);
      await disconnectCalendar({ env, dataDir, fetchImpl });
      store.setSetting(db, "calendar", { calendar_id: null, calendar_name: null, last_error: null });
      log("calendar.disconnect", "calendar", "Disconnected the shared calendar.", admin.id);
      return sendJson(res, 200, { settings: await settingsView() });
    }
    if (pathname === "/api/settings/calendar/retry" && method === "POST") {
      const admin = requireRole(req, "admin");
      await readBody(req);
      return sendJson(res, 200, await retryCalendar({ ...ctx, actor: admin }));
    }

    if (pathname === "/api/audit" && method === "GET") {
      requireRole(req, "admin");
      return sendJson(res, 200, { events: store.auditView(db, { limit: url.searchParams.get("limit") || 100 }) });
    }

    throw fail("Not found.", "not_found", 404);
  }

  // Headers every answer carries: no sniffing, no referrer, no framing, a
  // content policy that allows only this origin (the built client has no
  // inline scripts; React sets inline styles, hence 'unsafe-inline' for
  // style-src; the favicon is a data: image), and HSTS on https.
  const https = String(env.PUBLIC_ORIGIN ?? "").trim().toLowerCase().startsWith("https://");
  function securityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    // While any stand-in is on, only a request straight from this machine is
    // answered: a proxied or non-loopback request never reaches the practice
    // sign-in, outbox or calendar.
    const standInRefusal = requestRefusedByStandIns(req.headers, env);
    if (standInRefusal) {
      console.warn(`[stand-ins] refused ${req.method} ${String(req.url).split("?")[0].slice(0, 80)}: ${standInRefusal}; stand-ins on: ${fixturesOn(env).join(", ")}`);
      return sendJson(res, 403, { error: { code: "local_only", message: "This server is set up for local trying only." } });
    }
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return serveClient(res, url);
    } catch (error) {
      const shown = userFacing(error);
      const status = shown ? error.status : 500;
      // Never the body, a cookie or an address in the log: the path with ids masked, and the error without its message.
      if (!shown) logInternal(`${req.method} ${String(req.url).split("?")[0].replace(/[a-f0-9]{18}/g, ":id").slice(0, 80)}`, error);
      const payload = { error: shown ? { code: error.code || "error", message: error.message } : { code: "server_error", message: "Something went wrong on our side. Try again." } };
      if (error.destroy) {
        // Answer, then cut the connection so the rest of the body is never read.
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify(payload), () => req.destroy());
        return;
      }
      if (res.headersSent) return res.end();
      sendJson(res, status, payload);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  const shownHost = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  if (!ctx.origin) ctx.origin = `http://${shownHost}:${actualPort}`;
  // The host's cron needs a token for the monthly report; make one once.
  if (!String(env.JOB_TOKEN ?? "").trim()) {
    saveKeys(dataDir, { job_token: randomBytes(24).toString("hex") });
    console.log(`Monthly report job token saved as job_token in ${keysFile(dataDir)}`);
  }
  // A Google client exists: the setup token has nothing left to open.
  if (hasGoogleClient(env)) deleteSetupToken(dataDir);
  // No Google client yet: the setup page needs its one-time token.
  if (!hasGoogleClient(env)) {
    ensureSetupToken(dataDir);
    console.log(`Setup page: /setup (token in ${setupTokenFile(dataDir)})`);
  }
  if (proxyTrust(env).mode !== "off") console.log(`[proxy] TRUST_PROXY=${proxyTrust(env).mode}: the client address is read from X-Forwarded-For`);
  return {
    server,
    db,
    dataDir,
    port: actualPort,
    url: `http://${shownHost}:${actualPort}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        try { db.close(); } catch { /* already closed */ }
        resolve();
      });
    }),
  };
}

// Started by any runner (npm start, systemd, or a host's own Node loader,
// which may wrap this file so argv cannot tell): it always
// listens, on PORT, unless TIMEOFF_NO_AUTOSTART=1. Tests and scripts that
// import startServer set that first.
if (process.env.TIMEOFF_NO_AUTOSTART !== "1") {
  startServer().then(({ url }) => {
    console.log(`${APP_NAME} listening on ${url}`);
    const on = fixturesOn(process.env);
    if (on.length) console.log(`[stand-ins] on: ${on.join(", ")}`);
  }).catch((error) => {
    console.error(`[startup] ${error.message}`);
    process.exit(1);
  });
}
