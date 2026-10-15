// What Time Off says in Slack, and where: a DM to the requester when they
// ask and when it is decided, a DM with Approve / Deny buttons to the
// manager (every admin when there is no manager), and an update of that
// message when the request is decided or cancelled anywhere, Slack or the
// site. Plain American English, the same words as the emails.
//
// Every function here swallows its own failure into the audit table
// (slack.failed, with Slack's error code): Slack being down never fails or
// undoes a request, and email still goes out alongside.

import { formatDays, formatRange } from "../domain/dates.mjs";
import { KIND_LABELS, daysText } from "../domain/kinds.mjs";
import { parseJson } from "../db.mjs";
import * as store from "../store.mjs";
import { slackCall, slackSwitch } from "./api.mjs";
import { slackIdFor } from "./identity.mjs";

// Slack mrkdwn treats &, < and > as markup (links, mentions): every name,
// note or line that reaches Slack text goes through esc, so it is shown as
// typed and can never become a link or an @channel.
export const esc = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function failed(ctx, subject, error) {
  store.audit(ctx.db, { action: "slack.failed", subject, detail: `Slack did not take a message (${error?.slackError || error?.code || "error"}).` });
}

/** A one-line summary: "SMTO (3 days), Mon, Oct 26 to Wed, Oct 28, 2026". */
export const requestLine = (request) => `${KIND_LABELS[request.kind]} (${daysText(request)}), ${formatRange(request.start_date, request.end_date)}`;

