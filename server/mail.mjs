// What this app emails, and which way it goes. Plain text, American
// English, no words about how the app works; links are PUBLIC_ORIGIN + a
// page.
//
//   request_submitted  -> the approver (the one chosen, else the manager,
//                         else every admin): Approve and Deny links that
//                         work without signing in (decide.mjs), and /approvals
//   request_approved   -> the requester              (/)
//   request_denied     -> the requester              (/)
//   request_cancelled  -> the approver, when approved time off is cancelled (/approvals)
//   monthly_report     -> admins (everyone) and managers (their team) (/reports)
//   person_enrolled    -> admins, when someone added themselves from Slack (/people)
//   manager_picked     -> admins, when a requester picked a new manager in Slack (/approvals)
//
// A notice never fails the request that caused it: mail off is skipped,
// and a send that fails is written to the audit table (the template and
// the request id, never an address) and the request goes on.
//
// The way out, first that applies (mailRoute):
//   fixture  MAIL_FIXTURE: every message to the practice outbox, marked with
//            the transport it would have used
//   gmail    the admin's Google grant includes gmail.send (google/gmail.mjs)
//   smtp     every SMTP_* value and MAIL_FROM set (auth/mail.mjs), the fallback
//   off      nothing is sent
// A grant made before email was added (no gmail.send) reports
// needs_reconnect and falls through to SMTP or off.

import { fixtureFlag } from "./fixture-guard.mjs";
import { captureMail, headerSafe, sendMail } from "./auth/mail.mjs";
import { grantStatus } from "./google/calendar-grant.mjs";
import { gmailFrom, sendViaGmail } from "./google/gmail.mjs";
import { formatDays, formatRange } from "./domain/dates.mjs";
import { KIND_LABELS, daysText } from "./domain/kinds.mjs";

const noteLine = (label, note) => (String(note || "").trim() ? `${label}: ${String(note).trim()}\n\n` : "");

export const TEMPLATES = Object.freeze({
  request_submitted: ({ person, request, links, origin }) => ({
    subject: `${person.name} asked for ${KIND_LABELS[request.kind]}`,
    text: `${person.name} asked for time off.\nType: ${KIND_LABELS[request.kind]}\nDates: ${formatRange(request.start_date, request.end_date)}\nDays: ${daysText(request)}\n\n${noteLine("Their note", request.note)}${links ? `Approve:\n${links.approve}\n\nDeny:\n${links.deny}\n\nThese two links work once, for 14 days, without signing in.\n\n` : ""}Everything waiting for you:\n${origin}/approvals\n`,
  }),
  request_approved: ({ request, decider, origin }) => ({
    subject: `Your ${KIND_LABELS[request.kind]} request is approved`,
    text: `${decider.name} approved your ${KIND_LABELS[request.kind]} request: ${formatRange(request.start_date, request.end_date)} (${daysText(request)}).\n\n${noteLine("Their note", request.decision_note)}See your time off and balance here:\n${origin}/\n`,
  }),
  request_denied: ({ request, decider, origin }) => ({
    subject: `Your ${KIND_LABELS[request.kind]} request was not approved`,
    text: `${decider.name} did not approve your ${KIND_LABELS[request.kind]} request: ${formatRange(request.start_date, request.end_date)} (${daysText(request)}).\n\n${noteLine("Their note", request.decision_note)}See your time off and balance here:\n${origin}/\n`,
  }),
  manager_confirm: ({ requester, manager, request, links, managerLinks, origin }) => ({
    subject: `${requester} named ${manager} as their manager`,
    text: `${requester} named ${manager} as their manager. Is that right?\n\n`
      + (managerLinks ? `Yes, ${manager} is their manager:\n${managerLinks.confirm}\n\nNo:\n${managerLinks.reject}\n\n` : "")
      + `The request: ${KIND_LABELS[request.kind]}, ${formatRange(request.start_date, request.end_date)} (${daysText(request)}).\n\n`
      + (links ? `To decide it without settling the manager, approve anyway:\n${links.approve}\n\nor deny:\n${links.deny}\n\n` : "")
      + `These links work once, for 14 days, without signing in. Or use Approvals:\n${origin}/approvals\n`,
  }),
  manager_picked: ({ requester, manager, origin }) => ({
    subject: `${requester} picked ${manager} as their manager`,
    text: `${requester} picked ${manager} as their manager; the request is waiting with them and in Approvals.\n\n${origin}/approvals\n`,
  }),
  person_enrolled: ({ name, origin }) => ({
    subject: `${name} was added to Time Off from Slack`,
    text: `${name} just asked for time off from Slack and was added to the roster. Set their manager and allowance on the People page: ${origin}/people\n`,
  }),
  monthly_report: ({ title, table, origin }) => ({
    subject: title,
    text: `${title}\n\n${table}\n\nSee it in Time Off:\n${origin}/reports\n`,
  }),
  request_cancelled: ({ person, request, actor, origin }) => ({
    subject: `${person.name}'s approved ${KIND_LABELS[request.kind]} was cancelled`,
    text: `${actor.id === person.id ? person.name : actor.name} cancelled ${actor.id === person.id ? "their" : `${person.name}'s`} approved ${KIND_LABELS[request.kind]}: ${formatRange(request.start_date, request.end_date)} (${daysText(request)}).\n\nSee who is out and what is waiting here:\n${origin}/approvals\n`,
  }),
});

