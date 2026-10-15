// Home: what I have, asking for more, what I've asked for, who's out, and
// the holidays coming up. Everyone lands here.

import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Empty, ErrorLine, KindTag, Loading, StatusChip, Tile, TypeChip } from "../components/Bits";
import { CalendarIcon } from "../components/Icons";
import RequestForm from "../components/RequestForm";
import { Legend, MonthGrid } from "./Team";
import { api, messageOf, type Balance, type Balances, type HomeData, type HomeTeam, type UsedSpan, type Holiday, type Overlap, type TimeOffRequest } from "../lib/api";
import { daysLabel, formatDay, formatMonth, formatNumber, formatRange, formatStampDay, overlapsRange, parts, todayIso } from "../lib/dates";
import { useMe, useSession } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { KIND_LABEL, SLACK_LINE, calendarHint, daysWithCount, firstName } from "../lib/words";

export default function Home() {
  const me = useMe();
  const { data, setData, error, loading, reload } = useLoad(() => api.home(), []);
  const slack = useSlackOn();

  function patch(request: TimeOffRequest, balance: Balances) {
    setData((current: HomeData | null) => {
      if (!current) return current;
      const exists = current.requests.some((r) => r.id === request.id);
      const requests = exists ? current.requests.map((r) => (r.id === request.id ? request : r)) : [request, ...current.requests];
      return { ...current, requests, balance };
    });
  }

  const today = todayIso();
  const longToday = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Hi, {firstName(me.name)}</h1>
        <p className="page-sub">{longToday}</p>
      </header>

      {loading && !data ? <Loading label="Loading your time off" /> : null}
      {error && !data ? <ErrorLine message={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <div className="home-grid">
          <div className="home-balance">
            <BalanceCards balance={data.balance} contractor={data.person.worker_type === "contractor"} used={data.used_days} />
          </div>
          <div className="home-form">
            <RequestForm person={data.person} balance={data.balance} onSubmitted={patch} />
            {slack ? <p className="slack-line">{SLACK_LINE}</p> : null}
          </div>
          {data.team ? null : (
            <div className="home-out">
              <TeamOut entries={data.team_out} today={today} />
            </div>
          )}
          <div className="home-requests">
            <MyRequests requests={data.requests} today={today} onChanged={patch} />
          </div>
          <div className="home-holidays">
            <Holidays holidays={data.holidays} today={today} />
          </div>
        </div>
      ) : null}

      {data?.team ? <TeamSection team={data.team} today={today} /> : null}
    </div>
  );
}

// Admins read Slack's state from settings; everyone else from /api/me.
function useSlackOn(): boolean {
  const me = useMe();
  const { slackAvailable } = useSession();
  const admin = me.role === "admin";
  const [settingsOn, setSettingsOn] = useState(false);
  useEffect(() => {
    if (!admin) return;
    let live = true;
    api
      .settings()
      .then((s) => live && setSettingsOn(s.slack.on === true))
      .catch(() => live && setSettingsOn(false));
    return () => {
      live = false;
    };
  }, [admin]);
  return admin ? settingsOn : slackAvailable;
}

// ------------------------------------------------------------- balance --

// SMTO and sick. With no limit (employees), a card says how much was used this
// year and lists the days; with a limit (contractors), the balance card. An
// untracked balance is hidden; a quiet line says when sick time isn't tracked.
function BalanceCards({
  balance,
  contractor,
  used,
}: {
  balance: Balances;
  contractor: boolean;
  used?: HomeData["used_days"];
}) {
  const pto = balance.pto;
  const sick = balance.sick;
  const ptoCard = pto.unlimited ? (
    <UsedCard title={`${KIND_LABEL.pto} used this year`} used={pto.used} pending={pto.pending} spans={used?.pto ?? []} note={`No limit on ${KIND_LABEL.pto}.`} />
  ) : pto.tracked ? (
    <BalanceCard balance={pto} title={KIND_LABEL.pto} unitWord="day" />
  ) : null;
  const sickRelevant = sick.used > 0 || sick.pending > 0 || (used?.sick.length ?? 0) > 0;
  const sickCard = sick.unlimited ? (
    sickRelevant ? (
      <UsedCard title="Sick days used this year" used={sick.used} pending={sick.pending} spans={used?.sick ?? []} compact />
    ) : null
  ) : sick.tracked ? (
    <BalanceCard balance={sick} title="Sick days" unitWord="sick day" foot="Sick days don’t carry over to next year." compact={pto.tracked} />
  ) : null;
  if (!ptoCard && !sickCard) {
    return pto.unlimited || sick.unlimited ? null : <NoBalanceCard contractor={contractor} />;
  }
  return (
    <div className="balance-stack">
      {ptoCard}
      {sickCard}
      {!sickCard && !sick.unlimited && !sick.tracked && pto.tracked ? <p className="balance-quiet">No sick balance is tracked.</p> : null}
    </div>
  );
}

