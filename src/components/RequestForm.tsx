// "Request time off": type, dates, working days, manager, a note. While the dates change
// it asks the server for a preview (debounced) and shows the day count, the
// balance after, who else is out, and any warnings, before anything is sent.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, messageOf, type BalanceAfter, type Balances, type Kind, type Person, type PersonRef, type Preview, type TimeOffRequest } from "../lib/api";
import { addDays, daysLabel, formatNumber, formatRange, isIsoDate, todayIso } from "../lib/dates";
import { useSession } from "../lib/session";
import { KIND_LABEL, firstName } from "../lib/words";
import { ErrorLine } from "./Bits";
import { AlertIcon, CheckIcon } from "./Icons";

// Used only when the server doesn't send /api/me.kinds yet.
const FALLBACK_KINDS: Kind[] = ["pto", "sick", "unpaid", "loa"];

function kindHint(kind: Kind, balance: Balances): string {
  switch (kind) {
    case "pto":
      return balance.pto.unlimited ? "Paid time off." : "Comes out of your SMTO balance.";
    case "sick":
      return balance.sick.unlimited ? "Paid sick time." : balance.sick.tracked ? "Comes out of your sick days." : "Sick time.";
    case "unpaid":
      return "Time off without pay. Doesn’t come out of a balance.";
    case "loa":
      return "A leave of absence. Doesn’t come out of a balance.";
    default:
      return "Lets your manager and team know you’re not working these days.";
  }
}

type PreviewState = { status: "idle" } | { status: "loading"; last: Preview | null } | { status: "ready"; data: Preview } | { status: "error"; message: string };

export function overlapSentence(overlaps: Preview["overlaps"]): string {
  if (overlaps.length === 0) return "";
  const names = overlaps.map((o) => `${o.name} ${formatRange(o.start_date, o.end_date)}${o.status === "pending" ? " (not approved yet)" : ""}`);
  const lead = overlaps.length === 1 ? "1 teammate is also out then" : `${overlaps.length} teammates are also out then`;
  return `${lead}: ${names.join(", ")}.`;
}

const ADMINS = "__admins"; // the select's value for "no manager: the admins decide"

