// Sample data and stand-ins can never be served from a real host by
// accident. Every fixture switch in this app reads `fixtureAllowed(env)`:
// stand-ins are allowed ONLY when ALL of these hold:
//   - ALLOW_FIXTURES=1 is set on purpose (from the M3/M4 review: a flag
//     alone is never enough, because a host behind a reverse proxy to
//     loopback, the usual shared-host setup behind a reverse proxy, looks local), and
//   - NODE_ENV is not "production" in any letter case, and
//   - the server listens on a loopback address (HOST unset, which binds
//     127.0.0.1, or HOST set to a loopback address), and
//   - PUBLIC_ORIGIN is unset, or an http address on a loopback host.
// A server bound to 0.0.0.0, or with an https or non-loopback
// PUBLIC_ORIGIN, or NODE_ENV=production, is production-like: there a
// fixture flag is treated as off by the module that owns it, and the
// server refuses to start at all while any such flag (or ALLOW_FIXTURES)
// is set (assertNoFixturesInProduction), naming the flag and the reason.
// An unset PUBLIC_ORIGIN is NOT proof of a real server (it is how a local
// walk runs), which is why ALLOW_FIXTURES is required as well.
//
// And while any stand-in is on, every request must look local
// (requestLooksLocal): a Host header that is not loopback, or any proxy
// header (X-Forwarded-For, Forwarded, X-Forwarded-Host, X-Forwarded-Proto,
// X-Forwarded-Server, X-Real-IP, Via, CF-Connecting-IP, True-Client-IP), is
// answered 403 and logged for the owner, so a proxied public visitor never
// reaches the stand-in sign-in, outbox, calendar or Slack.
//
// The flags are for local trying and the offline QA suites only.

export const FIXTURE_FLAGS = Object.freeze([
  "GOOGLE_FIXTURE",
  "MAIL_FIXTURE",
  "CALENDAR_FIXTURE",
  "SLACK_FIXTURE",
]);

export const ALLOW_FLAG = "ALLOW_FIXTURES";
export const DEFAULT_HOST = "127.0.0.1";
// From the final fix pass: every header a common proxy or CDN adds. A proxy
// that rewrites Host to loopback AND strips every one of these cannot be
// told apart from a local browser; that is why ALLOW_FIXTURES must never
// be set on a host (docs/GO_LIVE_CHECKLIST.md).
export const PROXY_HEADERS = Object.freeze(["x-forwarded-for", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-server", "x-real-ip", "via", "cf-connecting-ip", "true-client-ip"]);

/** A loopback host name or address: localhost, 127.x.x.x, ::1. */
export function isLoopbackHost(value) {
  const host = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Why this server counts as production-like, or null when it is local. */
export function productionReason(env = process.env) {
  if (String(env.NODE_ENV ?? "").trim().toLowerCase() === "production") return `NODE_ENV=${String(env.NODE_ENV).trim()}`;
  const host = String(env.HOST ?? "").trim();
  if (host && !isLoopbackHost(host)) return `HOST=${host} is not a loopback address`;
  const origin = String(env.PUBLIC_ORIGIN ?? "").trim();
  if (origin) {
    let url = null;
    try { url = new URL(origin); } catch { return `PUBLIC_ORIGIN=${origin} is not a local address`; }
    if (url.protocol !== "http:") return `PUBLIC_ORIGIN=${origin} is not plain http`;
    if (!isLoopbackHost(url.hostname)) return `PUBLIC_ORIGIN=${origin} is not a loopback address`;
  }
  return null;
}

export function productionLike(env = process.env) {
  return productionReason(env) !== null;
}

export const fixtureAllowed = (env = process.env) => String(env?.[ALLOW_FLAG] ?? "") === "1" && !productionLike(env);

/** Is this fixture flag on, and allowed here? */
export function fixtureFlag(env, name) {
  return String(env?.[name] ?? "") === "1" && fixtureAllowed(env);
}

export function fixtureFlagsSet(env = process.env) {
  return FIXTURE_FLAGS.filter((name) => String(env[name] ?? "") === "1");
}

/** The stand-ins actually on here (set AND allowed). */
export function fixturesOn(env = process.env) {
  return FIXTURE_FLAGS.filter((name) => fixtureFlag(env, name));
}

/**
 * While any stand-in is on, a request must come straight from this machine:
 * a loopback Host header and no proxy header. Returns null when it may go
 * on, or the reason it is refused.
 */
export function requestRefusedByStandIns(headers = {}, env = process.env) {
  if (!fixturesOn(env).length) return null;
  const proxy = PROXY_HEADERS.find((name) => headers[name] !== undefined);
  if (proxy) return `a ${proxy} header (a proxied request)`;
  const host = String(headers.host ?? "").trim().replace(/:\d+$/, "");
  if (!isLoopbackHost(host)) return `Host ${host || "(none)"} is not a loopback address`;
  return null;
}

/** Called at startup: a production-like server with any fixture flag set does not start. */
export function assertNoFixturesInProduction(env = process.env) {
  const flags = fixtureFlagsSet(env);
  const set = flags.length ? flags : String(env[ALLOW_FLAG] ?? "") === "1" ? [ALLOW_FLAG] : [];
  const reason = productionReason(env);
  if (reason && set.length) {
    throw Object.assign(new Error(`Refusing to start: ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set on a server that is not local (${reason}). Fixture flags are for a server on 127.0.0.1 with no public origin only; unset them.`), { code: "fixture_in_production" });
  }
}
