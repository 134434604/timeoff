// Everything someone does inside a Slack message or form:
//
//   view_submission "timeoff_request"  the Request time off form: checked by
//       the same rules as the site (checkDraft); a refusal comes back on the
//       field it is about, and the form stays open
//   view_submission "timeoff_deny"     the optional note behind Deny
//   block_actions approve / deny       the manager's buttons
//   block_actions cancel               a button from /timeoff cancel
//
// Who clicked is checked by the same rule as the site (domain/requests.mjs
// through actions.mjs): a refusal is a line only the clicker sees, and the
// message is left as it was. Slack wants an answer within three seconds,
// so the reply is sent first and the calendar, email and messages follow
// (`later`).

import { approveRequest, cancelRequest, checkDecision, confirmManager, createRequest, denyRequest, rejectManager } from "../actions.mjs";
import { nowIso, transaction } from "../db.mjs";
import { formatRange } from "../domain/dates.mjs";
import { checkDraft } from "../domain/requests.mjs";
import { notify } from "../mail.mjs";
import { slackCall, slackRespond, withinBudget } from "./api.mjs";
import { REQUEST_CALLBACK } from "./commands.mjs";
import { LOOKUP_BUDGET_MS, PICK_WORDS, remainingBudget, resolveManagerPick, unresolvedWords } from "./identity.mjs";
import { resolveAndWelcome } from "./enroll.mjs";
import { dm, esc, requestLine, whisper } from "./messages.mjs";
import * as store from "../store.mjs";

export const DENY_CALLBACK = "timeoff_deny";

// Only a refusal the rules raised on purpose (an HTTP status of its own) is
// shown; anything else goes up to the route, which logs it.
const userFacing = (error) => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;

// Which field of the form a refusal belongs on.
const FIELD_FOR = {
  invalid_kind: "kind",
  invalid_approver: "manager",
  invalid_days_requested: "days",
  no_working_days: "days",
  kind_not_offered: "kind",
  end_before_start: "end",
  too_long: "end",
  note_too_long: "note",
};

function formBody(values = {}) {
  const pick = (block) => values[block]?.value;
  return {
    kind: pick("kind")?.selected_option?.value,
    start_date: pick("start")?.selected_date ?? "",
    end_date: pick("end")?.selected_date ?? "",
    half_day_start: false,
    half_day_end: false,
    note: pick("note")?.value || "",
    days_requested: pick("days")?.value ?? "",
  };
}

