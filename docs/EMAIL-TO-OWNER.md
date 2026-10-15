Subject: Time Off — one prompt sets it all up (about an hour, all in your browser)

Hi,

Time Off is ready for your company. Your team asks for time off by typing /timeoff in Slack; the request goes to the manager they pick (you confirm the manager once); the manager approves from Slack or from two buttons in an email; approved days land on the SMTO Google Calendar; balances, reports and insights are kept for you, with a monthly summary by email.

Nothing gets installed on your computer. Open a new chat in Claude, paste the block below, and follow along. Claude reads the instructions from the app's page on GitHub and takes you through Google, Slack, the server, and the setup page, one screen at a time. Budget about an hour, plus waiting for one DNS record that whoever manages your company domain adds (Claude gives you the exact words to send them).

Two things to have ready: your work email (you'll be the admin) and your company's email domain, the part after the @ (for example smto.com; the app's address becomes timeoff.smto.com).

----- PASTE EVERYTHING BELOW THIS LINE INTO CLAUDE -----

I'm setting up an internal app called "Time Off" for my company. I'm not technical. The app's code and all of its instructions are public on GitHub at https://github.com/134434604/timeoff. Please be my guide from start to finish: read the instructions from the repository yourself, then take me through them one screen at a time, confirming each step with me before the next. If you have browser control, do the clicking and typing for me and tell me what you did. Never ask me for my password; I'll sign in myself when a page asks.

Start by reading these files from the repository (use the raw links):
- https://raw.githubusercontent.com/134434604/timeoff/main/docs/LAUNCH.md  (the order of work)
- https://raw.githubusercontent.com/134434604/timeoff/main/docs/OWNER-SETUP.md  (the Google and Slack tasks)
- https://raw.githubusercontent.com/134434604/timeoff/main/docs/prompts-for-the-owner.md  (the detailed step lists; use "Prompt 3 (GitHub)" for the server, but clone with:  git clone https://github.com/134434604/timeoff.git timeoff && cd timeoff  since the repository is public and needs no sign-in)
- https://raw.githubusercontent.com/134434604/timeoff/main/docs/HANDOFF.md  (how it works day to day; use it to answer my questions at the end)

Facts you'll need from me: my company's email domain (the part after the @ in my work email; the app's address will be timeoff.<that domain>), and my work email (I'll be the admin). Ask for both first.

Then take me through, in this order, each as its own clearly announced part:
1. Google: a Google Cloud project named "Time Off", the Google Calendar API and Gmail API enabled, an Internal OAuth consent screen, and a Web application OAuth client with exactly these two redirect URIs: https://timeoff.<domain>/api/auth/google/callback and https://timeoff.<domain>/api/settings/calendar/callback. Have me copy the Client ID and Client secret.
2. Slack: create the app from the manifest file docs/slack-manifest.yml in the repository (read it from the raw link https://raw.githubusercontent.com/134434604/timeoff/main/docs/slack-manifest.yml and replace timeoff.<company domain> in its two URLs with my real address before I paste it), install it to my workspace, and have me copy the Bot User OAuth Token and the Signing Secret.
3. Server: in Google Cloud Shell (the terminal icon at the top right of the Google Cloud console), clone the repository, run node scripts/set-domain.mjs timeoff.<domain>, then scripts/gcp/create-vm.sh, the DNS record (give me the exact message to send whoever manages our domain), scripts/gcp/install.sh over gcloud compute ssh, scripts/gcp/release.sh, and finally print my setup link from /opt/timeoff/data/setup-token. The exact commands are in "Prompt 3 (GitHub)" in prompts-for-the-owner.md.
4. Setup page: open the link, paste the four values from parts 1 and 2 plus my admin email and company domain, save.
5. First day: sign in with Google, add people (or let them join by typing /timeoff), set allowances and holidays, Settings → Connect Google and pick the SMTO calendar, review the two settings on the Slack and Google cards, then tell the team "Type /timeoff in Slack". Then stay with me while one person sends a test request and I approve it, and check with me that the event appeared on the calendar.

If any command or page shows an error, show me the exact message and suggest the fix before moving on. Keep a short running checklist of what's done and what's next, and don't skip ahead.

----- END -----

The day-to-day guide is HANDOFF.md in the docs folder at https://github.com/134434604/timeoff. When /timeoff opens its form in your Slack, you're live.
