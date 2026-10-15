# Time Off — setup and hosting

For whoever runs the app. The owner's guide is `HANDOFF.md`.

## What it needs

- Node 22.13 or newer (production runs Node 24). No database server: the
  app keeps everything in one SQLite file under `data/` through Node's
  built-in `node:sqlite`. No npm packages at runtime; the client is built
  once with Vite.
- A **Google Cloud OAuth client** (type "Web application") for "Sign in
  with Google" and the admin's Google connection, which covers both the
  shared calendar and the notification email: mail goes out from her own
  Workspace account (Gmail API, send only). Nothing else to set up for email.
- Optional: an SMTP mailbox, used for email only while Google is not
  connected (or was connected before email was added).
- Nothing from Slack unless the optional Slack approvals are turned on.

## Google Cloud, step by step

The owner's own copy of these steps, plus the Slack install, is
`OWNER-SETUP.md`: hand her that file.

Done once, by whoever owns the Google Cloud project. Two options:

**A. Inside the company's Google Workspace (recommended, ~10 minutes).**
Any Workspace user can usually do this; if "Create project" is greyed out,
a Workspace admin has to allow it or do it for you.
1. https://console.cloud.google.com → New project → name it "Time Off".
2. APIs & Services → Library → enable **Google Calendar API** and **Gmail API**.
3. APIs & Services → OAuth consent screen → User type **Internal** → app
   name "Time Off", support email, authorized domain = the company domain.
   Internal apps need no verification and only company accounts can sign in.
4. Credentials → Create credentials → OAuth client ID → Web application.
   Authorized redirect URIs (replace the origin with yours):
   - `https://timeoff.example.com/api/auth/google/callback`
   - `https://timeoff.example.com/api/settings/calendar/callback`
5. Copy the client ID and secret into the app's env (below).

**B. Under any Google account (the fallback used at first).** Same steps,
but User type **External**, leave it in "Testing", and add every staff
address under Test users (up to 100). Signing in shows a "Google hasn't
verified this app" screen once; that's expected for test users. Moving
from B to A later is only a change of the two env values.

## The setup page (keys typed in a browser)

The Google client (ID and secret), the Slack app's token and signing
secret, the company email domain, the From address and the first
admin's address can be typed into the app instead of the env file, so the
owner can do it herself:

1. Start the app with no Google client set. It writes a one-time setup
   token to `data/setup-token` and logs `Setup page: /setup (token in …)`.
2. Hand her the address `https://timeoff.<company domain>/setup` and the
   token (read it with `cat ~/timeoff/data/setup-token`). She pastes the
   keys there; Slack's token is tried on the spot and the page says
   whether Slack accepted it.
3. The first time a Google client ID is saved, the token is deleted. From
   then on keys change only from Settings → Keys, by a signed-in admin.

The keys are kept in `data/keys.json` (mode 600; it is part of `data/`, so
back it up and never commit or deploy it). They take effect at once, no
restart. A value saved there wins over the same name in `.env.local`.

## Environment

The server reads `.env.local` next to `package.json` (copy from
`.env.example`). Most hosts can also set them as environment variables. The env way stays valid for every key
the setup page offers (marked "or the setup page" below): a name with no
value saved on the setup page comes from here.

