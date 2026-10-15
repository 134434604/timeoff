# Time Off — API contract

JSON over `/api/*`. Cookie session (`timeoff_session`, httpOnly, SameSite=Lax).
Mutations are `POST`/`PUT`/`PATCH` with `Content-Type: application/json` (the
CSRF guard: a cross-site form cannot send that content type without a
preflight). The exception is `/api/slack/*`, which Slack posts form-encoded
and which is guarded by Slack's signature instead (see "Slack" below).
Every error is `{ "error": { "code": "...", "message": "..." } }`
with a plain-English message safe to show on screen. Dates are `YYYY-MM-DD`
strings (no time zone); timestamps are ISO 8601 UTC.

Roles: `employee` < `manager` < `admin`. A manager can do everything an
employee can plus act on direct reports. An admin can do everything, sees
every pending request, and manages people, policies, holidays, and settings.

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src
'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors
'none'`, and `Strict-Transport-Security: max-age=31536000` when `PUBLIC_ORIGIN` is
https. The client must load nothing from other origins and use no inline scripts.

## Shared shapes

```ts
type Role = "employee" | "manager" | "admin";
type WorkerType = "employee" | "contractor";
type Kind = "pto" | "sick" | "unpaid" | "loa" | "unavailable";   // unavailable: old requests only
// The field is called "Type" wherever a person sees it. Labels (server/domain/kinds.mjs),
// used in Slack, emails, calendar titles ("Name — LOA") and reports:
//   pto "SMTO" (time-off balance), sick "Sick" (sick balance), unpaid "Unpaid Time",
//   loa "LOA" (leave of absence), unavailable "Unavailable".
// Unpaid Time, LOA and Unavailable need approval and touch no balance.
// Types offered per class (kindsFor; GET /api/me `kinds`, the Slack form):
//   employee and contractor_monthly: pto, sick, unpaid, loa
//   contractor_hourly:               pto, unpaid, loa   (no Sick)
// Unavailable is no longer offered or accepted for new requests; existing
// Unavailable requests still display with that label.
type Status = "pending" | "approved" | "denied" | "cancelled";

type PayBasis = "hourly" | "monthly";

// A person's class, from worker_type and pay_basis. It sets the default
// policy and the Types offered.
type PersonClass = "employee" | "contractor_monthly" | "contractor_hourly";
//   employee            worker_type "employee", any pay basis
//   contractor_monthly  worker_type "contractor", pay_basis "monthly"
//   contractor_hourly   worker_type "contractor", pay_basis "hourly"
// Class default policies (front-loaded, nothing carried over):
//   employee            SMTO unlimited, sick unlimited, holidays_apply true
//   contractor_monthly  SMTO 10 a year, sick 5 a year, holidays_apply false
//   contractor_hourly   SMTO 15 a year, sick 0 (no Sick Type), holidays_apply false
// A person gets their class default when they are created (by an admin, as
// the first admin, or from Slack) and again whenever their class changes
// (PATCH worker_type / pay_basis), unless the PATCH says keep_policy: true.
// Audit "policy.class_default" (or "policy.kept"). Policies that existed
// before classes came in were not changed: their numbers stay, limited, with
// holidays_apply true; only new people (or a class change) get the defaults.

interface Person {
  id: string; email: string; name: string; role: Role; worker_type: WorkerType;
  manager: { id: string; name: string } | null; active: boolean;
  timezone: string; slack_user_id: string | null;
  pay_basis: PayBasis;            // default "monthly"; hours are reported for "hourly"
  hours_per_day: number;          // default 8 (0.5 to 24)
  team: string | null;            // free text set by an admin
  enrolled_via: "admin" | "bootstrap" | "slack";  // added by an admin, the first admin, or themselves from Slack
  needs_setup: boolean;           // not an admin and no manager yet (typically enrolled from Slack)
  sample: boolean;                // added by scripts/seed-sample.mjs for a demo
  class: PersonClass;             // from worker_type and pay_basis (above)
}

interface Policy {
  annual_days: number;            // time off a year; 0 = no time-off allowance tracked
  accrual: "front_loaded" | "monthly";
  carryover_cap: number;          // time-off days allowed to roll into the next year
  start_date: string;             // employment start, accrual begins here
  sick_days: number;              // sick days a year, all on Jan 1 (prorated in the start
                                  // year like time off), never carried over; 0 = not tracked
  pto_unlimited: boolean;         // no SMTO limit: annual_days/accrual/carryover are ignored
  sick_unlimited: boolean;        // no sick limit: sick_days is ignored
  holidays_apply: boolean;        // true: company holidays are left out of this person's day
}                                 // counts; false: a holiday inside a request counts as a
                                  // working day (weekends are always left out)

interface Balance {               // one balance: time off or sick time
  unit: "days"; year: number;
  allowance: number | null;       // the year's allowance (prorated in the start year); null when unlimited
  accrued: number | null;         // accrued to today under the accrual rule; null when unlimited
  carried_over: number;           // always 0 for sick time, and when unlimited
  adjustments: number;            // sum of admin adjustments of this kind this year
  used: number;                   // approved days of this kind this year (real when unlimited too)
  pending: number;                // pending days of this kind this year (held; real when unlimited too)
  available: number | null;       // accrued + carried_over + adjustments - used - pending; null when unlimited
  tracked: boolean;               // false when the allowance is 0 or there is no policy (then
                                  // allowance/accrued/carried_over/adjustments/available are 0
                                  // and only used/pending are informative); true when unlimited
  unlimited: boolean;             // the policy's pto_unlimited / sick_unlimited
}

