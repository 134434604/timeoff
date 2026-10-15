// Approvals: the requests waiting on me, one card each with everything needed
// to decide (dates, days, balance before and after, who else is out, the
// note), and Approve / Deny confirmed inline. Decisions show at once and roll
// back with the server's sentence if they don't go through.

import { useState } from "react";
import { Avatar, Empty, ErrorLine, KindTag, Loading, StatusChip, TypeChip } from "../components/Bits";
import { CalendarIcon, CheckIcon, CloseIcon } from "../components/Icons";
import { overlapSentence } from "../components/RequestForm";
import { api, messageOf, type ApprovalsData, type DecidedItem, type PendingItem } from "../lib/api";
import { daysLabel, formatNumber, formatRange, formatStampDay, formatWhen, todayIso } from "../lib/dates";
import { useMe } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { KIND_LABEL, calendarHint, classOf, daysWithCount, firstName, groupByClass, plural } from "../lib/words";

type Decision = "approve" | "deny";

export default function Approvals() {
  const me = useMe();
  const { data, setData, error, loading, reload } = useLoad(() => api.approvals(), []);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");

  async function decide(item: PendingItem, decision: Decision, note: string) {
    if (!data) return;
    const index = data.pending.findIndex((p) => p.request.id === item.request.id);
    const now = new Date().toISOString();
    const optimistic: DecidedItem = {
      person: item.person,
      request: {
        ...item.request,
        status: decision === "approve" ? "approved" : "denied",
        decided_by: { id: me.id, name: me.name },
        decided_at: now,
        decision_note: note,
        calendar: decision === "approve" ? { ...item.request.calendar, state: "pending" } : item.request.calendar,
      },
    };
    setCardErrors((e) => ({ ...e, [item.request.id]: "" }));
    setData((d: ApprovalsData | null) =>
      d ? { pending: d.pending.filter((p) => p.request.id !== item.request.id), recent: [optimistic, ...d.recent] } : d,
    );
    setAnnounce(`${decision === "approve" ? "Approved" : "Denied"} ${item.person.name}’s request.`);
    try {
      const answer = decision === "approve" ? await api.approve(item.request.id, note || undefined) : await api.deny(item.request.id, note || undefined);
      setData((d: ApprovalsData | null) =>
        d ? { ...d, recent: d.recent.map((r) => (r.request.id === item.request.id ? { ...r, request: answer.request } : r)) } : d,
      );
    } catch (cause) {
      setData((d: ApprovalsData | null) => {
        if (!d) return d;
        const pending = d.pending.filter((p) => p.request.id !== item.request.id);
        pending.splice(Math.min(Math.max(index, 0), pending.length), 0, item);
        return { pending, recent: d.recent.filter((r) => r.request.id !== item.request.id) };
      });
      setCardErrors((e) => ({ ...e, [item.request.id]: messageOf(cause) }));
      setAnnounce(`That didn’t go through: ${messageOf(cause)}`);
    }
  }

  function replaceRecent(updated: DecidedItem) {
    setData((d: ApprovalsData | null) =>
      d ? { ...d, recent: d.recent.map((r) => (r.request.id === updated.request.id ? updated : r)) } : d,
    );
  }

  const count = data?.pending.length ?? 0;

  return (
    <div className="page page-wide approvals-page">
      <header className="page-head">
        <h1 className="page-title">Approvals</h1>
        <p className="page-sub">
          {data ? (count ? `${plural(count, "request is", "requests are")} waiting on you.` : "You’re all caught up.") : " "}
        </p>
      </header>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>

      {loading && !data ? <Loading label="Loading approvals" /> : null}
      {error && !data ? <ErrorLine message={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <>
          {data.pending.length === 0 ? (
            <div className="card all-clear">
              <span className="all-clear-mark">
                <CheckIcon size={26} />
              </span>
              <Empty title="Nothing waiting on you.">New requests from your team will show up here.</Empty>
            </div>
          ) : (
            groupByClass(data.pending, (i) => classOf(i.person)).map((group) =>
              group.items.length ? (
                <section key={group.key} className="class-group" aria-labelledby={`pending-${group.key}`}>
                  <h2 id={`pending-${group.key}`} className="group-heading">
                    {group.title} <span className="count">{group.items.length}</span>
                  </h2>
                  <ul className="queue">
                    {group.items.map((item) => (
                      <QueueCard
                        key={item.request.id}
                        item={item}
                        error={cardErrors[item.request.id] ?? ""}
                        isAdmin={me.role === "admin"}
                        meId={me.id}
                        onManagerSettled={() => void reload()}
                        onDecide={decide}
                      />
                    ))}
                  </ul>
                </section>
              ) : null,
            )
          )}

          <section className="card recent" aria-labelledby="recent-title">
            <h2 id="recent-title" className="card-title">
              Decided recently
            </h2>
            {data.recent.length === 0 ? (
              <Empty title="No decisions in the last 30 days." />
            ) : (
              groupByClass(data.recent, (i) => classOf(i.person)).map((group) =>
                group.items.length ? (
                  <div key={group.key} className="recent-group">
                    <h3 className="list-head">{group.title}</h3>
                    <ul className="recent-list">
                      {group.items.map((item) => (
                        <RecentRow key={item.request.id} item={item} onChanged={replaceRecent} />
                      ))}
                    </ul>
                  </div>
                ) : null,
              )
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function QueueCard({
  item,
  error,
  isAdmin,
  meId,
  onManagerSettled,
  onDecide,
}: {
  item: PendingItem;
  error: string;
  isAdmin: boolean;
  meId: string;
  onManagerSettled: () => void;
  onDecide: (item: PendingItem, decision: Decision, note: string) => void;
}) {
  const [mode, setMode] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const { request, person, balance } = item;
  const cls = classOf(person);
  const contractor = cls !== "employee";
  // The balance this kind comes out of (time off or sick days); held already, so "before" adds the days back.
  const matching = request.kind === "pto" ? balance.pto : request.kind === "sick" ? balance.sick : null;
  const after = matching?.tracked ? (request.kind === "pto" ? item.balance_after.pto : item.balance_after.sick) : null;
  const first = firstName(person.name);
  const noteId = `note-${request.id}`;

  return (
    <li className="card queue-card">
      <div className="queue-head">
        <Avatar name={person.name} />
        <div className="queue-who">
          <p className="queue-name">{person.name}</p>
          <p className="queue-sub">
            {person.team ? `${person.team} · ` : ""}asked {formatStampDay(request.created_at)}
          </p>
          <p className="queue-sub">Approver: {request.approver ? request.approver.name : "the admins"}</p>
        </div>
        <span className="queue-tags">
          <KindTag kind={request.kind} />
          <TypeChip cls={cls} />
        </span>
      </div>

      <div className={contractor ? "queue-facts" : "queue-facts is-two"}>
        <div className="fact">
          <span className="fact-label">Dates</span>
          <span className="fact-value">{formatRange(request.start_date, request.end_date)}</span>
        </div>
        <div className="fact">
          <span className="fact-label">Working days</span>
          <span className="fact-value">
            {formatNumber(request.days)}
            {request.days_overridden && typeof request.days_computed === "number" && request.days_computed !== request.days ? (
              <span className="fact-aside"> (counted {formatNumber(request.days_computed)})</span>
            ) : null}
            {request.half_day_start || request.half_day_end ? <span className="fact-aside"> incl. half day</span> : null}
            {person.pay_basis === "hourly" && request.hours ? <span className="fact-aside"> · {formatNumber(request.hours)} h</span> : null}
          </span>
        </div>
        {contractor ? (
        <div className="fact">
          <span className="fact-label">{request.kind === "sick" ? "Sick days" : request.kind === "pto" ? `${KIND_LABEL.pto} balance` : "Balance"}</span>
          <span className="fact-value">
            {matching?.unlimited ? (
              <span className="fact-aside">No limit</span>
            ) : after !== null ? (
              <>
                {formatNumber(after + request.days)}
                <span className="arrow" aria-label="becomes">
                  {" → "}
                </span>
                <span className={after < 0 ? "is-negative" : undefined}>{formatNumber(after)}</span>
              </>
            ) : (
              <span className="fact-aside">{matching?.tracked ? "Not affected" : request.kind === "pto" || request.kind === "sick" ? "Not tracked" : "Not affected"}</span>
            )}
          </span>
        </div>
        ) : null}
      </div>

      {item.overlaps.length ? <p className="queue-overlap">{overlapSentence(item.overlaps)}</p> : null}
      {request.note ? (
        <blockquote className="queue-note">
          <span className="visually-hidden">{first}’s note: </span>
          {request.note}
        </blockquote>
      ) : null}

      <ErrorLine message={error} />

      {isAdmin && item.pending_manager ? <ConfirmManager item={item} onSettled={onManagerSettled} /> : null}

      {isAdmin || request.approver?.id === meId ? <Remind item={item} /> : null}

      {mode === null ? (
        <div className="queue-actions">
          <button type="button" className="button button-primary" onClick={() => setMode("approve")}>
            <CheckIcon size={18} />
            Approve<span className="visually-hidden"> {person.name}’s request</span>
          </button>
          <button type="button" className="button button-quiet" onClick={() => setMode("deny")}>
            <CloseIcon size={18} />
            Deny<span className="visually-hidden"> {person.name}’s request</span>
          </button>
        </div>
      ) : (
        <div className={`decide decide-${mode}`} role="group" aria-label={mode === "approve" ? "Confirm approval" : "Confirm denial"}>
          <p className="decide-q">
            {mode === "approve"
              ? `Approve ${daysLabel(request.days).toLowerCase()} for ${first}?`
              : `Deny ${first}’s request?`}
          </p>
          <label className="label" htmlFor={noteId}>
            {mode === "approve" ? `Note to ${first}` : `Tell ${first} why`} <span className="optional">optional</span>
          </label>
          <textarea
            id={noteId}
            className="input"
            rows={2}
            maxLength={500}
            value={note}
            autoFocus
            placeholder={mode === "approve" ? "Enjoy!" : "We’re short that week. Could you move it a few days?"}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="queue-actions">
            <button
              type="button"
              className={mode === "approve" ? "button button-primary" : "button button-danger"}
              onClick={() => onDecide(item, mode, note.trim())}
            >
              {mode === "approve" ? "Yes, approve" : "Deny request"}
            </button>
            <button type="button" className="button button-quiet" onClick={() => setMode(null)}>
              Back
            </button>
          </div>
          <p className="hint">{first} will see your answer on their Home page.</p>
        </div>
      )}
    </li>
  );
}

function RecentRow({ item, onChanged }: { item: DecidedItem; onChanged: (item: DecidedItem) => void }) {
  const { request, person } = item;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hint = calendarHint(request.calendar.state, request.status);
  const cancellable = request.status === "approved" && request.end_date >= todayIso();

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const answer = await api.cancel(request.id);
      onChanged({ person, request: answer.request });
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="recent-row">
      <Avatar name={person.name} />
      <div className="recent-body">
        <div className="recent-top">
          <p className="recent-name">
            {person.name} <TypeChip cls={classOf(person)} />
          </p>
          <StatusChip status={request.status} />
        </div>
        <p className="recent-meta">
          <KindTag kind={request.kind} /> {formatRange(request.start_date, request.end_date)} · {daysWithCount(request)}
        </p>
        {request.decided_by ? (
          <p className="recent-meta muted">
            {request.status === "cancelled" ? "Cancelled" : request.status === "approved" ? "Approved" : "Denied"}
            {request.status !== "cancelled" ? ` by ${request.decided_by.name}` : ""}
            {request.decided_at && request.status !== "cancelled" ? ` on ${formatStampDay(request.decided_at)}` : ""}
            {request.decision_note ? ` · “${request.decision_note}”` : ""}
          </p>
        ) : null}
        {hint ? (
          <p className={`req-cal req-cal-${request.calendar.state}`}>
            <CalendarIcon size={16} />
            {hint}
          </p>
        ) : null}
        {cancellable ? (
          confirming ? (
            <div className="inline-confirm" role="group" aria-label="Cancel this time off">
              <span>Cancel {firstName(person.name)}’s time off? It comes off the team calendar.</span>
              <div className="inline-confirm-actions">
                <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => void cancel()}>
                  {busy ? "Cancelling…" : "Yes, cancel it"}
                </button>
                <button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="link-button req-cancel" onClick={() => setConfirming(true)}>
              Cancel this time off<span className="visually-hidden"> for {person.name}, {formatRange(request.start_date, request.end_date)}</span>
            </button>
          )
        ) : null}
        <ErrorLine message={error} />
      </div>
    </li>
  );
}

// A requester named someone as their manager in Slack. An admin confirms it
// once; after that the request goes to that manager like any other.
function ConfirmManager({ item, onSettled }: { item: PendingItem; onSettled: () => void }) {
  const pm = item.pending_manager!;
  const [busy, setBusy] = useState<"" | "yes" | "no">("");
  const [error, setError] = useState("");
  const first = firstName(pm.name);

  async function answer(yes: boolean) {
    setBusy(yes ? "yes" : "no");
    setError("");
    try {
      if (yes) await api.confirmManager(item.request.id);
      else await api.rejectManager(item.request.id);
      onSettled();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy("");
    }
  }

  return (
    <div className="confirm-manager" role="group" aria-label="Confirm their manager">
      <p>
        <strong>{item.person.name}</strong> named <strong title={pm.email}>{pm.name}</strong> as their manager.
      </p>
      <div className="inline-confirm-actions">
        <button type="button" className="button button-primary button-small" disabled={busy !== ""} onClick={() => void answer(true)}>
          {busy === "yes" ? "Saving…" : `Yes, ${first} is a manager`}
        </button>
        <button type="button" className="button button-quiet button-small" disabled={busy !== ""} onClick={() => void answer(false)}>
          {busy === "no" ? "Saving…" : "No"}
        </button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

// Nudge the approver again (admins, or the approver on their own items).
function Remind({ item }: { item: PendingItem }) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const [last, setLast] = useState(item.last_reminded_at ?? null);
  const who = item.request.approver?.name ?? "the admins";

  async function send() {
    setBusy(true);
    setLine("");
    setError("");
    try {
      const answer = await api.remind(item.request.id);
      setLast(answer.last_reminded_at ?? new Date().toISOString());
      setLine(`Sent to ${who} again.`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="remind">
      <button type="button" className="link-button" disabled={busy} onClick={() => void send()}>
        {busy ? "Sending…" : "Send again"}
        <span className="visually-hidden"> to {who}</span>
      </button>
      {last ? <span className="remind-when">reminded {formatWhen(last)}</span> : null}
      {line ? (
        <span className="remind-done" role="status">
          {line}
        </span>
      ) : null}
      {error ? (
        <span className="remind-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
