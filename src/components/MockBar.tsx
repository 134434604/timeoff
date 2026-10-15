// Dev only: a thin bar for switching who is signed in against
// scripts/mock-api.mjs. App.tsx renders it only behind import.meta.env.DEV,
// so a production build drops this module entirely, and it shows itself only
// when the mock answers GET /api/mock/roles (the real server does not).

import { useEffect, useState } from "react";
import { mockApi } from "../lib/api";
import { useSession } from "../lib/session";

export default function MockBar() {
  const { refresh } = useSession();
  const [roles, setRoles] = useState<Array<{ id: string; label: string }> | null>(null);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mockApi
      .roles()
      .then((answer) => {
        setRoles(answer.roles);
        setCurrent(answer.current);
      })
      .catch(() => setRoles(null));
  }, []);

  if (!roles) return null;

  async function pick(role: string) {
    setBusy(true);
    try {
      await mockApi.signInAs(role);
      setCurrent(role);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mockbar" role="region" aria-label="Sample data controls">
      <span className="mockbar-label">Sample data · sign in as</span>
      <div className="mockbar-roles">
        {roles.map((role) => (
          <button
            key={role.id}
            type="button"
            className={role.id === current ? "mockbar-role is-current" : "mockbar-role"}
            aria-pressed={role.id === current}
            disabled={busy}
            onClick={() => void pick(role.id)}
          >
            {role.label}
          </button>
        ))}
      </div>
    </div>
  );
}
