// Outbound mail: the four notices about a request (server/mail.mjs holds
// the words). No mail library: a shared host typically hands the site a
// mailbox on its own domain with SPF and DKIM already set, reachable over
// SMTP. The client below speaks just enough SMTP for that: EHLO, AUTH
// PLAIN, one recipient, one plain-text body.
//
// Ported from an earlier project. Unchanged but for the EHLO name.
//
// Every SMTP_* value set (plus PUBLIC_ORIGIN) turns it on; MAIL_FIXTURE=1
// stands in for the mailbox and writes each message to
// <DATA_DIR>/outbox/<id>.json instead of sending, so QA and browser walks
// read it off disk and nothing leaves the box.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { DATA_DIR } from "../db.mjs";
import { AUTH_WORDS, fail } from "./words.mjs";
import { fixtureFlag } from "../fixture-guard.mjs";

export const OUTBOX_DIR = process.env.OUTBOX_DIR || path.join(DATA_DIR, "outbox");
const SMTP_TIMEOUT_MS = 15 * 1000;
const ADDRESS_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NUL = String.fromCharCode(0);

export function mailSwitch(env = process.env) {
  const has = (name) => Boolean(String(env[name] ?? "").trim());
  const real = has("SMTP_HOST") && has("SMTP_USER") && has("SMTP_PASS") && has("MAIL_FROM");
  // A real mailbox always wins over the outbox, and the outbox is off on a
  // production-like server (fixture-guard.mjs).
  const fixture = fixtureFlag(env, "MAIL_FIXTURE") && !real;
  const on = fixture || (real && has("PUBLIC_ORIGIN"));
  return { on, fixture };
}

// A header value can never carry a line break: that is how a second
// recipient or a second header would be smuggled in.
export function headerSafe(value, max = 254) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