function UsedCard({
  title,
  used,
  pending,
  spans,
  note,
  compact = false,
}: {
  title: string;
  used: number;
  pending: number;
  spans: UsedSpan[];
  note?: string;
  compact?: boolean;
}) {
  const titleId = useId();
  const [all, setAll] = useState(false);
  const sorted = [...spans].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const shown = all ? sorted : sorted.slice(-5);
  return (
    <section className={compact ? "card balance-card used-card is-compact" : "card balance-card used-card"} aria-labelledby={titleId}>
      <h2 id={titleId} className="card-kicker">
        {title}
      </h2>
      <p className="balance-big">
        <span className="balance-number">{formatNumber(used)}</span>
        <span className="balance-unit">{used === 1 ? "day" : "days"}</span>
      </p>
      {pending > 0 ? <p className="muted small">{daysLabel(pending)} more waiting for approval.</p> : null}
      {sorted.length ? (
        <>
          <ul className="used-list">
            {shown.map((s) => (
              <li key={s.request_id ?? `${s.start_date}-${s.end_date}`}>
                <span>{formatRange(s.start_date, s.end_date)}</span>
                <span className="used-days">{daysLabel(s.days)}</span>
              </li>
            ))}
          </ul>
          {sorted.length > 5 ? (
            <button type="button" className="link-button list-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${sorted.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted small">None yet this year.</p>
      )}
      {note ? <p className="balance-foot">{note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------- your team --

function TeamSection({ team, today }: { team: HomeTeam; today: string }) {
  const classById = new Map(team.month.people.map((p) => [p.id, p.class]));
  const soon = [...team.out_soon].sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, 8);
  return (
    <section className="team-section" aria-labelledby="your-team">
      <header className="team-head">
        <h2 id="your-team" className="section-heading">
          Your team
        </h2>
        <p className="page-sub">{team.scope === "everyone" ? "Everyone" : "Only your reports and people who named you"}</p>
      </header>
      <ul className="tiles" aria-label="Your team at a glance">
        <Tile label="Out today" value={team.out_today} unit={team.out_today === 1 ? "person" : "people"} to="/team" />
        <Tile label="Out in the next 30 days" value={team.out_next_30} unit={team.out_next_30 === 1 ? "person" : "people"} to="/team" />
        <Tile label="Waiting for approval" value={team.pending} unit={team.pending === 1 ? "request" : "requests"} to="/approvals" />
        <Tile label={`Unused ${KIND_LABEL.pto}`} value={team.unused_pto_total} unit="days" to="/insights" />
      </ul>
      <div className="team-strip">
        <div className="team-strip-head">
          <h3 className="card-title">{formatMonth(team.month.month)}</h3>
          <Link to="/team" className="link-button">
            Open the team calendar
          </Link>
        </div>
        <Legend />
        <MonthGrid data={team.month} today={today} compact />
      </div>
      <section className="card" aria-labelledby="team-soon">
        <div className="team-strip-head">
          <h3 id="team-soon" className="card-title">
            Who’s out soon
          </h3>
          <Link to="/insights" className="link-button">
            See insights
          </Link>
        </div>
        {soon.length === 0 ? (
          <Empty title="Nobody is out in the next while." />
        ) : (
          <ul className="soon-list">
            {soon.map((o) => (
              <li key={`${o.person_id}-${o.start_date}`}>
                <Avatar name={o.name} />
                <div className="out-text">
                  <span className="out-name">
                    {o.name} <TypeChip cls={classById.get(o.person_id)} />
                  </span>
                  <span className="out-range">
                    {overlapsRange(o.start_date, o.end_date, today, today) ? `Out now, through ${formatDay(o.end_date)}` : formatRange(o.start_date, o.end_date)}
                  </span>
                </div>
                <KindTag kind={o.kind} />
                {o.status === "pending" ? <StatusChip status="pending" /> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="team-links">
          <Link to="/approvals">Approvals</Link>
          <Link to="/team">Team calendar</Link>
          <Link to="/insights">Insights</Link>
        </p>
      </section>
    </section>
  );
}

function NoBalanceCard({ contractor }: { contractor: boolean }) {
  {
    return (
      <section className="card balance-card is-untracked" aria-labelledby="balance-title">
        <h2 id="balance-title" className="card-kicker">
          Your balance
        </h2>
        <p className="balance-none">No balance is tracked for you</p>
        <p className="muted small">
          {contractor
            ? "Mark the days you won’t be working and your manager will see them."
            : "You can still ask for time off. Your manager approves each request."}
        </p>
      </section>
    );
  }
}

function BalanceCard({
  balance,
  title,
  unitWord,
  foot,
  compact = false,
}: {
  balance: Balance;
  title: string;
  unitWord: string;
  foot?: string;
  compact?: boolean;
}) {
  const titleId = useId();
  // This card is only for limited balances, where these are numbers.
  const available = balance.available ?? 0;
  const avail = Math.max(available, 0);
  const total = Math.max(balance.used + balance.pending + avail, 0.0001);
  const pct = (n: number) => `${(Math.max(n, 0) / total) * 100}%`;
  const extras: string[] = [];
  if (balance.carried_over) extras.push(`${daysLabel(balance.carried_over).toLowerCase()} carried over from ${balance.year - 1}`);
  if (balance.adjustments) extras.push(`${balance.adjustments > 0 ? "+" : ""}${formatNumber(balance.adjustments)} adjusted by your admin`);
  const accruing = (balance.accrued ?? 0) < (balance.allowance ?? 0);

  return (
    <section className={compact ? "card balance-card is-compact" : "card balance-card"} aria-labelledby={titleId}>
      <h2 id={titleId} className="card-kicker">
        {title}
      </h2>
      <p className="balance-big">
        <span className={available < 0 ? "balance-number is-negative" : "balance-number"}>{formatNumber(available)}</span>
        <span className="balance-unit">{available === 1 ? unitWord : `${unitWord}s`}</span>
      </p>
      <div className="meter" aria-hidden="true">
        <span className="meter-used" style={{ width: pct(balance.used) }} />
        <span className="meter-pending" style={{ width: pct(balance.pending) }} />
        <span className="meter-free" style={{ width: pct(avail) }} />
      </div>
      <dl className="balance-stats">
        <div>
          <dt>
            <span className="dot dot-used" aria-hidden="true" />
            Used
          </dt>
          <dd>{formatNumber(balance.used)}</dd>
        </div>
        <div>
          <dt>
            <span className="dot dot-pending" aria-hidden="true" />
            Waiting
          </dt>
          <dd>{formatNumber(balance.pending)}</dd>
        </div>
        <div>
          <dt>{balance.year} allowance</dt>
          <dd>{formatNumber(balance.allowance)}</dd>
        </div>
      </dl>
      {accruing || extras.length || foot ? (
        <p className="balance-foot">
          {accruing ? `You’ve earned ${formatNumber(balance.accrued)} of ${formatNumber(balance.allowance)} so far this year. ` : ""}
          {extras.length ? `Includes ${extras.join(" and ")}. ` : ""}
          {foot ?? ""}
        </p>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------- my requests --

function canCancel(request: TimeOffRequest, today: string): boolean {
  if (request.status === "pending") return true;
  return request.status === "approved" && today < request.start_date;
}

function MyRequests({
  requests,
  today,
  onChanged,
}: {
  requests: TimeOffRequest[];
  today: string;
  onChanged: (request: TimeOffRequest, balance: Balances) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { open, past } = useMemo(() => {
    const open: TimeOffRequest[] = [];
    const past: TimeOffRequest[] = [];
    for (const r of requests) {
      if ((r.status === "pending" || r.status === "approved") && r.end_date >= today) open.push(r);
      else past.push(r);
    }
    open.sort((a, b) => a.start_date.localeCompare(b.start_date));
    return { open, past };
  }, [requests, today]);
  const pastShown = showAll ? past : past.slice(0, 4);

  return (
    <section className="card" aria-labelledby="mine-title">
      <h2 id="mine-title" className="card-title">
        My requests
      </h2>
      {requests.length === 0 ? (
        <Empty title="You haven’t asked for any time off yet.">When you do, it shows up here with its answer.</Empty>
      ) : (
        <>
          {open.length ? (
            <>
              <h3 className="list-head">Coming up</h3>
              <ul className="req-list">
                {open.map((r) => (
                  <RequestRow key={r.id} request={r} today={today} onChanged={onChanged} />
                ))}
              </ul>
            </>
          ) : null}
          {past.length ? (
            <>
              <h3 className="list-head">Earlier</h3>
              <ul className="req-list">
                {pastShown.map((r) => (
                  <RequestRow key={r.id} request={r} today={today} onChanged={onChanged} />
                ))}
              </ul>
              {past.length > pastShown.length || showAll ? (
                <button type="button" className="link-button list-more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? "Show fewer" : `Show ${past.length - pastShown.length} more`}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function RequestRow({
  request,
  today,
  onChanged,
}: {
  request: TimeOffRequest;
  today: string;
  onChanged: (request: TimeOffRequest, balance: Balances) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { m, d } = parts(request.start_date);
  const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const hint = calendarHint(request.calendar.state, request.status);
  const decided = request.status === "approved" || request.status === "denied";

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const answer = await api.cancel(request.id);
      onChanged(answer.request, answer.balance);
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`req req-${request.status}`}>
      <div className="req-date" aria-hidden="true">
        <span className="req-month">{month}</span>
        <span className="req-day">{d}</span>
      </div>
      <div className="req-body">
        <div className="req-top">
          <p className="req-range">{formatRange(request.start_date, request.end_date)}</p>
          <StatusChip status={request.status} />
        </div>
        <p className="req-meta">
          <KindTag kind={request.kind} /> <span>{daysWithCount(request)}</span>
          {request.half_day_start || request.half_day_end ? <span className="muted"> · includes a half day</span> : null}
        </p>
        {request.note ? <p className="req-note">“{request.note}”</p> : null}
        {request.status === "pending" || request.approver ? (
          <p className="req-approver">Approver: {request.approver ? request.approver.name : "the admins"}</p>
        ) : null}
        {decided && request.decided_by ? (
          <p className="req-decision">
            {request.status === "approved" ? "Approved" : "Denied"} by {request.decided_by.name}
            {request.decided_at ? ` on ${formatStampDay(request.decided_at)}` : ""}
            {request.decision_note ? <span className="req-decision-note">“{request.decision_note}”</span> : null}
          </p>
        ) : null}
        {hint ? (
          <p className={`req-cal req-cal-${request.calendar.state}`}>
            <CalendarIcon size={16} />
            {hint}
          </p>
        ) : null}
        {canCancel(request, today) ? (
          confirming ? (
            <div className="inline-confirm" role="group" aria-label="Cancel this request">
              <span>{request.status === "approved" ? "Cancel this time off? Your manager will be told." : "Take back this request?"}</span>
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
              Cancel request<span className="visually-hidden"> for {formatRange(request.start_date, request.end_date)}</span>
            </button>
          )
        ) : null}
        <ErrorLine message={error} />
      </div>
    </li>
  );
}

// ------------------------------------------------------------ team out --

function TeamOut({ entries, today }: { entries: Overlap[]; today: string }) {
  const sorted = [...entries].sort((a, b) => a.start_date.localeCompare(b.start_date));
  return (
    <section className="card" aria-labelledby="out-title">
      <h2 id="out-title" className="card-title">
        Who’s out soon
      </h2>
      {sorted.length === 0 ? (
        <Empty title="Nobody on your team is out in the next two months." />
      ) : (
        <ul className="out-strip">
          {sorted.map((o) => {
            const now = overlapsRange(o.start_date, o.end_date, today, today);
            return (
              <li key={`${o.person_id}-${o.start_date}`} className={now ? "out is-now" : "out"}>
                <Avatar name={o.name} />
                <div className="out-text">
                  <span className="out-name">{o.name}</span>
                  <span className="out-range">{now ? `Out now, through ${formatDay(o.end_date)}` : formatRange(o.start_date, o.end_date)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------ holidays --

function Holidays({ holidays, today }: { holidays: Holiday[]; today: string }) {
  const upcoming = holidays.filter((h) => h.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  return (
    <section className="card" aria-labelledby="holidays-title">
      <h2 id="holidays-title" className="card-title">
        Company holidays
      </h2>
      {upcoming.length === 0 ? (
        <Empty title="No holidays are on the calendar yet." />
      ) : (
        <ul className="holiday-list">
          {upcoming.map((h) => (
            <li key={h.date}>
              <span className="holiday-date">{formatDay(h.date)}</span>
              <span className="holiday-name">{h.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
