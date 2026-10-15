# Time Off — two things only you can set up

Both take about ten minutes and happen inside accounts your company
owns. When you're done, you'll have four values to paste into Time Off's setup page (Prompt 3
ends with that link). Keep them out of email threads.

## A. Let staff sign in with their company Google account

This creates a "Time Off" entry inside your Google Workspace so people
sign in with the account they already have. Nothing gets installed and no
one outside your company can sign in.

1. Open https://console.cloud.google.com while signed in to your company
   Google account. If it asks you to agree to terms, that's the normal
   first visit.
2. Top bar → project picker → **New project**. Name: `Time Off`. Leave
   Organization as your company. **Create**, then make sure that project
   is selected in the picker.
   - If "New project" is greyed out, your Workspace admin has to allow it
     or do this part for you. Send them this page.
3. Left menu → **APIs & Services → Library**. Search `Google Calendar
   API` → open it → **Enable**. Then back to the Library, search `Gmail
   API` → **Enable**. (Calendar is for approved days; Gmail lets Time
   Off send its notification emails from your account.)
4. **APIs & Services → OAuth consent screen** (it may be called "Google
   Auth platform → Branding" in newer consoles). Choose **Internal**. App
   name `Time Off`, your email as the support and developer contact.
   Save. Internal means only your company's accounts can use it, and no
   Google review is needed.
5. **APIs & Services → Credentials → Create credentials → OAuth client
   ID**. Application type **Web application**. Name `Time Off`. Under
   **Authorized redirect URIs**, add these two, exactly:
   - `https://timeoff.<company domain>/api/auth/google/callback`
   - `https://timeoff.<company domain>/api/settings/calendar/callback`
   **Create.**
6. A box shows **Client ID** and **Client secret**. Copy both. Those are
   values 1 and 2. (You can also download the JSON; the
   same two values are inside it.)

## B. Put `/timeoff` in your Slack

This adds a "Time Off" app to your Slack workspace. Anyone allowed to
install apps can do it; if your workspace restricts installs, Slack asks
an admin to approve once.

1. Open https://api.slack.com/apps → **Create New App** → **From a
   manifest** → pick your workspace → **Next**.
2. Switch the box to **YAML**, delete what's there, and paste the whole
   contents of the file `slack-manifest.yml` (it's in the Time Off
   repository under `docs/`). **Next → Create**.
3. In the left menu, **Install App → Install to Workspace → Allow**.
4. Still in **Install App** (or **OAuth & Permissions**), copy the **Bot
   User OAuth Token** (starts with `xoxb-`). That's value 3.
5. **Basic Information → App Credentials → Signing Secret → Show**, copy
   it. That's value 4.

## C. The four values

1. Google client ID
2. Google client secret
3. Slack bot token
4. Slack signing secret

Plus the company email you'll sign in with (you become the admin) and
your company's email domain. All of these go into the setup page.

When you later click **Connect Google** in Time Off's Settings, Google
will ask you to allow it to manage calendar events and send email as
you. That's the one grant that powers both.

## What happens after

You paste the values into the setup page, then sign in once at
https://timeoff.<company domain>, add your people, set allowances, connect
the SMTO calendar from Settings, and tell everyone: "Type `/timeoff` in
Slack." The owner's guide, `HANDOFF.md`, covers the day-to-day.
