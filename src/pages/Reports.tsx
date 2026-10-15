// Reports (managers and admins): one month of days off in two sections,
// Employees then Contractors, each with its team tables and a section total,
// then the company total. Contractor tables carry hours. A CSV download is
// built right here in the browser. Opens on last month, the one the 1st's
// email covers.

import { useSearchParams } from "react-router-dom";
import { Empty, ErrorLine, Loading, TypeChip } from "../components/Bits";
import { ChevronLeft, ChevronRight } from "../components/Icons";
import { api, type KindDays, type MonthlyReport, type PersonClass, type ReportPerson } from "../lib/api";
import { formatMonth, formatNumber, monthOf, shiftMonth, todayIso } from "../lib/dates";
import { useLoad } from "../lib/useLoad";
import { CLASS_LABEL, KIND_LABEL } from "../lib/words";

const COLUMNS: Array<{ key: keyof KindDays & keyof typeof KIND_LABEL; label: string }> = (
  ["pto", "sick", "unpaid", "loa", "unavailable"] as const
).map((key) => ({ key, label: KIND_LABEL[key] }));

const v = (d: KindDays, key: keyof KindDays) => d[key] ?? 0;
const total = (d: KindDays) => d.pto + d.sick + d.unpaid + d.unavailable + (d.loa ?? 0);
const teamName = (team: string | null) => team ?? "No team";

type Totals = KindDays & { hours: number };
const zero = (): Totals => ({ pto: 0, sick: 0, unpaid: 0, unavailable: 0, loa: 0, hours: 0 });
function sum(rows: ReportPerson[]): Totals {
  const t = zero();
  for (const r of rows) {
    t.pto += r.pto;
    t.sick += r.sick;
    t.unpaid += r.unpaid;
    t.unavailable += r.unavailable;
    t.loa = (t.loa ?? 0) + (r.loa ?? 0);
    t.hours += r.hours ?? 0;
  }
  return t;
}

/** Without a class from the server, a person counts as an employee. */
const isContractor = (p: ReportPerson) => !!p.class && p.class !== "employee";

interface SectionTeam {
  team: string | null;
  people: ReportPerson[];
  totals: Totals;
}
interface Section {
  key: "employees" | "contractors";
  title: string;
  hours: boolean;
  teams: SectionTeam[];
  people: number;
  totals: Totals;
}

function sectionsOf(report: MonthlyReport): Section[] {
  const build = (key: Section["key"], title: string, pick: (p: ReportPerson) => boolean, hours: boolean): Section => {
    const teams = report.teams
      .map((t) => {
        const people = t.people.filter(pick);
        return { team: t.team, people, totals: sum(people) };
      })
      .filter((t) => t.people.length > 0);
    const everyone = teams.flatMap((t) => t.people);
    return { key, title, hours, teams, people: everyone.length, totals: sum(everyone) };
  };
  return [build("employees", "Employees", (p) => !isContractor(p), false), build("contractors", "Contractors", isContractor, true)];
}

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const thisMonth = monthOf(todayIso());
  const asked = params.get("month") ?? "";
  const lastMonth = shiftMonth(thisMonth, -1);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : lastMonth;
  const [y, m] = month.split("-").map(Number);
  const { data, error, loading, reload } = useLoad(() => api.reportMonthly(y, m), [month]);
  const report = data && data.month === month ? data : null;
  const sections = report ? sectionsOf(report) : [];

  function go(to: string) {
    setParams(to === lastMonth ? {} : { month: to });
  }

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            Days off by team for one month. Weekends aren’t counted. Company holidays aren’t counted for employees; they count as working days for
            contractors.
          </p>
        </div>
        <div className="month-nav" role="group" aria-label="Choose month">
          <button type="button" className="icon-button" aria-label="Previous month" onClick={() => go(shiftMonth(month, -1))}>
            <ChevronLeft />
          </button>
          <p className="month-name" aria-live="polite">
            {formatMonth(month)}
          </p>
          <button type="button" className="icon-button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => go(shiftMonth(month, 1))}>
            <ChevronRight />
          </button>
        </div>
      </header>

      <p className="report-note">
        This report is emailed to admins and managers on the 1st of each month, for the month before. Only approved time counts.
      </p>

      {loading && !report ? <Loading label="Loading the report" /> : null}
      <ErrorLine message={error} onRetry={() => void reload()} />

      {report ? (
        report.teams.length === 0 || total(report.totals) === 0 ? (
          <div className="card">
            <Empty title={`Nobody took time off in ${formatMonth(month)}.`} />
          </div>
        ) : (
          <>
            <div className="report-actions">
              <p className="report-sum">
                <strong>{formatNumber(total(report.totals))}</strong> days off in {formatMonth(month)}
              </p>
              <button type="button" className="button button-quiet" onClick={() => downloadCsv(report, month)}>
                Download CSV
              </button>
            </div>

            {sections.map((section) => (
              <section key={section.key} className="report-section" aria-labelledby={`sec-${section.key}`}>
                <header className="report-section-head">
                  <h2 id={`sec-${section.key}`} className="section-heading">
                    {section.title} <span className="count">{section.people}</span>
                  </h2>
                  {section.people ? (
                    <p className="muted small">
                      {formatNumber(total(section.totals))} days off
                      {section.hours && section.totals.hours ? ` · ${formatNumber(section.totals.hours)} hours` : ""}
                    </p>
                  ) : null}
                </header>
                {section.teams.length === 0 ? (
                  <div className="card">
                    <Empty title={section.key === "employees" ? "No employees in this report." : "No contractors in this report."} />
                  </div>
                ) : (
                  <>
                    {section.teams.map((team) => (
                      <TeamTable key={`${section.key}-${teamName(team.team)}`} team={team} hours={section.hours} />
                    ))}
                    <TotalsTable label={`${section.title} total`} totals={section.totals} hours={section.hours} />
                  </>
                )}
              </section>
            ))}

            <TotalsTable label="Company total" totals={{ ...report.totals, loa: report.totals.loa ?? 0 }} hours company />
          </>
        )
      ) : null}
    </div>
  );
}

