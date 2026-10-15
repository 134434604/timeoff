// Who a Slack member is on the roster. people.slack_user_id is the cache;
// on a miss Slack is asked about the member (users.info, which needs the
// users:read.email scope) and their email is matched against the active
// roster, the same rule as Google sign-in. The match is stored, so the next
// click needs no call. Someone not on the roster gets one plain sentence and
// nothing about anyone else.
//
// A member is linked only when Slack says they belong to our own workspace
// (team_id from auth.test), are not deleted, not a bot, not a stranger from
// a shared channel, and their email is confirmed. Guests (is_restricted)
// are allowed: contractors are often guests. A link is never moved
// silently: a person already linked to another member id, or a member id
// already linked to another person, is refused and written to the audit.
//
// Slack allows three seconds per answer, so the lookup has a budget
// (LOOKUP_BUDGET_MS); a lookup that runs over reports "slow" and nothing is
// created on its behalf.
//
// The other direction (a manager who has never used /timeoff, so their
// member id is not stored yet) asks Slack by email (users.lookupByEmail),
// under the same checks.
//
// Self-enrollment: a member who passes every check above but whose address
// is on no roster row at all (not even an inactive one) is added as an
// employee with no manager, unless the admin turned slack_auto_enroll off.
// Their requests go to the admins until someone sets their manager. The
// company domain rule (ALLOWED_EMAIL_DOMAIN) still applies.

import { normalizeEmail } from "../auth/mail.mjs";
import { domainAllowed, newId } from "../auth/sessions.mjs";
import { nowIso } from "../db.mjs";
import * as store from "../store.mjs";
import { ourWorkspace, slackCall, withinBudget } from "./api.mjs";

export const NOT_ON_ROSTER = "You're not on the Time Off roster yet. Ask an admin to add you.";
export const SLACK_SLOW = "Slack was slow to answer. Try again in a moment.";
export const LOOKUP_BUDGET_MS = 2000;

/**
 * What is left of the request's three seconds: the Slack route sets
 * ctx.deadline when the request arrives and each step gets the rest.
 * Without a deadline (a caller outside the route), `fallback`.
 */
export const remainingBudget = (ctx, fallback = LOOKUP_BUDGET_MS) => (ctx?.deadline ? Math.max(0, ctx.deadline - Date.now()) : fallback);
const pastDeadline = (ctx) => Boolean(ctx?.deadline) && Date.now() > ctx.deadline;
// Slack member ids are U/W plus capitals and digits; "_" is allowed so the
// practice stand-in can use readable ids like U_ADMIN.
export const SLACK_ID = /^[UW][A-Z0-9_]{2,20}$/;

/**
 * Tie a Slack member id to one person. Refused (false, with an audit row)
 * when either side is already tied to someone else.
 */
export function linkSlack(db, personId, slackUserId) {
  const person = store.personRow(db, personId);
  const holder = db.prepare("SELECT id FROM people WHERE slack_user_id = ?").get(slackUserId);
  if ((person?.slack_user_id && person.slack_user_id !== slackUserId) || (holder && holder.id !== personId)) {
    store.audit(db, { action: "slack.link_refused", subject: personId, detail: "A Slack member matched this person by email, but one of them is already linked elsewhere. Fix it on the People page." });
    return false;
  }
  if (person?.slack_user_id === slackUserId) return true;
  db.prepare("UPDATE people SET slack_user_id = ? WHERE id = ?").run(slackUserId, personId);
  store.audit(db, { action: "person.slack_linked", subject: personId, detail: "Linked to a Slack member." });
  return true;
}

/** The active person cached for this member id, or null (no call made). */
export function cachedPerson(db, slackUserId) {
  const row = db.prepare("SELECT * FROM people WHERE slack_user_id = ?").get(String(slackUserId ?? ""));
  return row && row.active === 1 ? row : null;
}

/** The roster address of a Slack member we may trust, or null. */
async function eligibleEmail(ctx, member) {
  const ours = await ourWorkspace(ctx);
  if (!ours?.team_id || member?.team_id !== ours.team_id) return null;
  if (member.deleted === true || member.is_bot === true || member.is_stranger === true || member.is_email_confirmed === false) return null;
  return normalizeEmail(member?.profile?.email);
}

/** The admin's self-enrollment switch (on unless turned off). */
export const autoEnrollSetting = (db) => store.getSetting(db, "slack_auto_enroll", true) !== false;

/** Why self-enrollment cannot work yet, or null: it needs the company email domain. */
export const autoEnrollBlockedReason = (env) => (String(env?.ALLOWED_EMAIL_DOMAIN ?? "").trim() ? null : "Set the company email domain on the Keys page first.");

/** Is self-enrollment from Slack on: switched on, and a company domain to hold it to. */
export const autoEnrollOn = (ctx) => autoEnrollSetting(ctx.db) && !autoEnrollBlockedReason(ctx.env);

