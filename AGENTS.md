# Time Off — standing rules

A time-off request and approval app for one small company: staff request time
off (in Slack or on the site), their manager approves or denies it, approved
time lands on the company's shared Google Calendar, and balances accrue per
person. These are the standing rules for anyone, person or coding agent,
changing it.

## Where things are

- `server/` plain `node:http` server, no framework (`server/index.mjs`),
  SQLite through `node:sqlite` (`server/db.mjs`). Node 22.13+; production
  runs Node 24.
- `server/auth/` Google sign-in, cookie sessions, throttle, SMTP mail.
  `server/google/` the admin's Google grant: the shared calendar and the
  notification email (Gmail send). `server/slack/` the Slack front door.
- `server/domain/` the math and the rules: day counting, accrual and
  balances, the request state machine. Pure functions; `tests/` covers them.
- `src/` the Vite + React + TypeScript client; built to `dist/`, served by
  the server with an `index.html` fallback for client routes.
- `docs/API.md` is the contract between client and server. Change it first,
  then both sides.

## Rules every session keeps

- Read `git status --short --branch` before editing. Commit by explicit
  path (`git add <files>`; never `git add -A`). Push only when asked, and a
  push is finished only when its CI run has been read.
- `data/` is never committed and never deployed: it holds the database,
  the calendar refresh token, and fixture outboxes. The deploy script
  excludes it structurally.
- Fixture flags (`GOOGLE_FIXTURE`, `MAIL_FIXTURE`, `CALENDAR_FIXTURE`, `SLACK_FIXTURE`) run
  only with `ALLOW_FIXTURES=1` on a loopback server. A production-like
  server refuses to start with any of them set (`server/fixture-guard.mjs`).
- Every outbound effect (calendar write, email, Slack) has an off, a
  capture/fixture, and a live mode, and the UI never says "sent" or "added
  to calendar" for a captured one.
- Staff records are personal data. No real names, emails, or balances in
  commits, tests, fixtures, or docs. Tests use `@example.com` people.
- Copy on user-facing pages is plain American English with no backend
  vocabulary: "time off", "approve", "balance", never "request entity",
  "OAuth", "fixture", "sync".
- "Done" means `npm run check` passes and the claim names what it proved.
  A localhost URL is handed over only after an HTTP 200 just before.
- Decisions that belong to the business (policy, who approves, what staff
  see) go to the company's owner in writing before the change ships; don't
  settle them in code.
