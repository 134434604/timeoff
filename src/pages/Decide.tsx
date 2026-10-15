// Approve or deny from an email link: /approve/:token or /deny/:token, and
// confirm or reject a manager someone named: /confirm-manager/:token,
// /reject-manager/:token.
// No sign-in and no app frame: the signed link names the request, the action
// and the approver, works once, and expires. Opening it changes nothing (mail
// scanners open links on their own); only the big button decides.
// Built for a phone.

import { useState } from "react";
import { useParams } from "react-router-dom";
import { KindTag, Loading } from "../components/Bits";
import { CheckIcon, CloseIcon } from "../components/Icons";
import { BrandMark } from "../components/Shell";
import { ApiError, api, messageOf, type DecideAction, type DecideRequest, type DecideView } from "../lib/api";
import { daysLabel, formatRange } from "../lib/dates";
import { useLoad } from "../lib/useLoad";
import { firstName } from "../lib/words";

type Ended = "already_decided" | "expired" | "invalid";

const ENDED: Record<Ended, { title: string; line: string }> = {
  already_decided: { title: "This request was already handled", line: "Someone has already approved or denied it. Open Time Off to see the answer." },
  expired: { title: "This link has expired", line: "Open Time Off to decide." },
  invalid: { title: "This link isn’t valid", line: "It may have been cut off when it was copied. Open Time Off to decide." },
};

/** A refused decision that means the link is spent, old, or wrong. */
function endedOf(cause: unknown): Ended | null {
  if (!(cause instanceof ApiError)) return null;
  if (cause.code === "already_decided") return "already_decided";
  if (cause.code === "expired") return "expired";
  if (cause.code === "invalid" || cause.status === 404) return "invalid";
  return null;
}

