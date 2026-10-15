// Insights drill-downs: what's behind a number. A drill is kept in the
// address (?drill=month:2026-03:pto) so a refresh reopens it, and opens a
// side panel listing the requests from GET /api/insights/requests. The
// footer total adds up days_in_window, the same numbers the chart, the
// tables and Reports use, so it equals the number that was clicked.

import { Link } from "react-router-dom";
import { Empty, ErrorLine, KindTag, Loading, StatusChip, TypeChip } from "../components/Bits";
import Drawer from "../components/Drawer";
import { api, type Insights, type InsightRequest, type InsightRequestQuery, type Kind } from "../lib/api";
import { formatMonth, formatNumber, formatRange, formatStampDay } from "../lib/dates";
import { useLoad } from "../lib/useLoad";
import { KIND_LABEL, daysWithCount } from "../lib/words";

export type KindGroup = "pto" | "sick" | "other";
export type ClassGroupKey = "employees" | "contractors";
export type TileKey = "out_today" | "out_next_30" | "pending" | "unused";

export type Drill =
  | { type: "month"; month: string; kind?: KindGroup }
  | { type: "team"; team: string | null; cls?: ClassGroupKey }
  | { type: "person"; id: string }
  | { type: "tile"; tile: TileKey };

const NO_TEAM = "~none";

export function drillToParam(d: Drill): string {
  switch (d.type) {
    case "month":
      return `month:${d.month}${d.kind ? `:${d.kind}` : ""}`;
    case "team":
      return `team:${d.team === null ? NO_TEAM : encodeURIComponent(d.team)}${d.cls ? `:${d.cls}` : ""}`;
    case "person":
      return `person:${encodeURIComponent(d.id)}`;
    default:
      return `tile:${d.tile}`;
  }
}

export function parseDrill(value: string | null): Drill | null {
  if (!value) return null;
  const [type, a, b] = value.split(":");
  try {
    if (type === "month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(a ?? "")) {
      return { type: "month", month: a, ...(b === "pto" || b === "sick" || b === "other" ? { kind: b } : {}) };
    }
    if (type === "team" && a) {
      return { type: "team", team: a === NO_TEAM ? null : decodeURIComponent(a), ...(b === "employees" || b === "contractors" ? { cls: b } : {}) };
    }
    if (type === "person" && a) return { type: "person", id: decodeURIComponent(a) };
    if (type === "tile" && (a === "out_today" || a === "out_next_30" || a === "pending" || a === "unused")) return { type: "tile", tile: a };
  } catch {
    return null;
  }
  return null;
}

const KIND_GROUP_LABEL: Record<KindGroup, string> = { pto: KIND_LABEL.pto, sick: "Sick", other: "Unpaid and other" };
const inGroup = (kind: Kind, group: KindGroup) => (group === "other" ? kind !== "pto" && kind !== "sick" : kind === group);
const isContractor = (r: InsightRequest) => !!r.person.class && r.person.class !== "employee";
const TILE_TITLE: Record<TileKey, string> = {
  out_today: "Today",
  out_next_30: "Next 30 days",
  pending: "Waiting for approval",
  unused: `Unused ${KIND_LABEL.pto}`,
};

export function drillTitle(d: Drill, insights: Insights): string {
  switch (d.type) {
    case "month":
      return `${formatMonth(d.month)}${d.kind ? ` · ${KIND_GROUP_LABEL[d.kind]}` : ""}`;
    case "team":
      return `${d.team ?? "No team"}${d.cls ? ` · ${d.cls === "employees" ? "Employees" : "Contractors"}` : ""}`;
    case "person":
      return insights.by_person.find((p) => p.id === d.id)?.name ?? "This person";
    default:
      return TILE_TITLE[d.tile];
  }
}

/** The server query for a drill; anything it can't express is filtered here after. */
function queryFor(d: Drill, year: number): InsightRequestQuery {
  switch (d.type) {
    case "month":
      return {
        year: Number(d.month.slice(0, 4)),
        month: d.month,
        ...(d.kind === "pto" || d.kind === "sick" ? { kind: d.kind } : {}),
        status: "approved",
      };
    case "team":
      return { year, team: d.team ?? "", status: "approved" };
    case "person":
      return { year, person_id: d.id, status: "approved" };
    default:
      // The time-based tiles don't depend on the year picked; Unused SMTO isn't fetched.
      return { window: d.tile === "pending" ? "pending" : d.tile === "out_today" ? "today" : "next_30" };
  }
}

/** True when the list is narrowed here beyond what the server filtered (then the footer sums the list). */
function narrowsHere(d: Drill): boolean {
  if (d.type === "month") return d.kind === "other";
  if (d.type === "team") return !!d.cls;
  return false;
}

function narrow(d: Drill, rows: InsightRequest[]): InsightRequest[] {
  switch (d.type) {
    case "month":
      return d.kind ? rows.filter((r) => inGroup(r.kind, d.kind!)) : rows;
    case "team":
      return rows.filter(
        (r) => (r.person.team ?? null) === d.team && (!d.cls || (d.cls === "contractors" ? isContractor(r) : !isContractor(r))),
      );
    case "person":
      return rows.filter((r) => r.person.id === d.id);
    default:
      return rows; // the server's window already picked these
  }
}

const sumDays = (rows: InsightRequest[]) => Math.round(rows.reduce((s, r) => s + (Number.isFinite(r.days_in_window) ? r.days_in_window : 0), 0) * 100) / 100;
const daysWord = (n: number) => (n === 1 ? "day" : "days");