/** The approval message: who, what, when, how many days, balance after, who else is out, the note; buttons while waiting. */
export function approvalBlocks({ request, person, balanceAfter = null, overlaps = [], buttons = true, line = null, approverName = null }) {
  // balanceAfter is { pto, sick } (or a plain number): show the one this kind draws on.
  const after = balanceAfter !== null && typeof balanceAfter === "object" ? balanceAfter[request.kind] ?? null : balanceAfter;
  const fields = [
    { type: "mrkdwn", text: `*Type*\n${KIND_LABELS[request.kind]}` },
    { type: "mrkdwn", text: `*Dates*\n${formatRange(request.start_date, request.end_date)}` },
    { type: "mrkdwn", text: `*Days*\n${daysText(request)}` },
  ];
  // Only a tracked balance is shown; an untracked one has nothing to say.
  if (after !== null && after !== undefined) fields.push({ type: "mrkdwn", text: `*${request.kind === "sick" ? "Sick days after" : "Balance after"}*\n${formatDays(after)}` });
  if (approverName) fields.push({ type: "mrkdwn", text: `*Approver*\n${esc(approverName)}` });
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*${esc(person.name)}* asked for time off.` } },
    { type: "section", fields },
  ];
  if (overlaps.length) {
    const names = [...new Set(overlaps.map((row) => esc(row.name)))];
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Also out then: ${names.join(", ")}` }] });
  }
  if (request.note) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Note*\n${esc(request.note)}` } });
  if (buttons) {
    blocks.push({
      type: "actions",
      block_id: "decision",
      elements: [
        { type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" }, style: "primary", value: request.id },
        { type: "button", action_id: "deny", text: { type: "plain_text", text: "Deny" }, style: "danger", value: request.id },
      ],
    });
  }
  if (line) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: esc(line) }] });
  return blocks;
}

/** The name of the approver a request names, or null. */
const approverNameOf = (db, request) => (request.approver_id ? store.personRow(db, request.approver_id)?.name ?? null : null);

/** Open a DM with this person and post into it; returns { channel, ts } or null. */
export async function dm(ctx, person, text, blocks) {
  if (!slackSwitch(ctx.env).on || !store.reachable(person)) return null;
  try {
    const user = await slackIdFor(ctx, person);
    if (!user) return null;
    const opened = await slackCall(ctx, "conversations.open", { users: user });
    const posted = await slackCall(ctx, "chat.postMessage", { channel: opened.channel.id, text, ...(blocks ? { blocks } : {}) });
    return { channel: posted.channel || opened.channel.id, ts: posted.ts };
  } catch (error) {
    failed(ctx, person.id, error);
    return null;
  }
}

/**
 * A new request: the requester hears where it went, each approver gets the
 * message with buttons, and the messages are remembered on the request.
 */
export async function announceRequest(ctx, { request, person, approvers, balanceAfter, overlaps }) {
  if (!slackSwitch(ctx.env).on) return;
  const to = approvers.length === 1 ? approvers[0].name : approvers.length ? "an admin" : "your admin";
  await dm(ctx, person, `Sent to ${esc(to)} for approval: ${requestLine(request)}.`);
  const posted = [];
  for (const approver of approvers) {
    const message = await dm(ctx, approver, `${esc(person.name)} asked for ${requestLine(request)}.`, approvalBlocks({ request, person, balanceAfter, overlaps, approverName: approverNameOf(ctx.db, request) }));
    if (message) posted.push(message);
  }
  if (!posted.length) return;
  const [first, ...rest] = posted;
  ctx.db.prepare("UPDATE requests SET slack_channel = ?, slack_ts = ?, slack_extra = ? WHERE id = ?").run(first.channel, first.ts, rest.length ? JSON.stringify(rest) : null, request.id);
  // Decided (on the site, say) while these were being sent: the decision
  // found no message to update, so settle them now.
  const now = store.requestRow(ctx.db, request.id);
  if (now.status !== "pending") await settleMessages(ctx, { request: now, line: decisionLine(ctx.db, now), balanceAfter, overlaps });
}

/** The foot line for a decided request, from the row alone. */
export function decisionLine(db, request) {
  const decider = request.decided_by ? store.personRow(db, request.decided_by)?.name : null;
  if (request.status === "approved") {
    const where = request.calendar_state === "added" ? " · on the team calendar" : request.calendar_state === "pending" ? " · the calendar update is waiting" : "";
    return `Approved${decider ? ` by ${decider}` : ""}${where}`;
  }
  if (request.status === "denied") return `Denied${decider ? ` by ${decider}` : ""}${request.decision_note ? `: ${request.decision_note}` : ""}`;
  if (request.status === "cancelled") return "Cancelled";
  return "Waiting for approval";
}

/** The question, Yes / No, and the request with Approve / Deny, for an admin. */
function confirmBlocks({ request, person, pick, balanceAfter, overlaps }) {
  const question = `${esc(person.name)} named ${esc(pick.name)} as their manager. Is that right?`;
  return {
    question,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: question } },
      { type: "actions", block_id: "manager_pick", elements: [
        { type: "button", action_id: "confirm_manager", style: "primary", value: request.id, text: { type: "plain_text", text: `Yes, ${pick.name} is a manager`.slice(0, 75) } },
        { type: "button", action_id: "reject_manager", value: request.id, text: { type: "plain_text", text: "No" } },
      ] },
      ...approvalBlocks({ request, person, balanceAfter, overlaps }),
    ],
  };
}

/**
 * A reminder: the approval message posted again to each approver (the
 * Manager question too while one is waiting). The new messages are added to
 * the ones kept on the request, so a decision closes them all.
 */
export async function repostApproval(ctx, { request, person, approvers, pick = null, balanceAfter, overlaps }) {
  if (!slackSwitch(ctx.env).on) return 0;
  const asking = pick && !pick.rejected;
  const { question, blocks } = asking ? confirmBlocks({ request, person, pick, balanceAfter, overlaps }) : { question: `Reminder: ${esc(person.name)} asked for ${requestLine(request)}.`, blocks: approvalBlocks({ request, person, balanceAfter, overlaps, approverName: approverNameOf(ctx.db, request) }) };
  const posted = [];
  for (const approver of approvers) {
    const message = await dm(ctx, approver, question, blocks);
    if (message) posted.push(message);
  }
  if (!posted.length) return 0;
  const current = store.requestRow(ctx.db, request.id);
  const kept = [...(current.slack_ts ? [{ channel: current.slack_channel, ts: current.slack_ts }] : []), ...(parseJson(current.slack_extra, []) || [])];
  const [first, ...rest] = [...posted, ...kept];
  ctx.db.prepare("UPDATE requests SET slack_channel = ?, slack_ts = ?, slack_extra = ? WHERE id = ?").run(first.channel, first.ts, rest.length ? JSON.stringify(rest) : null, request.id);
  return posted.length;
}

/**
 * A Manager pick for an admin to confirm: the request, a question, Yes / No,
 * and the usual Approve / Deny so an admin can also just decide it. The
 * requester hears it went to the admins. The messages are kept on the
 * request so a confirm, a no or a decision can close them.
 */
export async function askAdminsAboutManager(ctx, { request, person, admins, pick, balanceAfter, overlaps }) {
  if (!slackSwitch(ctx.env).on) return;
  await dm(ctx, person, `Sent to the admins: ${requestLine(request)}. They will check ${esc(pick.name)} as your manager first.`);
  const { question, blocks } = confirmBlocks({ request, person, pick, balanceAfter, overlaps });
  const posted = [];
  // Linked admins only: an admin whose Slack is not linked gets the email.
  for (const admin of admins.filter((row) => row.slack_user_id)) {
    const message = await dm(ctx, admin, question, blocks);
    if (message) posted.push(message);
  }
  if (!posted.length) return;
  const [first, ...rest] = posted;
  ctx.db.prepare("UPDATE requests SET slack_channel = ?, slack_ts = ?, slack_extra = ? WHERE id = ?").run(first.channel, first.ts, rest.length ? JSON.stringify(rest) : null, request.id);
}

/**
 * Every approval message for this request, rewritten without buttons and
 * with `line` at the foot. Balance after and who else is out are kept.
 */
export async function settleMessages(ctx, { request, line, balanceAfter = null, overlaps = [], buttons = false }) {
  if (!slackSwitch(ctx.env).on || !request.slack_ts) return;
  const person = store.personRow(ctx.db, request.person_id);
  const messages = [{ channel: request.slack_channel, ts: request.slack_ts }, ...(parseJson(request.slack_extra, []) || [])];
  // buttons: keep Approve / Deny (a turned-down Manager pick still waits on the admins).
  const blocks = approvalBlocks({ request, person, balanceAfter, overlaps, buttons, line, approverName: approverNameOf(ctx.db, request) });
  for (const message of messages) {
    try {
      await slackCall(ctx, "chat.update", { channel: message.channel, ts: message.ts, text: `${esc(person.name)}: ${esc(line)}`, blocks });
    } catch (error) {
      failed(ctx, request.id, error);
    }
  }
}

/** A short line for someone in the channel where they clicked, seen only by them. */
export async function whisper(ctx, { channel, user, text }) {
  try {
    await slackCall(ctx, "chat.postEphemeral", { channel, user, text });
  } catch (error) {
    failed(ctx, user, error);
  }
}