function denyModal(request, person, meta) {
  return {
    type: "modal",
    callback_id: DENY_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Deny time off" },
    submit: { type: "plain_text", text: "Deny" },
    close: { type: "plain_text", text: "Back" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${esc(person.name)}: ${requestLine(request)}` } },
      { type: "input", block_id: "note", optional: true, label: { type: "plain_text", text: "A note for them (optional)" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 1000 } },
    ],
  };
}

async function submitRequest(ctx, payload) {
  // The form must be answered within three seconds, so who is asking is
  // looked up under a budget; no request is made for someone unresolved.
  const { person, reason } = await resolveAndWelcome(ctx, payload.user?.id);
  if (!person) return { reply: { response_action: "errors", errors: { start: unresolvedWords(reason) } }, later: null };
  const body = formBody(payload.view?.state?.values);
  const refuse = (error) => {
    if (!userFacing(error)) throw error;
    const field = FIELD_FOR[error.code] || (error.code === "invalid_dates" && body.start_date ? "end" : "start");
    return { reply: { response_action: "errors", errors: { [field]: error.message } }, later: null };
  };
  // The dates and type first (nothing written), so a bad form never adds a manager.
  try {
    checkDraft(body, { person, today: store.todayFor(person), holidays: store.holidaysFor(ctx.db, person), own: store.requestsFor(ctx.db, person.id) });
  } catch (error) {
    return refuse(error);
  }
  // Both are required in the Slack form (Slack enforces it too; this is the
  // server's own check): the working days, and the Manager.
  if (body.days_requested === "" || body.days_requested === null || body.days_requested === undefined) {
    return { reply: { response_action: "errors", errors: { days: "Enter the number of working days, like 1.5" } }, later: null };
  }
  // The Manager picker: anyone in the workspace, checked and matched to the roster.
  const picked = payload.view?.state?.values?.manager?.value?.selected_user || null;
  if (!picked) return { reply: { response_action: "errors", errors: { manager: "Pick your manager" } }, later: null };
  let manager = null;
  let pendingManager = null;
  let enrolled = false;
  let promoted = false;
  if (picked) {
    const found = await withinBudget(resolveManagerPick(ctx, picked, person), remainingBudget(ctx, LOOKUP_BUDGET_MS));
    if (found.timedOut) return { reply: { response_action: "errors", errors: { manager: PICK_WORDS.slow } }, later: null };
    if (found.error) return { reply: { response_action: "errors", errors: { manager: PICK_WORDS[found.error] } }, later: null };
    manager = found.person || null;
    pendingManager = found.pending || null;
    enrolled = found.enrolled === true;
  }
  let out;
  let newManager = false;
  try {
    out = transaction(ctx.db, () => {
      if (manager && manager.role === "employee") {
        promoted = true;
        ctx.db.prepare("UPDATE people SET role = 'manager' WHERE id = ?").run(manager.id);
        store.audit(ctx.db, { actorId: person.id, action: "person.promoted_by_request", subject: manager.id, detail: `${manager.name} became a manager when ${person.name} picked them.` });
      }
      const requester = store.personRow(ctx.db, person.id);
      // The pick becomes their manager when they have none (and it makes no loop).
      if (manager && !requester.manager_id && !reportsTo(ctx.db, manager, requester.id)) {
        ctx.db.prepare("UPDATE people SET manager_id = ? WHERE id = ?").run(manager.id, requester.id);
        store.audit(ctx.db, { actorId: person.id, action: "person.update", subject: requester.id, detail: `Manager set to ${manager.name} from the Slack form.` });
        newManager = true;
      }
      return createRequest({ ...ctx, pendingManager, actor: store.personRow(ctx.db, person.id), body: { ...body, approver_id: manager?.id ?? "" } });
    });
  } catch (error) {
    return refuse(error);
  }
  const changed = manager && manager.id !== person.manager_id;
  return {
    reply: null,
    later: async () => {
      // A pick that made someone a manager is news for the admins straight away.
      if (promoted || enrolled) await dmAdminsOfPick(ctx, person, manager, enrolled);
      await out.followUp();
      if (changed) await tellAdminsOfPick(ctx, person, manager);
    },
  };
}

// Would making `manager` the requester's manager make a loop?
function reportsTo(db, manager, requesterId) {
  let cursor = manager;
  for (let hops = 0; cursor && hops < 100; hops += 1) {
    if (cursor.manager_id === requesterId) return true;
    cursor = cursor.manager_id ? store.personRow(db, cursor.manager_id) : null;
  }
  return false;
}

// Slack DM to every admin whose Slack is linked: a pick promoted or added a manager.
async function dmAdminsOfPick(ctx, requester, manager, enrolled) {
  const what = enrolled ? "was added to the roster as a manager" : "was made a manager";
  for (const admin of ctx.db.prepare("SELECT * FROM people WHERE role = 'admin' AND active = 1 AND sample = 0 AND slack_user_id IS NOT NULL").all()) {
    await dm(ctx, admin, `${esc(requester.name)} picked ${esc(manager.name)} as their manager in Slack, so ${esc(manager.name)} ${what}. Check the People page: ${ctx.origin}/people`);
  }
}

// Every admin hears that a requester picked someone new as their manager.
async function tellAdminsOfPick(ctx, requester, manager) {
  const audit = (action, subject, detail) => store.audit(ctx.db, { action, subject, detail });
  const mailOptions = { env: ctx.env, origin: ctx.origin, outboxDir: ctx.outboxDir, dataDir: ctx.dataDir, fetchImpl: ctx.fetchImpl, audit };
  for (const admin of ctx.db.prepare("SELECT * FROM people WHERE role = 'admin' AND active = 1 AND sample = 0").all()) {
    await notify("manager_picked", { to: admin.email, data: { requester: requester.name, manager: manager.name } }, mailOptions);
  }
  store.audit(ctx.db, { action: "request.manager_picked", subject: requester.id, detail: `${requester.name} picked ${manager.name} as their manager (${nowIso().slice(0, 10)}).` });
}

async function submitDeny(ctx, payload) {
  const { person, reason } = await resolveAndWelcome(ctx, payload.user?.id);
  if (!person) return { reply: { response_action: "errors", errors: { note: unresolvedWords(reason) } }, later: null };
  let meta = {};
  try { meta = JSON.parse(payload.view?.private_metadata || "{}"); } catch { meta = {}; }
  try {
    const out = denyRequest({ ...ctx, actor: person, id: String(meta.id ?? ""), note: formBody(payload.view?.state?.values).note });
    return { reply: null, later: out.followUp };
  } catch (error) {
    if (!userFacing(error)) throw error;
    return { reply: { response_action: "errors", errors: { note: error.message } }, later: null };
  }
}

async function clicked(ctx, payload) {
  const action = payload.actions?.[0] || {};
  const userId = payload.user?.id;
  const channel = payload.channel?.id || payload.container?.channel_id;
  const tell = (text) => (channel ? whisper(ctx, { channel, user: userId, text }) : slackRespond(ctx, payload.response_url, { response_type: "ephemeral", replace_original: false, text }));
  const { person, reason } = await resolveAndWelcome(ctx, userId);
  if (!person) return tell(unresolvedWords(reason));
  const id = String(action.value ?? "");
  try {
    if (action.action_id === "confirm_manager" || action.action_id === "reject_manager") {
      // Admins only, checked here and again in actions.mjs.
      if (person.role !== "admin") return tell("Only an admin can confirm a manager.");
      const act = action.action_id === "confirm_manager" ? confirmManager : rejectManager;
      await act({ ...ctx, actor: person, id }).followUp();
    } else if (action.action_id === "approve") {
      await approveRequest({ ...ctx, actor: person, id }).followUp();
    } else if (action.action_id === "deny") {
      const request = checkDecision({ db: ctx.db, actor: person, id, action: "deny" });
      await slackCall(ctx, "views.open", { trigger_id: payload.trigger_id, view: denyModal(request, store.personRow(ctx.db, request.person_id), { id }) });
    } else if (action.action_id === "cancel") {
      const out = cancelRequest({ ...ctx, actor: person, id });
      await out.followUp();
      await slackRespond(ctx, payload.response_url, { replace_original: true, text: `Cancelled: ${formatRange(out.request.start_date, out.request.end_date)}.` });
    }
  } catch (error) {
    if (!userFacing(error)) throw error;
    await tell(error.message);
  }
}

/**
 * One interaction payload (the JSON in `payload=`). Returns { reply, later }
 * like handleCommand: `reply` is the response body or null for an empty
 * acknowledgment.
 */
export async function handleInteraction(ctx, payload) {
  if (payload?.type === "view_submission") {
    const callback = payload.view?.callback_id;
    if (callback === REQUEST_CALLBACK) return submitRequest(ctx, payload);
    if (callback === DENY_CALLBACK) return submitDeny(ctx, payload);
    return { reply: null, later: null };
  }
  if (payload?.type === "block_actions") return { reply: null, later: () => clicked(ctx, payload) };
  return { reply: null, later: null };
}