export function DrillDrawer({ drill, year, insights, onClose }: { drill: Drill; year: number; insights: Insights; onClose: () => void }) {
  const title = drillTitle(drill, insights);
  const needsFetch = !(drill.type === "tile" && drill.tile === "unused");
  const key = drillToParam(drill);
  const { data, error, loading, reload } = useLoad(
    () => (needsFetch ? api.insightRequests(queryFor(drill, year)) : Promise.resolve(null)),
    [key, year],
  );
  const rows = data ? narrow(drill, data.requests).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.person.name.localeCompare(b.person.name)) : [];

  const subtitle =
    drill.type === "month"
      ? "Approved days in this month"
      : drill.type === "tile"
        ? drill.tile === "pending"
          ? "Requests waiting for a decision"
          : drill.tile === "unused"
            ? `${KIND_LABEL.pto} still available, people with a limit`
            : drill.tile === "out_today"
              ? "Approved time off today"
              : "Approved time off from today through the next 30 days"
        : `Approved days in ${year}`;

  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose}>
      {drill.type === "tile" && drill.tile === "unused" ? (
        <UnusedList insights={insights} />
      ) : (
        <>
          {loading && !data ? <Loading label="Loading the requests" /> : null}
          <ErrorLine message={error} onRetry={() => void reload()} />
          {data ? (
            rows.length === 0 ? (
              <div className="drawer-section">
                <Empty title="Nothing in this view." />
              </div>
            ) : (
              <>
                <ul className="drill-list">
                  {rows.map((r) => (
                    <li key={r.id} className="drill-row">
                      <div className="drill-top">
                        <span className="drill-name">
                          {r.person.name} <TypeChip cls={r.person.class} />
                        </span>
                        <StatusChip status={r.status} />
                      </div>
                      <p className="drill-meta">
                        <KindTag kind={r.kind} /> {formatRange(r.start_date, r.end_date)}
                      </p>
                      <p className="drill-meta">
                        {r.days_in_window === r.days ? (
                          <strong>{daysWithCount(r)}</strong>
                        ) : (
                          <>
                            <strong>
                              {formatNumber(r.days_in_window)} {daysWord(r.days_in_window)}
                            </strong>
                            <span className="muted"> of {daysWithCount(r)}</span>
                          </>
                        )}
                        {r.hours && r.days_in_window === r.days ? <span className="muted"> · {formatNumber(r.hours)} h</span> : null}
                      </p>
                      <p className="drill-meta muted">
                        Approver: {r.approver?.name ?? "the admins"}
                        {r.decided_at ? ` · decided ${formatStampDay(r.decided_at)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
                {data.truncated ? <p className="hint">Showing the first 500 requests.</p> : null}
                <DrillFooter
                  drill={drill}
                  rows={rows}
                  serverTotal={narrowsHere(drill) ? null : data.total_days}
                  serverRequests={data.total_requests ?? null}
                  serverPeople={data.total_people ?? null}
                />
              </>
            )
          ) : null}
        </>
      )}
      <p className="drill-links">
        {drill.type === "tile" && drill.tile === "pending" ? (
          <Link to="/approvals">Open in Approvals</Link>
        ) : (
          <Link to={drill.type === "month" ? `/team?month=${drill.month}` : "/team"}>Open in Team</Link>
        )}
      </p>
    </Drawer>
  );
}

function DrillFooter({
  drill,
  rows,
  serverTotal,
  serverRequests,
  serverPeople,
}: {
  drill: Drill;
  rows: InsightRequest[];
  serverTotal: number | null;
  serverRequests: number | null;
  serverPeople: number | null;
}) {
  if (drill.type === "tile" && (drill.tile === "out_today" || drill.tile === "out_next_30")) {
    const people = serverPeople ?? new Set(rows.map((r) => r.person.id)).size;
    return (
      <p className="drill-total" role="status">
        <span>Total</span>
        <strong>
          {people} {people === 1 ? "person" : "people"}
        </strong>
      </p>
    );
  }
  if (drill.type === "tile" && drill.tile === "pending") {
    const count = serverRequests ?? rows.length;
    return (
      <p className="drill-total" role="status">
        <span>Total</span>
        <strong>
          {count} {count === 1 ? "request" : "requests"}
        </strong>
      </p>
    );
  }
  // The server's total covers every match, even past a truncated list.
  const days = serverTotal ?? sumDays(rows);
  return (
    <p className="drill-total" role="status">
      <span>Total</span>
      <strong>
        {formatNumber(days)} {daysWord(days)}
      </strong>
    </p>
  );
}

function UnusedList({ insights }: { insights: Insights }) {
  const rows = insights.by_person
    .filter((p) => typeof p.pto_available === "number" && p.pto_available > 0)
    .sort((a, b) => (b.pto_available ?? 0) - (a.pto_available ?? 0));
  const total = Math.round(rows.reduce((s, p) => s + (p.pto_available ?? 0), 0) * 100) / 100;
  if (!rows.length) {
    return (
      <div className="drawer-section">
        <Empty title="Nothing in this view." />
      </div>
    );
  }
  return (
    <>
      <ul className="drill-list">
        {rows.map((p) => (
          <li key={p.id} className="drill-row">
            <div className="drill-top">
              <span className="drill-name">
                {p.name} <TypeChip cls={p.class} />
              </span>
              <strong>
                {formatNumber(p.pto_available)} {daysWord(p.pto_available ?? 0)}
              </strong>
            </div>
            <p className="drill-meta muted">{p.team ?? "No team"}</p>
          </li>
        ))}
      </ul>
      <p className="drill-total" role="status">
        <span>Total</span>
        <strong>
          {formatNumber(total)} {daysWord(total)}
        </strong>
      </p>
    </>
  );
}
