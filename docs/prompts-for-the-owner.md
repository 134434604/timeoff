# Two prompts to paste into Claude

Each one turns Claude into a patient guide for one setup task (the launch order is in LAUNCH.md). Paste the
whole block, including the lines between the fences, as the first message
of a new chat. If Claude in Chrome is installed, Claude can click through
most of it for you; otherwise it walks you one screen at a time.

---

## Prompt 1 — Google (so staff can sign in and the calendar and email work)

```
I run a company on Google Workspace. We're installing a small internal app called "Time Off" (staff request time off, managers approve it, approved days go on our shared Google Calendar, and it emails people from my account). The app's developer needs me to create a Google Cloud OAuth client inside my own Workspace. Please guide me through it one screen at a time, wait for me to confirm each step before the next, and if you have browser control, do the clicking for me and tell me what you did. Never ask me for my password; I'll sign in myself.

Exactly what we need to end up with:
1. A Google Cloud project named "Time Off" under my company's organization (console.cloud.google.com → project picker → New project). If "New project" is greyed out, tell me the exact words to send my Workspace admin so they can allow it or do it.
2. In that project, two APIs enabled from APIs & Services → Library: "Google Calendar API" and "Gmail API".
3. An OAuth consent screen (may be labeled "Google Auth platform → Branding/Audience" in newer consoles) with user type INTERNAL, app name "Time Off", my email as support and developer contact. Internal means only my company can sign in and Google does not review it. Do not choose External.
4. Under Credentials → Create credentials → OAuth client ID: type "Web application", name "Time Off", with exactly these two Authorized redirect URIs and nothing else:
   https://timeoff.<company domain>/api/auth/google/callback
   https://timeoff.<company domain>/api/settings/calendar/callback
5. At the end, the Client ID and Client secret that Google shows. Tell me to copy both and paste them into Time Off's setup page (the installer gives me that link), and not to paste the secret anywhere else. Don't read them aloud or repeat them back in this chat.

Also tell me, in one sentence, that later when I click "Connect Google" inside Time Off's Settings, Google will ask me to allow calendar access and sending email as me, and that's expected.

Start by asking me to open https://console.cloud.google.com in a tab where I'm signed in with my company Google account, then take it from there.
```

---

## Prompt 2 — Slack (so the team can type /timeoff)

```
I own a Slack workspace and we're adding an internal app called "Time Off" (staff type /timeoff to request time off, managers approve from a Slack message, everything else happens inside the app). The developer gave me a manifest file that defines the app. Please guide me through installing it one screen at a time, confirm each step with me before the next, and if you have browser control, do the clicking for me and tell me what you did. Never ask me for my password.

Exactly what we need to end up with:
1. At https://api.slack.com/apps → "Create New App" → "From a manifest" → choose my workspace → Next. Switch the editor to YAML, delete whatever is there, and paste the entire manifest I'll give you below, then Next → Create. If Slack shows a review of permissions first, that's expected: it posts messages, opens direct messages, reads members' emails to match them to our staff list, and adds the /timeoff command.
2. In the app's left menu: "Install App" → "Install to Workspace" → Allow. If my workspace requires admin approval for apps, tell me the exact words to send our Slack admin.
3. Copy two values for Time Off's setup page: the "Bot User OAuth Token" (starts with xoxb-, shown on the Install App or OAuth & Permissions page) and the "Signing Secret" (Basic Information → App Credentials → Show). Don't repeat them back in this chat.
4. Finally, tell me to type /timeoff in any Slack channel to confirm the command exists. It will say the app isn't connected yet until the two values are on the setup page; that's expected.

Here is the manifest to paste in step 1 (everything between the lines):
-----
<paste the contents of slack-manifest.yml here>
-----

Start by asking me to open https://api.slack.com/apps in a tab where I'm signed in to Slack as the workspace owner, then take it from there.
```

Before sending Prompt 2, open `slack-manifest.yml` (it came with these
files), copy everything in it, and put it where the prompt says.

---

## Prompt 3 (zip) — Set up the server in your own Google Cloud (nothing to install)

