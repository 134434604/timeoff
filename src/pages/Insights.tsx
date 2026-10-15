// Insights (admins: the company; managers: their team) for one year: four
// numbers, days off by month, by team, and by person. Each block switches
// between a chart and a table (remembered per block), and every number opens
// a drill-down listing the requests behind it (InsightsDrill.tsx).
//
// Chart colors are three validated slots (SMTO / sick / other) defined on
// :root in styles.css for light and dark (--viz-*). Marks carry the color;
// every label and value stays in text ink. Charts have hover and keyboard
// access, a legend, and a table view.

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Empty, ErrorLine, Loading, Tile, TypeChip } from "../components/Bits";
import { api, type Insights as InsightsData, type KindDays } from "../lib/api";
import { formatNumber, parts, todayIso } from "../lib/dates";
import { useMe } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { KIND_LABEL } from "../lib/words";
import { DrillDrawer, drillToParam, parseDrill, type ClassGroupKey, type Drill, type KindGroup } from "./InsightsDrill";

/** The chart's third series: unpaid, unavailable and LOA together. Tables split LOA out. */
const otherOf = (d: KindDays) => d.unpaid + d.unavailable + (d.loa ?? 0);
const otherNoLoa = (d: KindDays) => d.unpaid + d.unavailable;
const totalOf = (d: KindDays) => d.pto + d.sick + d.unpaid + d.unavailable + (d.loa ?? 0);

const SERIES = [
  { key: "pto", label: KIND_LABEL.pto, color: "var(--viz-pto)" },
  { key: "sick", label: "Sick", color: "var(--viz-sick)" },
  { key: "other", label: "Unpaid and other", color: "var(--viz-other)" },
] as const;
type SeriesKey = (typeof SERIES)[number]["key"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Open = (drill: Drill) => void;

/** Enter or Space on something acting as a button. */
function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

export default function Insights() {
  const me = useMe();
  const thisYear = parts(todayIso()).y;
  const [params, setParams] = useSearchParams();
  const askedYear = Number(params.get("year"));
  const year = askedYear >= 2000 && askedYear <= 2100 ? askedYear : thisYear;
  const drill = parseDrill(params.get("drill"));
  const { data, error, loading, reload } = useLoad(() => api.insights(year), [year]);
  const shown = data && data.year === year ? data : null;

  const setYear = (y: number) => {
    const next = new URLSearchParams(params);
    if (y === thisYear) next.delete("year");
    else next.set("year", String(y));
    next.delete("drill");
    setParams(next);
  };
  const open: Open = useCallback(
    (d) => {
      const next = new URLSearchParams(params);
      next.set("drill", drillToParam(d));
      setParams(next);
    },
    [params, setParams],
  );
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("drill");
    setParams(next, { replace: true });
  };

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-sub">
            {me.role === "admin" ? "Time off across the company" : "Your team’s time off"} in {year}. Only approved time counts. Select any number to see
            the requests behind it.
          </p>
        </div>
        <div className="field field-inline">
          <label className="label" htmlFor="insights-year">
            Year
          </label>
          <select id="insights-year" className="input input-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading && !shown ? <Loading label="Loading insights" /> : null}
      <ErrorLine message={error} onRetry={() => void reload()} />

      {shown ? (
        <>
          <ul className="tiles" aria-label="At a glance">
            <Tile label="Out today" value={shown.out_today} unit={shown.out_today === 1 ? "person" : "people"} onSelect={() => open({ type: "tile", tile: "out_today" })} />
            <Tile
              label="Out in the next 30 days"
              value={shown.out_next_30}
              unit={shown.out_next_30 === 1 ? "person" : "people"}
              onSelect={() => open({ type: "tile", tile: "out_next_30" })}
            />
            <Tile
              label="Waiting for approval"
              value={shown.pending}
              unit={shown.pending === 1 ? "request" : "requests"}
              onSelect={() => open({ type: "tile", tile: "pending" })}
            />
            <Tile label={`Unused ${KIND_LABEL.pto}`} value={shown.unused_pto_total} unit="days" onSelect={() => open({ type: "tile", tile: "unused" })} />
          </ul>
          <MonthBlock months={shown.by_month} year={year} open={open} />
          <TeamBlock teams={shown.by_team} persons={shown.by_person} open={open} />
          <PersonBlock persons={shown.by_person} open={open} />
          {drill ? <DrillDrawer drill={drill} year={year} insights={shown} onClose={close} /> : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------- chart | table --

type View = "chart" | "table";

/** Chart or table, remembered per block in this browser. */
function useView(block: string): [View, (v: View) => void] {
  const key = `insights.view.${block}`;
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(key) === "table" ? "table" : "chart";
    } catch {
      return "chart";
    }
  });
  const set = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* remembering is a convenience */
    }
  };
  return [view, set];
}