interface Balances { pto: Balance; sick: Balance }
// Every "balance" in this API is Balances: pto draws on pto, sick on sick,
// unpaid, LOA and unavailable on neither.
interface BalanceAfter { pto: number | null; sick: number | null }
// The one the request's kind draws on is a number (null when that balance is
// not tracked or is unlimited); the other is null. Both null for unpaid, LOA and unavailable.

interface UsedSpan { request_id: string; start_date: string; end_date: string; days: number }
// An approved request's days in this year (only this year's share of one that crosses New Year).

interface Request {
  id: string; person_id: string; kind: Kind; status: Status;
  start_date: string; end_date: string;
  half_day_start: boolean; half_day_end: boolean;
  days: number;                   // the days that apply: the typed number when there is one, else days_computed
  days_computed: number;          // working days by the calendar: weekends and holidays out, halves honored
  days_overridden: boolean;       // true when the requester typed days_requested; show "3 days (counted 4)" when it differs
  hours: number | null;           // days x the person's hours_per_day when it was asked for
  approver: { id: string; name: string } | null;  // who was asked to decide (null: the admins)
  pending_manager: { slack_user_id: string; email: string; name: string; person_id: string | null; rejected?: true } | null;
                                  // a Manager pick waiting for an admin to confirm it (see "Slack");
                                  // the client shows "Yes, <name> is a manager" / "No" while it is set and not rejected
  note: string;
  decided_by: { id: string; name: string } | null; decided_at: string | null; decision_note: string;
  calendar: { state: "none" | "added" | "pending" | "failed" | "removed"; event_id: string | null; error: string | null };
  created_at: string; updated_at: string;
}
// calendar.state: "none" = no event (not approved, or no calendar connected and
// chosen at approval time; nothing back-fills later); "added"; "pending" = a
// write is owed: set in the same commit as the approval, so a restart before
// the write lands leaves it for retry; it stays "pending" with `error` (a plain
// sentence) when an add, or a remove after a cancel, fails; "removed" = the
// event was taken off after a cancel. The server does not produce "failed" yet;
// it is reserved. Each request's event has a fixed id ("timeoff" + the hex of
// the request id), so a repeated write never makes a second event.