| Variable | What it is |
|---|---|
| `PUBLIC_ORIGIN` | The https address users open. Required for real Google sign-in. |
| `PORT`, `HOST` | The host's Node selector sets `PORT`; locally 5610. `HOST` defaults to 127.0.0.1. |
| `BOOTSTRAP_ADMIN_EMAIL` | Or the setup page. The first sign-in by this address creates the admin when the roster is empty; changing it once an admin exists makes nobody else an admin. |
| `ALLOWED_EMAIL_DOMAIN` | Optional, or the setup page. Refuse any Google account outside this domain. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the OAuth client above, or the setup page. |
| `MAIL_FROM` | Optional, or the setup page. Email goes out through the admin's Google connection (Settings → Connect Google: calendar and email); unset, it is from "Time Off" at that account. To use another address it must be the account itself or one of its Workspace "send as" aliases, or Gmail quietly sends from the account. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Optional fallback, used only while Google is not connected for email; needs `MAIL_FROM` too. |
| `DATA_DIR` | Where the database and the calendar token live. Default `data/`. Back this directory up. |
| `JOB_TOKEN` | Optional. The bearer token the monthly-report cron sends (see "Monthly report"). Unset, the app makes one at startup and keeps it as `job_token` in `data/keys.json`. |
| `DEFAULT_TIMEZONE` | Optional. The company's time zone, for which month just ended and for new people. Default `America/New_York`. |
| `TRUST_PROXY` | Set `1` on the host (one web server in front). Without it every visitor arrives from the web server's address and the sign-in limit (20 starts per 10 minutes) is shared by everyone. Leave unset locally. |
| `TIMEOFF_NO_AUTOSTART` | Leave unset. `server/index.mjs` starts listening whenever it is loaded (`npm start`, a systemd unit, or a shared host's app loader); tests set this to `1` so they can call `startServer()` themselves. |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | From the Slack app made with `docs/slack-manifest.yml`, or the setup page; both set = Slack on. See "Slack". |

Never set `ALLOW_FIXTURES` or any `*_FIXTURE` flag on a host; the server
refuses to start with them on anything that isn't a loopback address.

## Run it locally

```bash
npm install
cp .env.example .env.local      # fill in what you have; fixtures below need nothing
npm run build:client
npm start                       # http://127.0.0.1:5610
```

To try everything without Google, mail, or a calendar:

```bash
ALLOW_FIXTURES=1 GOOGLE_FIXTURE=1 MAIL_FIXTURE=1 CALENDAR_FIXTURE=1 BOOTSTRAP_ADMIN_EMAIL=admin@example.com npm start
```

The sign-in page then offers a local stand-in where you type any roster
address; emails are written to `data/outbox/` and calendar events to
`data/calendar-fixture.json`. `npm run qa:walk` drives a whole
request-approve cycle against that server and prints a receipt.

`npm run check` runs the syntax check, the TypeScript check, and the unit
tests (day counting, accrual, the request rules). CI runs the same on every
push.

## Hosting

Time Off runs on any machine with Node 22+ that is reachable over https:
Google and Slack call back into it. The recommended home is a small VM in
the company's own Google Cloud project, the same project that holds the
OAuth client; the scripts and the step-by-step are in
`HOSTING-GOOGLE-CLOUD.md`. Any other Node host works the same way: clone,
`npm ci && npm run build:client && npm start` behind https, keep `data/`
on a persistent disk and back it up.

`scripts/deploy-release.mjs` packages a release (never `data/` or `.env`)
and ships it over ssh to a host of your choosing; see its header.

## Moving it between hosts

Any host that runs Node 22+ works (a $5 VPS, Render, Fly, Railway, Cloud
Run with a persistent volume for `data/`). Steps: clone the repo, set the
env from the table above, `npm ci && npm run build:client && npm start`
behind https, copy `data/` across, and update the two redirect URIs in the
Google Cloud project to the new origin. Nothing else is tied to the host.

## Slack (the team's front door)

Staff request with `/timeoff`, managers approve with buttons, everyone is
matched to the roster by the email on their Slack profile. Email copies
still go out. One-time install, done by anyone in the workspace allowed to
install apps (a Slack admin approves once if installs are restricted):

1. https://api.slack.com/apps → Create New App → **From a manifest** →
   pick the workspace → paste `docs/slack-manifest.yml` from this repo
   (it already points at `https://timeoff.<company domain>`; change the two
   URLs if the app lives elsewhere) → Create.
2. **Install to Workspace** and allow the permissions it lists (post
   messages, read member emails, open direct messages, the `/timeoff`
   command).
3. Copy **Bot User OAuth Token** (OAuth & Permissions) and **Signing
   Secret** (Basic Information) into the host's `.env.local` as
   `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, restart the app.
4. Settings in the web app then shows the workspace name. Type `/timeoff`
   in Slack to confirm the form opens.

Slack must be able to reach the app over https within 3 seconds, which is
why the certificate step comes first. Locally, `SLACK_FIXTURE=1` (with
`ALLOW_FIXTURES=1`) stands in for Slack: every call is written to
`data/slack-fixture.json`, and `data/slack-fixture-users.json` maps
practice Slack user ids to roster emails.

## Classes and their default policies

Everyone is one of three classes, from their worker type and pay basis:

| Class | Who | SMTO | Sick | Company holidays |
|---|---|---|---|---|
| Employee | worker type employee, any pay basis | unlimited | unlimited | days off (not counted) |
| Monthly contractor | contractor, paid monthly | 10 a year | 5 a year | working days (counted) |
| Hourly contractor | contractor, paid hourly | 15 a year | none (no Sick Type) | working days (counted) |

Contractor allowances are all there on January 1 (prorated in the year they
start) and nothing carries over. A person gets their class's policy when
they are added, and again when an admin changes their worker type or a
contractor's pay basis, unless the admin keeps the policy they have. An
admin can still set any policy by hand.

Upgrading an existing install does not change anyone's policy: people who
already had one keep their numbers, limited, with company holidays left out
of their counts as before. Only people added from then on (or whose class
changes) get the class defaults. To move an existing employee to unlimited,
set it on their policy.

## Sample data for a demo

To show the app before real people use it, add a sample company: two teams
(Support, Operations), eight people whose names start with "Sample " and
whose addresses are `@example.com`, their allowances, one company holiday
("Sample Founders Day"), and about thirty requests over the last nine
months and the next six weeks: every status, every Type, half days, a
request across New Year, typed working days, an overdrawn balance, an
hourly contractor, requests waiting on a manager and on the admins.

Nothing goes out while it is added: no Slack, no email, no calendar
events. The People and Settings pages show a "sample data" banner while it
is there (`sample` on each person, `sample_people` in settings).

```bash
cd ~/timeoff
node scripts/seed-sample.mjs --add       # once; running it again does nothing
node scripts/seed-sample.mjs --remove    # takes every sample row back out
```

Both are safe while the app is running (the database allows one writer at a
time and waits its turn). Locally, pass `--data <folder>` when the data is
not in `data/`. The sample holiday is placed on a date no real person has
time off, so real balances never move; it goes with `--remove`.

Either order works: add the sample before or after the first sign-in. The
first admin is made when `BOOTSTRAP_ADMIN_EMAIL` signs in and no real
(non-sample) person exists yet, so sample people never block it. While no
real admin exists, `--add` ends with a reminder to sign in as that address.

## Go-live checklist

1. `node scripts/seed-sample.mjs --remove` if sample data was added for a
   demo (Settings shows `sample_people: 0` afterwards).
2. The keys are in (setup page or `.env.local`): Google sign-in works for
   the owner, and Settings shows Slack's workspace name.
3. Google is connected in Settings (calendar and email) and a shared
   calendar is chosen.
4. The monthly-report cron is in (see "Monthly report").
5. `https://timeoff.<company domain>/healthz` answers `{"ok":true}`.

## Known limits

- **Changing a policy rewrites past carryover.** A balance is computed from
  the current policy every time, so editing someone's allowance, accrual
  rule, carryover cap or start date also changes what earlier years carried
  into this one. To change only the future, leave the policy and add an
  adjustment with a note instead.
- **`balance_after` checks only the first year of a request across New
  Year.** A preview (or an approval card) for Dec 29 to Jan 3 measures the
  December days against this year's balance; the January days are charged
  to next year's balance but not warned about until then.
