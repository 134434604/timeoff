// /timeoff, the slash command staff use instead of the site.
//
//   /timeoff  or  /timeoff request   the "Request time off" form (a modal)
//   /timeoff balance                 my balance and what is waiting
//   /timeoff cancel                  my waiting and upcoming time off, with Cancel buttons
//   /timeoff help  (or anything else) how to use it
//
// Slack wants an answer within three seconds. A member already linked to
// the roster gets their answer in the response itself; opening the form,
// and anything that first has to ask Slack who the member is, happens after
// the response (`later`), with replies sent through the command's
// response_url. That lookup has a two-second budget: a slow Slack gets
// "try again", never a form opened after its trigger has expired.

import { formatDays, formatRange } from "../domain/dates.mjs";
import { KIND_LABELS, daysText, kindsFor } from "../domain/kinds.mjs";
import * as store from "../store.mjs";
import { defaultApprover } from "../actions.mjs";
import { slackCall, slackRespond } from "./api.mjs";
import { cachedPerson, unresolvedWords } from "./identity.mjs";
import { resolveAndWelcome } from "./enroll.mjs";

export const REQUEST_CALLBACK = "timeoff_request";
const STATUS_WORDS = { pending: "waiting for approval", approved: "approved" };

export const ephemeral = (text, blocks) => ({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });

const HELP = [
  "*Time Off in Slack*",
  "`/timeoff` ask for time off",
  "`/timeoff balance` see your balance and what is waiting",
  "`/timeoff cancel` cancel time off that is waiting or coming up",
].join("\n");

/**
 * "12 days available, 2 waiting", plus " · 5 days of sick time available"
 * when sick time is tracked, or that no balance is kept for them. An
 * unlimited allowance shows the days used this year instead.
 */
export function balanceLine({ pto, sick }) {
  const parts = [];
  if (pto.unlimited) parts.push(`Unlimited ${KIND_LABELS.pto}, ${formatDays(pto.used)} used this year`);
  else if (pto.tracked) parts.push(`${formatDays(pto.available)} available${pto.pending ? `, ${pto.pending} waiting` : ""}`);
  if (sick.unlimited) parts.push(`unlimited sick time, ${formatDays(sick.used)} used this year`);
  else if (sick.tracked) parts.push(`${formatDays(sick.available)} of sick time available`);
  return parts.length ? parts.join(" · ") : "No balance is tracked for you";
}

/** The "Request time off" modal for this person. */
export function requestModal(db, person) {
  const options = kindsFor(person).map((kind) => ({ text: { type: "plain_text", text: KIND_LABELS[kind] }, value: kind }));
  // Both dates start at today where the requester is (their time zone).
  const today = store.todayFor(person);
  // Manager: anyone in the workspace (Slack's people picker); their manager
  // first when that manager's Slack is linked. interactions.mjs checks the pick.
  const manager = defaultApprover(db, person);
  return {
    type: "modal",
    callback_id: REQUEST_CALLBACK,
    title: { type: "plain_text", text: "Request time off" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "context", block_id: "balance", elements: [{ type: "mrkdwn", text: balanceLine(store.balanceFor(db, person)) }] },
      { type: "input", block_id: "kind", label: { type: "plain_text", text: "Type" }, element: { type: "static_select", action_id: "value", options, initial_option: options[0] } },
      { type: "input", block_id: "start", label: { type: "plain_text", text: "First day" }, element: { type: "datepicker", action_id: "value", initial_date: today, placeholder: { type: "plain_text", text: "First day" } } },
      { type: "input", block_id: "end", label: { type: "plain_text", text: "Last day" }, element: { type: "datepicker", action_id: "value", initial_date: today, placeholder: { type: "plain_text", text: "Last day" } } },
      // Required: half days are said here (1.5 for a day and a half), so the
      // form has no half-day boxes.
      {
        type: "input", block_id: "days", label: { type: "plain_text", text: "How many working days?" },
        hint: { type: "plain_text", text: "Enter in 0.00 format, like 1.5 for a day and a half" },
        element: { type: "number_input", action_id: "value", is_decimal_allowed: true, min_value: "0.5", placeholder: { type: "plain_text", text: "0.0" } },
      },
      {
        type: "input", block_id: "manager", label: { type: "plain_text", text: "Manager" },
        element: { type: "users_select", action_id: "value", ...(manager?.slack_user_id ? { initial_user: manager.slack_user_id } : {}) },
      },
      { type: "input", block_id: "note", optional: true, label: { type: "plain_text", text: "Note for your manager" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 1000 } },
    ],
  };
}

