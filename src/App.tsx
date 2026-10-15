import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loading } from "./components/Bits";
import Shell from "./components/Shell";
import type { Role } from "./lib/api";
import { useSession } from "./lib/session";
import { atLeast } from "./lib/words";
import Approvals from "./pages/Approvals";
import Decide from "./pages/Decide";
import Insights from "./pages/Insights";
import Reports from "./pages/Reports";
import Home from "./pages/Home";
import People from "./pages/People";
import SettingsPage from "./pages/Settings";
import Setup from "./pages/Setup";
import SignIn, { safeReturn } from "./pages/SignIn";
import Team from "./pages/Team";

// The sample-data role switch exists only in development; in a production
// build this constant is null and the module is never bundled.
const MockBar = import.meta.env.DEV ? lazy(() => import("./components/MockBar")) : null;

const TITLES: Record<string, string> = {
  "/": "Home",
  "/approvals": "Approvals",
  "/team": "Team",
  "/people": "People",
  "/settings": "Settings",
  "/signin": "Sign in",
  "/setup": "Set up",
  "/reports": "Reports",
  "/insights": "Insights",
};

function useTitleAndScroll() {
  const location = useLocation();
  useEffect(() => {
    const page = TITLES[location.pathname] ?? (/^\/(approve|deny|confirm-manager|reject-manager)\//.test(location.pathname) ? "Decide" : undefined);
    document.title = page && page !== "Home" ? `${page} · Time Off` : "Time Off";
    window.scrollTo(0, 0);
  }, [location.pathname]);
}

function RequireRole({ needs, children }: { needs: Role; children: ReactNode }) {
  const { person } = useSession();
  if (person && atLeast(person.role, needs)) return <>{children}</>;
  return (
    <section className="page narrow">
      <div className="card notice-card">
        <h1 className="page-title">This page isn’t part of your account</h1>
        <p className="muted">
          {needs === "admin"
            ? "Only admins can open it. If you need something changed, ask your admin."
            : "It’s for managers who approve time off."}
        </p>
        <Link className="button button-primary" to="/">
          Go to Home
        </Link>
      </div>
    </section>
  );
}

function SignedIn() {
  const location = useLocation();
  if (location.pathname === "/signin") {
    const target = safeReturn(new URLSearchParams(location.search).get("return_to"));
    return <Navigate to={target} replace />;
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/approvals"
          element={
            <RequireRole needs="manager">
              <Approvals />
            </RequireRole>
          }
        />
        <Route
          path="/team"
          element={
            <RequireRole needs="manager">
              <Team />
            </RequireRole>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireRole needs="manager">
              <Reports />
            </RequireRole>
          }
        />
        <Route
          path="/insights"
          element={
            <RequireRole needs="manager">
              <Insights />
            </RequireRole>
          }
        />
        <Route
          path="/people"
          element={
            <RequireRole needs="admin">
              <People />
            </RequireRole>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireRole needs="admin">
              <SettingsPage />
            </RequireRole>
          }
        />
        <Route
          path="*"
          element={
            <section className="page narrow">
              <div className="card notice-card">
                <h1 className="page-title">That page isn’t here</h1>
                <p className="muted">The link may be old. Everything you need starts from Home.</p>
                <Link className="button button-primary" to="/">
                  Go to Home
                </Link>
              </div>
            </section>
          }
        />
      </Routes>
    </Shell>
  );
}

function Gate() {
  const { state, refresh } = useSession();
  const location = useLocation();
  useTitleAndScroll();

  // Approve/deny links from email need no sign-in and no app frame.
  if (/^\/(approve|deny|confirm-manager|reject-manager)\/[^/]+$/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/approve/:token" element={<Decide action="approve" />} />
        <Route path="/deny/:token" element={<Decide action="deny" />} />
        <Route path="/confirm-manager/:token" element={<Decide action="confirm_manager" />} />
        <Route path="/reject-manager/:token" element={<Decide action="reject_manager" />} />
      </Routes>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="boot">
        <Loading label="Opening Time Off" />
      </div>
    );
  }
  if (state.status === "unreachable") {
    return (
      <div className="boot">
        <div className="card notice-card">
          <h1 className="page-title">Time Off isn’t answering</h1>
          <p className="muted">{state.message}</p>
          <button type="button" className="button button-primary" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  // The setup page stands on its own: the owner arrives with a private link
  // before anyone can sign in, or an admin comes from Settings → Keys.
  if (location.pathname === "/setup") return <Setup />;
  if (!state.me.signedIn) {
    if (location.pathname === "/signin") return <SignIn me={state.me} />;
    // Google sends failed sign-ins back to /?signin_error=… or
    // /?not_on_roster=1&email=…; carry those to the sign-in page and keep
    // everything else as the place to return to.
    const params = new URLSearchParams(location.search);
    const carry = new URLSearchParams();
    for (const key of ["signin_error", "not_on_roster"]) {
      const value = params.get(key);
      if (value) carry.set(key, value);
      params.delete(key);
    }
    const rest = params.toString();
    const back = location.pathname + (rest ? `?${rest}` : "");
    if (back !== "/") carry.set("return_to", back);
    const query = carry.toString();
    return <Navigate to={query ? `/signin?${query}` : "/signin"} replace />;
  }
  return <SignedIn />;
}

export default function App() {
  return (
    <>
      {MockBar ? (
        <Suspense fallback={null}>
          <MockBar />
        </Suspense>
      ) : null}
      <Gate />
    </>
  );
}
