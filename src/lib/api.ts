// The one way the client talks to the server: same-origin JSON with the
// session cookie riding along. Every refusal becomes an ApiError carrying the
// server's own plain-English sentence and its code (docs/API.md).

// ------------------------------------------------------------------ shapes --

export type Role = "employee" | "manager" | "admin";
export type WorkerType = "employee" | "contractor";
export type Kind = "pto" | "sick" | "unpaid" | "unavailable" | "loa"; // loa = leave of absence, no balance effect
export type Status = "pending" | "approved" | "denied" | "cancelled";

export interface PersonRef {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: Role;
  worker_type: WorkerType;
  manager: PersonRef | null;
  active: boolean;
  timezone: string;
  slack_user_id: string | null;
  team: string | null;
  pay_basis: PayBasis;
  /** Hours in one day off (default 8); reports use it for hourly people. */
  hours_per_day: number;
  /** How they got on the roster: their own first /timeoff in Slack, an admin, or the first sign-in. */
  enrolled_via?: "slack" | "admin" | "bootstrap";
  /** Employee, or contractor paid monthly / hourly; it picks the default allowance. */
  class?: PersonClass;
  /** No policy and no manager yet: an admin still has to set them up. */
  needs_setup?: boolean;
  /** A demo person loaded for trying Time Off out; remove before real staff sign in. */
  sample?: boolean;
}

export type PayBasis = "monthly" | "hourly";

export type PersonClass = "employee" | "contractor_monthly" | "contractor_hourly";

export interface Policy {
  annual_days: number;
  accrual: "front_loaded" | "monthly";
  carryover_cap: number;
  start_date: string;
  /** Sick days a year; 0 = not tracked. They never carry over. */
  sick_days: number;
  /** Employees: no limit on SMTO / sick unless an admin sets one. */
  pto_unlimited?: boolean;
  sick_unlimited?: boolean;
  /** Contractors: company holidays are days off (true) or count as working days (false). */
  holidays_apply?: boolean;
}

export interface Balance {
  unit: "days";
  year: number;
  /** null when unlimited */
  allowance: number | null;
  /** null when unlimited */
  accrued: number | null;
  carried_over: number;
  adjustments: number;
  used: number;
  pending: number;
  /** null when unlimited */
  available: number | null;
  tracked: boolean;
  /** No limit: only used/pending mean anything. */
  unlimited?: boolean;
}

/** One balance for time off and one for sick days, each the shape above. */
export interface Balances {
  pto: Balance;
  sick: Balance;
}

/** What a request would leave, per balance; null where it doesn't apply. */
export interface BalanceAfter {
  pto: number | null;
  sick: number | null;
}

export type CalendarState = "none" | "added" | "pending" | "failed" | "removed";

export interface TimeOffRequest {
  id: string;
  person_id: string;
  kind: Kind;
  status: Status;
  start_date: string;
  end_date: string;
  half_day_start: boolean;
  half_day_end: boolean;
  days: number;
  note: string;
  decided_by: PersonRef | null;
  decided_at: string | null;
  decision_note: string;
  /** Who was asked to decide (picked on the form, the manager by default); null = the admins. */
  approver: PersonRef | null;
  /** days x the person's hours_per_day when it was asked for. */
  hours: number | null;
  /** What the dates count to; `days` differs from it when the person typed their own number. */
  days_computed?: number;
  days_overridden?: boolean;
  calendar: { state: CalendarState; event_id: string | null; error: string | null };
  created_at: string;
  updated_at: string;
}

/** Staff who aren't managers see "out" instead of a teammate's real kind. */
export type OverlapKind = Kind | "out";

export interface Overlap {
  person_id: string;
  name: string;
  start_date: string;
  end_date: string;
  kind: OverlapKind;
  status: Status;
}

export interface Holiday {
  date: string;
  name: string;
}

