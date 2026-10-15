// Settings (admins): the Google connection (calendar and email), Slack, Google sign-in,
// and a log of who changed what. Every card says what is actually happening,
// including when something is in test mode and not really going out.

import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Empty, ErrorLine, Loading } from "../components/Bits";
import { CalendarIcon, CheckIcon } from "../components/Icons";
import { api, messageOf, type CalendarChoice, type CalendarTitles, type ManagerPick, type Settings } from "../lib/api";
import { formatStamp } from "../lib/dates";
import { useLoad } from "../lib/useLoad";
import { actionWords, plural, readableDetail, readableSubject } from "../lib/words";

export default function SettingsPage() {
  const { data, setData, error, loading, reload } = useLoad(() => api.settings(), []);

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">How Time Off connects to your calendar, email, and sign-in.</p>
        </div>
        <Link className="button button-quiet" to="/setup">
          Keys
        </Link>
      </header>

      {loading && !data ? <Loading label="Loading settings" /> : null}
      {error && !data ? <ErrorLine message={error} onRetry={() => void reload()} /> : null}

      {data && (data.sample_people ?? 0) > 0 ? (
        <p className="sample-banner" role="note">
          {data.sample_people === 1 ? "1 sample person is" : `${data.sample_people} sample people are`} on the roster for the demo. Remove them before
          real staff sign in (see SETUP.md).
        </p>
      ) : null}

      {data ? (
        <div className="settings-grid">
          <CalendarCard settings={data} onChange={(s) => setData(s)} onReload={() => void reload()} />
          <MailCard mail={data.mail} />
          <SlackCard slack={data.slack} onChange={(s) => setData(s)} />
          <SigninCard google={data.google_signin} />
        </div>
      ) : null}

      <Activity />
    </div>
  );
}

