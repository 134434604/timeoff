// Email through the admin's Google grant: the raw message, the Gmail call,
// and the order the mail switch picks a way out.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRawMessage, gmailFrom, sendViaGmail } from "../server/google/gmail.mjs";
import { FIXTURE_ACCOUNT, GRANT_SCOPES, GMAIL_SEND_SCOPE, readFixture, tokenFile, writeFixture } from "../server/google/calendar-grant.mjs";
import { mailRoute, notify } from "../server/mail.mjs";

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "timeoff-gmail-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const fromB64url = (text) => Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const CALENDAR_ONLY = GRANT_SCOPES.filter((scope) => scope !== GMAIL_SEND_SCOPE);
const SMTP = { SMTP_HOST: "mail.example.com", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "Time Off <timeoff@example.com>" };

function practiceGrant(dataDir, scopes = null) {
  writeFixture(dataDir, { ...readFixture(dataDir), account_email: FIXTURE_ACCOUNT, scopes });
}

test("the raw message: headers, CRLF, encoded subject, base64 body", () => {
  const raw = buildRawMessage({ from: "Time Off <boss@example.com>", to: "pat@example.com", subject: "Zoë asked for time off", text: "Línea uno\nLine two", date: new Date("2026-10-14T12:00:00Z"), messageId: "abc123" });
  const [head, body] = raw.split("\r\n\r\n");
  const headers = head.split("\r\n");
  assert.ok(headers.includes("From: Time Off <boss@example.com>"));
  assert.ok(headers.includes("To: pat@example.com"));
  assert.ok(headers.includes("Date: Wed, 14 Oct 2026 12:00:00 GMT"));
  assert.ok(headers.includes("Message-ID: <abc123@example.com>"));
  assert.ok(headers.includes("MIME-Version: 1.0"));
  assert.ok(headers.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(headers.includes("Content-Transfer-Encoding: base64"));
  const subject = headers.find((line) => line.startsWith("Subject: "));
  assert.match(subject, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(subject.slice(19, -2), "base64").toString("utf8"), "Zoë asked for time off");
  for (const line of body.trimEnd().split("\r\n")) assert.ok(line.length <= 76);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Línea uno\r\nLine two");
  // A plain subject stays plain; a header can never gain a second line.
  assert.match(buildRawMessage({ from: "a@example.com", to: "b@example.com", subject: "Hi\r\nBcc: x@example.com", text: "" }), /\r\nSubject: Hi Bcc: x@example.com\r\n/);
});

test("From: MAIL_FROM when set, else Time Off at the connected account", () => {
  assert.equal(gmailFrom({}, "boss@example.com"), "Time Off <boss@example.com>");
  assert.equal(gmailFrom({ MAIL_FROM: "HR <hr@example.com>" }, "boss@example.com"), "HR <hr@example.com>");
  assert.equal(gmailFrom({}, null), null);
});

test("Gmail send: the raw message goes to messages.send, a 401 refreshes once, errors are redacted", async () => {
  const dataDir = tempDir();
  const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", PUBLIC_ORIGIN: "https://timeoff.example.com", DATA_DIR: dataDir };
  writeFileSync(tokenFile(dataDir), JSON.stringify({ refreshToken: "1//stub-refresh", accountEmail: "boss@example.com", scopes: [...GRANT_SCOPES] }));
  const seen = [];
  let sends = 0;
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: `ya29.token${seen.length}`, expires_in: 3600 }), { status: 200 });
    sends += 1;
    if (sends === 1) return new Response("{}", { status: 401 });
    if (sends === 2) return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "Bad token ya29.leaked-value" } }), { status: 400 });
  };
  const sent = await sendViaGmail({ to: "Pat@Example.com", subject: "Hello", text: "Body", from: "Time Off <boss@example.com>" }, { env, dataDir, fetchImpl });
  assert.deepEqual(sent, { sent: true, id: "msg-1" });
  const posts = seen.filter((row) => row.url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(posts.length, 2);
  assert.equal(seen.filter((row) => row.url.startsWith("https://oauth2.googleapis.com/token")).length, 2, "refreshed once after the 401");
  assert.match(posts[1].init.headers.Authorization, /^Bearer ya29\./);
  assert.match(fromB64url(JSON.parse(posts[1].init.body).raw), /\r\nTo: pat@example.com\r\n/);
  await assert.rejects(sendViaGmail({ to: "pat@example.com", subject: "x", text: "y", from: "a@example.com" }, { env, dataDir, fetchImpl }), (error) => error.googleStatus === 400 && error.status === undefined && !error.message.includes("ya29.leaked") && error.message.includes("[redacted]"));
});