// slack_available: whether staff can use /timeoff in Slack. needs_setup: the
// Google keys aren't in yet, so nobody can sign in. Missing means false.
export type Me =
  | {
      signedIn: true;
      person: Person;
      app: { name: string };
      slack_available?: boolean;
      needs_setup?: boolean;
      /** The Types this person may ask for, in order. */
      kinds?: Array<Kind | { id: Kind; label?: string }>;
    }
  | {
      signedIn: false;
      google: { on: boolean; fixture: boolean };
      notOnRoster?: { email: string };
      slack_available?: boolean;
      needs_setup?: boolean;
    };

export interface SetupStatus {
  ok: boolean;
  has_google: boolean;
  has_slack: boolean;
  has_admin_email: boolean;
  has_allowed_domain: boolean;
  has_mail_from: boolean;
  public_origin: string | null;
}

export interface SetupKeys {
  token?: string;
  google_client_id?: string;
  google_client_secret?: string;
  slack_bot_token?: string;
  slack_signing_secret?: string;
  allowed_email_domain?: string;
  mail_from?: string;
  bootstrap_admin_email?: string;
}

export interface SetupSaved {
  saved: string[];
  /** checked: the server tried the bot token with Slack; message: its own sentence, shown as-is. */
  slack: { checked: boolean; ok: boolean | null; team_name: string | null; message?: string };
  google: { ok: boolean };
}

/** One stretch of approved time this year, for the "used this year" lists. */
export interface UsedSpan {
  request_id?: string;
  start_date: string;
  end_date: string;
  days: number;
}

/** The manager/admin part of Home. */
export interface HomeTeam {
  scope: "reports" | "everyone";
  out_today: number;
  out_next_30: number;
  pending: number;
  unused_pto_total: number;
  month: TeamCalendar;
  out_soon: Overlap[];
}

export interface HomeData {
  person: Person;
  balance: Balances;
  requests: TimeOffRequest[];
  holidays: Holiday[];
  team_out: Overlap[];
  /** Approved days this year, per balance, for people without a limit. */
  used_days?: { pto: UsedSpan[]; sick: UsedSpan[] };
  /** Only for managers and admins. */
  team?: HomeTeam | null;
}

export interface DraftRequest {
  start_date: string;
  end_date: string;
  half_day_start?: boolean;
  half_day_end?: boolean;
  kind: Kind;
  note?: string;
  approver_id?: string | null;
  /** Only when the person changed the counted number of working days. */
  days_requested?: number;
}

export interface Preview {
  /** The days the request would use: days_requested when given, else the counted days. */
  days: number;
  /** What the dates count to (weekends and holidays left out, halves honored). */
  days_computed?: number;
  /** True when days_requested was sent; the typed number is what counts. */
  days_overridden?: boolean;
  balance_after: BalanceAfter;
  overlaps: Overlap[];
  warnings: string[];
}

export interface PendingItem {
  request: TimeOffRequest;
  person: Person;
  balance: Balances;
  balance_after: BalanceAfter;
  overlaps: Overlap[];
  /** Someone the requester named as their manager in Slack; an admin confirms them once. */
  pending_manager?: { name: string; email: string } | null;
  /** When the approver was last nudged about this request. */
  last_reminded_at?: string | null;
}

export interface DecidedItem {
  request: TimeOffRequest;
  person: Person;
}

export interface ApprovalsData {
  pending: PendingItem[];
  recent: DecidedItem[];
}

export interface TeamCalendar {
  month: string;
  entries: Overlap[];
  holidays: Holiday[];
  /** class lets the grid group employees and contractors (when the server sends it). */
  people: Array<PersonRef & { class?: PersonClass }>;
}

export type PersonRow = Person & { policy: Policy | null; balance: Balances };

export interface NewPerson {
  email: string;
  name: string;
  role: Role;
  worker_type: WorkerType;
  manager_id?: string | null;
  timezone?: string;
  team?: string | null;
  pay_basis?: PayBasis;
  hours_per_day?: number;
}

export interface PersonPatch {
  name?: string;
  role?: Role;
  worker_type?: WorkerType;
  manager_id?: string | null;
  timezone?: string;
  slack_user_id?: string | null;
  active?: boolean;
  team?: string | null;
  pay_basis?: PayBasis;
  hours_per_day?: number;
}