export default function Decide({ action: routeAction }: { action: DecideAction }) {
  const { token = "" } = useParams();
  const { data, error, loading, reload } = useLoad<DecideView>(() => api.decideView(token), [token]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const [ended, setEnded] = useState<Ended | null>(null);
  const [done, setDone] = useState<{ action: DecideAction; request: DecideRequest } | null>(null);
  const managerLink = (data?.action ?? routeAction) === "confirm_manager" || (data?.action ?? routeAction) === "reject_manager";

  // The token names its action; the path is only how the email linked to it.
  const action: DecideAction = data?.action ?? routeAction;
  const stop: Ended | null = ended ?? (data && data.state !== "pending" ? data.state : null);
  const request = data?.request ?? null;

  async function decide() {
    setBusy(true);
    setFailed("");
    try {
      const answer = await api.decide(token, action === "deny" && note.trim() ? note.trim() : undefined);
      if (managerLink) {
        setDone({ action: answer.action ?? action, request: answer.request ?? request! });
        return;
      }
      setDone({ action: answer.action, request: answer.request });
    } catch (cause) {
      const over = endedOf(cause);
      if (over) setEnded(over);
      else setFailed(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="decide-page">
      <header className="decide-brand">
        <BrandMark />
        <span>Time Off</span>
      </header>
      <main id="main" className="decide-main">
        {loading && !data ? <Loading label="Opening the request" /> : null}
        {error && !data ? (
          <div className="card decide-card">
            <h1 className="decide-title">That didn’t load</h1>
            <p className="muted">{error}</p>
            <button type="button" className="button button-quiet" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        ) : null}

        {stop ? (
          <div className="card decide-card">
            <h1 className="decide-title">{managerLink && stop === "already_decided" ? "This was already answered" : ENDED[stop].title}</h1>
            <p className="muted">
              {managerLink && stop === "already_decided" ? "Someone already said whether this is their manager. Open Time Off to see the request." : ENDED[stop].line}
            </p>
            <a className="button button-quiet button-wide" href="/approvals">
              Open Time Off
            </a>
          </div>
        ) : done && managerLink ? (
          <div className="card decide-card" role="status">
            <span className={done.action === "confirm_manager" ? "decide-mark is-approved" : "decide-mark is-neutral"}>
              {done.action === "confirm_manager" ? <CheckIcon size={30} /> : <CloseIcon size={30} />}
            </span>
            <h1 className="decide-title">
              {done.action === "confirm_manager" ? `Sent to ${data?.manager_name ?? "their manager"} to approve` : "Kept with the admins"}
            </h1>
            <p className="muted">
              {done.action === "confirm_manager"
                ? `${data?.manager_name ?? "They"} will get ${firstName(done.request.person_name)}’s request now.`
                : "Decide it on Approvals or let another admin."}
            </p>
            <a className="button button-quiet button-wide" href="/approvals">
              Open Time Off
            </a>
          </div>
        ) : request && managerLink ? (
          <div className="card decide-card">
            <h1 className="decide-title">
              Is {data?.manager_name ?? "this person"} {request.person_name}’s manager?
            </h1>
            <dl className="decide-facts">
              <div>
                <dt>What</dt>
                <dd>
                  <KindTag kind={request.kind} />
                </dd>
              </div>
              <div>
                <dt>Dates</dt>
                <dd>{formatRange(request.start_date, request.end_date)}</dd>
              </div>
              <div>
                <dt>Working days</dt>
                <dd>{daysLabel(request.days)}</dd>
              </div>
            </dl>
            {request.note ? <blockquote className="queue-note">{request.note}</blockquote> : null}
            {failed ? (
              <p className="error-line" role="alert">
                {failed}
              </p>
            ) : null}
            {action === "confirm_manager" ? (
              <button type="button" className="button button-primary decide-go" disabled={busy} onClick={() => void decide()}>
                {busy ? "Saving…" : `Yes, ${data?.manager_name ?? "they"} ${data?.manager_name ? "is" : "are"} their manager`}
              </button>
            ) : (
              <button type="button" className="button button-quiet decide-go" disabled={busy} onClick={() => void decide()}>
                {busy ? "Saving…" : "No"}
              </button>
            )}
            <p className="hint decide-hint">
              Not sure? <a href="/approvals">Open Time Off</a> to see the request.
            </p>
          </div>
        ) : done ? (
          <div className="card decide-card" role="status">
            <span className={done.action === "approve" ? "decide-mark is-approved" : "decide-mark is-denied"}>
              {done.action === "approve" ? <CheckIcon size={30} /> : <CloseIcon size={30} />}
            </span>
            <h1 className="decide-title">{done.action === "approve" ? "Approved" : "Denied"}</h1>
            <p className="muted">
              {firstName(done.request.person_name)}’s {daysLabel(done.request.days).toLowerCase()},{" "}
              {formatRange(done.request.start_date, done.request.end_date)}. {firstName(done.request.person_name)} will hear back from Time Off.
            </p>
            <a className="button button-quiet button-wide" href="/approvals">
              Open Time Off
            </a>
          </div>
        ) : request ? (
          <div className="card decide-card">
            <p className="decide-kicker">
              {action === "approve" ? "Approve this request?" : "Deny this request?"}
              {data?.approver_name ? ` · for ${data.approver_name}` : ""}
            </p>
            <h1 className="decide-title">{request.person_name}</h1>
            <dl className="decide-facts">
              <div>
                <dt>What</dt>
                <dd>
                  <KindTag kind={request.kind} />
                </dd>
              </div>
              <div>
                <dt>Dates</dt>
                <dd>{formatRange(request.start_date, request.end_date)}</dd>
              </div>
              <div>
                <dt>Working days</dt>
                <dd>{daysLabel(request.days)}</dd>
              </div>
            </dl>
            {request.note ? <blockquote className="queue-note">{request.note}</blockquote> : null}

            {action === "deny" ? (
              <div className="field decide-note">
                <label className="label" htmlFor="decide-note">
                  Tell {firstName(request.person_name)} why <span className="optional">optional</span>
                </label>
                <textarea id="decide-note" className="input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            ) : null}

            {failed ? (
              <p className="error-line" role="alert">
                {failed}
              </p>
            ) : null}

            <button
              type="button"
              className={action === "approve" ? "button button-primary decide-go" : "button button-danger decide-go"}
              disabled={busy}
              onClick={() => void decide()}
            >
              {busy ? (action === "approve" ? "Approving…" : "Denying…") : action === "approve" ? "Approve time off" : "Deny time off"}
            </button>
            <p className="hint decide-hint">
              Not sure yet? <a href="/approvals">Open Time Off</a> to see everything waiting.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
