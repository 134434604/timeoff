// Team: one month at a time. Wide screens get a grid (a row per person, a
// column per day); phones get the same month as a list grouped by week,
// because 31 columns don't fit in a hand.

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Avatar, Empty, ErrorLine, KindTag, Loading, StatusChip, TypeChip } from "../components/Bits";
import { ChevronLeft, ChevronRight } from "../components/Icons";
import { api, type Overlap, type TeamCalendar } from "../lib/api";
import {
  addDays,
  daysInMonth,
  formatDay,
  formatMonth,
  formatRange,
  formatShort,
  isWeekend,
  monthOf,
  overlapsRange,
  parts,
  shiftMonth,
  startOfWeek,
  todayIso,
  weekdayLetter,
} from "../lib/dates";
import { useLoad } from "../lib/useLoad";
import { groupByClass, kindLabel } from "../lib/words";

export default function Team() {
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const asked = params.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : monthOf(today);
  const { data, error, loading, reload } = useLoad(() => api.teamCalendar(month), [month]);

  function go(to: string) {
    setParams(to === monthOf(today) ? {} : { month: to }, { replace: false });
  }

  const shown = data && data.month === month ? data : null;

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-sub">Who’s out, a month at a time.</p>
        </div>
        <div className="month-nav" role="group" aria-label="Choose month">
          <button type="button" className="icon-button" aria-label="Previous month" onClick={() => go(shiftMonth(month, -1))}>
            <ChevronLeft />
          </button>
          <p className="month-name" aria-live="polite">
            {formatMonth(month)}
          </p>
          <button type="button" className="icon-button" aria-label="Next month" onClick={() => go(shiftMonth(month, 1))}>
            <ChevronRight />
          </button>
          {month !== monthOf(today) ? (
            <button type="button" className="button button-quiet button-small" onClick={() => go(monthOf(today))}>
              This month
            </button>
          ) : null}
        </div>
      </header>

      {loading && !shown ? <Loading label="Loading the team calendar" /> : null}
      <ErrorLine message={error} onRetry={() => void reload()} />

      {shown ? (
        <>
          <Legend />
          <MonthGrid data={shown} today={today} />
          <WeekList data={shown} today={today} />
        </>
      ) : null}
    </div>
  );
}

export function Legend() {
  return (
    <ul className="legend" aria-label="Key">
      <li>
        <span className="swatch swatch-approved" aria-hidden="true" />
        Approved
      </li>
      <li>
        <span className="swatch swatch-pending" aria-hidden="true" />
        Waiting for approval
      </li>
      <li>
        <span className="swatch swatch-holiday" aria-hidden="true" />
        Holiday
      </li>
      <li className="legend-grid-only">
        <span className="swatch swatch-weekend" aria-hidden="true" />
        Weekend
      </li>
    </ul>
  );
}

function entryFor(entries: Overlap[], personId: string, day: string): Overlap | null {
  let found: Overlap | null = null;
  for (const e of entries) {
    if (e.person_id !== personId || !overlapsRange(e.start_date, e.end_date, day, day)) continue;
    if (!found || (found.status !== "approved" && e.status === "approved")) found = e;
  }
  return found;
}