export type CalendarTitles = "type" | "out";
export type ManagerPick = "confirm_every" | "confirm_new" | "managers_only" | "anyone";

export interface Settings {
  calendar: {
    connected: boolean;
    account_email: string | null;
    calendar_id: string | null;
    calendar_name: string | null;
    last_error: string | null;
    pending_writes: number;
    fixture: boolean;
    /** What calendar entries say: just "Out" (SMTO stays SMTO), or the type of time off. */
    titles?: CalendarTitles;
  };
  mail: {
    on: boolean;
    transport: "gmail" | "smtp" | "fixture" | "off";
    from: string | null;
    account_email: string | null;
    needs_reconnect: boolean;
  };
  slack: {
    on: boolean;
    fixture: boolean;
    team_name: string | null;
    linked_people: number;
    auto_enroll?: boolean;
    /** Set when auto-enroll can't be turned on; a plain sentence saying why. */
    auto_enroll_blocked_reason?: string | null;
    /** Who someone can pick as their manager in Slack. */
    manager_pick?: ManagerPick;
  };
  google_signin: { on: boolean; fixture: boolean };
  /** How many demo people are still on the roster. */
  sample_people?: number;
}

export interface CalendarChoice {
  id: string;
  name: string;
  writable: boolean;
}

export interface AuditEvent {
  at: string;
  actor: PersonRef | null;
  action: string;
  subject: string;
  detail: string;
}

// ------------------------------------------------- decide links (email) --

export type DecideAction = "approve" | "deny" | "confirm_manager" | "reject_manager";

/** The few request facts a decide link may show, without signing in. */
export interface DecideRequest {
  id: string;
  person_name: string;
  kind: Kind;
  start_date: string;
  end_date: string;
  days: number;
  note: string;
  status: Status;
}

export interface DecideView {
  request: DecideRequest | null;
  action: DecideAction | null;
  approver_name: string | null;
  /** For confirm_manager / reject_manager: the person named as manager. */
  manager_name?: string | null;
  state: "pending" | "already_decided" | "expired" | "invalid";
}

// ------------------------------------------------------- reports, insights --

export interface KindDays {
  pto: number;
  sick: number;
  unpaid: number;
  unavailable: number;
  /** Leave of absence; older servers leave it out. */
  loa?: number;
}

export interface ReportPerson extends KindDays {
  id: string;
  name: string;
  pay_basis: PayBasis;
  class?: PersonClass;
  /** Hours away (days x hours per day) for hourly people; null for monthly. */
  hours: number | null;
}

export interface ReportTeam {
  team: string | null; // null = no team, listed last
  people: ReportPerson[];
  totals: KindDays & { hours: number };
}

export interface MonthlyReport {
  year: number;
  month: string; // "YYYY-MM"
  from: string;
  to: string;
  teams: ReportTeam[];
  totals: KindDays & { hours: number };
}

export interface Insights {
  year: number;
  by_month: Array<KindDays & { month: string }>; // 12 entries, "YYYY-MM"
  by_team: Array<KindDays & { team: string | null; people: number; hours: number }>;
  by_person: Array<
    KindDays & {
      id: string;
      name: string;
      team: string | null;
      hours: number | null;
      pto_available: number | null;
      sick_available: number | null;
      class?: PersonClass;
    }
  >;
  by_kind: KindDays;
  out_today: number;
  out_next_30: number;
  pending: number;
  unused_pto_total: number;
}

/** One request inside an Insights drill-down; days_in_window is its share of the month or year. */
export interface InsightRequest {
  id: string;
  person: { id: string; name: string; class?: PersonClass; team: string | null };
  kind: Kind;
  status: Status;
  start_date: string;
  end_date: string;
  days: number;
  days_in_window: number;
  /** The calendar count; differs from days when the person typed their own number. */
  days_computed?: number;
  days_overridden?: boolean;
  hours: number | null;
  approver: PersonRef | null;
  decided_at: string | null;
}