interface Overlap { person_id: string; name: string; start_date: string; end_date: string; kind: Kind | "out"; status: Status }
// kind is "out" when the viewer is an employee (team_out, preview overlaps): an
// employee sees that a teammate is out, not why. Managers and admins get the real kind.
interface Holiday { date: string; name: string }
```

## Session

- `GET /api/me` →
  `{ signedIn: true, person: Person, kinds: Kind[], app: { name: "Time Off" }, slack_available: boolean, needs_setup: boolean }` or
  `{ signedIn: false, google: { on: boolean, fixture: boolean }, kinds: [], slack_available: boolean, needs_setup: boolean, notOnRoster?: { email: string } }`.
  `kinds` is the plain list of Types this person may ask for, in order (see
  "Types offered per class"); the form shows exactly these.
  `slack_available` is true when Slack is on (a real token and signing secret, or
  the practice stand-in), so any page can point people to `/timeoff` in Slack.
  `needs_setup` is true while no Google client is configured (not on the setup
  page and not in the env) and the practice sign-in is off: the page sends the
  visitor to `/setup`. The sign-in error `google_off` says the same in words.

## Setup (keys typed in a browser, `server/keys.mjs`)

The Google client, the Slack keys, the company domain, the From address and the first admin's address can be entered on the `/setup` page (or
Settings → Keys) instead of the host's `.env.local`. They are stored in
`data/keys.json` (mode 600) and a value there wins over the env; a name with
no saved value still comes from the env. They take effect without a restart.

Access: the one-time setup token (`data/setup-token`, made at startup while no
Google client is configured; the server logs where it is) or a signed-in admin.
Anyone else gets a 404 as if the route did not exist. Send the token in the
`X-Setup-Token` header (the `token` query or body field still works). It is
accepted only while no Google client is configured: it is deleted the first
time a Google client id is saved with it, and at startup whenever a Google
client exists (env or keys); after that only admins.

- `GET /api/setup/status?token=…` →
  `{ ok: true, has_google: boolean, google_client_id_last4: string | null, has_slack: boolean,
     has_admin_email: boolean, has_allowed_domain: boolean, has_mail_from: boolean, public_origin: string | null }`.
  Only booleans and the client id's last four characters; never a key.
  `has_slack` is false for the practice stand-in; `has_admin_email` is true when
  the first admin's address is set (setup page or `BOOTSTRAP_ADMIN_EMAIL`) or an admin exists.
- `PUT /api/setup/keys` `{ token?, google_client_id?, google_client_secret?, slack_bot_token?, slack_signing_secret?, allowed_email_domain?, mail_from?, bootstrap_admin_email?, job_token? }` →
  `{ saved: string[]; slack: { checked: boolean; ok: boolean | null; team_name: string | null; message?: string };
     google: { ok: boolean } }`.
  Saves the names present (an empty string clears one). Each value is one line;
  a client id must look like `….apps.googleusercontent.com` (400
  `invalid_google_client_id`), a domain like `example.com`, `bootstrap_admin_email` an email address (it makes the first admin only while the roster is empty; changing it later makes nobody an admin), a From like
  `Time Off <timeoff@example.com>`. A new Slack token is tried with `auth.test`
  (changes nothing): `ok` with the workspace name, or "The Slack token was not
  accepted." `google.ok` is the client id's shape. Audit `keys.updated` names the
  keys saved, never their values.
  `notOnRoster` is set when Google identified the person but no active roster
  row matches their email; the client shows "Ask your admin to add you."
- `GET /api/auth/google/start?return_to=/path` → 302 to Google (or the fixture consent page).
- `GET /api/auth/google/callback` → sets the cookie, 302 to `return_to`.
  When Google identified someone who is not an active roster person (or whose
  address is outside `ALLOWED_EMAIL_DOMAIN`): no session, 302 to
  `/?not_on_roster=1` (no address in the URL), and `/api/me` reports
  `notOnRoster: { email }` for ten minutes from an httpOnly cookie; the client
  reads the address from there. Any other failure: 302 to `/?signin_error=<code>` (`signin_failed`,
  `signin_expired`, `signin_busy`, `invalid_email`, `account_mismatch` when the
  roster address is already linked to a different Google account, `google_off`;
  anything unexpected is logged and reported as `signin_failed`).
  With `ALLOWED_EMAIL_DOMAIN` set, the Google account must also belong to that
  Workspace (the id token's `hd` claim); a consumer account with an address in
  the domain is refused as not on the roster.
  While `people` is empty, the first sign-in by `BOOTSTRAP_ADMIN_EMAIL` creates
  that admin (name from Google; scope is `openid email profile`).
- `GET /api/auth/google/fixture` (fixture only) → an HTML consent page with an
  `email` field so QA can sign in as any roster address; submitting it
  completes the sign-in like Google would.
- `POST /api/auth/signout` → `{ ok: true }`, cookie cleared.
- `GET /healthz` → `{ ok: true }` (no auth; also reports nothing else).

## Everyone (signed in)

- `GET /api/home` →
  ```ts
  { person: Person; balance: Balances; requests: Request[];     // mine, newest first, all statuses
    used_days: { pto: UsedSpan[]; sick: UsedSpan[] };            // my approved requests' days this year, per balance
    holidays: Holiday[];                                         // this year and next
    team_out: Overlap[];                                         // approved, today..+60 days, my team (same manager) and my reports
    team: HomeTeam | null }                                      // managers and admins; null for employees

  interface HomeTeam {
    scope: "reports" | "everyone";   // a manager: their reports (and requests naming them); an admin: everyone
    out_today: number;               // people in scope out today (approved, counted days)
    out_next_30: number;             // people in scope out at some point today..+30 days
    pending: number;                 // pending requests of people in scope
    unused_pto_total: number;        // sum of positive SMTO available in scope (unlimited people add 0)
    month: { month: string; entries: Overlap[]; holidays: Holiday[]; people: Array<{ id, name, class: PersonClass }> };
                                     // exactly GET /api/team/calendar for the current month
    out_soon: Overlap[];             // approved, today..+60 days, people in scope
  }
  ```
  `used_days` lets Home show which days an unlimited allowance went to (it is
  there for limited balances too). The numbers in `team` are the Insights
  numbers for this year, scoped the same way (see "Reports and insights").
- `POST /api/requests/preview` `{ start_date, end_date, half_day_start?, half_day_end?, kind?, days_requested? }` →
  `{ days: number; days_computed: number; days_overridden: boolean; balance_after: BalanceAfter; overlaps: Overlap[]; warnings: string[] }`
  `days_requested` (optional, label it "How many working days?"): half-day
  steps, from 0.5 to the calendar days in the span (400
  `invalid_days_requested` otherwise). When given it replaces the count for the
  balance, hours and reports (spread over the same working days in proportion,
  or evenly over the span when the calendar counts none).
  (warnings are plain sentences like "This takes you 1.5 days below your
  balance." or, for sick time, "... below your sick days.").
  `kind` defaults to `pto`. `balance_after` is measured in the request's first
  year as of its first day (so monthly accrual counts up to then, and a request
  for next year is measured against next year), minus that year's share of
  the request. Days are counted with weekends out always and company
  holidays out only when the person's policy has `holidays_apply` (a
  contractor's holiday counts as a working day, and no holiday warning is
  given for it); submit, holiday recounts and reports count the same way.
  Preview skips the submit-only refusals (too far back, no
  working days, overlaps my own) and says them as warnings instead. A start
  more than 730 days ahead is refused in preview and submit alike (`too_far_ahead`).
- `GET /api/approvers` → `{ approvers: Array<{ id, name, team }>, default_id: string | null }`:
  everyone who may approve my request (active managers and admins, not me),
  by name; `default_id` is my manager (when active and a manager or admin).
  The web form labels this picker "Manager".
- `POST /api/requests` `{ start_date, end_date, half_day_start?, half_day_end?, kind, note?, approver_id?, days_requested? }` →
  `{ request: Request, balance: Balances }`. `approver_id` must be one of
  `/api/approvers` (400 `invalid_approver`); left out, it is my manager, or
  null (every admin) when I have none. `hours` is stored as days x my
  hours_per_day. Validation: end ≥ start, within the
  past 30 days or up to 730 days ahead, no overlap with my own pending/approved request,
  `kind` one of my `kinds` (400 `kind_not_offered`, "That Type isn't offered to
  you. Choose SMTO, Unpaid Time, LOA."; Unavailable is refused for everyone), `days > 0`, and at most a year from
  start to end. Sends the manager the "new request" email when mail is on
  (every active admin when the person has no active manager).
- `POST /api/requests/:id/cancel` → `{ request, balance }`. Allowed for the
  requester on `pending` any time and on `approved` before `start_date`; for a
  manager/admin of that person (or its approver) on `approved` any time. Removes the calendar
  event when one was added. A manager/admin cancelling someone else's
  `pending` request is refused (`deny_instead`): deny it. `balance` is the
  requester's. "Before `start_date`" is read in the requester's time zone.

## Managers and admins

- `GET /api/approvals` →
  ```ts
  { pending: Array<{ request: Request; person: Person; balance: Balances; balance_after: BalanceAfter; overlaps: Overlap[];
                     used_this_year: number | null;   // the kind's balance is unlimited: its used days this year
                                                      // (balance_after is then null); null otherwise
                     last_reminded_at: string | null }>;
    recent: Array<{ request: Request; person: Person }> }        // decided in the last 30 days, newest first
  ```
  Managers see requests that name them as approver and their direct reports'
  requests; admins see everyone's except their own (nobody decides their own). `balance` is the person's current year; `balance_after`
  is measured as in preview, with this request already held.
- `POST /api/requests/:id/approve` `{ note? }` → `{ request }`. Only on `pending`,
  only by the request's approver or the person's manager (either while their
  role is still `manager`) or an admin, never on your own request (except: the
  only active admin may decide their own, audit `request.self_decided`; their own
  pending requests then show in their Approvals and their request email comes to
  them); any other
  manager gets 403 `not_your_report`. Adds the calendar event (or queues it with
  `calendar.state = "pending"` and the error when the write fails) and emails
  the requester. If the request is cancelled while its event is being
  written, the event is taken off again.
- `POST /api/requests/:id/deny` `{ note? }` → `{ request }`. Same rules; emails the requester.
- `POST /api/requests/:id/remind` → `{ request, last_reminded_at }`. An admin or the request's approver
  (403 `not_allowed` for anyone else), on a pending request (409 `not_pending`), at most once every 10
  minutes per request (409 `too_soon`). Sends the approval email again with fresh Approve/Deny links (the
  Manager question instead while a pick waits on the admins) and posts the Slack message again when the
  last one is more than 10 minutes old (a decision closes old and new). Audit `request.reminded`.
- `POST /api/requests/:id/confirm-manager` and `/reject-manager` (admins; 403 `not_admin` otherwise) → `{ request }`.
  Answer a Manager pick waiting on the admins (`request.pending_manager`); 409 `no_pending_manager` when
  there is none (or it was already turned down). What each does is under "Slack".
- `GET /api/team/calendar?month=YYYY-MM` →
  `{ month: string; entries: Overlap[]; holidays: Holiday[]; people: Array<{ id: string; name: string; class: PersonClass }> }`
  (approved and pending in that month; managers get their scope, see
  "Reports and insights"; admins get everyone).

## Admins

- `GET /api/people` → `{ people: Array<Person & { policy: Policy | null; balance: Balances }>; teams: string[] }`
  (inactive included, flagged; `teams` is every team named on anyone, sorted).
- `POST /api/people` `{ email, name, role, worker_type, manager_id?, timezone?, pay_basis?, hours_per_day?, team? }` → `{ person }`.
  Email must be unique; `ALLOWED_EMAIL_DOMAIN` enforced when set.
- `PATCH /api/people/:id` any of `{ name, role, worker_type, manager_id, timezone, slack_user_id, active, pay_basis, hours_per_day, team, keep_policy }` → `{ person }`.
  `team` "" or null clears it. When the change moves the person to another
  class (`worker_type`, or a contractor's `pay_basis`), their policy is reset
  to that class's default and their open and approved requests are recounted
  (holidays may now count), unless `keep_policy: true`. A pay basis change
  inside the employee class keeps the policy.
  A person cannot be their own manager; demoting the last admin is refused.
  A manager must be an active person with the manager or admin role, and no
  loop of managers is allowed. Deactivating someone ends their sessions at
  once; deactivating the last admin is refused like demoting. Making a
  manager or admin an employee while they still have active reports is
  refused (409 `has_reports`, the message names how many). `slack_user_id` is
  normally filled in by itself the first time someone uses Slack; a member id
  already linked to someone else is refused (409 `slack_user_taken`).
- `PUT /api/people/:id/policy` `Policy` → `{ person, balance: Balances }`. `start_date` must be in 2000–2100;
  `sick_days` may be left out (0). The PUT replaces the whole policy: the
  three switches left out mean `pto_unlimited: false`, `sick_unlimited: false`,
  `holidays_apply: true`; anything but a boolean is 400 `invalid_policy_flag`.
  Changing `holidays_apply` recounts the person's open and approved requests.
- `POST /api/people` gives the new person their class default policy (no
  policy needs to be PUT afterwards).
- `POST /api/people/:id/adjustments` `{ days: number, note: string, kind?: "pto" | "sick" }` → `{ balance: Balances }`
  (positive or negative, note required, `kind` defaults to `pto`). The adjustment counts in the person's current year.
- `GET /api/holidays?year=YYYY` → `{ holidays: Holiday[] }`; `PUT /api/holidays` `{ year, holidays: Holiday[] }` replaces that year
  and recounts `days` (and `hours`) on every pending and approved request touching that year.
- `GET /api/settings` →
  ```ts
  { calendar: { connected: boolean; account_email: string | null; calendar_id: string | null; calendar_name: string | null;
                last_error: string | null; pending_writes: number; fixture: boolean;
                titles: "type" | "out" };       // calendar event titles, see PUT /api/settings/calendar
    mail: { on: boolean; transport: "gmail" | "smtp" | "fixture" | "off"; from: string | null;
            account_email: string | null; needs_reconnect: boolean };
    slack: { on: boolean; fixture: boolean; team_name: string | null; linked_people: number;
             auto_enroll: boolean;                       // the admin's switch
             auto_enroll_blocked_reason: string | null;  // "Set the company email domain on the Keys page first." while none is set
             manager_pick: "confirm_every" | "confirm_new" | "anyone" | "managers_only" };   // default "confirm_every"
    google_signin: { on: boolean; fixture: boolean };
    sample_people: number }       // people from the demo sample set (scripts/seed-sample.mjs); show a banner while > 0
  ```
  `slack.on` = `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` set, or the practice
  stand-in. `team_name` is the workspace's name from Slack, asked at most once an
  hour (null when Slack is off or did not answer). `linked_people` counts active
  people whose Slack member id is known. `auto_enroll` (default true): see "Slack".
- `PUT /api/settings/slack` `{ auto_enroll?: boolean, manager_pick?: "confirm_every" | "confirm_new" | "anyone" | "managers_only" }` → `{ settings }` (admin).
  `mail.transport` is the first of: `fixture` (`MAIL_FIXTURE`, the practice
  outbox), `gmail` (the Google grant includes `gmail.send`), `smtp` (every
  `SMTP_*` and `MAIL_FROM` set), `off`. `from` is `MAIL_FROM`, or "Time Off" at
  the connected account for Gmail. `account_email` is the connected Google
  account. `needs_reconnect` is true for a grant made before email was added
  (no `gmail.send`): the calendar keeps working, mail falls through to SMTP
  or off, and Settings says "Reconnect to enable email".
- `GET /api/settings/calendar/connect` → 302 to Google consent for the admin's
  grant, calendar and email together (scopes `calendar.events` +
  `calendar.calendarlist.readonly` + `gmail.send`), admin only. The scopes
  Google granted are stored with the token.
  In fixture mode it goes straight to the callback and connects as
  `calendar-fixture@example.com`.
- `GET /api/settings/calendar/callback` → stores the refresh token under `data/`, 302 to `/settings`.
  Any failure: 302 to `/settings?calendar_error=<code>` (`calendar_off` when the
  Google keys are not set, `calendar_state_invalid`, `calendar_grant_failed`,
  `calendar_no_refresh`, `not_signed_in`, `forbidden`; anything unexpected is
  `calendar_failed`). The grant must be finished by the admin who started it.
- `GET /api/settings/calendars` → `{ calendars: Array<{ id: string; name: string; writable: boolean }> }`.
  Both 409 `calendar_not_connected` before a connection.
- `PUT /api/settings/calendar` `{ calendar_id?, titles?: "type" | "out" }` → `{ settings }`. The id must be in the list
  and writable. `titles` (default `out`): with `out`, events read "Name — SMTO", contractors "Name —
  Unavailable", and Sick, Unpaid Time and LOA all "Name — Out"; with `type`, every event names its Type.
  Applies to new events; ones already on the calendar keep their titles.
- `POST /api/settings/calendar/disconnect` → `{ settings }` (revokes the token).
- `POST /api/settings/calendar/retry` → `{ retried: number; failed: number }` re-runs pending calendar writes.
  With no calendar connected and chosen, the rows stay `pending` and count as failed.
- `GET /api/audit?limit=100` → `{ events: Array<{ at: string; actor: { id, name } | null; action: string; subject: string; detail: string }> }`.

## Approve and Deny (and the Manager question) from the email (no sign-in)

The request email to the approver carries two links,
`{PUBLIC_ORIGIN}/approve/{token}` and `{PUBLIC_ORIGIN}/deny/{token}` (client
routes). The `manager_confirm` email to an admin also carries
`{PUBLIC_ORIGIN}/confirm-manager/{token}` and
`{PUBLIC_ORIGIN}/reject-manager/{token}` (client routes; issued only to
admins, and only while the request has a Manager pick waiting). The token is
a random id (32 bytes, base64url: 43 characters, short enough that no mail
client wraps it). What it means is kept in the `decide_links` table under
the id's SHA-256 hash: the request, the action, the person it was sent to,
an expiry 14 days out, when it was used, and its pair: Approve/Deny from one
email, or Yes/No from one email, are spent together. Links of the earlier
long signed format are simply `invalid`. Both routes are rate-limited per
address (30 per 10 minutes, then 429 `too_many`).

- `GET /api/decide/:token` →
  `{ request: { id, person_name, kind, start_date, end_date, days, note, status } | null;
     action: "approve" | "deny" | "confirm_manager" | "reject_manager" | null; approver_name: string | null;
     manager_name: string | null;     // the Manager pick's name, when the request has one
     state: "pending" | "already_decided" | "expired" | "invalid" }`, always 200.
  For `confirm_manager` / `reject_manager` the state is `already_decided` once
  the pick was answered (by link, Slack or the site) or the request decided.
  Never changes anything (mail scanners open links on their own). `request` is
  null only for `invalid`.
- `POST /api/decide/:token` `{ note? }` → `{ ok: true, action, request: (same subset, status after) }`.
  Decides as the approver the token names, by the same rules as the site
  (403 `not_your_report` if they no longer may); a Yes / No link answers the
  Manager question as that admin, exactly as `POST /api/requests/:id/confirm-manager`
  / `reject-manager` would. Once only: the token is
  spent in the same transaction as the decision (`INSERT OR IGNORE`; two posts
  at once decide once, the other gets 409 `already_decided`). Refusals: 409
  `already_decided` or `expired`, 404 `invalid`. A refused try does not spend it.

## Reports and insights

People in scope: an admin sees everyone; a manager sees themselves, their
direct reports, and anyone who named them as approver on a request. The
free-text `team` is only a label for grouping, never a reason to see someone. Only approved time
counts, split by date (a request across a month end counts in both months,
half days as 0.5). `hours` is days away x hours_per_day for hourly people,
null for monthly people (team and company totals sum the hourly ones).

```ts
interface KindDays { pto: number; sick: number; unpaid: number; loa: number; unavailable: number }
interface MonthlyReport {
  year: number; month: string;                 // "YYYY-MM"
  from: string; to: string;
  teams: Array<{ team: string | null;          // null = no team, listed last
                 people: Array<KindDays & { id: string; name: string; class: PersonClass; pay_basis: PayBasis; hours: number | null }>;
                 totals: KindDays & { hours: number } }>;
  totals: KindDays & { hours: number };
}
```
Every active person in scope is listed, with zeros when they were not out;
an inactive person only when they were out that month.

- `GET /api/reports/monthly?year=YYYY&month=M` (managers and admins; default:
  last month) → `MonthlyReport` for the viewer's scope.
- `POST /api/jobs/monthly-report` with `Authorization: Bearer <JOB_TOKEN>`, body
  `{ year?, month? }` (default: last month in `DEFAULT_TIMEZONE`, America/New_York
  unless set) → `{ sent: true, month, recipients }` or
  `{ sent: false, month, already: true }`, or `{ sent: false, month, recipients: 0, retry: true }`
  when nobody was reached (mail off or every send failed; the month is not
  claimed, so the next run tries again). Only sent or captured emails count as
  recipients; sample people get none. No session; a wrong or missing token
  is a 404. The token is `JOB_TOKEN` in the env or `job_token` in
  `data/keys.json` (made at startup when neither exists). Emails every active
  admin the whole company and every active manager their scope; once per
  month (claimed in a transaction). Also sent lazily: the first signed-in
  request after a month ends sends last month's report, unless the app was
  first used this month.
- `GET /api/insights?year=YYYY` (managers and admins) →
  ```ts
  { year: number;
    by_month: Array<KindDays & { month: string }>;              // 12 entries, "YYYY-MM"
    by_team: Array<KindDays & { team: string | null; people: number; hours: number }>;
    by_person: Array<KindDays & { id: string; name: string; class: PersonClass; team: string | null; hours: number | null;
                                  pto_available: number | null; sick_available: number | null }>;  // null = not tracked or unlimited
    by_kind: KindDays;
    out_today: number;        // active people in scope with an approved, counted day today (weekends and holidays are not out)
    out_next_30: number;      // ... overlapping today through today + 30
    pending: number;          // pending requests in scope
    unused_pto_total: number } // sum of pto_available, each counted as at least 0
  ```
- `GET /api/insights/requests?year=YYYY[&month=YYYY-MM][&team=][&person_id=][&kind=][&class=][&status=]`
  or `GET /api/insights/requests?window=today|next_30|pending[&team=][&person_id=][&kind=][&class=]`
  (managers and admins; the Insights drill-downs) →
  ```ts
  { filters: { year: number | null; month: string | null; window: "today" | "next_30" | "pending" | null;
               from: string | null; to: string | null;      // the dates counted (null for window=pending)
               team: string | null; person_id: string | null;
               kind: Kind | null; class: PersonClass | null; status: "approved" | "pending" };
    total_days: number;          // the sum of days_in_window over every match (not only the listed ones)
    total_requests: number;      // how many requests matched
    total_people: number;        // how many different people they belong to
    truncated: boolean;          // true when more than 500 matched; only the first 500 are listed
    requests: Array<{ id: string; person: { id: string; name: string; class: PersonClass; team: string | null };
                      kind: Kind; status: Status; start_date: string; end_date: string;
                      days: number;              // the whole request's days (the typed number when there is one)
                      days_computed: number;     // what the dates count to
                      days_overridden: boolean;  // true when the requester typed the days
                      days_in_window: number;    // the part inside the window, month, or year
                      hours: number | null;      // the whole request's hours, as stored
                      approver: { id: string; name: string } | null; decided_at: string | null }> }
  ```
  `window` stands in for `year`/`month` and matches the Insights tiles exactly
  (today is the company's date, `DEFAULT_TIMEZONE`):
  `today` is approved time off of active people with a counted day today
  (`total_people` = `out_today`); `next_30` is the same for today through
  today + 30 (`total_people` = `out_next_30`); `pending` is every pending
  request in scope whatever its year (`total_requests` = `pending`), with
  `days_in_window` the request's whole days. A bad window is 400
  `invalid_window`; with a window, `month` and `status` are ignored.
  Without a window `year` is required (400 `invalid_year`); `month` must be in that year (400
  `invalid_month`); `kind` (400 `invalid_kind`), `class` (400 `invalid_class`)
  and `status` (`approved`, the default, or `pending`; 400 `invalid_status`)
  narrow it. `team` left out means any team, `team=` (empty) means people with
  no team. Scope is exactly `/api/insights`'s (a manager: themselves, their
  reports, and anyone whose request named them; an admin: everyone).
  `days_in_window` uses the same per-date weights as Insights (weekends out,
  holidays out unless the person works them, half days and typed days spread as
  charged), so a request across two months shows each month its own slice and,
  for approved requests, `total_days` equals the matching Insights figure (for
  a month, that month's `by_month` row summed over the kinds filtered).
  Requests with no days inside the window are left out. Newest start first.

## Email (from the admin's Google account; SMTP as a fallback; `data/outbox/` in fixture mode)

Every notice has a plain-text body; the ones below with buttons are sent as
`multipart/alternative` (text first, then an inline-styled HTML part, each
base64) through Gmail and SMTP alike. The HTML has a heading, the request,
and big buttons (at least 44 px tall, full width on a narrow screen) with
each link written out underneath; every typed text is HTML-escaped.
`request_submitted`: Approve (green) and Deny (grey) plus Open Approvals;
`manager_confirm`: in order "Yes, <Name> is their manager" (green), "No"
(grey), then "Approve anyway" and "Deny" (smaller, grey), and Open
Approvals, with the text part listing the same links; `request_approved`, `request_denied`,
`request_cancelled`, `manager_picked` and `person_enrolled`: one "Open Time
Off" button. `monthly_report` stays plain text. In fixture mode the outbox
file has `html` beside `text`.

Links are `PUBLIC_ORIGIN` + path:
`request_submitted` → the approver (the one chosen, else the manager, else every admin), with the
Approve and Deny links above and `/approvals`; `request_approved` → requester (`/`),
`request_denied` → requester (`/`), `request_cancelled` → the approver when an approved request is
cancelled (`/approvals`; not sent to whoever did the cancelling); `monthly_report` → admins and
managers (`/reports`, a client route), a plain-text table per team; `person_enrolled` and
`manager_picked` → admins (see "Slack"). Request emails name the Type ("Type: SMTO") and show
"Days: 3 days (counted 4)" when the requester typed the days. A send that fails is an audit row (`mail.failed`) and never fails the request.
Email goes out whether or not Slack is on. In fixture mode each outbox file
also records `transport` (and `would_use`: the way it would have gone).

## Slack (`server/slack/`, app manifest in `docs/slack-manifest.yml`)

Staff use Slack; the site is for admins. Both share one code path
(`server/actions.mjs`): the same rules, audit rows, calendar writes and
emails, whichever side a request is asked for or decided on.

- `POST /api/slack/commands` and `POST /api/slack/interactions`: form-encoded
  posts from Slack (interactions carry `payload=<JSON>`). The raw body is checked
  against Slack's v0 signature (`SLACK_SIGNING_SECRET`, timestamp within 5
  minutes) before anything is parsed: 401 `bad_signature` otherwise, 404
  `slack_off` when Slack is off. A signed payload whose `team_id` (or
  `api_app_id`, when present) is not ours, per `auth.test` (cached an hour;
  `SLACK_APP_ID` overrides the app id), gets 403 with an ephemeral
  `{ response_type, text }` only the clicker sees (audit `slack.refused`); 503
  with the same shape when Slack cannot say who we are in time. Answered
  within Slack's 3 seconds; calendar, email and Slack calls run after the
  answer, failures go to the audit table (`slack.failed`, `followup.failed`). An address that sends 20 badly signed
  posts in 10 minutes gets 429 `too_many` before its body is read; bad
  signatures write at most one `slack.bad_signature` audit row a minute.
- A Slack member is matched to the roster by `people.slack_user_id`, else by the
  email on their Slack profile against active people (then stored). The member
  must be in our workspace, not deleted, not a bot, not a stranger from a
  shared channel, with a confirmed email; guests can be linked to a row an
  admin made. An existing link is never moved to another member id (audit
  `slack.link_refused`).
- Self-enrollment (settings `slack.auto_enroll`, on by default, and only once
  `ALLOWED_EMAIL_DOMAIN` is set; until then `slack.auto_enroll_blocked_reason`
  says so): a member who passes those checks, is not a guest
  (`is_restricted` / `is_ultra_restricted`), whose address is on no roster row
  at all (not even an inactive one) and is inside that domain, is
  added on their first `/timeoff` or form: name from Slack (real name, else
  display name, else the email's first part), role employee, worker type
  employee, paid monthly, no manager, no team, `enrolled_via: "slack"`, linked
  to the member id. Audit `person.auto_enrolled` (name only). Every active
  admin gets a Slack DM (when their Slack is linked) and an email
  (`person_enrolled`): "<name> just asked for time off from Slack and was
  added to the roster. Set their manager and allowance on the People page:
  <origin>/people". The member carries on; their requests go to the admins
  until a manager is set.
- With auto-enroll off, and for anyone who fails the checks, the answer is only
  "You're not on the Time Off roster yet. Ask an admin to add you."
  The lookup has a 2-second budget; past it the answer is "Slack was slow to
  answer. Try again in a moment." and nothing is created.
- `/timeoff` (or `/timeoff request`) opens the "Request time off" form: the
  balance line ("12 days available, 2 waiting", plus " · 5 days of sick time
  available" when sick time is tracked; "Unlimited SMTO, 3 days used this year"
  and "unlimited sick time, 1 day used this year" when unlimited; or "No balance
  is tracked for you"), Type (block `kind`: the person's `kinds`, so SMTO, Sick,
  Unpaid Time, LOA; an hourly contractor gets no Sick; a refused Type comes back
  on this block), First day and Last day (datepickers starting at today in the
  requester's time zone, placeholders "First day" / "Last day"), "How many working days?" (block `days`,
  required number, placeholder "0.0", hint "Enter in 0.00 format, like 1.5 for
  a day and a half"; half-day steps from 0.5 to the calendar days in the span;
  missing: "Enter the number of working days, like 1.5"), Manager (block
  `manager`, required: Slack's people picker, the requester's manager
  preselected when their Slack is linked; missing: "Pick your manager"), note.
  There are no half-day boxes: half days are said in the typed days, and
  `half_day_start` / `half_day_end` are false for Slack requests. The typed
  days apply; `days_computed` keeps the calendar count for the "counted N"
  line. (On the site, `days_requested` stays optional in the API; the web form
  sends it.)
- The Manager pick: the picked member must be a full member of our workspace
  (our team, not a guest, stranger, bot or deleted, a confirmed email) and
  inside `ALLOWED_EMAIL_DOMAIN` when set, else the picker shows "Pick someone
  from your company's workspace."; picking yourself shows "Pick someone other
  than yourself." What happens next depends on `slack.manager_pick` (requests
  from the site, with the roster approver select, always go straight to the
  chosen manager):
  - `"confirm_every"` (the default): every pick waits for an admin, even one
    who is already a manager or admin; the rest is as for `"confirm_new"`
    below (on Yes an existing manager is simply made the approver).
  - `"confirm_new"` (the earlier `"confirm"`, still accepted as stored): a pick
    who is an active manager or admin goes straight to them. For anyone else
    nobody is promoted or added. The request is
    made with no approver and `pending_manager` set, and waits with the admins
    (not in the requester's own manager's queue). Every admin whose Slack is
    linked gets a DM "<Requester> named <Name> as their manager. Is that
    right?" with "Yes, <Name> is a manager" (`confirm_manager`), "No"
    (`reject_manager`), Approve and Deny; every admin gets the email
    `manager_confirm` (Approvals link plus Approve/Deny links). The requester
    hears it went to the admins.
    - Yes (an admin, checked on the server; Slack or `POST …/confirm-manager`):
      <Name> is promoted to manager, or added as a manager from Slack; becomes
      the requester's manager when they have none; becomes the approver;
      `pending_manager` clears; the admins' messages read "Confirmed by
      <Admin>: <Name> is a manager"; <Name> gets the DM with buttons and the
      approval email; the requester gets "Sent to <Name> for approval";
      audit `person.manager_confirmed`. A later pick of <Name> goes straight through.
    - No: the request stays with the admins (`pending_manager.rejected`), the
      admins' messages keep Approve/Deny with "not confirmed as manager", the
      requester hears "<Name> isn't set up as a manager; an admin will handle
      this one."; audit `person.manager_rejected`.
  - `"managers_only"`: only an active
  manager or admin may be picked ("Pick one of your company's managers");
  - `"anyone"`: a roster person with that email is used (an
  employee is promoted to manager, audit `person.promoted_by_request`) and
  someone on no roster row is added as a manager (same rules as
  self-enrollment; when it is off or blocked: "That person is not on the roster
  yet. Ask an admin to add them."). A pick that promotes or adds someone DMs
  every admin whose Slack is linked right away.
  In every mode, a pick that goes through (straight, or once confirmed)
  becomes the requester's manager when they have none, and the request's
  approver: they get the Slack DM with buttons and the approval email. When the
  pick is not the requester's current manager, every admin gets the email
  `manager_picked`: "<requester> picked <manager> as their manager; the
  request is waiting with them and in Approvals." The dates and Type are
  checked before the pick, so a refused form adds nobody. A refusal from the same rules as `POST /api/requests` comes back on its
  field and the form stays open. `/timeoff balance` and `/timeoff cancel`
  answer only to the asker; anything else shows how to use it.
- A new request (from Slack or the site) DMs the requester ("Sent to Morgan for
  approval …") and DMs the approver (the one chosen, else the manager, else
  every active admin) with Approve / Deny buttons; the message names the
  approver and shows the balance the kind draws on ("Balance after" or "Sick
  days after"). Deny opens a short form for an optional
  note. The click is checked by the same rule as the site; a refusal is shown
  only to the clicker and the message is left alone.
- Approving, denying or cancelling, from Slack or the site, rewrites those
  messages without buttons ("Approved by X · on the team calendar", "Denied by
  X: note", "Cancelled by X") and DMs the requester when someone else decided.
