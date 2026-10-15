// Sending the notification email from the admin's own Google Workspace
// account, through the same grant that connects the calendar (scope
// gmail.send: send only, nothing is read). One call per message: the Gmail
// API's messages.send with the whole RFC 822 message, base64url-encoded,
// as `raw`. Same shape as calendar.mjs: the access token from
// calendar-grant.mjs, one forced refresh on a 401, a 10 second timeout,
// and errors that carry .googleStatus with tokens redacted, never .status
// (so a Google error can never reach a browser as if it were ours).
//
// From: MAIL_FROM when set. Gmail honors it only when it is the granted
// account or one of its Workspace "send as" aliases; anything else Gmail
// quietly replaces with the account itself. Unset, it is "Time Off" at the
// connected account's address.
//
// With CALENDAR_FIXTURE's practice grant, the message is written to the
// practice outbox (marked transport "gmail") instead of being sent.

import { randomBytes } from "node:crypto";
import { alternativeBody, base64Lines, captureMail, encodeHeader, headerSafe, normalizeEmail } from "../auth/mail.mjs";
import { calendarSwitch, getAccessToken, safeErrorBody } from "./calendar-grant.mjs";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TIMEOUT_MS = 10_000;

export const base64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The From header: MAIL_FROM, else "Time Off" at the connected account. */
export function gmailFrom(env, accountEmail) {
  const configured = headerSafe(env?.MAIL_FROM);
  if (configured) return configured;
  return accountEmail ? `Time Off <${headerSafe(accountEmail)}>` : null;
}

/**
 * One plain-text RFC 822 message: the subject RFC 2047-encoded when it is
 * not plain ASCII, the body UTF-8 in base64 lines of 76, CRLF throughout.
 */
export function buildRawMessage({ from, to, subject, text, html = null, date = new Date(), messageId = randomBytes(12).toString("hex") }) {
  const sender = headerSafe(from);
  const domain = (sender.match(/@([A-Za-z0-9.-]+)/) || [])[1] || "localhost";
  const headers = [
    `From: ${sender}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeader(headerSafe(subject, 200))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  // With an HTML part: multipart/alternative (text first, then HTML).
  if (html) {
    const mime = alternativeBody({ text, html });
    return `${[...headers, ...mime.headers].join("\r\n")}\r\n\r\n${mime.body}\r\n`;
  }
  headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
  return `${headers.join("\r\n")}\r\n\r\n${base64Lines(text)}\r\n`;
}

function gmailError(status, body) {
  return Object.assign(new Error(`Gmail ${status}: ${safeErrorBody(body)}`), { googleStatus: status, code: "gmail_failed" });
}

/**
 * Send one message from the granted account. Returns { sent: true, id } or,
 * with the practice grant, { sent: false, fixture: true, id }.
 * `opts` is { env, dataDir, fetchImpl, outboxDir, now }.
 */
export async function sendViaGmail({ to, subject, text, html = null, from }, opts = {}) {
  const env = opts.env || process.env;
  const address = normalizeEmail(to);
  if (!address) throw Object.assign(new Error("not an email address"), { code: "invalid_email" });
  if (calendarSwitch(env).fixture) {
    const captured = captureMail({ to: address, from, subject, text, html }, { outboxDir: opts.outboxDir, now: opts.now, extra: { transport: "gmail" } });
    return { sent: false, fixture: true, id: captured.id };
  }
  const raw = base64url(buildRawMessage({ from, to: address, subject, text, html, date: opts.now || new Date() }));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let force = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAccessToken({ env, dataDir: opts.dataDir, fetchImpl, force });
    let response;
    try {
      response = await fetchImpl(SEND_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw Object.assign(new Error(`Gmail did not answer (${error?.name || "error"})`), { code: "gmail_failed" });
    }
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      return { sent: true, id: String(payload?.id || "") };
    }
    // An expired access token looks like a revoked grant: refresh once first.
    if (response.status === 401 && !force) {
      force = true;
      continue;
    }
    throw gmailError(response.status, await response.text().catch(() => ""));
  }
  throw gmailError(401, "unauthorized");
}