export function MonthGrid({ data, today, compact = false }: { data: TeamCalendar; today: string; compact?: boolean }) {
  const days = daysInMonth(data.month);
  // When the grid is wider than its box (phones), start with today in view.
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = scroller.current;
    const cell = box?.querySelector<HTMLElement>("th.is-today");
    const name = box?.querySelector<HTMLElement>("th.mg-person");
    if (!box || !cell || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = Math.max(0, cell.offsetLeft - (name?.offsetWidth ?? 0) - 2 * cell.offsetWidth);
  }, [data.month, today]);
  const holidays = new Map(data.holidays.map((h) => [h.date, h.name]));
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name));
  // Employees, then contractors, each under its own subheading (when the server sends class).
  const groups = groupByClass(people, (p) => p.class);
  const grouped = people.some((p) => p.class);

  return (
    <div className={compact ? "card grid-card is-compact" : "card grid-card"}>
      {people.length === 0 ? (
        <Empty title="No one to show yet." />
      ) : (
        <div className="grid-scroll" ref={scroller} tabIndex={0} aria-label={`${formatMonth(data.month)} calendar, scrolls sideways`}>
          <table className="month-grid">
            <caption className="visually-hidden">Who’s out in {formatMonth(data.month)}</caption>
            <thead>
              <tr>
                <th scope="col" className="mg-person">
                  <span className="visually-hidden">Person</span>
                </th>
                {days.map((day) => {
                  const holiday = holidays.get(day);
                  const cls = ["mg-day", isWeekend(day) && "is-weekend", holiday && "is-holiday", day === today && "is-today"].filter(Boolean).join(" ");
                  return (
                    <th key={day} scope="col" className={cls} title={holiday ? `${formatDay(day)} · ${holiday}` : formatDay(day)}>
                      <span className="mg-wd" aria-hidden="true">
                        {weekdayLetter(day)}
                      </span>
                      <span className="mg-num">
                        <span className="visually-hidden">{formatShort(day).split(" ")[0]} </span>
                        {parts(day).d}
                      </span>
                      {holiday ? <span className="visually-hidden">, {holiday}</span> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) => [
                grouped && group.items.length ? (
                  <tr key={`h-${group.key}`} className="mg-group">
                    <th scope="rowgroup" colSpan={days.length + 1}>
                      <span className="mg-group-label">{group.title}</span>
                    </th>
                  </tr>
                ) : null,
                ...group.items.map((person) => (
                <tr key={person.id}>
                  <th scope="row" className="mg-person">
                    <span className="mg-person-inner">
                      <Avatar name={person.name} />
                      <span className="mg-name">{person.name}</span>
                      <TypeChip cls={person.class} />
                    </span>
                  </th>
                  {days.map((day) => {
                    const entry = entryFor(data.entries, person.id, day);
                    const holiday = holidays.has(day);
                    const weekend = isWeekend(day);
                    const prev = entry ? entryFor(data.entries, person.id, addDays(day, -1)) : null;
                    const next = entry ? entryFor(data.entries, person.id, addDays(day, 1)) : null;
                    const cls = [
                      "mg-cell",
                      weekend && "is-weekend",
                      holiday && "is-holiday",
                      day === today && "is-today",
                      entry && `has-${entry.status}`,
                      entry && (!prev || prev.start_date !== entry.start_date) && "is-start",
                      entry && (!next || next.start_date !== entry.start_date) && "is-end",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const label = entry
                      ? `${kindLabel(entry.kind)}, ${formatRange(entry.start_date, entry.end_date)}${entry.status === "pending" ? ", waiting for approval" : ""}`
                      : "";
                    return (
                      <td key={day} className={cls} title={entry ? `${person.name} · ${label}` : undefined}>
                        {entry ? <span className="mg-bar">{(!prev || prev.start_date !== entry.start_date) ? <span className="visually-hidden">{label}</span> : null}</span> : null}
                      </td>
                    );
                  })}
                </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {data.holidays.length ? (
        <p className="grid-holidays">
          <span className="swatch swatch-holiday" aria-hidden="true" />
          {data.holidays.map((h) => `${formatShort(h.date)} ${h.name}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function WeekList({ data, today }: { data: TeamCalendar; today: string }) {
  const classById = new Map(data.people.map((p) => [p.id, p.class]));
  const hasClasses = data.people.some((p) => p.class);
  const weeks = useMemo(() => {
    const days = daysInMonth(data.month);
    const first = days[0];
    const last = days[days.length - 1];
    const out: Array<{ from: string; to: string; entries: Overlap[]; holidays: TeamCalendar["holidays"] }> = [];
    for (let monday = startOfWeek(first); monday <= last; monday = addDays(monday, 7)) {
      const from = monday < first ? first : monday;
      const sunday = addDays(monday, 6);
      const to = sunday > last ? last : sunday;
      out.push({
        from,
        to,
        entries: data.entries
          .filter((e) => overlapsRange(e.start_date, e.end_date, from, to))
          .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name)),
        holidays: data.holidays.filter((h) => h.date >= from && h.date <= to),
      });
    }
    return out;
  }, [data]);

  return (
    <div className="week-list">
      {weeks.map((week) => {
        const now = overlapsRange(week.from, week.to, today, today);
        return (
          <section key={week.from} className={now ? "card week is-now" : "card week"} aria-label={`Week of ${formatRange(week.from, week.to)}`}>
            <h2 className="week-head">
              {formatRange(week.from, week.to).replace(/^\w{3}, /, "")}
              {now ? <span className="week-now">This week</span> : null}
            </h2>
            {week.holidays.map((h) => (
              <p key={h.date} className="week-holiday">
                <span className="swatch swatch-holiday" aria-hidden="true" />
                {formatDay(h.date)} · {h.name}
              </p>
            ))}
            {week.entries.length === 0 ? (
              <p className="week-empty">Everyone’s in.</p>
            ) : (
              groupByClass(week.entries, (e) => classById.get(e.person_id)).map((group) =>
                group.items.length ? (
              <div key={group.key}>
                {hasClasses ? <h3 className="list-head week-group">{group.title}</h3> : null}
              <ul className="week-entries">
                {group.items.map((e) => (
                  <li key={`${e.person_id}-${e.start_date}`} className={`week-entry is-${e.status}`}>
                    <Avatar name={e.name} />
                    <div className="week-entry-text">
                      <span className="out-name">{e.name}</span>
                      <span className="out-range">
                        {formatRange(e.start_date, e.end_date)} · <KindTag kind={e.kind} />
                      </span>
                    </div>
                    {e.status === "pending" ? <StatusChip status="pending" /> : null}
                  </li>
                ))}
              </ul>
              </div>
                ) : null,
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