export interface InsightRequests {
  filters: Record<string, string | number | null>;
  /** Sum of days_in_window over every match, listed or not. */
  total_days: number;
  /** More than 500 matched; only the first 500 are listed. */
  truncated?: boolean;
  /** For window drills: how many requests matched (the pending tile's number). */
  total_requests?: number;
  /** For window drills: how many people (the Out today / Next 30 days tiles' number). */
  total_people?: number;
  requests: InsightRequest[];
}

export interface InsightRequestQuery {
  /** Required unless window is given. */
  year?: number;
  /** Time-based tiles, independent of the year picked: today, the next 30 days, or everything waiting. */
  window?: "today" | "next_30" | "pending";
  /** "YYYY-MM", inside year */
  month?: string;
  /** "" = people with no team; left out = any team */
  team?: string;
  person_id?: string;
  kind?: Kind;
  class?: string;
  status?: Status;
}

// ------------------------------------------------------------------ errors --

const FALLBACK = "That didn't go through. Try again.";
const OFFLINE = "Time Off couldn't be reached. Check your connection and try again.";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** The sentence to put on screen for anything a call threw. */
export function messageOf(cause: unknown, fallback = FALLBACK): string {
  if (cause instanceof ApiError) return cause.message;
  return fallback;
}

// A signed-in page whose session lapses hears about it here, so the app can
// fall back to the sign-in screen instead of showing a pile of errors.
let unauthorized: (() => void) | null = null;
export function onUnauthorized(handler: (() => void) | null) {
  unauthorized = handler;
}

async function call<T>(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", OFFLINE, 0);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : response.status >= 500 ? "server" : "failed";
    const message =
      typeof error?.message === "string" && error.message ? error.message : response.status >= 500 ? OFFLINE : FALLBACK;
    if (response.status === 401 && url !== "/api/me") unauthorized?.();
    throw new ApiError(code, message, response.status);
  }
  if (payload === null) throw new ApiError("bad_answer", FALLBACK, response.status);
  return payload as T;
}

const get = <T>(url: string) => call<T>("GET", url);
const setupHeader = (token: string | null): Record<string, string> => (token ? { "X-Setup-Token": token } : {});
const post = <T>(url: string, body: unknown = {}) => call<T>("POST", url, body);
const put = <T>(url: string, body: unknown) => call<T>("PUT", url, body);
const patch = <T>(url: string, body: unknown) => call<T>("PATCH", url, body);
const seg = (value: string) => encodeURIComponent(value);

// ------------------------------------------------------------------ routes --