function StateTag({ tone, children }: { tone: "on" | "off" | "warn" | "test"; children: string }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

// ------------------------------------------------------------- calendar --

// Google sends a failed calendar connection back to /settings?calendar_error=<code>.
const CONNECT_ERRORS: Record<string, string> = {
  calendar_off: "Google can’t be connected yet: whoever set up Time Off still needs to add the Google keys.",
  calendar_state_invalid:
    "That connection took too long, or was finished by a different admin than the one who started it. Start again and finish it in the same window.",
  calendar_grant_failed: "Google didn’t finish connecting the calendar. Try again.",
  calendar_no_refresh:
    "Google didn’t give Time Off lasting access. In that Google account, remove Time Off from the apps with access, then connect again.",
};

function CalendarCard({ settings, onChange, onReload }: { settings: Settings; onChange: (s: Settings) => void; onReload: () => void }) {
  const cal = settings.calendar;
  const ids = useId();
  const [choices, setChoices] = useState<CalendarChoice[] | null>(null);
  const [choicesError, setChoicesError] = useState("");
  const [picked, setPicked] = useState(cal.calendar_id ?? "");
  const [busy, setBusy] = useState<"" | "save" | "retry" | "disconnect">("");
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [params, setParams] = useSearchParams();
  const connectCode = params.get("calendar_error");
  const connectError = connectCode ? (CONNECT_ERRORS[connectCode] ?? CONNECT_ERRORS.calendar_grant_failed) : "";
  const clearConnectError = () => setParams({}, { replace: true });

  useEffect(() => {
    if (!cal.connected) return;
    api
      .calendars()
      .then((answer) => setChoices(answer.calendars))
      .catch((cause) => setChoicesError(messageOf(cause)));
  }, [cal.connected]);

  useEffect(() => setPicked(cal.calendar_id ?? ""), [cal.calendar_id]);

  async function choose() {
    if (!picked) return;
    setBusy("save");
    setError("");
    setLine("");
    try {
      const answer = await api.chooseCalendar(picked);
      onChange(answer.settings);
      setLine("Approved time off will go on this calendar.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  async function setTitles(next: CalendarTitles) {
    setBusy("save");
    setError("");
    setLine("");
    try {
      const answer = await api.setCalendarTitles(next);
      onChange(answer.settings ?? (await api.settings()));
      setLine(next === "out" ? "Calendar entries will just say “Out”." : "Calendar entries will name the type of time off.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  async function retry() {
    setBusy("retry");
    setError("");
    setLine("");
    try {
      const answer = await api.retryCalendar();
      setLine(
        answer.failed
          ? `${plural(answer.retried - answer.failed, "entry was", "entries were")} added. ${plural(answer.failed, "is", "are")} still waiting.`
          : answer.retried === 1
            ? "The waiting entry is on the calendar now."
            : answer.retried
              ? `All ${answer.retried} waiting entries are on the calendar now.`
              : "Nothing was waiting.",
      );
      onReload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setError("");
    setLine("");
    try {
      const answer = await api.disconnectCalendar();
      onChange(answer.settings);
      setConfirmOff(false);
      setChoices(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  const writable = (choices ?? []).filter((c) => c.writable);

  return (
    <section className="card settings-card settings-calendar" aria-labelledby={`${ids}-h`}>
      <div className="settings-head">
        <span className="settings-icon">
          <CalendarIcon />
        </span>
        <h2 id={`${ids}-h`} className="card-title">
          Google: calendar and email
        </h2>
        {cal.connected ? (
          cal.fixture ? (
            <StateTag tone="test">Test mode</StateTag>
          ) : cal.calendar_id ? (
            <StateTag tone="on">Connected</StateTag>
          ) : (
            <StateTag tone="warn">Pick a calendar</StateTag>
          )
        ) : (
          <StateTag tone="off">Not connected</StateTag>
        )}
      </div>

      {connectError ? (
        <div className="settings-problem" role="alert">
          <p>
            <strong>Couldn’t connect:</strong> {connectError}
          </p>
          <button type="button" className="link-button" onClick={clearConnectError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {!cal.connected ? (
        <>
          <p className="settings-line">
            Connect the Google account that can edit your shared calendar. Approved time off is added to the calendar, and removed if it’s
            cancelled.{settings.mail.transport === "smtp" ? "" : " Notification emails are sent from that account too."}
          </p>
          <a className="button button-primary" href={api.calendarConnectUrl}>
            Connect Google
          </a>
        </>
      ) : (
        <>
          <p className="settings-line">
            Connected as <strong>{cal.account_email ?? "a Google account"}</strong>. Approved time off goes on the calendar below
            {settings.mail.transport === "gmail" && !settings.mail.needs_reconnect ? ", and notification emails are sent from this account." : "."}
            {cal.fixture ? " Test mode: entries are recorded here but not written to Google Calendar." : ""}
          </p>

          <div className="field">
            <label className="label" htmlFor={`${ids}-cal`}>
              Calendar for approved time off
            </label>
            {choicesError ? (
              <ErrorLine message={choicesError} />
            ) : !choices ? (
              <Loading label="Loading calendars" />
            ) : (
              <div className="inline-pick">
                <select id={`${ids}-cal`} className="input" value={picked} onChange={(e) => setPicked(e.target.value)}>
                  {!cal.calendar_id ? <option value="">Choose a calendar…</option> : null}
                  {writable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="button button-primary" disabled={!picked || picked === cal.calendar_id || busy !== ""} onClick={() => void choose()}>
                  {busy === "save" ? "Saving…" : "Use this calendar"}
                </button>
              </div>
            )}
            {choices && writable.length < choices.length ? (
              <p className="hint">Calendars this account can only view aren’t listed.</p>
            ) : null}
          </div>

          {cal.titles ? (
            <div className="field">
              <label className="label" htmlFor={`${ids}-titles`}>
                Calendar entries show
              </label>
              <select
                id={`${ids}-titles`}
                className="input"
                value={cal.titles}
                disabled={busy !== ""}
                onChange={(e) => void setTitles(e.target.value as CalendarTitles)}
              >
                <option value="out">Just “Out” (SMTO stays SMTO)</option>
                <option value="type">The type of time off</option>
              </select>
              <p className="hint">With “Out”, sick days and leaves aren’t visible on the shared calendar.</p>
            </div>
          ) : null}

          {!cal.calendar_id ? (
            <p className="settings-line">Choose a calendar above. Until then, approved time off isn’t added anywhere.</p>
          ) : cal.pending_writes > 0 ? (
            <div className="settings-waiting">
              <p>
                <strong>{plural(cal.pending_writes, "calendar change is", "calendar changes are")}</strong> waiting to be made.
              </p>
              <button type="button" className="button button-quiet button-small" disabled={busy !== ""} onClick={() => void retry()}>
                {busy === "retry" ? "Trying…" : "Retry now"}
              </button>
            </div>
          ) : (
            <p className="settings-ok">
              <CheckIcon size={16} />
              The calendar is up to date.
            </p>
          )}

          {cal.last_error ? (
            <p className="settings-problem">
              <strong>Last problem:</strong> {cal.last_error}
            </p>
          ) : null}

          {line ? (
            <p className="saved-line" role="status">
              <CheckIcon size={16} />
              {line}
            </p>
          ) : null}
          <ErrorLine message={error} />

          <div className="settings-foot">
            {confirmOff ? (
              <div className="inline-confirm">
                <span>
                  Disconnect? Until you connect again, new approvals won’t go on the calendar and emails sent through Google stop. Entries already
                  on the calendar stay.
                </span>
                <div className="inline-confirm-actions">
                  <button type="button" className="button button-danger button-small" disabled={busy !== ""} onClick={() => void disconnect()}>
                    {busy === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                  <button type="button" className="button button-quiet button-small" onClick={() => setConfirmOff(false)}>
                    Keep connected
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="link-button link-danger" onClick={() => setConfirmOff(true)}>
                Disconnect Google
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------- other channels --

function MailCard({ mail }: { mail: Settings["mail"] }) {
  const sender = mail.from ?? mail.account_email;
  const tag = mail.needs_reconnect ? (
    <StateTag tone="warn">Needs Google</StateTag>
  ) : mail.transport === "fixture" ? (
    <StateTag tone="test">Test mode</StateTag>
  ) : mail.on ? (
    <StateTag tone="on">On</StateTag>
  ) : (
    <StateTag tone="off">Off</StateTag>
  );
  return (
    <section className="card settings-card" aria-labelledby="mail-h">
      <div className="settings-head">
        <span className="settings-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
            <path d="m4 7 8 6 8-6" />
          </svg>
        </span>
        <h2 id="mail-h" className="card-title">
          Email
        </h2>
        {tag}
      </div>
      {mail.needs_reconnect ? (
        <div className="settings-waiting">
          <p>Reconnect Google to turn email on.</p>
          <a className="button button-quiet button-small" href={api.calendarConnectUrl}>
            Reconnect
          </a>
        </div>
      ) : mail.transport === "fixture" ? (
        <p className="settings-line">Test mode: emails are kept on the server instead of being delivered.</p>
      ) : mail.transport === "gmail" ? (
        <p className="settings-line">
          Sent from <strong>{sender ?? "the connected Google account"}</strong> through Google.
        </p>
      ) : mail.transport === "smtp" ? (
        <p className="settings-line">
          Sent from <strong>{mail.from ?? "the mail server’s address"}</strong> through the mail server.
        </p>
      ) : (
        <p className="settings-line">Off. Connect Google to turn email on.</p>
      )}
      {mail.on && !mail.needs_reconnect && mail.transport !== "fixture" ? (
        <p className="hint">Managers hear when someone asks for time off, and people hear back when it’s decided.</p>
      ) : null}

    </section>
  );
}

function SlackCard({ slack, onChange }: { slack: Settings["slack"]; onChange: (s: Settings) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoEnroll = slack.auto_enroll === true;
  const blocked = typeof slack.auto_enroll_blocked_reason === "string" && slack.auto_enroll_blocked_reason !== "" ? slack.auto_enroll_blocked_reason : null;

  async function pickManagers(next: ManagerPick) {
    setBusy(true);
    setError("");
    try {
      const answer = await api.setSlackManagerPick(next);
      onChange(answer.settings ?? (await api.settings()));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      const answer = await api.setSlackAutoEnroll(next);
      onChange(answer.settings ?? (await api.settings()));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card settings-card" aria-labelledby="slack-h">
      <div className="settings-head">
        <span className="settings-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M9.5 4v16M14.5 4v16M4 9.5h16M4 14.5h16" />
          </svg>
        </span>
        <h2 id="slack-h" className="card-title">
          Slack
        </h2>
        {slack.on && slack.fixture ? <StateTag tone="test">Test mode</StateTag> : null}
        {slack.on ? <StateTag tone="on">Connected</StateTag> : <StateTag tone="off">Not connected</StateTag>}
      </div>
      {slack.on ? (
        <>
          <p className="settings-line">
            Connected to <strong>{slack.team_name ?? "your Slack workspace"}</strong>. Staff can type <code className="slash">/timeoff</code> in Slack to ask for time off.
            {slack.fixture ? " Test mode: Slack messages are kept on the server instead of being posted." : ""}
          </p>
          <p className="settings-stat">
            <strong>{plural(slack.linked_people, "person", "people")}</strong> linked
          </p>
          {"auto_enroll" in slack ? (
            <div className="switch-row">
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoEnroll}
                  disabled={busy || blocked !== null}
                  aria-describedby={blocked ? "slack-blocked" : undefined}
                  onChange={(e) => void toggle(e.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
                <span className="switch-label">Let anyone in the workspace ask for time off</span>
              </label>
              {blocked ? (
                <p className="settings-blocked" id="slack-blocked">
                  {blocked}
                </p>
              ) : (
                <p className="hint">
                  {autoEnroll
                    ? "On: someone’s first /timeoff adds them to the roster. You then give them a manager and an allowance on People."
                    : "Off: people who aren’t on the roster are told to ask an admin to add them."}
                </p>
              )}
            </div>
          ) : null}
          {slack.manager_pick ? (
            <div className="field settings-select">
              <label className="label" htmlFor="slack-manager-pick">
                Who can be picked as manager in Slack
              </label>
              <select
                id="slack-manager-pick"
                className="input"
                value={slack.manager_pick}
                disabled={busy}
                onChange={(e) => void pickManagers(e.target.value as ManagerPick)}
              >
                <option value="confirm_every">Anyone; an admin confirms every request’s manager first</option>
                <option value="confirm_new">Anyone; an admin confirms new managers once</option>
                <option value="managers_only">Only existing managers</option>
                <option value="anyone">Anyone, no confirmation</option>
              </select>
            </div>
          ) : null}
          <ErrorLine message={error} />
        </>
      ) : (
        <>
          <p className="settings-line">
            Let staff ask for time off with <code className="slash">/timeoff</code> in Slack. Setting it up takes three steps:
          </p>
          <ol className="steps">
            <li>Create a Slack app from the manifest file that came with Time Off.</li>
            <li>Install the app to your Slack workspace.</li>
            <li>Paste its two keys, the bot token and the signing secret, into the host settings where Time Off runs.</li>
          </ol>
          <p className="hint">Keys never go into this page. Once they’re in place, this card shows your workspace.</p>
        </>
      )}
    </section>
  );
}

function SigninCard({ google }: { google: Settings["google_signin"] }) {
  return (
    <section className="card settings-card" aria-labelledby="signin-h">
      <div className="settings-head">
        <span className="settings-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
            <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
          </svg>
        </span>
        <h2 id="signin-h" className="card-title">
          Google sign-in
        </h2>
        {google.fixture ? <StateTag tone="test">Test mode</StateTag> : google.on ? <StateTag tone="on">On</StateTag> : <StateTag tone="warn">Off</StateTag>}
      </div>
      <p className="settings-line">
        {google.fixture
          ? "Test mode: people pick a sample account instead of signing in to Google."
          : google.on
            ? "People sign in with their Google account. Only people on the roster get in."
            : "Google sign-in isn’t set up, so nobody new can sign in. Whoever set up Time Off can finish it."}
      </p>
    </section>
  );
}

// ------------------------------------------------------------- activity --

function Activity() {
  // People's names, so "updated a person" can say who; activity rows carry ids.
  const { data, error, loading, reload } = useLoad(async () => {
    const [audit, roster] = await Promise.all([api.audit(100), api.people().catch(() => ({ people: [] }))]);
    return { events: audit.events, names: new Map(roster.people.map((p) => [p.id, p.name])) };
  }, []);
  const [showAll, setShowAll] = useState(false);
  const events = data?.events ?? [];
  const shown = showAll ? events : events.slice(0, 15);

  return (
    <section className="card activity" aria-labelledby="activity-h">
      <h2 id="activity-h" className="card-title">
        Activity
      </h2>
      {loading && !data ? <Loading label="Loading activity" /> : null}
      <ErrorLine message={error} onRetry={() => void reload()} />
      {data ? (
        events.length === 0 ? (
          <Empty title="Nothing has happened yet." />
        ) : (
          <>
            <ol className="activity-list">
              {shown.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <time dateTime={e.at} className="activity-at">
                    {formatStamp(e.at)}
                  </time>
                  <p className="activity-what">
                    <strong>{e.actor?.name ?? "Time Off"}</strong> {actionWords(e.action)}
                    {readableSubject(data.names.get(e.subject) ?? e.subject) ? <> · {readableSubject(data.names.get(e.subject) ?? e.subject)}</> : null}
                  </p>
                  {readableDetail(e.detail) ? <p className="activity-detail">{readableDetail(e.detail)}</p> : null}
                </li>
              ))}
            </ol>
            {events.length > 15 ? (
              <button type="button" className="link-button list-more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                {showAll ? "Show fewer" : `Show all ${events.length}`}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
