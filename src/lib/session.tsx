// Who is signed in, shared by every page. Loaded once from GET /api/me and
// refreshed after sign-out, the dev-only role switch, or a lapsed session.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, onUnauthorized, type Kind, type Me, type Person } from "./api";
import { kindIds } from "./words";

type SessionState =
  | { status: "loading" }
  | { status: "unreachable"; message: string }
  | { status: "ready"; me: Me };

interface SessionValue {
  state: SessionState;
  person: Person | null;
  /** Staff can also use /timeoff in Slack (from /api/me; false when the server doesn't say). */
  slackAvailable: boolean;
  /** The Types this person may ask for, from /api/me (null when the server doesn't say). */
  kinds: Kind[] | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setState({ status: "ready", me });
    } catch {
      setState({
        status: "unreachable",
        message: "Time Off couldn't be reached. Check your connection and try again.",
      });
    }
  }, []);

  const signOut = useCallback(async () => {
    await api.signOut().catch(() => null);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    onUnauthorized(() => void refresh());
    return () => onUnauthorized(null);
  }, [refresh]);

  const person = state.status === "ready" && state.me.signedIn ? state.me.person : null;
  const slackAvailable = state.status === "ready" && state.me.slack_available === true;
  const kinds = state.status === "ready" && state.me.signedIn ? kindIds(state.me.kinds) : null;

  return <SessionContext.Provider value={{ state, person, slackAvailable, kinds, refresh, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

/** The signed-in person; only for pages rendered behind the sign-in gate. */
export function useMe(): Person {
  const { person } = useSession();
  if (!person) throw new Error("useMe without a signed-in person");
  return person;
}