```
We're installing an internal app called "Time Off" in my company's Google Cloud project named "Time Off" (the same project where I created the OAuth client). Everything runs in Cloud Shell, the terminal built into the Google Cloud console, so nothing is installed on my computer. Please guide me one screen at a time, confirm each step before the next, and if you have browser control, do the clicking and typing and tell me what you did. Never ask me for my password. When a command prints something I need later (an IP address, a link), tell me to copy it.

What we have: the app's code as a zip file called timeoff.zip, saved on my computer. Our address for the app will be timeoff.<our company domain>. (If I was given a GitHub invitation instead, use the GitHub route in step 2.)

Steps:
1. console.cloud.google.com -> make sure the "Time Off" project is selected in the top bar -> click the terminal icon at the top right ("Activate Cloud Shell"). Wait for the prompt to appear.
2. Upload the code: in the Cloud Shell toolbar click the three dots -> Upload -> choose timeoff.zip. Then run: unzip -o timeoff.zip -d timeoff && cd timeoff   (if that created a single folder inside, cd into it; "ls" should show package.json). GitHub route instead: accept the invitation, then: gh auth login   (GitHub.com, HTTPS, Yes, Login with a web browser; copy the one-time code and approve it on the page it opens), then: gh repo clone <owner>/timeoff timeoff && cd timeoff
3. Put our address into the files: node scripts/set-domain.mjs timeoff.<our company domain>
4. Create the server: PROJECT=$(gcloud config get-value project) DOMAIN=timeoff.<our company domain> bash scripts/gcp/create-vm.sh
   It prints an IP address. Tell me to copy it. If it asks to enable an API or pick a zone, say yes / accept the default.
5. The DNS record. Help me find who manages our company domain's DNS (usually whoever set up our company email, or the registrar: GoDaddy, Squarespace, Cloudflare, Network Solutions...). Give me the exact message to send them: "Please add an A record: host 'timeoff', pointing to <IP>, TTL default." If I manage DNS myself, walk me through adding it. Then check with: nslookup timeoff.<our company domain> 8.8.8.8   until it shows that IP (this can take from minutes to a few hours).
6. Install, once the name resolves:
   gcloud compute scp scripts/gcp/install.sh timeoff:/tmp/install.sh --zone us-east1-b
   gcloud compute ssh timeoff --zone us-east1-b -- sudo DOMAIN=timeoff.<our company domain> bash /tmp/install.sh
   (The first ssh may offer to create a key; answer yes and press Enter for an empty passphrase.)
7. Release the app: VM=timeoff ZONE=us-east1-b PROJECT=$(gcloud config get-value project) bash scripts/gcp/release.sh
   Then check: curl -s https://timeoff.<our company domain>/healthz   -> it should print {"ok":true}
8. My setup link: gcloud compute ssh timeoff --zone us-east1-b -- sudo cat /opt/timeoff/data/setup-token
   Tell me the link is https://timeoff.<our company domain>/setup?token=<what it printed>, to open in a normal browser tab, where I paste the Google and Slack values, my admin email and our company domain.

If any command errors, show me the exact message and suggest the fix before moving on.
Start by asking me for our company domain and confirming timeoff.zip is on my computer (or that I have a GitHub invitation instead).
```

---

## Prompt 3 (GitHub) — the same, cloning the public repository

Use this instead of the zip version. The code is public on GitHub, so no
account, invitation or sign-in is needed. Everything after the clone is
identical to the zip version. (If you'd rather hand Claude one prompt for
the whole setup, use ONE-PROMPT.md.)

```
We're installing an internal app called "Time Off" in my company's Google Cloud project named "Time Off" (the same project where I created the OAuth client). Everything runs in Cloud Shell, the terminal built into the Google Cloud console, so nothing is installed on my computer. Please guide me one screen at a time, confirm each step before the next, and if you have browser control, do the clicking and typing and tell me what you did. Never ask me for my password. When a command prints something I need later (an IP address, a link), tell me to copy it.

What we have: the app's code at https://github.com/134434604/timeoff (public, nothing to sign in to). Our address for the app will be timeoff.<our company domain>.

Steps:
1. console.cloud.google.com -> make sure the "Time Off" project is selected in the top bar -> click the terminal icon at the top right ("Activate Cloud Shell"). Wait for the prompt to appear.
2. Get the code:   git clone https://github.com/134434604/timeoff.git timeoff && cd timeoff     ("ls" should show package.json)
3. Put our address into the files:   node scripts/set-domain.mjs timeoff.<our company domain>
4. Create the server:   PROJECT=$(gcloud config get-value project) DOMAIN=timeoff.<our company domain> bash scripts/gcp/create-vm.sh
   It prints an IP address. Tell me to copy it. If it asks to enable an API or pick a zone, say yes / accept the default.
5. The DNS record. Help me find who manages our company domain's DNS (usually whoever set up our company email, or the registrar: GoDaddy, Squarespace, Cloudflare, Network Solutions...). Give me the exact message to send them: "Please add an A record: host 'timeoff', pointing to <IP>, TTL default." If I manage DNS myself, walk me through adding it. Then check with:   nslookup timeoff.<our company domain> 8.8.8.8   until it shows that IP (this can take from minutes to a few hours).
6. Install, once the name resolves:
   gcloud compute scp scripts/gcp/install.sh timeoff:/tmp/install.sh --zone us-east1-b
   gcloud compute ssh timeoff --zone us-east1-b -- sudo DOMAIN=timeoff.<our company domain> bash /tmp/install.sh
   (The first ssh may offer to create a key; answer yes and press Enter for an empty passphrase.)
7. Release the app:   VM=timeoff ZONE=us-east1-b PROJECT=$(gcloud config get-value project) bash scripts/gcp/release.sh
   Then check:   curl -s https://timeoff.<our company domain>/healthz   -> it should print {"ok":true}
8. My setup link:   gcloud compute ssh timeoff --zone us-east1-b -- sudo cat /opt/timeoff/data/setup-token
   Tell me the link is https://timeoff.<our company domain>/setup?token=<what it printed>, to open in a normal browser tab, where I paste the Google and Slack values, my admin email and our company domain.

Later updates: in Cloud Shell,   cd timeoff && git pull   then repeat step 7.

If any command errors, show me the exact message and suggest the fix before moving on.
Start by asking me for our company domain.
```