export const api = {
  // Session
  me: () => get<Me>("/api/me"),
  googleStartUrl: (returnTo: string) => `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`,
  signOut: () => post<{ ok: true }>("/api/auth/signout"),

  // Everyone
  home: () => get<HomeData>("/api/home"),
  preview: (draft: Omit<DraftRequest, "note" | "kind" | "approver_id"> & { kind?: Kind }) => post<Preview>("/api/requests/preview", draft),
  submit: (draft: DraftRequest) => post<{ request: TimeOffRequest; balance: Balances }>("/api/requests", draft),
  cancel: (requestId: string) => post<{ request: TimeOffRequest; balance: Balances }>(`/api/requests/${seg(requestId)}/cancel`),
  approvers: () => get<{ approvers: Array<PersonRef & { team: string | null }>; default_id: string | null }>("/api/approvers"),

  // Managers and admins
  approvals: () => get<ApprovalsData>("/api/approvals"),
  approve: (requestId: string, note?: string) =>
    post<{ request: TimeOffRequest }>(`/api/requests/${seg(requestId)}/approve`, note ? { note } : {}),
  deny: (requestId: string, note?: string) =>
    post<{ request: TimeOffRequest }>(`/api/requests/${seg(requestId)}/deny`, note ? { note } : {}),
  remind: (requestId: string) => post<{ last_reminded_at?: string | null }>(`/api/requests/${seg(requestId)}/remind`),
  confirmManager: (requestId: string) => post<{ request?: TimeOffRequest }>(`/api/requests/${seg(requestId)}/confirm-manager`),
  rejectManager: (requestId: string) => post<{ request?: TimeOffRequest }>(`/api/requests/${seg(requestId)}/reject-manager`),
  teamCalendar: (month: string) => get<TeamCalendar>(`/api/team/calendar?month=${encodeURIComponent(month)}`),

  // Admins
  people: () => get<{ people: PersonRow[]; teams?: string[] }>("/api/people"),
  addPerson: (person: NewPerson) => post<{ person: Person }>("/api/people", person),
  updatePerson: (personId: string, changes: PersonPatch) => patch<{ person: Person }>(`/api/people/${seg(personId)}`, changes),
  setPolicy: (personId: string, policy: Policy) =>
    put<{ person: Person; balance: Balances }>(`/api/people/${seg(personId)}/policy`, policy),
  adjust: (personId: string, days: number, note: string, kind: "pto" | "sick" = "pto") =>
    post<{ balance: Balances }>(`/api/people/${seg(personId)}/adjustments`, { days, note, kind }),
  holidays: (year: number) => get<{ holidays: Holiday[] }>(`/api/holidays?year=${year}`),
  saveHolidays: (year: number, holidays: Holiday[]) => put<{ holidays?: Holiday[] }>("/api/holidays", { year, holidays }),
  settings: () => get<Settings>("/api/settings"),
  calendarConnectUrl: "/api/settings/calendar/connect",
  calendars: () => get<{ calendars: CalendarChoice[] }>("/api/settings/calendars"),
  chooseCalendar: (calendarId: string) => put<{ settings: Settings }>("/api/settings/calendar", { calendar_id: calendarId }),
  setSlackAutoEnroll: (autoEnroll: boolean) => put<{ settings?: Settings }>("/api/settings/slack", { auto_enroll: autoEnroll }),
  setSlackManagerPick: (managerPick: ManagerPick) => put<{ settings?: Settings }>("/api/settings/slack", { manager_pick: managerPick }),
  setCalendarTitles: (titles: CalendarTitles) => put<{ settings?: Settings }>("/api/settings/calendar", { titles }),
  disconnectCalendar: () => post<{ settings: Settings }>("/api/settings/calendar/disconnect"),
  retryCalendar: () => post<{ retried: number; failed: number }>("/api/settings/calendar/retry"),
  // The setup token rides in a header, never the query string, so it stays out of server logs.
  setupStatus: (token: string | null) => call<SetupStatus>("GET", "/api/setup/status", undefined, setupHeader(token)),
  saveKeys: (keys: Omit<SetupKeys, "token">, token: string | null) => call<SetupSaved>("PUT", "/api/setup/keys", keys, setupHeader(token)),
  reportMonthly: (year: number, month: number) => get<MonthlyReport>(`/api/reports/monthly?year=${year}&month=${month}`),
  insights: (year: number) => get<Insights>(`/api/insights?year=${year}`),
  insightRequests: (q: InsightRequestQuery) => {
    const qs = new URLSearchParams();
    // An empty team is meaningful (no team), so only undefined/null are left out.
    for (const [k, val] of Object.entries(q)) if (val !== undefined && val !== null) qs.set(k, String(val));
    return get<InsightRequests>(`/api/insights/requests?${qs.toString()}`);
  },
  decideView: (token: string) => get<DecideView>(`/api/decide/${seg(token)}`),
  decide: (token: string, note?: string) =>
    post<{ ok: true; action: DecideAction; request: DecideRequest }>(`/api/decide/${seg(token)}`, note ? { note } : {}),
  audit: (limit = 100) => get<{ events: AuditEvent[] }>(`/api/audit?limit=${limit}`),
};

// ----------------------------------------------------------- dev-only mock --
// Answered only by scripts/mock-api.mjs. The client calls these only behind
// import.meta.env.DEV, so they never run in a production build.

export const mockApi = {
  roles: () => get<{ roles: Array<{ id: string; label: string }>; current: string }>("/api/mock/roles"),
  signInAs: (role: string) => post<{ ok: true }>("/api/mock/signin-as", { role }),
};