// Column order everywhere: Person, Total (bold), SMTO, Sick, Unpaid Time, LOA, Unavailable, Hours.
function HeadRow({ first, hours }: { first: string; hours: boolean }) {
  return (
    <tr>
      <th scope="col">{first}</th>
      <th scope="col" className="num">
        Total
      </th>
      {COLUMNS.map((c) => (
        <th key={c.key} scope="col" className="num">
          {c.label}
        </th>
      ))}
      {hours ? (
        <th scope="col" className="num">
          Hours
        </th>
      ) : null}
    </tr>
  );
}

function TeamTable({ team, hours }: { team: SectionTeam; hours: boolean }) {
  const name = teamName(team.team);
  return (
    <section className="card report-card" aria-label={name}>
      <h3 className="card-title">{name}</h3>
      <div className="report-scroll" tabIndex={0} aria-label={`${name} days off, scrolls sideways`}>
        <table className="report-table">
          <thead>
            <HeadRow first="Person" hours={hours} />
          </thead>
          <tbody>
            {team.people.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <span className="report-person">
                    {p.name}
                    <TypeChip cls={p.class} />
                  </span>
                </th>
                <td className="num strong">
                  <Cell days={total(p)} />
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="num">
                    <Cell days={v(p, c.key)} />
                  </td>
                ))}
                {hours ? <td className="num">{!p.hours ? <span className="muted">–</span> : `${formatNumber(p.hours)} h`}</td> : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Team total</th>
              <td className="num">{formatNumber(total(team.totals))}</td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="num">
                  {formatNumber(v(team.totals, c.key))}
                </td>
              ))}
              {hours ? <td className="num">{team.totals.hours ? `${formatNumber(team.totals.hours)} h` : "–"}</td> : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function TotalsTable({ label, totals, hours, company = false }: { label: string; totals: Totals; hours: boolean; company?: boolean }) {
  return (
    <section className={company ? "card report-card report-company" : "card report-card report-section-total"} aria-label={label}>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <HeadRow first={label} hours={hours} />
          </thead>
          <tbody>
            <tr>
              <th scope="row">{company ? "Everyone" : "All teams"}</th>
              <td className="num strong">{formatNumber(total(totals))}</td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="num">
                  {formatNumber(v(totals, c.key))}
                </td>
              ))}
              {hours ? <td className="num">{totals.hours ? `${formatNumber(totals.hours)} h` : "–"}</td> : null}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cell({ days }: { days: number }) {
  if (!days) return <span className="muted">–</span>;
  return <>{formatNumber(days)}</>;
}

// ------------------------------------------------------------------- CSV --

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const typeWord = (cls: PersonClass | undefined) => (cls ? CLASS_LABEL[cls] : "Employee");

function downloadCsv(report: MonthlyReport, month: string) {
  const rows: Array<Array<string | number | null>> = [
    [
      "Type",
      "Team",
      "Person",
      "Total days",
      `${KIND_LABEL.pto} days`,
      `${KIND_LABEL.sick} days`,
      `${KIND_LABEL.unpaid} days`,
      `${KIND_LABEL.loa} days`,
      `${KIND_LABEL.unavailable} days`,
      "Hours (hourly contractors)",
    ],
  ];
  const line = (type: string, team: string, who: string, d: KindDays, hours: number | null) => [
    type,
    team,
    who,
    total(d),
    d.pto,
    d.sick,
    d.unpaid,
    d.loa ?? 0,
    d.unavailable,
    hours,
  ];
  for (const section of sectionsOf(report)) {
    for (const team of section.teams) {
      for (const p of team.people) rows.push(line(typeWord(p.class), teamName(team.team), p.name, p, section.hours ? p.hours : null));
      rows.push(line(section.title, teamName(team.team), "Team total", team.totals, section.hours ? team.totals.hours : null));
    }
    if (section.people) rows.push(line(section.title, "All teams", `${section.title} total`, section.totals, section.hours ? section.totals.hours : null));
  }
  const contractorHours = sectionsOf(report).find((x) => x.key === "contractors")?.totals.hours ?? 0;
  rows.push(line("Everyone", "All teams", "Company total", report.totals, contractorHours));
  const text = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([`﻿${text}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `time-off-${month}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