test("the switch: fixture, then Gmail, then SMTP, then off", () => {
  const dataDir = tempDir();
  const local = { ALLOW_FIXTURES: "1", DATA_DIR: dataDir, PUBLIC_ORIGIN: "http://127.0.0.1:5610" };
  // Nothing set up.
  assert.equal(mailRoute({ env: { ...local, CALENDAR_FIXTURE: "1" }, dataDir }).transport, "off");
  // SMTP alone.
  assert.equal(mailRoute({ env: { ...local, CALENDAR_FIXTURE: "1", ...SMTP }, dataDir }).transport, "smtp");
  // The grant with gmail.send wins over SMTP.
  practiceGrant(dataDir);
  const gmail = mailRoute({ env: { ...local, CALENDAR_FIXTURE: "1", ...SMTP }, dataDir });
  assert.equal(gmail.transport, "gmail");
  assert.equal(gmail.from, "Time Off <timeoff@example.com>");
  assert.deepEqual(mailRoute({ env: { ...local, CALENDAR_FIXTURE: "1" }, dataDir }), { on: true, transport: "gmail", would_use: "gmail", from: `Time Off <${FIXTURE_ACCOUNT}>`, account_email: FIXTURE_ACCOUNT, needs_reconnect: false });
  // The practice outbox wins over all of them, and says what it stood in for.
  const fixture = mailRoute({ env: { ...local, CALENDAR_FIXTURE: "1", MAIL_FIXTURE: "1", ...SMTP }, dataDir });
  assert.equal(fixture.transport, "fixture");
  assert.equal(fixture.would_use, "gmail");
});

test("an older grant without gmail.send: reconnect needed, mail falls through", () => {
  const dataDir = tempDir();
  const local = { ALLOW_FIXTURES: "1", CALENDAR_FIXTURE: "1", DATA_DIR: dataDir };
  practiceGrant(dataDir, CALENDAR_ONLY);
  const off = mailRoute({ env: local, dataDir });
  assert.equal(off.needs_reconnect, true);
  assert.equal(off.transport, "off");
  assert.equal(mailRoute({ env: { ...local, ...SMTP, PUBLIC_ORIGIN: "http://127.0.0.1:5610" }, dataDir }).transport, "smtp");

  // The same for a real grant on disk.
  const live = tempDir();
  writeFileSync(tokenFile(live), JSON.stringify({ refreshToken: "1//old", accountEmail: "boss@example.com", scopes: CALENDAR_ONLY }));
  const real = mailRoute({ env: { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", PUBLIC_ORIGIN: "https://timeoff.example.com", DATA_DIR: live }, dataDir: live });
  assert.equal(real.needs_reconnect, true);
  assert.equal(real.transport, "off");
  assert.equal(real.account_email, "boss@example.com");
});

test("with the practice grant, Gmail mail lands in the outbox marked gmail", async () => {
  const dataDir = tempDir();
  const outboxDir = path.join(dataDir, "outbox");
  const env = { ALLOW_FIXTURES: "1", CALENDAR_FIXTURE: "1", DATA_DIR: dataDir };
  practiceGrant(dataDir);
  const request = { id: "req_000000000000000001", kind: "pto", start_date: "2026-10-19", end_date: "2026-10-21", days: 3, note: "", decision_note: "" };
  const result = await notify("request_approved", { to: "pat@example.com", data: { request, decider: { name: "Morgan Manager" } } }, { env, dataDir, outboxDir, origin: "http://127.0.0.1:5610" });
  assert.equal(result, "captured");
  const [file] = readdirSync(outboxDir);
  const message = JSON.parse(readFileSync(path.join(outboxDir, file), "utf8"));
  assert.equal(message.transport, "gmail");
  assert.equal(message.from, `Time Off <${FIXTURE_ACCOUNT}>`);
  assert.equal(message.to, "pat@example.com");
});

test("with an HTML part the message is multipart/alternative: text first, then HTML, both base64", () => {
  const raw = buildRawMessage({ from: "Time Off <boss@example.com>", to: "pat@example.com", subject: "Hi", text: "Plain body", html: "<p>Rich body</p>" });
  const boundary = (raw.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/) || [])[1];
  assert.ok(boundary);
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64/);
  assert.match(parts[1], /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64/);
  const decode = (part) => Buffer.from(part.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(decode(parts[0]), "Plain body");
  assert.equal(decode(parts[1]), "<p>Rich body</p>");
  assert.ok(raw.trimEnd().endsWith(`--${boundary}--`));
});
