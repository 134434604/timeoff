// Someone who added themselves to the roster from Slack (identity.mjs):
// every admin hears about it, by Slack DM when the admin's Slack is linked
// and by email, so a manager and an allowance get set. The member's own
// request carries on meanwhile and goes to the admins.

import { notify } from "../mail.mjs";
import * as store from "../store.mjs";
import { resolveMember } from "./identity.mjs";
import { dm, esc } from "./messages.mjs";

/** Tell every active admin that `person` enrolled from Slack. Never throws. */
export async function welcomeAdmins(ctx, person) {
  const link = `${ctx.origin}/people`;
  const audit = (action, subject, detail) => store.audit(ctx.db, { action, subject, detail });
  const mailOptions = { env: ctx.env, origin: ctx.origin, outboxDir: ctx.outboxDir, dataDir: ctx.dataDir, fetchImpl: ctx.fetchImpl, audit };
  for (const admin of ctx.db.prepare("SELECT * FROM people WHERE role = 'admin' AND active = 1 AND sample = 0").all()) {
    try {
      if (admin.slack_user_id) await dm(ctx, admin, `${esc(person.name)} just asked for time off from Slack and was added to the roster. Set their manager and allowance on the People page: ${link}`);
      await notify("person_enrolled", { to: admin.email, data: { name: person.name } }, mailOptions);
    } catch (error) {
      audit("followup.failed", person.id, `Telling an admin about a new person did not finish (${error?.code || error?.name || "error"}).`);
    }
  }
}

/** resolveMember, with the admins told about anyone it enrolls. */
export function resolveAndWelcome(ctx, slackUserId) {
  return resolveMember(ctx, slackUserId, { onEnrolled: (person) => { welcomeAdmins(ctx, person).catch(() => {}); } });
}