function balanceReply(db, person) {
  const { pto: balance, sick } = store.balanceFor(db, person);
  const lines = [balance.unlimited
    ? `*${KIND_LABELS.pto} for ${balance.year}:* unlimited (${balance.used} used, ${balance.pending} waiting).`
    : balance.tracked
      ? `*Your balance for ${balance.year}:* ${formatDays(balance.available)} available (${balance.used} used, ${balance.pending} waiting).`
      : "No balance is tracked for you."];
  if (sick.unlimited) lines.push(`*Sick time for ${sick.year}:* unlimited (${sick.used} used, ${sick.pending} waiting).`);
  else if (sick.tracked) lines.push(`*Sick time for ${sick.year}:* ${formatDays(sick.available)} available (${sick.used} used, ${sick.pending} waiting).`);
  const waiting = store.requestsFor(db, person.id).filter((row) => row.status === "pending");
  if (waiting.length) {
    lines.push("", "*Waiting for approval*");
    for (const row of waiting) lines.push(`• ${formatRange(row.start_date, row.end_date)}: ${KIND_LABELS[row.kind]}, ${daysText(row)}`);
  }
  return ephemeral(lines.join("\n"));
}

function cancelReply(db, person) {
  const today = store.todayFor(person);
  const rows = store.requestsFor(db, person.id).filter((row) => row.status === "pending" || (row.status === "approved" && row.start_date > today));
  if (!rows.length) return ephemeral("You have nothing waiting or coming up to cancel.");
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Your time off that can still be cancelled*" } }];
  for (const row of rows.sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${formatRange(row.start_date, row.end_date)}\n${KIND_LABELS[row.kind]}, ${daysText(row)}, ${STATUS_WORDS[row.status]}` },
      accessory: {
        type: "button", action_id: "cancel", value: row.id, style: "danger", text: { type: "plain_text", text: "Cancel" },
        confirm: { title: { type: "plain_text", text: "Cancel this time off?" }, text: { type: "plain_text", text: formatRange(row.start_date, row.end_date) }, confirm: { type: "plain_text", text: "Cancel it" }, deny: { type: "plain_text", text: "Keep it" } },
      },
    });
  }
  return ephemeral("Your time off that can still be cancelled", blocks);
}

function replyFor(db, person, word) {
  if (word === "balance") return balanceReply(db, person);
  if (word === "cancel") return cancelReply(db, person);
  return ephemeral(HELP);
}

/**
 * One /timeoff command (the form fields Slack posted). Returns { reply,
 * later }: `reply` is the response body (null for an empty acknowledgment),
 * `later` the work to run after the response is sent.
 */
export function handleCommand(ctx, form) {
  const word = String(form.text ?? "").trim().toLowerCase().split(/\s+/)[0] || "request";
  const userId = String(form.user_id ?? "");
  const openForm = (person) => slackCall(ctx, "views.open", { trigger_id: form.trigger_id, view: requestModal(ctx.db, person) });
  const known = cachedPerson(ctx.db, userId);
  if (known) {
    if (word === "request") return { reply: null, later: () => openForm(known) };
    return { reply: replyFor(ctx.db, known, word), later: null };
  }
  return {
    reply: null,
    later: async () => {
      const { person, reason } = await resolveAndWelcome(ctx, userId);
      if (!person) return slackRespond(ctx, form.response_url, ephemeral(unresolvedWords(reason)));
      if (word === "request") return openForm(person);
      return slackRespond(ctx, form.response_url, replyFor(ctx.db, person, word));
    },
  };
}