/**
 * What the Manager pick in the Slack form does:
 *   "confirm_every" (the default)  every pick goes to the admins first, even
 *                                  an existing manager; nobody is promoted
 *                                  or added until one says yes
 *   "confirm_new"                  a manager or admin goes straight through;
 *                                  anyone else waits for an admin's yes
 *   "anyone"                       promote or add them at once
 *   "managers_only"                refuse anyone who is not a manager
 * Requests from the site (the roster approver select) are not affected.
 */
export const MANAGER_PICK_MODES = Object.freeze(["confirm_every", "confirm_new", "anyone", "managers_only"]);
export function managerPickMode(db) {
  const stored = store.getSetting(db, "slack_manager_pick", "confirm_every");
  // "confirm" was the earlier name of "confirm_new".
  const mode = stored === "confirm" ? "confirm_new" : stored;
  return MANAGER_PICK_MODES.includes(mode) ? mode : "confirm_every";
}

/** Does this pick wait for an admin's yes under the current mode? */
const needsConfirming = (db, person) => {
  const mode = managerPickMode(db);
  return mode === "confirm_every" || (mode === "confirm_new" && !decides(person));
};

const decides = (row) => row && row.active === 1 && (row.role === "manager" || row.role === "admin");

/** Add (or find, if a race added them first) a manager named in a confirmed pick. */
export function enrollManager(ctx, { slack_user_id, email, name }) {
  return enroll(ctx, slack_user_id, email, { real_name: name }, "manager");
}

/** The name Slack shows for a member: real name, display name, else the email's first part. */
export function slackName(member, email) {
  const pick = [member?.real_name, member?.profile?.real_name, member?.profile?.display_name].map((value) => String(value ?? "").replace(/[\p{Cc}]+/gu, " ").trim()).find(Boolean);
  return (pick || String(email).split("@")[0]).slice(0, 120);
}

// Add a member who is not on the roster: paid monthly, no manager and no
// team, linked to this member id. An employee when they enrolled
// themselves; a manager when a requester picked them as their manager.
// Returns { person, created }: two clicks racing to add the same member both
// get the one row (the second insert hits UNIQUE and reads the first's).
function enroll(ctx, id, email, member, role = "employee") {
  const personId = newId("per");
  const name = slackName(member, email);
  const timezone = String(ctx.env?.DEFAULT_TIMEZONE || "America/New_York");
  try {
    ctx.db.prepare(`INSERT INTO people (id, email, name, role, worker_type, manager_id, active, timezone, slack_user_id, pay_basis, hours_per_day, team, created_at, enrolled_via)
                    VALUES (?, ?, ?, ?, 'employee', NULL, 1, ?, ?, 'monthly', 8, NULL, ?, 'slack')`).run(personId, email, name, role, timezone, id, nowIso());
  } catch (error) {
    if (!/UNIQUE/i.test(String(error?.message))) throw error;
    const again = ctx.db.prepare("SELECT * FROM people WHERE email = ? OR slack_user_id = ?").get(email, id);
    return { person: again && again.active === 1 ? again : null, created: false };
  }
  store.applyClassPolicy(ctx.db, personId, { reason: "Added from Slack." });
  store.audit(ctx.db, { actorId: role === "employee" ? personId : null, action: "person.auto_enrolled", subject: personId, detail: role === "employee" ? `${name} added themselves from Slack.` : `${name} was added from Slack as someone's manager.` });
  return { person: store.personRow(ctx.db, personId), created: true };
}

// ---------------------------------------------------- the Manager picker --

/** The sentences for a Manager pick the form refuses (on the picker field). */
export const PICK_WORDS = Object.freeze({
  workspace: "Pick someone from your company's workspace.",
  self: "Pick someone other than yourself.",
  inactive: "That person is no longer on the roster. Pick someone else.",
  not_on_roster: "That person is not on the roster yet. Ask an admin to add them.",
  managers_only: "Pick one of your company's managers",
  slow: SLACK_SLOW,
});

/**
 * Who a requester picked as their manager in the form (a Slack member id).
 * The pick must be a full member of our workspace: not a guest
 * (is_restricted / is_ultra_restricted), stranger, bot or deleted, a
 * confirmed email, and inside ALLOWED_EMAIL_DOMAIN when that is set. A
 * roster person by that email is used (and linked); someone on no roster
 * row is enrolled as a manager (unless self-enrollment is off). Returns
 * { person, enrolled } or { error: one of PICK_WORDS' keys }.
 */
