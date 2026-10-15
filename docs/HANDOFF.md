# Time Off — the owner's guide

Time Off is how your team requests time off. Someone asks for days from
Slack, their manager approves or denies it in Slack, and approved time
shows up on the shared SMTO Google Calendar on its own. Everyone's balance
is tracked for them. Email copies go out as well, so nothing is missed.

Nobody on the team needs to open a website. The website,
`https://timeoff.<company domain>`, is for you: it's where you keep the
roster, the allowances, the holidays, and the calendar connection. Sign in
there with your company Google account; there are no passwords.

## For the team: it's all in Slack

- **Ask for time off**: type `/timeoff` in any Slack channel or message.
  A form opens showing your balance (contractors) or your days used this
  year (employees). Pick the type (SMTO, Sick, Unpaid Time, or LOA), the
  first and last day, and type how many working days that is, like 1.5
  for a day and a half. In **Manager**, pick the person who approves your
  time off (@ anyone in the workspace; your manager is preselected once
  you have one). Add a note and send it.
- **What happens next**: you get a Slack message saying it went to your
  manager. Your manager gets a message with the request, your balance, who
  else is out those days, and Approve / Deny buttons. When they decide,
  you get a Slack message with the outcome. Approved time is on the team
  calendar within a minute.
- **Check your balance**: `/timeoff balance`.
- **Change your mind**: `/timeoff cancel` lists your waiting and upcoming
  requests with a Cancel button each. You can cancel a waiting request
  any time and an approved one before it starts.
- **Help**: `/timeoff help`.

Weekends never count, so a Friday-to-Monday request is two days. Company
holidays don't count for employees; for contractors they count as normal
days. SMTO and sick days are separate. Unpaid Time and LOA still go to
the manager but don't touch any balance. Waiting requests already count
against a contractor's balance, so nobody double-books days they don't
have.

If someone picks a manager who isn't on the roster yet, that person is
added as a manager, becomes their manager, and gets the request in Slack
and by email; the admins get an email about it and see the request in
Approvals.

## For managers

- Your Home page shows your own time off first, then a "Your team"
  section: who's out today and soon, this month at a glance, what's
  waiting on you, with links to the full Team, Insights and Approvals
  pages.

- Approve or Deny from the Slack message, or from the two buttons in the
  email you get for each request (no sign-in needed; the link opens a
  confirmation page and works once). Deny asks for an optional note that
  the person sees.
- **Reports** shows any month: days taken per person and per team, with
  hours for hourly people, and a CSV download. The same report is emailed
  on the 1st of each month: the whole company to admins, each team to its
  manager.
- **Insights** shows the year at a glance: who's out today and in the next
  30 days, what's waiting, days by month, by team, by person, and unused
  balances.
- The website's **Approvals** and **Team** pages show the same queue and
  a month view of the team's time off, if you ever want the overview.
- You can cancel an approved request at any time (plans change). Waiting
  requests from your reports are yours to approve or deny, not cancel.

## For you: setting it up (about an hour, once)

1. **Sign in** at the website with your company Google account. The
   first sign-in by the address set up at install becomes the admin.
2. **People → Add person** for everyone: company email, name, employee or
   contractor, monthly or hourly (hourly people get hours per day, used
   in reports; the type sets their allowance, see step 3), their team,
   their manager, and their role (most are
   "Staff"; approvers are "Manager"; you and anyone else who runs the
   roster are "Admin").
   The email must be the one on their Slack profile; that is how Slack
   knows who they are. Someone not on the roster who types `/timeoff` is
   told to ask you.
3. **Allowances are set for you** from the person's type:
   - *Employees*: unlimited SMTO and sick days. No balance is shown;
     their page and yours show the days they've used this year and which
     ones. Company holidays never count for them.
   - *Monthly contractors*: 10 SMTO days and 5 sick days a year, given
     all at once on January 1 (prorated in their first year), no
     carryover. Company holidays count as normal days for them.
   - *Hourly contractors*: 15 SMTO days a year, no sick days, holidays
     count as normal days.
   Changing someone's type or pay basis resets their allowance to that
   type's default. If one person needs something different, open them in
   People and edit the numbers, or use **Adjust balance** with a note; the
   note stays in the activity log.
4. **Holidays**: enter the company holidays for this year and next.
5. **Settings → Connect Google**: sign in with the Google account that
   can edit the SMTO calendar, allow calendar and email, then pick "SMTO"
   from the list. Notification emails go out from that account.
6. **Slack**: Settings shows whether Slack is connected. Connecting it is a
   one-time install described in `SETUP.md` (create the app from a file
   in this repo, click Install, paste two keys to whoever hosts the app).
   If your workspace restricts app installs, a Slack admin approves it
   once.
7. Tell the team: "Type `/timeoff` in Slack."

## When something looks wrong

- **A request says the calendar entry is still on its way**: the
  calendar write didn't go through. Settings shows the reason in plain
  words and a Retry button. The usual cause is the connected Google
  account lost access to the SMTO calendar.
- **Someone's `/timeoff` says they're not on the roster**: check People.
  They must be listed, active, and the email there must match their
  Slack profile email.
- **A balance looks off**: open the person in People. It shows accrued,
  carried over, adjustments, used, and waiting; the activity log at the
  bottom of Settings shows every change and who made it.
- **Anything else**: send the activity log and what you expected to see to
  whoever looks after the app for you.

## Who to call

Whoever looks after the app for your company has the code and
`docs/SETUP.md`, which explains how it runs and how to move it.