// --------------------------------------------------------------- the HTML --
// A small inline-styled page for clients that show HTML: a heading, the
// request, and big buttons (at least 44 px tall, full width on a narrow
// screen), each with its link written out underneath for clients that strip
// styling. Every piece of text a person typed is escaped.

export const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const COLORS = { approve: "#1f7a4d", deny: "#6b7280", open: "#1f6f5f" };

function button({ label, href, tone = "open", small = false }) {
  // Small buttons are narrower and lighter, still at least 44 px tall to tap.
  const size = small ? "max-width:240px;padding:12px 14px;font:600 14px/20px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" : "max-width:360px;padding:12px 16px;font:600 16px/20px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";
  const style = `display:block;width:100%;${size}box-sizing:border-box;min-height:44px;margin:16px 0 4px;border-radius:8px;background:${COLORS[tone]};color:#ffffff;text-align:center;text-decoration:none;`;
  return `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a><p style="margin:0 0 8px;font:12px/16px system-ui,sans-serif;color:#555555;word-break:break-all;">${escapeHtml(href)}</p>`;
}

/** { heading, lines: [text], details: [[label, value]], note, buttons: [{ label, href, tone }], footer } -> HTML. */
export function htmlEmail({ heading, lines = [], details = [], note = "", buttons = [], footer = "" }) {
  const text = (value) => `<p style="margin:0 0 12px;font:16px/24px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;">${escapeHtml(value)}</p>`;
  const rows = details.map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;font:14px/20px system-ui,sans-serif;color:#555555;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:4px 0;font:14px/20px system-ui,sans-serif;color:#1a1a1a;">${escapeHtml(value)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f6f6f4;">`
    + `<div style="max-width:560px;margin:0 auto;padding:24px 16px;background:#ffffff;">`
    + `<h1 style="margin:0 0 16px;font:700 22px/28px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;">${escapeHtml(heading)}</h1>`
    + lines.map(text).join("")
    + (rows ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 12px;">${rows}</table>` : "")
    + (note ? `<p style="margin:0 0 12px;padding:12px;border-left:3px solid #d0d0cc;font:14px/20px system-ui,sans-serif;color:#1a1a1a;">${escapeHtml(note)}</p>` : "")
    + buttons.map(button).join("")
    + (footer ? `<p style="margin:16px 0 0;font:13px/18px system-ui,sans-serif;color:#555555;">${escapeHtml(footer)}</p>` : "")
    + `</div></body></html>`;
}

const requestDetails = (request) => [["Type", KIND_LABELS[request.kind]], ["Dates", formatRange(request.start_date, request.end_date)], ["Days", daysText(request)]];

// HTML for the notices that have it; the monthly report stays plain text.
export const HTML = Object.freeze({
  request_submitted: ({ person, request, links, origin }) => htmlEmail({
    heading: `${person.name} asked for time off`,
    details: requestDetails(request),
    note: request.note ? `Their note: ${request.note}` : "",
    buttons: [
      ...(links ? [{ label: "Approve", href: links.approve, tone: "approve" }, { label: "Deny", href: links.deny, tone: "deny" }] : []),
      { label: "Open Approvals", href: `${origin}/approvals` },
    ],
    footer: links ? "Approve and Deny work once, for 14 days, without signing in." : "",
  }),
  manager_confirm: ({ requester, manager, request, links, managerLinks, origin }) => htmlEmail({
    heading: `${requester} named ${manager} as their manager`,
    lines: ["Is that right?"],
    details: requestDetails(request),
    buttons: [
      ...(managerLinks ? [{ label: `Yes, ${manager} is their manager`, href: managerLinks.confirm, tone: "approve" }, { label: "No", href: managerLinks.reject, tone: "deny" }] : []),
      ...(links ? [{ label: "Approve anyway", href: links.approve, tone: "deny", small: true }, { label: "Deny", href: links.deny, tone: "deny", small: true }] : []),
      { label: "Open Approvals", href: `${origin}/approvals`, small: true },
    ],
    footer: "These links work once, for 14 days, without signing in.",
  }),
  request_approved: ({ request, decider, origin }) => htmlEmail({
    heading: `Your ${KIND_LABELS[request.kind]} request is approved`,
    lines: [`${decider.name} approved it.`],
    details: requestDetails(request),
    note: request.decision_note ? `Their note: ${request.decision_note}` : "",
    buttons: [{ label: "Open Time Off", href: `${origin}/` }],
  }),
  request_denied: ({ request, decider, origin }) => htmlEmail({
    heading: `Your ${KIND_LABELS[request.kind]} request was not approved`,
    lines: [`${decider.name} did not approve it.`],
    details: requestDetails(request),
    note: request.decision_note ? `Their note: ${request.decision_note}` : "",
    buttons: [{ label: "Open Time Off", href: `${origin}/` }],
  }),
  request_cancelled: ({ person, request, actor, origin }) => htmlEmail({
    heading: `${person.name}'s approved ${KIND_LABELS[request.kind]} was cancelled`,
    lines: [`Cancelled by ${actor.id === person.id ? person.name : actor.name}.`],
    details: requestDetails(request),
    buttons: [{ label: "Open Time Off", href: `${origin}/approvals` }],
  }),
  manager_picked: ({ requester, manager, origin }) => htmlEmail({
    heading: `${requester} picked ${manager} as their manager`,
    lines: ["The request is waiting with them and in Approvals."],
    buttons: [{ label: "Open Time Off", href: `${origin}/approvals` }],
  }),
  person_enrolled: ({ name, origin }) => htmlEmail({
    heading: `${name} was added to Time Off from Slack`,
    lines: [`${name} just asked for time off from Slack and was added to the roster. Set their manager and allowance on the People page.`],
    buttons: [{ label: "Open Time Off", href: `${origin}/people` }],
  }),
});

const has = (env, name) => Boolean(String(env?.[name] ?? "").trim());

/**
 * Which way mail goes here: { on, transport, would_use, from, account_email,
 * needs_reconnect }. transport is "fixture" | "gmail" | "smtp" | "off";
 * would_use is what it would be without the fixture.
 */
export function mailRoute({ env = process.env, dataDir } = {}) {
  const grant = grantStatus({ env, dataDir });
  const gmail = grant.connected && grant.gmail;
  const smtp = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "PUBLIC_ORIGIN"].every((name) => has(env, name));
  const wouldUse = gmail ? "gmail" : smtp ? "smtp" : "off";
  const transport = fixtureFlag(env, "MAIL_FIXTURE") ? "fixture" : wouldUse;
  const from = wouldUse === "gmail" ? gmailFrom(env, grant.account_email)
    : wouldUse === "smtp" ? headerSafe(env.MAIL_FROM)
    : transport === "fixture" ? headerSafe(env.MAIL_FROM) || "Time Off <timeoff@example.com>"
    : null;
  return { on: transport !== "off", transport, would_use: wouldUse, from, account_email: grant.account_email ?? null, needs_reconnect: grant.connected && !grant.gmail };
}

