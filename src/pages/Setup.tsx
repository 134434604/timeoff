// Set up Time Off: where the owner pastes the Google and Slack keys once.
// Reached by the private link the installer hands over (/setup?token=…) or by
// a signed-in admin from Settings → Keys. Stored keys are never shown back:
// inputs always start empty, and a "Set" chip says what's already done.

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ErrorLine, Loading } from "../components/Bits";
import { CheckIcon } from "../components/Icons";
import { BrandMark } from "../components/Shell";
import { ApiError, api, messageOf, type SetupKeys, type SetupSaved, type SetupStatus } from "../lib/api";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/useLoad";

const INVALID = "This link isn’t valid anymore. Ask whoever set up Time Off for a fresh one.";

export default function Setup() {
  // Read the link's token once; every call then sends it in a header.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  const { person } = useSession();
  const { data, setData, error, loading, reload } = useLoad(async () => {
    try {
      return { status: await api.setupStatus(token), invalid: false };
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return { status: null, invalid: true };
      throw cause;
    }
  }, [token]);

  const status = data?.status ?? null;

  async function refreshStatus() {
    try {
      const fresh = await api.setupStatus(token);
      setData({ status: fresh, invalid: false });
    } catch {
      /* the chips just stay as they were */
    }
  }

  return (
    <div className="setup">
      <header className="setup-head">
        <div className="signin-brand">
          <BrandMark />
          <span>Time Off</span>
        </div>
        {person ? (
          <Link className="link-button" to="/settings">
            Back to Settings
          </Link>
        ) : null}
      </header>

      <main id="main" className="setup-main">
        <h1 className="page-title">Set up Time Off</h1>

        {loading && !data ? <Loading label="Checking your setup link" /> : null}
        {error && !data ? <ErrorLine message={error} onRetry={() => void reload()} /> : null}

        {data?.invalid ? (
          <div className="card notice-card">
            <p className="setup-invalid">{INVALID}</p>
          </div>
        ) : null}

        {status ? (
          <>
            <p className="page-sub">
              Paste the keys below, one card at a time. Each card saves on its own, and you can come back to this link later to finish.
            </p>

            <ul className="setup-chips" aria-label="What’s done">
              <li>
                <SetChip label="Google" set={status.has_google} />
              </li>
              <li>
                <SetChip label="Slack" set={status.has_slack} />
              </li>
            </ul>

            <KeyCard
              title="Google sign-in and calendar"
              intro={
                <>
                  These come from Google Cloud: <strong>APIs &amp; Services → Credentials</strong>, then your OAuth client of type “Web
                  application”.
                </>
              }
              after={
                status.public_origin ? (
                  <div className="setup-uris">
                    <p className="hint">When Google asks for authorized redirect URIs, add both of these:</p>
                    <code>{status.public_origin}/api/auth/google/callback</code>
                    <code>{status.public_origin}/api/settings/calendar/callback</code>
                  </div>
                ) : null
              }
              alreadySet={status.has_google}
              fields={[
                { key: "google_client_id", label: "Client ID", secret: true, placeholder: "1234567890-abc.apps.googleusercontent.com" },
                { key: "google_client_secret", label: "Client secret", secret: true, placeholder: "GOCSPX-…" },
              ]}
              token={token}
              describe={(saved) =>
                saved.google.ok ? "Saved. Google is ready." : "Saved, but Google didn’t accept those keys yet. Copy them again from Google Cloud."
              }
              onSaved={refreshStatus}
            />

            <KeyCard
              title="Slack"
              intro={
                <>
                  These come from your Slack app at <strong>api.slack.com/apps</strong>: the bot token is under <strong>OAuth &amp; Permissions</strong>,
                  the signing secret under <strong>Basic Information</strong>.
                </>
              }
              alreadySet={status.has_slack}
              fields={[
                { key: "slack_bot_token", label: "Bot token", secret: true, placeholder: "xoxb-…" },
                { key: "slack_signing_secret", label: "Signing secret", secret: true, placeholder: "" },
              ]}
              token={token}
              describe={(saved) =>
                saved.slack.message
                  ? saved.slack.message
                  : saved.slack.checked && saved.slack.ok
                    ? `Saved · Slack workspace: ${saved.slack.team_name ?? "connected"}`
                    : saved.slack.checked
                      ? "Saved, but Slack didn’t accept that bot token. Copy it again from OAuth & Permissions."
                      : "Saved."
              }
              onSaved={refreshStatus}
            />

            <KeyCard
              title="Company"
              optional
              intro={<>The admin email decides who gets in first. The other two are optional. Leave a field empty to keep what’s there.</>}
              alreadySet={false}
              fields={[
                {
                  key: "bootstrap_admin_email",
                  label: "Admin email",
                  secret: false,
                  placeholder: "owner@yourcompany.com",
                  hint: "The company email that becomes the admin on first sign-in.",
                  isSet: status.has_admin_email,
                },
                {
                  key: "allowed_email_domain",
                  label: "Company email domain",
                  secret: false,
                  placeholder: "yourcompany.com",
                  hint: "Only Google accounts from this domain can sign in.",
                  isSet: status.has_allowed_domain,
                },
                {
                  key: "mail_from",
                  label: "Emails come from",
                  secret: false,
                  placeholder: "Time Off <timeoff@yourcompany.com>",
                  hint: "The name and address people see on notification emails.",
                  isSet: status.has_mail_from,
                },
              ]}
              token={token}
              describe={() => "Saved."}
              onSaved={refreshStatus}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}

function SetChip({ label, set }: { label: string; set: boolean }) {
  return (
    <span className={set ? "tag tag-on" : "tag"}>
      {label}: {set ? "set" : "not set"}
    </span>
  );
}

interface Field {
  key: Exclude<keyof SetupKeys, "token">;
  label: string;
  secret: boolean;
  placeholder: string;
  hint?: string;
  /** Already stored; the input still starts empty. */
  isSet?: boolean;
}

function KeyCard({
  title,
  intro,
  after,
  fields,
  alreadySet,
  optional = false,
  token,
  describe,
  onSaved,
}: {
  title: string;
  intro: ReactNode;
  after?: ReactNode;
  fields: Field[];
  alreadySet: boolean;
  optional?: boolean;
  token: string | null;
  describe: (saved: SetupSaved) => string;
  onSaved: () => void;
}) {
  const ids = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const filled = fields.filter((f) => (values[f.key] ?? "").trim() !== "");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!filled.length) {
      setError(optional ? "Fill in at least one field to save." : "Paste the keys first.");
      return;
    }
    setBusy(true);
    setError("");
    setSaved("");
    const body: Omit<SetupKeys, "token"> = {};
    for (const f of filled) body[f.key] = values[f.key].trim();
    try {
      const answer = await api.saveKeys(body, token);
      setSaved(describe(answer));
      setValues({});
      onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card setup-card" aria-labelledby={`${ids}-h`}>
      <div className="settings-head">
        <h2 id={`${ids}-h`} className="card-title">
          {title}
        </h2>
        {optional ? null : alreadySet ? <span className="tag tag-on">Set</span> : <span className="tag">Not set</span>}
      </div>
      <p className="settings-line">{intro}</p>
      <form onSubmit={save} noValidate>
        {fields.map((f) =>
          f.secret ? (
            <SecretInput
              key={f.key}
              id={`${ids}-${f.key}`}
              label={f.label}
              value={values[f.key] ?? ""}
              placeholder={alreadySet || f.isSet ? "Already set, paste to replace" : f.placeholder}
              onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
            />
          ) : (
            <div className="field" key={f.key}>
              <label className="label" htmlFor={`${ids}-${f.key}`}>
                {f.label}
                {f.isSet ? <span className="optional">set</span> : null}
              </label>
              <input
                id={`${ids}-${f.key}`}
                className="input"
                value={values[f.key] ?? ""}
                placeholder={f.isSet ? "Already set, type to replace" : f.placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setValues((all) => ({ ...all, [f.key]: e.target.value }))}
              />
              {f.hint ? <p className="hint">{f.hint}</p> : null}
            </div>
          ),
        )}
        {after}
        {saved ? (
          <p className="saved-line" role="status">
            <CheckIcon size={16} />
            {saved}
          </p>
        ) : null}
        <ErrorLine message={error} />
        <div className="form-actions setup-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

function SecretInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="secret">
        <input
          id={id}
          className="input"
          type={shown ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="secret-eye"
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
            <circle cx="12" cy="12" r="3" />
            {shown ? null : <path d="M4 20 20 4" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
