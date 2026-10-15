// People (admins): everyone on the roster with their balance, adding someone
// inline, and a side panel per person for their details, time-off policy,
// balance adjustments, and deactivation. Company holidays sit below.

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Avatar, Empty, ErrorLine, Loading, TypeChip } from "../components/Bits";
import Drawer from "../components/Drawer";
import { CheckIcon, PlusIcon } from "../components/Icons";
import {
  api,
  messageOf,
  type Holiday,
  type NewPerson,
  type PayBasis,
  type PersonRow,
  type Policy,
  type Role,
  type WorkerType,
} from "../lib/api";
import { formatDay, formatNumber, isIsoDate, parts, todayIso } from "../lib/dates";
import { useMe } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { CLASS_LABEL, CLASS_WORDS, KIND_LABEL, ROLE_LABEL, WORKER_LABEL, classOf, firstName } from "../lib/words";

const ROLES: Role[] = ["employee", "manager", "admin"];
const WORKERS: WorkerType[] = ["employee", "contractor"];
const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Asia/Manila",
];

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

export default function People() {
  const { data, setData, error, loading, reload } = useLoad(() => api.people(), []);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [flash, setFlash] = useState("");

  // People who joined from Slack and still need a manager and allowance go first.
  const fresh = (p: PersonRow) => p.enrolled_via === "slack" && p.needs_setup === true;
  const people = useMemo(
    () => [...(data?.people ?? [])].sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || a.name.localeCompare(b.name)),
    [data],
  );
  const freshCount = people.filter((p) => p.active && fresh(p)).length;
  const inactive = people.filter((p) => !p.active).length;
  const shown = showInactive ? people : people.filter((p) => p.active);
  const open = people.find((p) => p.id === openId) ?? null;
  const teams = useMemo(() => {
    const names = new Set<string>(data?.teams ?? []);
    for (const p of data?.people ?? []) if (p.team) names.add(p.team);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data]);

  function merge(id: string, changes: Partial<PersonRow>) {
    setData((d) => (d ? { ...d, people: d.people.map((p) => (p.id === id ? { ...p, ...changes } : p)) } : d));
  }

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1 className="page-title">People</h1>
          <p className="page-sub">Who can sign in, who approves for whom, and how much time off each person gets.</p>
        </div>
        {!adding ? (
          <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
            <PlusIcon size={18} />
            Add person
          </button>
        ) : null}
      </header>

      {freshCount ? (
        <p className="slack-joined" role="status">
          {freshCount === 1 ? "1 person joined" : `${freshCount} people joined`} from Slack and{" "}
          {freshCount === 1 ? "needs" : "need"} a manager and allowance. Open each one marked “New from Slack” to finish.
        </p>
      ) : null}

      {flash ? (
        <p className="flash" role="status">
          <CheckIcon size={18} />
          {flash}
        </p>
      ) : null}

      {adding && data ? (
        <AddPerson
          people={people}
          teams={teams}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void reload();
          }}
          onFlash={setFlash}
        />
      ) : null}

      {loading && !data ? <Loading label="Loading people" /> : null}
      {error && !data ? <ErrorLine message={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <>
          <div className="roster-tools">
            <p className="muted small">
              {people.length - inactive} on the roster
              {inactive ? ` · ${inactive} deactivated` : ""}
            </p>
            {inactive ? (
              <label className="check">
                <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                <span>Show deactivated</span>
              </label>
            ) : null}
          </div>
          <RosterSection
            title="Employees"
            rows={shown.filter((p) => classOf(p) === "employee")}
            contractors={false}
            isFresh={fresh}
            onEdit={setOpenId}
          />
          <RosterSection
            title="Contractors"
            rows={shown.filter((p) => classOf(p) !== "employee")}
            contractors
            isFresh={fresh}
            onEdit={setOpenId}
          />
        </>
      ) : null}

      <HolidaysEditor />

      {open ? (
        <Drawer title={open.name} subtitle={open.email} onClose={() => setOpenId(null)}>
          <PersonEditor key={open.id} row={open} people={people} teams={teams} onMerged={(changes) => merge(open.id, changes)} />
        </Drawer>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- roster --

function RosterSection({
  title,
  rows,
  contractors,
  isFresh,
  onEdit,
}: {
  title: string;
  rows: PersonRow[];
  contractors: boolean;
  isFresh: (p: PersonRow) => boolean;
  onEdit: (id: string) => void;
}) {
  const ids = useId();
  return (
    <section className="card table-card" aria-labelledby={`${ids}-h`}>
      <div className="table-tools">
        <h2 id={`${ids}-h`} className="card-title">
          {title} <span className="count">{rows.length}</span>
        </h2>
        <p className="muted small">
          {contractors ? "Each has an allowance by pay: monthly or hourly." : `Unlimited ${KIND_LABEL.pto} and sick unless a limit is set.`}
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="table-empty">
          <Empty title={contractors ? "No contractors yet." : "No employees yet."} />
        </div>
      ) : (
        <table className="people-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Team</th>
              <th scope="col">Role</th>
              <th scope="col">Manager</th>
              <th scope="col" className="num">
                Available
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const cls = classOf(p);
              const pto = p.balance.pto;
              return (
                <tr key={p.id} className={p.active ? undefined : "is-inactive"}>
                  <th scope="row" data-label="Name">
                    <span className="person-cell">
                      <Avatar name={p.name} />
                      <span>{p.name}</span>
                      <TypeChip cls={cls} />
                      {isFresh(p) ? <span className="tag tag-warn">New from Slack</span> : null}
                      {p.sample ? <span className="tag tag-sample">Sample</span> : null}
                      {p.slack_user_id ? (
                        <span className="slack-tick" title="Linked to Slack">
                          <CheckIcon size={12} />
                          Slack
                        </span>
                      ) : null}
                    </span>
                  </th>
                  <td data-label="Email" className="cell-email">
                    {p.email}
                  </td>
                  <td data-label="Team">{p.team ?? <span className="muted">None</span>}</td>
                  <td data-label="Role">{ROLE_LABEL[p.role]}</td>
                  <td data-label="Manager">{p.manager?.name ?? <span className="muted">None</span>}</td>
                  <td data-label="Available" className="num">
                    {pto.unlimited ? (
                      "Unlimited"
                    ) : pto.tracked ? (
                      `${formatNumber(pto.available)} days`
                    ) : (
                      <span className="muted">Not tracked</span>
                    )}
                  </td>
                  <td data-label="Status">{p.active ? <span className="tag tag-on">Active</span> : <span className="tag">Deactivated</span>}</td>
                  <td className="cell-action">
                    <button type="button" className="button button-quiet button-small" onClick={() => onEdit(p.id)}>
                      Edit<span className="visually-hidden"> {p.name}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ------------------------------------------------------------ add person --

function managersFor(people: PersonRow[], exceptId?: string) {
  return people.filter((p) => p.active && p.id !== exceptId && (p.role === "manager" || p.role === "admin"));
}

function AddPerson({
  people,
  teams,
  onCancel,
  onAdded,
  onFlash,
}: {
  people: PersonRow[];
  teams: string[];
  onCancel: () => void;
  onAdded: () => void;
  onFlash: (line: string) => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<NewPerson>({
    email: "",
    name: "",
    role: "employee",
    worker_type: "employee",
    manager_id: "",
    timezone: browserZone(),
    team: "",
    pay_basis: "monthly",
    hours_per_day: 8,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof NewPerson>(key: K, value: NewPerson[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError("Add a name and a full email address, like name@example.com.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await api.addPerson({
        ...form,
        email: form.email.trim(),
        name: form.name.trim(),
        manager_id: form.manager_id || null,
        team: form.team?.trim() || null,
        // hours_per_day is always a number on the server (default 8); only send it for hourly people.
        hours_per_day: form.pay_basis === "hourly" ? (form.hours_per_day ?? 8) : undefined,
      });
      onFlash(`${answer.person.name} is on the roster. They can sign in with ${answer.person.email}.`);
      onAdded();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card add-card" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="card-title">
        Add a person
      </h2>
      <form onSubmit={submit} className="form-grid" noValidate>
        <div className="field">
          <label className="label" htmlFor={`${ids}-name`}>
            Name
          </label>
          <input id={`${ids}-name`} className="input" value={form.name} autoComplete="off" autoFocus onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-email`}>
            Work email
          </label>
          <input id={`${ids}-email`} className="input" type="email" value={form.email} autoComplete="off" onChange={(e) => set("email", e.target.value)} />
          <p className="hint">The Google account they’ll sign in with.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-role`}>
            Role
          </label>
          <select id={`${ids}-role`} className="input" value={form.role} onChange={(e) => set("role", e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-type`}>
            Type
          </label>
          <select id={`${ids}-type`} className="input" value={form.worker_type} onChange={(e) => set("worker_type", e.target.value as WorkerType)}>
            {WORKERS.map((w) => (
              <option key={w} value={w}>
                {WORKER_LABEL[w]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-manager`}>
            Manager
          </label>
          <select id={`${ids}-manager`} className="input" value={form.manager_id ?? ""} onChange={(e) => set("manager_id", e.target.value)}>
            <option value="">No manager</option>
            {managersFor(people).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <p className="hint">Approves their time off.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-tz`}>
            Time zone
          </label>
          <input id={`${ids}-tz`} className="input" list={`${ids}-zones`} value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
          <datalist id={`${ids}-zones`}>
            {COMMON_ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <WorkFields
          idBase={ids}
          teams={teams}
          team={form.team ?? ""}
          payBasis={form.pay_basis ?? "monthly"}
          hours={form.hours_per_day ?? null}
          onTeam={(v) => set("team", v)}
          onPayBasis={(v) => set("pay_basis", v)}
          onHours={(v) => set("hours_per_day", v ?? undefined)}
        />
        <div className="form-span">
          <ErrorLine message={error} />
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "Adding…" : "Add to roster"}
            </button>
            <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

// Team, pay basis, and hours in a day: the same three fields on Add and Edit.
function WorkFields({
  idBase,
  teams,
  team,
  payBasis,
  hours,
  onTeam,
  onPayBasis,
  onHours,
}: {
  idBase: string;
  teams: string[];
  team: string;
  payBasis: PayBasis;
  hours: number | null;
  onTeam: (v: string) => void;
  onPayBasis: (v: PayBasis) => void;
  onHours: (v: number | null) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${idBase}-team`}>
          Team <span className="optional">optional</span>
        </label>
        <input id={`${idBase}-team`} className="input" list={`${idBase}-teams`} value={team} placeholder="Support" onChange={(e) => onTeam(e.target.value)} />
        <datalist id={`${idBase}-teams`}>
          {teams.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idBase}-pay`}>
          Paid
        </label>
        <select id={`${idBase}-pay`} className="input" value={payBasis} onChange={(e) => onPayBasis(e.target.value as PayBasis)}>
          <option value="monthly">Monthly</option>
          <option value="hourly">Hourly</option>
        </select>
      </div>
      {payBasis === "hourly" ? (
        <div className="field">
          <label className="label" htmlFor={`${idBase}-hours`}>
            Hours in a work day
          </label>
          <input
            id={`${idBase}-hours`}
            className="input input-days"
            type="number"
            inputMode="decimal"
            min={1}
            max={24}
            step={0.5}
            value={hours ?? 8}
            onChange={(e) => onHours(e.target.value === "" ? null : Number(e.target.value))}
          />
          <p className="hint">Reports show their time off in hours too.</p>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------- edit drawer --

function SaveLine({ saved, error }: { saved: string; error: string }) {
  if (error) return <ErrorLine message={error} />;
  if (!saved) return null;
  return (
    <p className="saved-line" role="status">
      <CheckIcon size={16} />
      {saved}
    </p>
  );
}

function PersonEditor({
  row,
  people,
  teams,
  onMerged,
}: {
  row: PersonRow;
  people: PersonRow[];
  teams: string[];
  onMerged: (changes: Partial<PersonRow>) => void;
}) {
  const me = useMe();
  return (
    <>
      <BalanceSummary row={row} />
      <DetailsForm row={row} people={people} teams={teams} onMerged={onMerged} />
      <PolicyForm row={row} onMerged={onMerged} />
      {row.balance.pto.tracked || row.balance.sick.tracked || row.policy ? <AdjustForm row={row} onMerged={onMerged} /> : null}
      <ActiveForm row={row} isMe={row.id === me.id} onMerged={onMerged} />
    </>
  );
}

function BalanceSummary({ row }: { row: PersonRow }) {
  const b = row.balance.pto;
  const sick = row.balance.sick;
  const sickLine = sick.unlimited ? (
    <p className="drawer-sick">
      Sick days: no limit · <strong>{formatNumber(sick.used)}</strong> used this year
    </p>
  ) : sick.tracked ? (
    <p className="drawer-sick">
      Sick days: <strong>{formatNumber(sick.available)}</strong> available · {formatNumber(sick.used)} used of {formatNumber(sick.allowance)} this year
    </p>
  ) : null;
  if (b.unlimited)
    return (
      <>
        <dl className="drawer-balance">
          <div>
            <dt>{KIND_LABEL.pto}</dt>
            <dd className="strong">No limit</dd>
          </div>
          <div>
            <dt>Used this year</dt>
            <dd>{formatNumber(b.used)}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{formatNumber(b.pending)}</dd>
          </div>
        </dl>
        {sickLine}
      </>
    );
  if (!b.tracked)
    return (
      <>
        <p className="drawer-balance muted">No {KIND_LABEL.pto} balance is tracked for {firstName(row.name)}.</p>
        {sickLine}
      </>
    );
  return (
    <>
    <dl className="drawer-balance">
      <div>
        <dt>Available</dt>
        <dd className="strong">{formatNumber(b.available)}</dd>
      </div>
      <div>
        <dt>Used</dt>
        <dd>{formatNumber(b.used)}</dd>
      </div>
      <div>
        <dt>Waiting</dt>
        <dd>{formatNumber(b.pending)}</dd>
      </div>
      <div>
        <dt>Earned</dt>
        <dd>{formatNumber(b.accrued)}</dd>
      </div>
      <div>
        <dt>Carried over</dt>
        <dd>{formatNumber(b.carried_over)}</dd>
      </div>
      <div>
        <dt>Adjusted</dt>
        <dd>{formatNumber(b.adjustments)}</dd>
      </div>
    </dl>
    {sickLine}
    </>
  );
}

function DetailsForm({
  row,
  people,
  teams,
  onMerged,
}: {
  row: PersonRow;
  people: PersonRow[];
  teams: string[];
  onMerged: (c: Partial<PersonRow>) => void;
}) {
  const ids = useId();
  const [name, setName] = useState(row.name);
  const [role, setRole] = useState<Role>(row.role);
  const [worker, setWorker] = useState<WorkerType>(row.worker_type);
  const [managerId, setManagerId] = useState(row.manager?.id ?? "");
  const [timezone, setTimezone] = useState(row.timezone);
  const [slack, setSlack] = useState(row.slack_user_id ?? "");
  const [team, setTeam] = useState(row.team ?? "");
  const [payBasis, setPayBasis] = useState<PayBasis>(row.pay_basis ?? "monthly");
  const [hours, setHours] = useState<number | null>(row.hours_per_day ?? 8);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Add a name.");
      return;
    }
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const answer = await api.updatePerson(row.id, {
        name: name.trim(),
        role,
        worker_type: worker,
        manager_id: managerId || null,
        timezone,
        slack_user_id: slack.trim() || null,
        team: team.trim() || null,
        pay_basis: payBasis,
        hours_per_day: payBasis === "hourly" ? (hours ?? 8) : undefined,
      });
      onMerged(answer.person);
      setSaved("Saved.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="drawer-section" onSubmit={save} noValidate aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="section-title">
        Details
      </h3>
      <div className="field">
        <label className="label" htmlFor={`${ids}-name`}>
          Name
        </label>
        <input id={`${ids}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-two">
        <div className="field">
          <label className="label" htmlFor={`${ids}-role`}>
            Role
          </label>
          <select id={`${ids}-role`} className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-type`}>
            Type
          </label>
          <select id={`${ids}-type`} className="input" value={worker} onChange={(e) => setWorker(e.target.value as WorkerType)}>
            {WORKERS.map((w) => (
              <option key={w} value={w}>
                {WORKER_LABEL[w]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${ids}-manager`}>
          Manager
        </label>
        <select id={`${ids}-manager`} className="input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">No manager</option>
          {managersFor(people, row.id).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-two">
        <div className="field">
          <label className="label" htmlFor={`${ids}-tz`}>
            Time zone
          </label>
          <input id={`${ids}-tz`} className="input" list={`${ids}-zones`} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id={`${ids}-zones`}>
            {COMMON_ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-slack`}>
            Slack member ID <span className="optional">optional</span>
          </label>
          <input id={`${ids}-slack`} className="input" value={slack} placeholder="U012AB3CD" onChange={(e) => setSlack(e.target.value)} />
        </div>
      </div>
      <div className="form-two">
        <WorkFields
          idBase={ids}
          teams={teams}
          team={team}
          payBasis={payBasis}
          hours={hours}
          onTeam={setTeam}
          onPayBasis={setPayBasis}
          onHours={setHours}
        />
      </div>
      {classOf({ worker_type: worker, pay_basis: payBasis }) !== classOf(row) ? (
        <p className="class-note" role="note">
          Allowance resets to the {CLASS_WORDS[classOf({ worker_type: worker, pay_basis: payBasis })]} default when you save.
        </p>
      ) : null}
      <SaveLine saved={saved} error={error} />
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : "Save details"}
        </button>
      </div>
    </form>
  );
}

const ACCRUAL_WORDS: Record<Policy["accrual"], { label: string; line: string }> = {
  front_loaded: { label: "All at once", line: "The full year’s days are available on January 1 (or on the start date in their first year)." },
  monthly: { label: "Monthly", line: "Days build up a twelfth at a time, at the start of each month." },
};

// Contractors' default allowances by pay basis (the server applies them when
// type or pay changes; these prefill a policy that hasn't been saved yet).
const CONTRACTOR_DEFAULTS: Record<"contractor_monthly" | "contractor_hourly", { pto: number; sick: number }> = {
  contractor_monthly: { pto: 10, sick: 5 },
  contractor_hourly: { pto: 15, sick: 0 },
};

function PolicyForm({ row, onMerged }: { row: PersonRow; onMerged: (c: Partial<PersonRow>) => void }) {
  const ids = useId();
  const cls = classOf(row);
  const employee = cls === "employee";
  const defaults = employee ? { pto: 15, sick: 5 } : CONTRACTOR_DEFAULTS[cls];
  const start: Policy = row.policy ?? {
    annual_days: defaults.pto,
    accrual: "front_loaded",
    carryover_cap: employee ? 5 : 0,
    start_date: todayIso(),
    sick_days: defaults.sick,
    pto_unlimited: employee,
    sick_unlimited: employee,
    // Class defaults (docs/API.md): employees keep holidays off; contractors work them.
    holidays_apply: employee,
  };
  // Employees have no limit unless one is set here; contractors always have numbers.
  const [ptoLimited, setPtoLimited] = useState(employee ? start.pto_unlimited === false : true);
  const [sickLimited, setSickLimited] = useState(employee ? start.sick_unlimited === false : true);
  const [holidaysApply, setHolidaysApply] = useState(start.holidays_apply !== false);
  const [sickDays, setSickDays] = useState(String(start.sick_days ?? 0));
  const [annual, setAnnual] = useState(String(start.annual_days));
  const [accrual, setAccrual] = useState<Policy["accrual"]>(start.accrual);
  const [cap, setCap] = useState(String(start.carryover_cap));
  const [startDate, setStartDate] = useState(start.start_date);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    const annualDays = Number(annual);
    const capDays = Number(cap);
    const sick = Number(sickDays);
    if (ptoLimited && (!Number.isFinite(annualDays) || annualDays < 0 || annualDays > 366)) {
      setError(`${KIND_LABEL.pto} days per year should be a number from 0 to 366.`);
      return;
    }
    if (ptoLimited && (!Number.isFinite(capDays) || capDays < 0)) {
      setError("The carryover limit should be 0 or more days.");
      return;
    }
    if (sickLimited && (!Number.isFinite(sick) || sick < 0 || sick > 366)) {
      setError("Sick days should be a number from 0 to 366.");
      return;
    }
    if (!isIsoDate(startDate)) {
      setError("Pick a start date.");
      return;
    }
    setBusy(true);
    setError("");
    setSaved("");
    const policy: Policy = {
      annual_days: ptoLimited ? annualDays : start.annual_days,
      accrual,
      carryover_cap: ptoLimited ? capDays : start.carryover_cap,
      start_date: startDate,
      sick_days: sickLimited ? sick : start.sick_days,
      pto_unlimited: employee ? !ptoLimited : false,
      sick_unlimited: employee ? !sickLimited : false,
      ...(employee ? {} : { holidays_apply: holidaysApply }),
    };
    try {
      const answer = await api.setPolicy(row.id, policy);
      onMerged({ ...answer.person, policy, balance: answer.balance });
      const b = answer.balance;
      const pto = b.pto.unlimited ? `no limit on ${KIND_LABEL.pto}` : `${formatNumber(b.pto.available)} ${KIND_LABEL.pto} days`;
      const sickText = b.sick.unlimited ? "no limit on sick days" : b.sick.tracked ? `${formatNumber(b.sick.available)} sick days` : "no sick days tracked";
      setSaved(`Saved. ${firstName(row.name)} has ${pto} and ${sickText}.`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const ptoFields = (
    <>
      <div className="form-two">
        <div className="field">
          <label className="label" htmlFor={`${ids}-annual`}>
            {KIND_LABEL.pto} days per year
          </label>
          <input id={`${ids}-annual`} className="input" type="number" inputMode="decimal" min={0} max={366} step={0.5} value={annual} onChange={(e) => setAnnual(e.target.value)} />
          <p className="hint">0 means no balance is tracked.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-cap`}>
            Carryover limit
          </label>
          <input id={`${ids}-cap`} className="input" type="number" inputMode="decimal" min={0} step={0.5} value={cap} onChange={(e) => setCap(e.target.value)} />
          <p className="hint">Unused days that roll into next year.</p>
        </div>
      </div>
      <fieldset className="field">
        <legend className="label">How days are given</legend>
        <div className="choice-list">
          {(Object.keys(ACCRUAL_WORDS) as Policy["accrual"][]).map((key) => (
            <label key={key} className={accrual === key ? "choice is-on" : "choice"}>
              <input type="radio" name={`${ids}-accrual`} value={key} checked={accrual === key} onChange={() => setAccrual(key)} />
              <span className="choice-text">
                <span className="choice-label">{ACCRUAL_WORDS[key].label}</span>
                <span className="choice-line">{ACCRUAL_WORDS[key].line}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );

  const sickField = (
    <div className="field">
      <label className="label" htmlFor={`${ids}-sick`}>
        Sick days per year
      </label>
      <input
        id={`${ids}-sick`}
        className="input input-days"
        type="number"
        inputMode="decimal"
        min={0}
        max={366}
        step={0.5}
        value={sickDays}
        onChange={(e) => setSickDays(e.target.value)}
      />
      <p className="hint">A fresh set every January 1. Unused sick days don’t carry over. 0 means sick days aren’t tracked.</p>
    </div>
  );

  return (
    <form className="drawer-section" onSubmit={save} noValidate aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="section-title">
        Time-off policy <TypeChip cls={cls} />
      </h3>
      {!row.policy ? <p className="hint hint-lead">No policy is saved yet. These are the {CLASS_WORDS[cls]} defaults; nothing changes until you save.</p> : null}

      {employee ? (
        <>
          <p className="policy-unlimited">
            {!ptoLimited && !sickLimited
              ? `Unlimited ${KIND_LABEL.pto} and sick`
              : !ptoLimited
                ? `Unlimited ${KIND_LABEL.pto}`
                : !sickLimited
                  ? "Unlimited sick"
                  : "Both have a limit"}
          </p>
          <div className="switch-row policy-switch">
            <label className="switch">
              <input type="checkbox" role="switch" checked={ptoLimited} onChange={(e) => setPtoLimited(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">Set a limit on {KIND_LABEL.pto}</span>
            </label>
          </div>
          {ptoLimited ? ptoFields : null}
          <div className="switch-row policy-switch">
            <label className="switch">
              <input type="checkbox" role="switch" checked={sickLimited} onChange={(e) => setSickLimited(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">Set a limit on sick days</span>
            </label>
          </div>
          {sickLimited ? sickField : null}
        </>
      ) : (
        <>
          {ptoFields}
          {sickField}
          <div className="switch-row policy-switch">
            <label className="switch">
              <input type="checkbox" role="switch" checked={!holidaysApply} onChange={(e) => setHolidaysApply(!e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">Company holidays count as working days</span>
            </label>
            <p className="hint">
              {holidaysApply
                ? "Off: company holidays are days off, so they aren’t counted in requests."
                : "On: company holidays are ordinary working days for this contractor and count in requests."}
            </p>
          </div>
        </>
      )}

      <div className="field">
        <label className="label" htmlFor={`${ids}-start`}>
          Start date
        </label>
        <input id={`${ids}-start`} className="input input-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <p className="hint">When they started. A limited first year is prorated from here.</p>
      </div>
      <SaveLine saved={saved} error={error} />
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : "Save policy"}
        </button>
      </div>
    </form>
  );
}

function AdjustForm({ row, onMerged }: { row: PersonRow; onMerged: (c: Partial<PersonRow>) => void }) {
  const ids = useId();
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [kind, setKind] = useState<"pto" | "sick">("pto");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    const amount = Number(days);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter how many days, like 1 or 0.5.");
      return;
    }
    if (!note.trim()) {
      setError("Add a short note saying why. It’s kept with the change.");
      return;
    }
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const signed = direction === "add" ? amount : -amount;
      const answer = await api.adjust(row.id, signed, note.trim(), kind);
      onMerged({ balance: answer.balance });
      const word = kind === "sick" ? (amount === 1 ? "sick day" : "sick days") : amount === 1 ? "day" : "days";
      const left = kind === "sick" ? answer.balance.sick : answer.balance.pto;
      setSaved(
        `${direction === "add" ? "Added" : "Removed"} ${formatNumber(amount)} ${word}. ${firstName(row.name)} now has ${formatNumber(left.available)} ${kind === "sick" ? "sick days" : "days off"} available.`,
      );
      setDays("");
      setNote("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="drawer-section" onSubmit={save} noValidate aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="section-title">
        Adjust balance
      </h3>
      <div className="segmented segmented-small adjust-kind" role="group" aria-label="Which balance">
        <label className={kind === "pto" ? "segment is-on" : "segment"}>
          <input type="radio" name={`${ids}-kind`} checked={kind === "pto"} onChange={() => setKind("pto")} />
          <span>{KIND_LABEL.pto}</span>
        </label>
        <label className={kind === "sick" ? "segment is-on" : "segment"}>
          <input type="radio" name={`${ids}-kind`} checked={kind === "sick"} onChange={() => setKind("sick")} />
          <span>Sick</span>
        </label>
      </div>
      <div className="adjust-row">
        <div className="segmented segmented-small" role="group" aria-label="Add or remove days">
          <label className={direction === "add" ? "segment is-on" : "segment"}>
            <input type="radio" name={`${ids}-dir`} checked={direction === "add"} onChange={() => setDirection("add")} />
            <span>Add</span>
          </label>
          <label className={direction === "remove" ? "segment is-on" : "segment"}>
            <input type="radio" name={`${ids}-dir`} checked={direction === "remove"} onChange={() => setDirection("remove")} />
            <span>Remove</span>
          </label>
        </div>
        <div className="field field-inline">
          <label className="visually-hidden" htmlFor={`${ids}-days`}>
            Days
          </label>
          <input id={`${ids}-days`} className="input input-days" type="number" inputMode="decimal" min={0.5} step={0.5} placeholder="1" value={days} onChange={(e) => setDays(e.target.value)} />
          <span className="muted">days</span>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${ids}-note`}>
          Why
        </label>
        <input id={`${ids}-note`} className="input" value={note} placeholder="Worked the holiday weekend" onChange={(e) => setNote(e.target.value)} />
      </div>
      <SaveLine saved={saved} error={error} />
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : "Save adjustment"}
        </button>
      </div>
    </form>
  );
}

function ActiveForm({ row, isMe, onMerged }: { row: PersonRow; isMe: boolean; onMerged: (c: Partial<PersonRow>) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = firstName(row.name);

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const answer = await api.updatePerson(row.id, { active: !row.active });
      onMerged(answer.person);
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="drawer-section drawer-danger">
      <h3 className="section-title">{row.active ? "Deactivate" : "Reactivate"}</h3>
      {isMe ? (
        <p className="muted small">You can’t deactivate yourself.</p>
      ) : row.active ? (
        <>
          <p className="muted small">
            {first} won’t be able to sign in, and won’t show on the team calendar. Their history stays.
          </p>
          {confirming ? (
            <div className="inline-confirm">
              <span>Deactivate {first}?</span>
              <div className="inline-confirm-actions">
                <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => void toggle()}>
                  {busy ? "Deactivating…" : `Yes, deactivate ${first}`}
                </button>
                <button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep active
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="button button-danger-quiet" onClick={() => setConfirming(true)}>
              Deactivate {first}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted small">{first} can sign in again once reactivated.</p>
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void toggle()}>
            {busy ? "Reactivating…" : `Reactivate ${first}`}
          </button>
        </>
      )}
      <ErrorLine message={error} />
    </section>
  );
}

// ------------------------------------------------------------- holidays --

type HolidayRow = Holiday & { key: number };

function HolidaysEditor() {
  const thisYear = parts(todayIso()).y;
  const years = [thisYear - 1, thisYear, thisYear + 1, thisYear + 2];
  const [year, setYear] = useState(thisYear);
  const { data, error, loading, reload } = useLoad(() => api.holidays(year), [year]);
  const [rows, setRows] = useState<HolidayRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveError, setSaveError] = useState("");
  const ids = useId();

  useEffect(() => {
    if (!data) return;
    setRows([...data.holidays].sort((a, b) => a.date.localeCompare(b.date)).map((h, i) => ({ ...h, key: i })));
    setDirty(false);
    setSaveError("");
  }, [data]);

  function edit(key: number, changes: Partial<Holiday>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...changes } : r)));
    setDirty(true);
    setSaved("");
  }

  function add() {
    const key = rows.reduce((m, r) => Math.max(m, r.key), -1) + 1;
    setRows((rs) => [...rs, { key, date: "", name: "" }]);
    setDirty(true);
    setSaved("");
    window.setTimeout(() => document.getElementById(`${ids}-date-${key}`)?.focus(), 0);
  }

  function remove(key: number) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
    setSaved("");
  }

  async function save() {
    const bad = rows.find((r) => !isIsoDate(r.date) || parts(r.date).y !== year || !r.name.trim());
    if (bad) {
      setSaveError(`Every holiday needs a ${year} date and a name.`);
      return;
    }
    const dates = rows.map((r) => r.date);
    if (new Set(dates).size !== dates.length) {
      setSaveError("Two holidays are on the same date. Remove one.");
      return;
    }
    setBusy(true);
    setSaveError("");
    try {
      const clean = rows.map((r) => ({ date: r.date, name: r.name.trim() })).sort((a, b) => a.date.localeCompare(b.date));
      await api.saveHolidays(year, clean);
      setRows(clean.map((h, i) => ({ ...h, key: i })));
      setDirty(false);
      setSaved(`Saved ${clean.length} holidays for ${year}.`);
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card holidays-card" aria-labelledby={`${ids}-title`}>
      <div className="table-tools">
        <div>
          <h2 id={`${ids}-title`} className="card-title">
            Company holidays
          </h2>
          <p className="muted small">Holidays aren’t counted as days off and show on everyone’s calendar.</p>
        </div>
        <div className="field field-inline">
          <label className="label" htmlFor={`${ids}-year`}>
            Year
          </label>
          <select
            id={`${ids}-year`}
            className="input input-auto"
            value={year}
            onChange={(e) => {
              if (dirty && !window.confirm("You have unsaved holiday changes. Switch years and lose them?")) return;
              setYear(Number(e.target.value));
              setSaved("");
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && !data ? <Loading label="Loading holidays" /> : null}
      <ErrorLine message={error} onRetry={() => void reload()} />

      {data ? (
        <>
          {rows.length === 0 ? (
            <Empty title={`No holidays for ${year} yet.`}>Add the days your company is closed.</Empty>
          ) : (
            <ul className="holiday-edit">
              {rows.map((r) => (
                <li key={r.key}>
                  <label className="visually-hidden" htmlFor={`${ids}-date-${r.key}`}>
                    Date
                  </label>
                  <input
                    id={`${ids}-date-${r.key}`}
                    type="date"
                    className="input input-date"
                    value={r.date}
                    min={`${year}-01-01`}
                    max={`${year}-12-31`}
                    onChange={(e) => edit(r.key, { date: e.target.value })}
                  />
                  <label className="visually-hidden" htmlFor={`${ids}-name-${r.key}`}>
                    Holiday name
                  </label>
                  <input
                    id={`${ids}-name-${r.key}`}
                    className="input"
                    value={r.name}
                    placeholder="Holiday name"
                    onChange={(e) => edit(r.key, { name: e.target.value })}
                  />
                  <span className="holiday-weekday muted">{isIsoDate(r.date) ? formatDay(r.date, true).split(",")[0] : ""}</span>
                  <button type="button" className="button button-quiet button-small" onClick={() => remove(r.key)}>
                    Remove<span className="visually-hidden"> {r.name || "this holiday"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <SaveLine saved={saved} error={saveError} />
          <div className="form-actions">
            <button type="button" className="button button-quiet" onClick={add}>
              <PlusIcon size={18} />
              Add holiday
            </button>
            <button type="button" className="button button-primary" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "Saving…" : `Save ${year} holidays`}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