/**
 * Send one notice. Returns "sent", "captured" (a practice outbox), "off",
 * or "failed". `audit(action, subject, detail)` records a failure.
 * Options: { env, origin, outboxDir, dataDir, fetchImpl, audit }.
 */
export async function notify(template, { to, data }, { env = process.env, origin, outboxDir, dataDir, fetchImpl, audit = () => {} } = {}) {
  const route = mailRoute({ env, dataDir });
  if (!to || !route.on) return "off";
  const { subject, text } = TEMPLATES[template]({ ...data, origin });
  const html = HTML[template] ? HTML[template]({ ...data, origin }) : null;
  try {
    if (route.transport === "fixture") {
      captureMail({ to, from: route.from, subject, text, html }, { outboxDir, extra: { transport: "fixture", would_use: route.would_use } });
      return "captured";
    }
    if (route.transport === "gmail") {
      const result = await sendViaGmail({ to, subject, text, html, from: route.from }, { env, dataDir, fetchImpl, outboxDir });
      return result.sent ? "sent" : "captured";
    }
    const result = await sendMail({ to, subject, text, html }, { env, outboxDir });
    return result.sent ? "sent" : "captured";
  } catch (error) {
    audit("mail.failed", data?.request?.id || "", `${template} could not be sent (${error.code || "error"})`);
    return "failed";
  }
}
