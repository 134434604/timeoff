// The words the screens use for the contract's values, in one place.

import type { CalendarState, Kind, OverlapKind, Person, PersonClass, Role, Status, WorkerType } from "./api";
import { daysLabel, formatNumber } from "./dates";

/** Employee, monthly contractor, hourly contractor: what sets someone's default allowance. */
export const CLASS_LABEL: Record<PersonClass, string> = {
  employee: "Employee",
  contractor_monthly: "Contractor · Monthly",
  contractor_hourly: "Contractor · Hourly",
};

/** The class lowercased for sentences: "the hourly contractor default". */
export const CLASS_WORDS: Record<PersonClass, string> = {
  employee: "employee",
  contractor_monthly: "monthly contractor",
  contractor_hourly: "hourly contractor",
};

/** The server's class when it sends one, else worked out from type and pay. */
export function classOf(p: Pick<Person, "worker_type" | "pay_basis"> & { class?: PersonClass }): PersonClass {
  if (p.class) return p.class;
  if (p.worker_type !== "contractor") return "employee";
  return p.pay_basis === "hourly" ? "contractor_hourly" : "contractor_monthly";
}

/** /api/me.kinds may be plain ids or { id, label }; the labels here win. */
export function kindIds(kinds: Array<Kind | { id: Kind; label?: string }> | undefined): Kind[] | null {
  if (!kinds || !kinds.length) return null;
  return kinds.map((k) => (typeof k === "string" ? k : k.id));
}

/** The one line that points people to Slack. */
export const SLACK_LINE = "You can also do this from Slack: type /timeoff.";

// The request "Type" names the company uses. SMTO is paid time off.
export const KIND_LABEL: Record<Kind, string> = {
  pto: "SMTO",
  sick: "Sick",
  unpaid: "Unpaid Time",
  loa: "LOA",
  unavailable: "Unavailable",
};

/** Longer names for places with room, like the request form's hint. */
export const KIND_LONG: Record<Kind, string> = {
  pto: "SMTO (paid time off)",
  sick: "Sick time",
  unpaid: "Unpaid time",
  loa: "Leave of absence",
  unavailable: "Unavailable",
};

/** "3 days", or "3 days (counted 4)" when the person typed their own count. */
export function daysWithCount(r: { days: number; days_overridden?: boolean; days_computed?: number }): string {
  const base = daysLabel(r.days);
  return r.days_overridden && typeof r.days_computed === "number" && r.days_computed !== r.days
    ? `${base} (counted ${formatNumber(r.days_computed)})`
    : base;
}

export function kindLabel(kind: OverlapKind): string {
  return kind === "out" ? "Out" : KIND_LABEL[kind];
}

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Waiting",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Cancelled",
};

export const ROLE_LABEL: Record<Role, string> = {
  employee: "Staff",
  manager: "Manager",
  admin: "Admin",
};

export const WORKER_LABEL: Record<WorkerType, string> = {
  employee: "Employee",
  contractor: "Contractor",
};

export const ROLE_RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2 };

export function atLeast(role: Role, needed: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[needed];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// Activity entries name what happened with a short code (server/index.mjs
// writes "request.approve", "policy.set", ...). Unknown codes are shown with
// their separators turned into spaces.
const ACTION_WORDS: Record<string, string> = {
  request_submit: "asked for time off",
  request_approve: "approved time off",
  request_deny: "denied time off",
  request_cancel: "cancelled time off",
  person_create: "added a person",
  person_update: "updated a person",
  person_bootstrap_admin: "became the first admin",
  policy_set: "set a time-off policy",
  adjustment_add: "adjusted a balance",
  holidays_set: "updated the holidays",
  calendar_connect: "connected Google Calendar",
  calendar_choose: "chose the team calendar",
  calendar_disconnect: "disconnected Google Calendar",
  calendar_retry: "retried the calendar",
  calendar_write_failed: "couldn’t update the team calendar",
  mail_failed: "couldn’t send an email",
  session_sign_in: "signed in",
  session_sign_out: "signed out",
  setup_keys: "saved setup keys",
};

export function actionWords(action: string): string {
  const key = action.replace(/[.\-:]/g, "_").toLowerCase();
  return ACTION_WORDS[key] ?? action.replace(/[._\-:]+/g, " ").toLowerCase();
}

/** Activity subjects are often internal ids ("req_3f…", "calendar"); show only words. */
export function readableSubject(subject: string): string {
  if (!subject || subject === "calendar") return "";
  if (/^[a-z]+_[a-z0-9]{6,}$/i.test(subject)) return "";
  return subject;
}

/** Status-change details ("pending to approved with a note") repeat the action; skip them. */
export function readableDetail(detail: string): string {
  if (!detail || /^(pending|approved|denied|cancelled) to (pending|approved|denied|cancelled)/.test(detail)) return "";
  return detail;
}

/** What the person sees about the shared calendar for one request. */
export function calendarHint(state: CalendarState, status: Status): string | null {
  if (status !== "approved") return null;
  if (state === "added") return "On the team calendar";
  if (state === "pending") return "Will appear on the calendar shortly";
  return null;
}

export interface ClassGroup<T> {
  key: "employees" | "contractors";
  title: string;
  items: T[];
}

/** Employees first, then contractors; order inside each group is kept. Unknown class counts as employee. */
export function groupByClass<T>(items: T[], classFor: (item: T) => PersonClass | undefined): ClassGroup<T>[] {
  const employees: T[] = [];
  const contractors: T[] = [];
  for (const item of items) (classFor(item) && classFor(item) !== "employee" ? contractors : employees).push(item);
  return [
    { key: "employees", title: "Employees", items: employees },
    { key: "contractors", title: "Contractors", items: contractors },
  ];
}
