# Launch plan

One afternoon, one person: the owner (non-technical, has the company's
Google Workspace and Slack). Nothing is downloaded or installed on her
computer; everything happens in a browser, including the server setup,
which runs in the terminal built into the Google Cloud console (Cloud
Shell). A helper can sit with her for steps 4 to 7 on her screen; no
access to her accounts is handed to anyone.

## What the owner receives

- `OWNER-SETUP.md` (the Google and Slack tasks) and `prompts-for-the-owner.md`
  (three prompts that walk her through everything in Claude, step by step).
- `HANDOFF.md`, the day-to-day guide, for after launch.
- An invitation to the private code repository on GitHub (she needs a
  free GitHub account; the invitation goes to it). Cloud Shell clones the
  code from there in step 6, and later updates come from the same place.
  A zip of the code works as a fallback.

## Order of work

| # | Who | What | Time |
|---|---|---|---|
| 1 | Owner | Decide the address: `timeoff.<company domain>` (the domain after the @ in work email). | 1 min |
| 2 | Owner | Prompt 1: Google Cloud project "Time Off", Calendar + Gmail APIs, Internal consent screen, OAuth client with the two redirect URIs for that address. Keeps the Client ID and secret. | 10 min |
| 3 | Owner | Prompt 2: Slack app from `slack-manifest.yml`, with the two addresses in it changed to her domain (the prompt says where). Keeps the bot token and signing secret. | 5 min |
| 4 | Owner | Prompt 3: open Cloud Shell inside the Google Cloud console (nothing to install, already signed in) and create the server with one command. Note the IP it prints. | 5 min |
| 5 | Owner | Ask whoever manages the company domain's DNS to add `A timeoff -> <IP>`. (Prompt 3 includes the exact wording.) | varies |
| 6 | Owner | When the name resolves: in Cloud Shell, sign in to GitHub once, clone the code, run the install and release commands (Prompt 3 covers it). | 10 min |
| 7 | Owner | Cloud Shell prints the setup link. | 1 min |
| 8 | Owner | Open the setup link. Paste the four values, her admin email, the company domain. Save. | 3 min |
| 9 | Owner | Sign in with Google. People: add everyone (or let them join by typing `/timeoff`). Allowances, holidays. Settings → Connect Google, pick the SMTO calendar. Choose the calendar-title and manager-pick settings. | 20 min |
| 10 | Owner | Tell the team: "Type `/timeoff` in Slack." | 1 min |

Steps 2 and 3 can happen any time before step 8. Step 5 is the only one
that depends on someone else (whoever manages the domain's DNS).

## First-day checks

- A staff member types `/timeoff`, picks dates, picks their manager, sends.
- The manager gets the Slack message with buttons and the email with
  buttons; approving from either puts the days on the SMTO calendar.
- The staff member gets the Slack and email confirmation.
- The owner sees it on Approvals, Reports and Insights.

## Afterwards

- Updates: in Cloud Shell, `cd timeoff && git pull`, then the release
  command from `HOSTING-GOOGLE-CLOUD.md`. Nothing else changes.
- Backups: nightly on the VM under `/opt/timeoff/backups`; copy them to a
  Cloud Storage bucket when convenient.
- Monthly report: emailed on the 1st automatically; a cron line is in
  `HOSTING-GOOGLE-CLOUD.md` for hosts that prefer a fixed time.
- The code repository is the company's. Anyone they bring in later starts
  from `AGENTS.md` and `SETUP.md`.