/** Base64 in lines of 76, CRLF between them. */
export const base64Lines = (value) => (Buffer.from(String(value ?? "").replace(/\r\n|\r|\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) || []).join("\r\n");

/**
 * The body of a message with an HTML part: multipart/alternative, the plain
 * text first (what plain clients show) and the HTML second, each in base64.
 * Returns { headers: [Content-Type ...], body }.
 */
export function alternativeBody({ text, html }) {
  const boundary = `timeoff_${randomBytes(12).toString("hex")}`;
  const part = (type, value) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(value)}\r\n`;
  return {
    headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
    body: `${part("text/plain", text)}${part("text/html", html)}--${boundary}--`,
  };
}

/**
 * Write one message to the practice outbox, <outboxDir>/<id>.json, instead
 * of sending it. `extra` records how it would have gone (the transport).
 */
export function captureMail({ to, from, subject, text, html = null }, { outboxDir = OUTBOX_DIR, now = new Date(), extra = {} } = {}) {
  const message = { id: randomBytes(8).toString("hex"), to: normalizeEmail(to), from: headerSafe(from), subject: headerSafe(subject, 200), text: String(text ?? ""), ...(html ? { html: String(html) } : {}), at: now.toISOString(), ...extra };
  mkdirSync(outboxDir, { recursive: true });
  const target = path.join(outboxDir, `${message.id}.json`);
  writeFileSync(`${target}.tmp`, JSON.stringify(message, null, 2));
  renameSync(`${target}.tmp`, target);
  return message;
}

export function normalizeEmail(value) {
  const clean = headerSafe(value).toLowerCase();
  return ADDRESS_PATTERN.test(clean) && clean.length <= 254 ? clean : null;
}

/**
 * Send one plain-text message. Fixture mode writes it to the outbox and
 * reports `sent: false`; the real path reports `sent: true` or throws
 * `mail_failed`. The SMTP error never reaches a browser.
 */
export async function sendMail({ to, subject, text, html = null }, { env = process.env, now = new Date(), connect = null, outboxDir = OUTBOX_DIR } = {}) {
  const sw = mailSwitch(env);
  if (!sw.on) throw fail(AUTH_WORDS.mail_off, "mail_off", 503);
  const address = normalizeEmail(to);
  if (!address) throw fail(AUTH_WORDS.invalid_email, "invalid_email", 400);
  const message = {
    id: randomBytes(8).toString("hex"),
    to: address,
    from: sw.fixture ? headerSafe(env.MAIL_FROM || "fixture@example.com") : headerSafe(env.MAIL_FROM),
    subject: headerSafe(subject, 200),
    text: String(text ?? ""),
    ...(html ? { html: String(html) } : {}),
    at: now.toISOString(),
  };
  if (sw.fixture) {
    const captured = captureMail(message, { outboxDir, now });
    return { sent: false, fixture: true, id: captured.id };
  }
  try {
    await smtpSend(message, { env, connect });
  } catch {
    throw fail(AUTH_WORDS.mail_failed, "mail_failed", 502);
  }
  return { sent: true, fixture: false, id: message.id };
}

// Every line ending becomes CRLF, a lone CR included: a bare CR or LF in
// the body is what SMTP smuggling relies on.
function dotStuff(text) {
  return String(text)
    .replace(/\r\n|\r|\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

// A header with anything outside printable ASCII (a name like "Zoë") goes
// out as RFC 2047 encoded words: UTF-8, base64, at most 45 bytes of text
// per word so each stays under 75 characters, folded onto new lines.
export function encodeHeader(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

function buildData(message) {
  const from = headerSafe(message.from);
  const headers = [
    `Date: ${new Date(message.at).toUTCString()}`,
    `From: ${from}`,
    `To: ${headerSafe(message.to)}`,
    `Subject: ${encodeHeader(headerSafe(message.subject, 200))}`,
    `Message-ID: <${headerSafe(message.id, 64)}@${from.split("@")[1] || "localhost"}>`,
    "MIME-Version: 1.0",
  ];
  if (message.html) {
    const mime = alternativeBody({ text: message.text, html: message.html });
    return `${[...headers, ...mime.headers].join("\r\n")}\r\n\r\n${dotStuff(mime.body)}\r\n.\r\n`;
  }
  headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
  return `${headers.join("\r\n")}\r\n\r\n${dotStuff(message.text)}\r\n.\r\n`;
}

// One conversation with the server. Replies are read a line at a time; a
// multi-line reply ("250-...") is complete on the first "NNN " line.
export function smtpSend(message, { env = process.env, connect = null } = {}) {
  const host = String(env.SMTP_HOST || "").trim();
  const port = Number(env.SMTP_PORT) || 465;
  const secure = String(env.SMTP_SECURE ?? "1") !== "0";
  const user = String(env.SMTP_USER || "");
  const pass = String(env.SMTP_PASS || "");
  const open = connect || ((onConnect) => (secure ? tls.connect({ host, port, servername: host }, onConnect) : net.connect({ host, port }, onConnect)));

  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = "";
    let waiting = null;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("smtp_timeout")), SMTP_TIMEOUT_MS);

    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (/^\d{3}-/.test(line)) continue;
        if (/^\d{3}( |$)/.test(line) && waiting) {
          const resolveReply = waiting;
          waiting = null;
          resolveReply(line);
        }
      }
    };
    const reply = () => new Promise((resolveReply) => { waiting = resolveReply; });
    const send = (command) => { socket.write(`${command}\r\n`); return reply(); };
    const expect = (line, codes, step) => {
      if (!codes.includes(line.slice(0, 3))) throw new Error(`smtp_${step}:${line.slice(0, 3)}`);
      return line;
    };

    const run = async () => {
      expect(await reply(), ["220"], "greeting");
      expect(await send("EHLO timeoff"), ["250"], "ehlo");
      if (!secure && !connect) {
        expect(await send("STARTTLS"), ["220"], "starttls");
        socket.removeListener("data", onData);
        socket = tls.connect({ socket, servername: host }, () => {});
        socket.on("data", onData);
        socket.on("error", finish);
        expect(await send("EHLO timeoff"), ["250"], "ehlo_tls");
      }
      const plain = Buffer.from(`${NUL}${user}${NUL}${pass}`, "utf8").toString("base64");
      expect(await send(`AUTH PLAIN ${plain}`), ["235"], "auth");
      expect(await send(`MAIL FROM:<${headerSafe(message.from)}>`), ["250"], "from");
      expect(await send(`RCPT TO:<${headerSafe(message.to)}>`), ["250", "251"], "rcpt");
      expect(await send("DATA"), ["354"], "data");
      socket.write(buildData(message));
      expect(await reply(), ["250"], "body");
      await send("QUIT").catch(() => {});
      finish(null);
    };

    socket = open(() => {
      run().catch(finish);
    });
    socket.setEncoding?.("utf8");
    socket.on("data", onData);
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("smtp_closed")));
  });
}
