# Hosting Time Off in the company's own Google Cloud

About 15 minutes once the company's Google Cloud project exists (it's the
same project the OAuth client lives in, see `OWNER-SETUP.md`). One small
VM, free-tier sized, with automatic https. Everything the app knows stays
in `/opt/timeoff/data` on that VM, backed up nightly.

## Who does what

| Step | Who | Where |
|---|---|---|
| 1. Open Cloud Shell in the project | Owner | Google Cloud console, terminal icon top right |
| 2. Add one DNS record for `timeoff.<company domain>` | Whoever manages the domain | DNS provider |
| 3. Create the VM, install, release | Owner, with a helper on her screen if she likes | Cloud Shell |
| 4. Paste the keys on the setup page, connect Google, install Slack with the new URLs | Owner | browser |

## 1. Cloud Shell

Cloud Shell is a terminal inside the console, already signed in as the
owner, with `gcloud` ready. Nothing is installed on anyone's computer and
nobody else is granted access to the project. Prompt 3 in
`prompts-for-the-owner.md` walks the owner through steps 1 to 3 with
Claude; the commands below are the same ones. Get the code in first, from
the private GitHub repository the company was invited to:

```bash
gh auth login            # GitHub.com, HTTPS, login with a web browser (one-time code)
gh repo clone <owner>/timeoff timeoff && cd timeoff
```

or, with a zip: upload it (Cloud Shell toolbar, three dots, Upload) and
`unzip -o timeoff.zip -d timeoff && cd timeoff`.

## 2. DNS

Create the VM first (step 3 prints its IP), then add at the company's DNS:

```
A    timeoff    <the VM's IP>
```

## 3. Create, install, release

In Cloud Shell (or any terminal with `gcloud` signed in to the project):

```bash
PROJECT=$(gcloud config get-value project) DOMAIN=timeoff.<company domain> bash scripts/gcp/create-vm.sh
```

When the DNS record resolves (`nslookup timeoff.<company domain>`), prepare
the box:

```bash
gcloud compute scp scripts/gcp/install.sh timeoff:/tmp/install.sh --zone us-east1-b
gcloud compute ssh timeoff --zone us-east1-b -- sudo DOMAIN=timeoff.<company domain> bash /tmp/install.sh
```

Then ship the app (and again for every later update):

```bash
VM=timeoff ZONE=us-east1-b PROJECT=$(gcloud config get-value project) bash scripts/gcp/release.sh
curl -s https://timeoff.<company domain>/healthz
```

Moving existing data (people, requests, the calendar connection) from the
old host: copy the old `data/` folder into `/opt/timeoff/data` on the VM
while the service is stopped (`sudo systemctl stop timeoff`), then start it.
Skip this for a fresh start.

## 4. Keys and connections

- Open `https://timeoff.<company domain>/setup?token=…`. The token is in
  `/opt/timeoff/data/setup-token` on the VM (`gcloud compute ssh timeoff --
  sudo cat /opt/timeoff/data/setup-token`). Paste the Google client,
  Slack keys, admin email, company domain.
- In the Google Cloud project's OAuth client, the two redirect URIs must
  use the new domain:
  `https://timeoff.<company domain>/api/auth/google/callback` and
  `https://timeoff.<company domain>/api/settings/calendar/callback`.
- In the Slack app (api.slack.com/apps → Time Off): Slash Commands →
  `/timeoff` request URL, and Interactivity → request URL, both to the new
  domain. (Or recreate the app from `docs/slack-manifest.yml` with the two
  URLs edited.)
- Sign in, Settings → Connect Google, pick the SMTO calendar.

## Operating it

- Logs: `sudo journalctl -u timeoff -f`. Restart: `sudo systemctl restart timeoff`.
- Backups: `/opt/timeoff/backups/data-YYYY-MM-DD.tar.gz`, 30 days. Copy
  them off the VM (a Cloud Storage bucket is the natural place).
- Monthly report cron (optional; the app also sends it lazily):
  `0 8 1 * * curl -s -H "Authorization: Bearer <JOB_TOKEN>" https://timeoff.<company domain>/api/jobs/monthly-report`
- Cost: e2-micro is free-tier in us-east1/us-west1/us-central1; the static
  IP is about $3/month while attached.