export default function RequestForm({
  person,
  balance,
  onSubmitted,
}: {
  person: Person;
  balance: Balances;
  onSubmitted: (request: TimeOffRequest, balance: Balances) => void;
}) {
  const { kinds: allowed } = useSession();
  const kinds: Kind[] = allowed ?? FALLBACK_KINDS;
  const [kind, setKind] = useState<Kind>(kinds[0]);
  // The date inputs are uncontrolled: a native date field reports "" while
  // it's being typed into, and writing that back would wipe what's shown.
  // The refs hold the fields; start/end mirror their last complete value.
  const startRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLInputElement | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  // Manager: required. Preselected to my manager; with none, a choice still has to be made.
  const [approvers, setApprovers] = useState<Array<PersonRef & { team: string | null }>>([]);
  const [defaultId, setDefaultId] = useState<string | null>(person.manager?.id ?? null);
  const [approverId, setApproverId] = useState(person.manager?.id ?? "");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  // How many working days: required, filled from the preview's count until the person types their own.
  const [daysText, setDaysText] = useState("");
  const [daysEdited, setDaysEdited] = useState(false);
  const [daysTouched, setDaysTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<TimeOffRequest | null>(null);
  const ticket = useRef(0);
  const ids = useId();

  const typedDays = Number(daysText);
  const daysValid = daysText.trim() !== "" && Number.isFinite(typedDays) && typedDays >= 0.5 && Number.isInteger(typedDays * 2);
  const daysForPreview = daysEdited && daysValid ? typedDays : undefined;
  const datesReady = isIsoDate(start) && isIsoDate(end) && end >= start;
  const earliest = addDays(todayIso(), -30);
  const managerChosen = approverId !== "";
  const showDaysError = (daysTouched || tried) && !daysValid;

  useEffect(() => {
    let live = true;
    api
      .approvers()
      .then((answer) => {
        if (!live) return;
        setApprovers(answer.approvers);
        setDefaultId(answer.default_id);
        setApproverId(answer.default_id ?? "");
      })
      .catch(() => live && setApprovers([]));
    return () => {
      live = false;
    };
  }, []);

  // Ask for a preview a moment after the dates settle; a newer answer wins.
  useEffect(() => {
    if (!datesReady) {
      setPreview({ status: "idle" });
      return;
    }
    const mine = ++ticket.current;
    setPreview((current) => ({ status: "loading", last: current.status === "ready" ? current.data : current.status === "loading" ? current.last : null }));
    const timer = window.setTimeout(() => {
      api
        .preview({ start_date: start, end_date: end, kind, ...(daysForPreview !== undefined ? { days_requested: daysForPreview } : {}) })
        .then((data) => {
          if (mine !== ticket.current) return;
          setPreview({ status: "ready", data });
          if (!daysEdited) setDaysText(String(data.days_computed ?? data.days));
        })
        .catch((cause) => {
          if (mine === ticket.current) setPreview({ status: "error", message: messageOf(cause) });
        });
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, kind, datesReady, daysForPreview]);

  // New dates mean a new count: forget a typed number (only the number; the dates stay).
  useEffect(() => {
    setDaysEdited(false);
  }, [start, end]);

  // Read a date field. An empty value while the field still holds a partial
  // date (badInput) means "being typed": keep the last complete value.
  function readDate(input: HTMLInputElement): string | null {
    if (input.value === "" && input.validity.badInput) return null;
    return input.value;
  }

  function changeStart(input: HTMLInputElement) {
    const value = readDate(input);
    if (value === null) return;
    setStart(value);
    if (value && endRef.current && (!end || end < value)) {
      endRef.current.value = value;
      setEnd(value);
    }
    setError("");
  }

  function changeEnd(input: HTMLInputElement) {
    const value = readDate(input);
    if (value === null) return;
    setEnd(value);
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!datesReady) {
      setError(start && end && end < start ? "The last day can’t be before the first day." : "Pick the first and last day.");
      return;
    }
    if (!daysValid) {
      setError("");
      document.getElementById(`${ids}-days`)?.focus();
      return;
    }
    if (approvers.length > 0 && !managerChosen) {
      setError("Choose a manager.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const answer = await api.submit({
        kind,
        start_date: start,
        end_date: end,
        note: note.trim() || undefined,
        approver_id: approverId && approverId !== ADMINS ? approverId : undefined,
        days_requested: typedDays,
      });
      setSent(answer.request);
      onSubmitted(answer.request, answer.balance);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    setSent(null);
    setStart("");
    setEnd("");
    setDaysText("");
    setDaysEdited(false);
    setDaysTouched(false);
    setTried(false);
    setNote("");
    setKind(kinds[0]);
    setApproverId(defaultId ?? "");
    setPreview({ status: "idle" });
  }

  const chosen = approverId && approverId !== ADMINS ? (approvers.find((a) => a.id === approverId) ?? person.manager ?? null) : null;
  const manager = chosen ? firstName(chosen.name) : null;

  if (sent) {
    return (
      <section className="card request-card" aria-labelledby={`${ids}-done`}>
        <div className="sent" role="status">
          <span className="sent-mark">
            <CheckIcon size={22} />
          </span>
          <div>
            <h2 id={`${ids}-done`} className="card-title">
              {sent.status === "approved" ? "You’re all set" : manager ? `Sent to ${manager}` : "Request sent"}
            </h2>
            <p className="muted">
              {KIND_LABEL[sent.kind]}, {formatRange(sent.start_date, sent.end_date)} · {daysLabel(sent.days)}.{" "}
              {sent.status === "pending" ? "It’s waiting for approval. The answer will show up below." : null}
            </p>
          </div>
        </div>
        <button type="button" className="button button-quiet" onClick={startOver}>
          Request more time off
        </button>
      </section>
    );
  }

  const shown = preview.status === "ready" ? preview.data : preview.status === "loading" ? preview.last : null;
  const counted = shown ? (shown.days_computed ?? null) : null;
  const left = afterFor(kind, shown?.balance_after ?? null, balance);

  return (
    <section className="card request-card" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="card-title">
        Request time off
      </h2>
      <form onSubmit={submit} noValidate>
        {kinds.length > 1 ? (
          <fieldset className="field">
            <legend className="label">Type</legend>
            <div className="segmented">
              {kinds.map((k) => (
                <label key={k} className={kind === k ? "segment is-on" : "segment"}>
                  <input type="radio" name={`${ids}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
                  <span>{KIND_LABEL[k]}</span>
                </label>
              ))}
            </div>
            <p className="hint">{kindHint(kind, balance)}</p>
          </fieldset>
        ) : (
          <p className="hint hint-lead">{kindHint(kind, balance)}</p>
        )}

        <div className="date-pair">
          <div className="field">
            <label className="label" htmlFor={`${ids}-start`}>
              First day
            </label>
            <input
              id={`${ids}-start`}
              ref={startRef}
              type="date"
              className="input"
              min={earliest}
              onChange={(e) => changeStart(e.currentTarget)}
              onInput={(e) => changeStart(e.currentTarget)}
              required
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${ids}-end`}>
              Last day
            </label>
            <input
              id={`${ids}-end`}
              ref={endRef}
              type="date"
              className="input"
              min={start || earliest}
              onChange={(e) => changeEnd(e.currentTarget)}
              onInput={(e) => changeEnd(e.currentTarget)}
              required
            />
          </div>
        </div>

        <div className="field days-field">
          <label className="label" htmlFor={`${ids}-days`}>
            How many working days?
          </label>
          <input
            id={`${ids}-days`}
            className={showDaysError ? "input input-days is-invalid" : "input input-days"}
            type="number"
            inputMode="decimal"
            min={0.5}
            step={0.5}
            placeholder="0.0"
            required
            aria-invalid={showDaysError}
            aria-describedby={`${ids}-days-hint`}
            value={daysText}
            onChange={(e) => {
              setDaysText(e.target.value);
              setDaysEdited(true);
            }}
            onBlur={() => setDaysTouched(true)}
          />
          {showDaysError ? (
            <p className="field-error" id={`${ids}-days-hint`} role="alert">
              Enter the number of working days, like 1.5
            </p>
          ) : counted !== null && daysEdited && daysValid && typedDays !== counted ? (
            <p className="hint" id={`${ids}-days-hint`}>
              Counted {formatNumber(counted)} from the dates.{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setDaysText(String(counted));
                  setDaysEdited(false);
                }}
              >
                Use {formatNumber(counted)}
              </button>
            </p>
          ) : (
            <p className="hint" id={`${ids}-days-hint`}>
              Enter in 0.00 format, like 1.5 for a day and a half.
            </p>
          )}
        </div>

        {datesReady ? (
          <div className={preview.status === "loading" ? "preview is-loading" : "preview"} aria-live="polite">
            {preview.status === "error" ? (
              <p className="preview-error">
                <AlertIcon size={18} />
                <span>{preview.message}</span>
              </p>
            ) : shown ? (
              <>
                <div className="preview-numbers">
                  <div className="preview-stat">
                    <span className="preview-value">{formatNumber(shown.days)}</span>
                    <span className="preview-unit">{shown.days === 1 ? "working day" : "working days"}</span>
                  </div>
                  {left ? (
                    <div className="preview-stat">
                      <span className={left.value < 0 ? "preview-value is-negative" : "preview-value"}>{formatNumber(left.value)}</span>
                      <span className="preview-unit">{left.label}</span>
                    </div>
                  ) : null}
                </div>
                <p className="preview-note">Weekends and holidays aren’t counted.</p>
                {shown.overlaps.length > 0 ? <p className="preview-overlap">{overlapSentence(shown.overlaps)}</p> : null}
                {shown.warnings.length > 0 ? (
                  <ul className="preview-warnings">
                    {shown.warnings.map((w) => (
                      <li key={w}>
                        <AlertIcon size={16} />
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="preview-note">Counting days…</p>
            )}
          </div>
        ) : null}

        {approvers.length > 0 ? (
          <div className="field">
            <label className="label" htmlFor={`${ids}-approver`}>
              Manager
            </label>
            <select
              id={`${ids}-approver`}
              className={tried && !managerChosen ? "input is-invalid" : "input"}
              value={approverId}
              required
              aria-invalid={tried && !managerChosen}
              onChange={(e) => setApproverId(e.target.value)}
            >
              {defaultId === null ? (
                <>
                  <option value="" disabled>
                    Choose who approves…
                  </option>
                  <option value={ADMINS}>The admins</option>
                </>
              ) : null}
              {approvers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.id === defaultId ? " (your manager)" : a.team ? ` · ${a.team}` : ""}
                </option>
              ))}
            </select>
            {tried && !managerChosen ? (
              <p className="field-error" role="alert">
                Choose a manager.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label className="label" htmlFor={`${ids}-note`}>
            Note <span className="optional">optional</span>
          </label>
          <textarea
            id={`${ids}-note`}
            className="input"
            rows={2}
            maxLength={500}
            value={note}
            placeholder="Family trip, appointment, anything your manager should know"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <ErrorLine message={error} />

        <div className="form-actions">
          <button type="submit" className="button button-primary button-wide" disabled={sending || preview.status === "error"}>
            {sending ? "Sending…" : manager ? `Send to ${manager}` : "Send request"}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The balance a request of this kind comes out of, and what it would leave. */
export function afterFor(kind: Kind, after: BalanceAfter | null, balance: Balances): { value: number; label: string } | null {
  if (!after) return null;
  if (kind === "pto" && balance.pto.tracked && after.pto !== null) return { value: after.pto, label: "days left after" };
  if (kind === "sick" && balance.sick.tracked && after.sick !== null) return { value: after.sick, label: "sick days left after" };
  return null;
}