function ViewToggle({ view, onChange, label }: { view: View; onChange: (v: View) => void; label: string }) {
  return (
    <div className="segmented segmented-small view-toggle" role="group" aria-label={`${label}: chart or table`}>
      {(["chart", "table"] as const).map((v) => (
        <button key={v} type="button" className={view === v ? "segment is-on" : "segment"} aria-pressed={view === v} onClick={() => onChange(v)}>
          {v === "chart" ? "Chart" : "Table"}
        </button>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <ul className="viz-legend" aria-label="Key">
      {SERIES.map((s) => (
        <li key={s.key}>
          <span className="viz-swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function BlockHead({ id, title, view, setView }: { id: string; title: string; view: View; setView: (v: View) => void }) {
  return (
    <div className="viz-head">
      <h2 id={id} className="card-title">
        {title}
      </h2>
      <ViewToggle view={view} onChange={setView} label={title} />
    </div>
  );
}

// ------------------------------------------------------- by month --

// Width of an element that can mount and unmount (chart <-> table view).
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) {
    const top = Math.ceil(max / step) * step;
    if (top / step <= 5) return { top, step };
  }
  const step = Math.pow(10, Math.ceil(Math.log10(max / 5)));
  return { top: Math.ceil(max / step) * step, step };
}

/** A bar segment with a 4px rounded top when it's the top of its stack. */
function segmentPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ""}V${y + h}Z`;
}

function MonthBlock({ months, year, open }: { months: InsightsData["by_month"]; year: number; open: Open }) {
  const [view, setView] = useView("month");
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  // Always twelve months, in order, whatever the server leaves out.
  const rows = useMemo(
    () =>
      MONTHS.map((_, i) => {
        const key = `${year}-${String(i + 1).padStart(2, "0")}`;
        const found = months.find((m) => m.month === key);
        return { month: key, label: MONTHS[i], pto: found?.pto ?? 0, sick: found?.sick ?? 0, other: found ? otherOf(found) : 0 };
      }),
    [months, year],
  );
  const totals = rows.map((r) => r.pto + r.sick + r.other);
  const empty = totals.every((t) => t === 0);

  const height = 240;
  // All twelve months always fit the width (no sideways scroll); on a phone
  // the axis margin shrinks so columns stay as wide as possible.
  const narrow = width < 420;
  const m = { top: 12, right: narrow ? 2 : 8, bottom: 28, left: narrow ? 17 : 34 };
  const chartW = width;
  const plotW = Math.max(chartW - m.left - m.right, 0);
  const plotH = height - m.top - m.bottom;
  const { top, step } = niceScale(Math.max(...totals));
  const band = plotW / 12;
  // Narrow columns: the bar fills the column but for a 2px gap; wide ones keep air around a 24px bar.
  const barW = band < 32 ? Math.max(band - 2, 4) : Math.max(Math.min(24, band * 0.62), 4);
  const y = (v: number) => m.top + plotH - (v / top) * plotH;
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);

  // Which segment sits under the pointer (for clicking one type of a month).
  function segmentAt(i: number, py: number): KindGroup | undefined {
    const MIN_TARGET = 14;
    let base = 0;
    let best: { key: KindGroup; dist: number } | undefined;
    for (const s of SERIES) {
      const v = rows[i][s.key];
      if (!v) continue;
      const yTop = y(base + v);
      const yBottom = y(base);
      const mid = (yTop + yBottom) / 2;
      const half = Math.max((yBottom - yTop) / 2, MIN_TARGET / 2);
      const dist = Math.abs(py - mid);
      if (dist <= half && (!best || dist < best.dist)) best = { key: s.key, dist };
      base += v;
    }
    return best?.key;
  }
  function clickColumn(i: number, e: MouseEvent<SVGRectElement>) {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const kind = segmentAt(i, e.clientY - box.top);
    open({ type: "month", month: rows[i].month, ...(kind ? { kind } : {}) });
  }

  const focused = hover !== null ? rows[hover] : null;

  return (
    <section className="card viz-card" aria-labelledby="by-month-h">
      <BlockHead id="by-month-h" title="Days off by month" view={view} setView={setView} />
      <Legend />
      {view === "table" ? (
        <div className="report-scroll">
          <table className="report-table insights-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">
                  Total
                </th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.month}>
                  <th scope="row">
                    <button type="button" className="row-drill" onClick={() => open({ type: "month", month: r.month })}>
                      {r.label}
                    </button>
                  </th>
                  <td className="num strong">
                    <button type="button" className="cell-drill" onClick={() => open({ type: "month", month: r.month })}>
                      {formatNumber(totals[i])}
                    </button>
                  </td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="num">
                      <button
                        type="button"
                        className="cell-drill"
                        aria-label={`${r.label}, ${s.label}: ${formatNumber(r[s.key])} days`}
                        onClick={() => open({ type: "month", month: r.month, kind: s.key })}
                      >
                        {formatNumber(r[s.key])}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-frame" ref={ref}>
          {empty ? <p className="viz-empty">No days off recorded in {year} yet.</p> : null}
          <div className="viz-scroll">
          {width > 0 ? (
            <svg width={chartW} height={height} role="img" aria-label={`Days off by month in ${year}, stacked by type. Select a month to see its requests.`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={m.left} x2={chartW - m.right} y1={y(t)} y2={y(t)} className="viz-grid" />
                  <text x={m.left - (narrow ? 3 : 8)} y={y(t)} className="viz-tick" textAnchor="end" dominantBaseline="middle">
                    {formatNumber(t)}
                  </text>
                </g>
              ))}
              {rows.map((r, i) => {
                const cx = m.left + band * i + band / 2;
                const x = cx - barW / 2;
                const present = SERIES.filter((s) => r[s.key] > 0);
                let base = 0;
                return (
                  <g key={r.month} className={hover !== null && hover !== i ? "viz-col is-dim" : "viz-col"}>
                    {present.map((s, k) => {
                      const v0 = base;
                      base += r[s.key];
                      const yTop = y(base);
                      const yBottom = y(v0) - (k > 0 ? 2 : 0); // 2px surface gap between segments
                      const h = Math.max(yBottom - yTop, 0.5);
                      return <path key={s.key} d={segmentPath(x, yTop, barW, h, k === present.length - 1)} fill={s.color} />;
                    })}
                    <text x={cx} y={height - m.bottom + 18} className="viz-tick" textAnchor="middle">
                      {band < 32 ? r.label[0] : r.label}
                    </text>
                    <rect
                      x={m.left + band * i}
                      y={m.top}
                      width={band}
                      height={plotH}
                      className="viz-hit is-drill"
                      tabIndex={0}
                      role="button"
                      aria-label={`${MONTHS_LONG[i]}: ${formatNumber(totals[i])} days off. ${KIND_LABEL.pto} ${formatNumber(r.pto)}, sick ${formatNumber(r.sick)}, unpaid and other ${formatNumber(r.other)}. Show the requests.`}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      onClick={(e) => clickColumn(i, e)}
                      onKeyDown={onActivate(() => open({ type: "month", month: r.month }))}
                    />
                  </g>
                );
              })}
              <line x1={m.left} x2={chartW - m.right} y1={y(0)} y2={y(0)} className="viz-axis" />
            </svg>
          ) : null}
          </div>
          {focused && hover !== null ? (
            <div
              className="viz-tip"
              style={{
                left: Math.min(Math.max(m.left + band * hover + band / 2, 90), Math.max(width - 90, 90)),
                top: Math.max(y(totals[hover]) - 10, 96), // keep it inside the chart, clear of the legend
              }}
              aria-hidden="true"
            >
              <p className="viz-tip-title">
                {MONTHS_LONG[hover]} {year} · {formatNumber(totals[hover])} days
              </p>
              {SERIES.map((s) => (
                <p key={s.key} className="viz-tip-row">
                  <span className="viz-swatch" style={{ background: s.color }} />
                  <span>{s.label}</span>
                  <strong>{formatNumber(focused[s.key])}</strong>
                </p>
              ))}
              <p className="viz-tip-hint">Select for the requests</p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------ shared bars --

function MiniStack({ pto, sick, other, max }: { pto: number; sick: number; other: number; max: number }) {
  const pct = (v: number) => `${max > 0 ? (v / max) * 100 : 0}%`;
  return (
    <span className="mini-stack" aria-hidden="true">
      {pto > 0 ? <span style={{ width: pct(pto), background: "var(--viz-pto)" }} /> : null}
      {sick > 0 ? <span style={{ width: pct(sick), background: "var(--viz-sick)" }} /> : null}
      {other > 0 ? <span style={{ width: pct(other), background: "var(--viz-other)" }} /> : null}
    </span>
  );
}

/** A labelled horizontal stacked bar that opens a drill-down. */
function BarRow({
  label,
  chip,
  pto,
  sick,
  other,
  total,
  max,
  sub = false,
  onOpen,
}: {
  label: string;
  chip?: ReactNode;
  pto: number;
  sick: number;
  other: number;
  total: number;
  max: number;
  sub?: boolean;
  onOpen: () => void;
}) {
  return (
    <li className={sub ? "bar-row is-sub" : "bar-row"}>
      <button
        type="button"
        className="bar-button"
        onClick={onOpen}
        aria-label={`${label}: ${formatNumber(total)} days. ${KIND_LABEL.pto} ${formatNumber(pto)}, sick ${formatNumber(sick)}, unpaid and other ${formatNumber(other)}. Show the requests.`}
        title={`${KIND_LABEL.pto} ${formatNumber(pto)} · Sick ${formatNumber(sick)} · Unpaid and other ${formatNumber(other)}`}
      >
        <span className="bar-label">
          {label}
          {chip}
        </span>
        <span className="bar-track">
          <MiniStack pto={pto} sick={sick} other={other} max={max} />
        </span>
        <span className="bar-value">{formatNumber(total)}</span>
      </button>
    </li>
  );
}

// ------------------------------------------------------- by team --

// One row per team, then a sub-row each for its employees and its
// contractors (worked out from by_person, which carries the class; when
// class isn't sent, the team rows stand alone).
interface TeamRow {
  key: string;
  team: string | null;
  cls?: ClassGroupKey;
  label: string;
  people: number;
  pto: number;
  sick: number;
  other: number;
  loa: number;
  total: number;
  hours: number;
  sub: boolean;
}

function teamRows(teams: InsightsData["by_team"], persons: InsightsData["by_person"]): TeamRow[] {
  const hasClass = persons.some((p) => p.class);
  const row = (team: string | null, cls: ClassGroupKey | undefined, label: string, list: KindDays[], people: number, hours: number): TeamRow => {
    const t = { pto: 0, sick: 0, unpaid: 0, unavailable: 0, loa: 0 };
    for (const d of list) {
      t.pto += d.pto;
      t.sick += d.sick;
      t.unpaid += d.unpaid;
      t.unavailable += d.unavailable;
      t.loa += d.loa ?? 0;
    }
    return {
      key: `${team ?? "~none"}-${cls ?? "all"}`,
      team,
      cls,
      label,
      people,
      pto: t.pto,
      sick: t.sick,
      other: otherNoLoa(t),
      loa: t.loa,
      total: totalOf(t),
      hours,
      sub: !!cls,
    };
  };
  const out: TeamRow[] = [];
  for (const team of [...teams].sort((a, b) => totalOf(b) - totalOf(a))) {
    out.push(row(team.team, undefined, team.team ?? "No team", [team], team.people, team.hours));
    if (!hasClass) continue;
    const members = persons.filter((p) => (p.team ?? null) === (team.team ?? null));
    const employees = members.filter((p) => (p.class ?? "employee") === "employee");
    const contractors = members.filter((p) => p.class && p.class !== "employee");
    if (employees.length) out.push(row(team.team, "employees", "Employees", employees, employees.length, employees.reduce((s, p) => s + (p.hours ?? 0), 0)));
    if (contractors.length)
      out.push(row(team.team, "contractors", "Contractors", contractors, contractors.length, contractors.reduce((s, p) => s + (p.hours ?? 0), 0)));
  }
  return out;
}

const drillTeam = (r: TeamRow): Drill => ({ type: "team", team: r.team, ...(r.cls ? { cls: r.cls } : {}) });

function TeamBlock({ teams, persons, open }: { teams: InsightsData["by_team"]; persons: InsightsData["by_person"]; open: Open }) {
  const [view, setView] = useView("team");
  const rows = teamRows(teams, persons);
  const max = Math.max(0, ...rows.filter((r) => !r.sub).map((r) => r.total));
  const anyHours = rows.some((r) => r.hours > 0);
  return (
    <section className="card" aria-labelledby="by-team-h">
      <BlockHead id="by-team-h" title="By team" view={view} setView={setView} />
      {rows.length === 0 ? (
        <Empty title="No teams to show yet." />
      ) : (
        <>
          <Legend />
          {view === "chart" ? (
            <ul className="bar-list">
              {rows.map((r) => (
                <BarRow
                  key={r.key}
                  label={r.label}
                  pto={r.pto}
                  sick={r.sick}
                  other={r.other + r.loa}
                  total={r.total}
                  max={max}
                  sub={r.sub}
                  onOpen={() => open(drillTeam(r))}
                />
              ))}
            </ul>
          ) : (
            <div className="report-scroll">
              <table className="report-table insights-table">
                <thead>
                  <tr>
                    <th scope="col">Team</th>
                    <th scope="col" className="num">
                      People
                    </th>
                    <th scope="col" className="num">
                      Total
                    </th>
                    <th scope="col" className="num">
                      {KIND_LABEL.pto}
                    </th>
                    <th scope="col" className="num">
                      Sick
                    </th>
                    <th scope="col" className="num">
                      Other
                    </th>
                    <th scope="col" className="num">
                      {KIND_LABEL.loa}
                    </th>
                    {anyHours ? (
                      <th scope="col" className="num">
                        Hours
                      </th>
                    ) : null}
                    <th scope="col" className="bar-col">
                      <span className="visually-hidden">Share</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.key}
                      className={r.sub ? "team-sub is-clickable" : "team-main is-clickable"}
                      onClick={(e) => {
                        e.currentTarget.querySelector<HTMLElement>(".row-drill")?.focus();
                        open(drillTeam(r));
                      }}
                    >
                      <th scope="row">
                        <button
                          type="button"
                          className="row-drill"
                          onClick={(e) => {
                            e.stopPropagation();
                            open(drillTeam(r));
                          }}
                        >
                          {r.label}
                        </button>
                      </th>
                      <td className="num">{r.people}</td>
                      <td className="num strong">{formatNumber(r.total)}</td>
                      <td className="num">{formatNumber(r.pto)}</td>
                      <td className="num">{formatNumber(r.sick)}</td>
                      <td className="num">{formatNumber(r.other)}</td>
                      <td className="num">{formatNumber(r.loa)}</td>
                      {anyHours ? <td className="num">{r.hours ? `${formatNumber(r.hours)} h` : "–"}</td> : null}
                      <td className="bar-col">
                        <MiniStack pto={r.pto} sick={r.sick} other={r.other + r.loa} max={max} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------ by person --

type PersonView = InsightsData["by_person"][number] & { other: number; loaDays: number; total: number };
type SortKey = "name" | "team" | SeriesKey | "loaDays" | "total" | "pto_available" | "sick_available";

function PersonBlock({ persons, open }: { persons: InsightsData["by_person"]; open: Open }) {
  const [view, setView] = useView("person");
  const [showAll, setShowAll] = useState(false);
  const rows: PersonView[] = useMemo(() => persons.map((r) => ({ ...r, other: otherNoLoa(r), loaDays: r.loa ?? 0, total: totalOf(r) })), [persons]);
  const employees = rows.filter((r) => (r.class ?? "employee") === "employee");
  const contractors = rows.filter((r) => r.class && r.class !== "employee");
  const ranked = [...rows].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const visible = showAll ? ranked : ranked.slice(0, 15);
  const max = Math.max(0, ...rows.map((r) => r.total));

  return (
    <section className="card" aria-labelledby="by-person-h">
      <BlockHead id="by-person-h" title="By person" view={view} setView={setView} />
      {rows.length === 0 ? (
        <Empty title="Nobody to show yet." />
      ) : view === "chart" ? (
        <>
          <Legend />
          <ul className="bar-list">
            {visible.map((r) => (
              <BarRow
                key={r.id}
                label={r.name}
                chip={<TypeChip cls={r.class} />}
                pto={r.pto}
                sick={r.sick}
                other={r.other + r.loaDays}
                total={r.total}
                max={max}
                onOpen={() => open({ type: "person", id: r.id })}
              />
            ))}
          </ul>
          {ranked.length > 15 ? (
            <button type="button" className="link-button list-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show top 15" : `Show all ${ranked.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <div className="person-tables">
          <PersonTable id="by-employee" title="Employees" rows={employees} balances={false} open={open} />
          <PersonTable id="by-contractor" title="Contractors" rows={contractors} balances open={open} />
        </div>
      )}
    </section>
  );
}

function PersonTable({ id, title, rows, balances, open }: { id: string; title: string; rows: PersonView[]; balances: boolean; open: Open }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "total", dir: "desc" });
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [rows.length]);

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const k = sort.key;
      const av = k === "name" ? a.name : k === "team" ? (a.team ?? "") : (a[k] ?? -1);
      const bv = k === "name" ? b.name : k === "team" ? (b.team ?? "") : (b[k] ?? -1);
      const c = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sort.dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, sort]);
  const visible = showAll ? sorted : sorted.slice(0, 12);

  function header(key: SortKey, label: string, numeric: boolean) {
    const active = sort.key === key;
    return (
      <th scope="col" className={numeric ? "num" : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          className={active ? "sort-button is-active" : "sort-button"}
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === "asc" ? "desc" : "asc") : numeric ? "desc" : "asc" }))}
        >
          {label}
          <span className="sort-mark" aria-hidden="true">
            {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      </th>
    );
  }

  return (
    <div className="person-table" aria-labelledby={`${id}-h`} role="group">
      <h3 id={`${id}-h`} className="list-head">
        {title} <span className="count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <Empty title={`No ${title.toLowerCase()} to show.`} />
      ) : (
        <>
          <div className="report-scroll">
            <table className="report-table insights-table">
              <thead>
                <tr>
                  {header("name", "Name", false)}
                  {header("team", "Team", false)}
                  {header("total", "Days taken", true)}
                  {header("pto", KIND_LABEL.pto, true)}
                  {header("sick", "Sick", true)}
                  {header("other", "Other", true)}
                  {header("loaDays", KIND_LABEL.loa, true)}
                  {balances ? header("pto_available", `${KIND_LABEL.pto} left`, true) : null}
                  {balances ? header("sick_available", "Sick left", true) : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    className="is-clickable"
                    onClick={(e) => {
                      e.currentTarget.querySelector<HTMLElement>(".row-drill")?.focus();
                      open({ type: "person", id: r.id });
                    }}
                  >
                    <th scope="row">
                      <span className="report-person">
                        <button
                          type="button"
                          className="row-drill"
                          onClick={(e) => {
                            e.stopPropagation();
                            open({ type: "person", id: r.id });
                          }}
                        >
                          {r.name}
                        </button>
                        <TypeChip cls={r.class} />
                      </span>
                    </th>
                    <td>{r.team ?? <span className="muted">None</span>}</td>
                    <td className="num strong">{formatNumber(r.total)}</td>
                    <td className="num">{formatNumber(r.pto)}</td>
                    <td className="num">{formatNumber(r.sick)}</td>
                    <td className="num">{formatNumber(r.other)}</td>
                    <td className="num">{formatNumber(r.loaDays)}</td>
                    {balances ? <td className="num">{r.pto_available === null ? <span className="muted">–</span> : formatNumber(r.pto_available)}</td> : null}
                    {balances ? <td className="num">{r.sick_available === null ? <span className="muted">–</span> : formatNumber(r.sick_available)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sorted.length > 12 ? (
            <button type="button" className="link-button list-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${sorted.length}`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