export async function resolveManagerPick(ctx, slackUserId, requester) {
  const id = String(slackUserId ?? "");
  if (!SLACK_ID.test(id)) return { error: "workspace" };
  if (id === requester.slack_user_id) return { error: "self" };
  // Someone already linked and active needs no call to Slack.
  const linked = cachedPerson(ctx.db, id);
  if (linked) {
    if (linked.id === requester.id) return { error: "self" };
    if (!decides(linked) && managerPickMode(ctx.db) === "managers_only") return { error: "managers_only" };
    if (needsConfirming(ctx.db, linked)) return { pending: { slack_user_id: id, email: linked.email, name: linked.name, person_id: linked.id } };
    return { person: linked, enrolled: false };
  }
  let info;
  try {
    info = await slackCall(ctx, "users.info", { user: id });
  } catch {
    return { error: "workspace" };
  }
  const member = info?.user;
  const email = await eligibleEmail(ctx, member);
  if (!email || member.is_restricted === true || member.is_ultra_restricted === true || !domainAllowed(email, ctx.env)) return { error: "workspace" };
  const known = ctx.db.prepare("SELECT * FROM people WHERE email = ?").get(email) || ctx.db.prepare("SELECT * FROM people WHERE slack_user_id = ?").get(id);
  // With "managers_only" set, only an active manager or admin may be picked:
  // nobody is promoted or added from the form.
  if (managerPickMode(ctx.db) === "managers_only" && known?.id !== requester.id && !(known && known.active === 1 && (known.role === "manager" || known.role === "admin"))) return { error: "managers_only" };
  if (known) {
    if (known.id === requester.id) return { error: "self" };
    if (known.active !== 1) return { error: "inactive" };
    // Waits for an admin's yes ("confirm_every", or "confirm_new" for a non-manager).
    if (needsConfirming(ctx.db, known)) return { pending: { slack_user_id: id, email: known.email, name: known.name, person_id: known.id } };
    // Linked when it can be; a link that would move someone else's is left alone.
    linkSlack(ctx.db, known.id, id);
    return { person: store.personRow(ctx.db, known.id), enrolled: false };
  }
  // Either confirm mode: someone not on the roster is only named; an admin adds them.
  if (managerPickMode(ctx.db).startsWith("confirm")) return { pending: { slack_user_id: id, email, name: slackName(member, email), person_id: null } };
  if (!autoEnrollOn(ctx)) return { error: "not_on_roster" };
  // Nothing is created once the request's budget is spent.
  if (pastDeadline(ctx)) return { error: "slow" };
  const added = enroll(ctx, id, email, member, "manager");
  return added.person ? { person: added.person, enrolled: added.created } : { error: "not_on_roster" };
}

async function lookUp(ctx, id, onEnrolled) {
  let info;
  try {
    info = await slackCall(ctx, "users.info", { user: id });
  } catch {
    return { person: null, reason: "not_on_roster" };
  }
  const email = await eligibleEmail(ctx, info?.user);
  if (!email) return { person: null, reason: "not_on_roster" };
  const known = ctx.db.prepare("SELECT * FROM people WHERE email = ?").get(email);
  if (!known) {
    // Guests can be linked to a row an admin made, but never add themselves.
    if (info.user?.is_restricted === true || info.user?.is_ultra_restricted === true) return { person: null, reason: "not_on_roster" };
    if (!autoEnrollOn(ctx) || !domainAllowed(email, ctx.env)) return { person: null, reason: "not_on_roster" };
    if (ctx.db.prepare("SELECT 1 FROM people WHERE slack_user_id = ?").get(id)) return { person: null, reason: "not_on_roster" };
    // Nothing is created once the request's budget is spent.
    if (pastDeadline(ctx)) return { person: null, reason: "slow" };
    const added = enroll(ctx, id, email, info.user);
    if (!added.person) return { person: null, reason: "not_on_roster" };
    if (added.created && onEnrolled) setImmediate(() => onEnrolled(added.person));
    return { person: added.person, reason: null, enrolled: added.created };
  }
  if (known.active !== 1 || !linkSlack(ctx.db, known.id, id)) return { person: null, reason: "not_on_roster" };
  return { person: store.personRow(ctx.db, known.id), reason: null };
}

/**
 * The active person behind a Slack member id, within the budget:
 * { person } or { person: null, reason: "not_on_roster" | "slow" }.
 */
export async function resolveMember(ctx, slackUserId, { budgetMs = remainingBudget(ctx), onEnrolled = null } = {}) {
  const id = String(slackUserId ?? "");
  if (!SLACK_ID.test(id)) return { person: null, reason: "not_on_roster" };
  const known = ctx.db.prepare("SELECT * FROM people WHERE slack_user_id = ?").get(id);
  if (known) return known.active === 1 ? { person: known, reason: null } : { person: null, reason: "not_on_roster" };
  const result = await withinBudget(lookUp(ctx, id, onEnrolled), budgetMs);
  return result.timedOut ? { person: null, reason: "slow" } : result;
}

/** The sentence for a member who could not be resolved. */
export const unresolvedWords = (reason) => (reason === "slow" ? SLACK_SLOW : NOT_ON_ROSTER);

/** This person's Slack member id: stored, or looked up by email and stored; null when Slack does not know them. */
export async function slackIdFor(ctx, person) {
  if (person.slack_user_id) return person.slack_user_id;
  try {
    const found = await slackCall(ctx, "users.lookupByEmail", { email: person.email });
    const id = String(found?.user?.id ?? "");
    if (!SLACK_ID.test(id) || (await eligibleEmail(ctx, found.user)) !== normalizeEmail(person.email)) return null;
    return linkSlack(ctx.db, person.id, id) ? id : null;
  } catch {
    return null;
  }
}
