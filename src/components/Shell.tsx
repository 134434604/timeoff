// The frame around every signed-in page: the app's name, the pages this
// person's role opens, who is signed in, and Sign out.
//
// Wide windows put the pages in the header. At phone width they move to a
// tab bar along the bottom edge, where a thumb reaches them; staff who only
// have Home get no nav at all.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { Role } from "../lib/api";
import { useMe, useSession } from "../lib/session";
import { ROLE_LABEL, atLeast } from "../lib/words";
import { CalendarIcon, ChartIcon, GearIcon, HomeIcon, InboxIcon, MoreIcon, PeopleIcon, ReportIcon } from "./Icons";

export interface Place {
  to: string;
  label: string;
  needs: Role;
  icon: (props: { size?: number }) => ReactNode;
}

export const PLACES: Place[] = [
  { to: "/", label: "Home", needs: "employee", icon: HomeIcon },
  { to: "/approvals", label: "Approvals", needs: "manager", icon: InboxIcon },
  { to: "/team", label: "Team", needs: "manager", icon: CalendarIcon },
  { to: "/reports", label: "Reports", needs: "manager", icon: ReportIcon },
  { to: "/insights", label: "Insights", needs: "manager", icon: ChartIcon },
  { to: "/people", label: "People", needs: "admin", icon: PeopleIcon },
  { to: "/settings", label: "Settings", needs: "admin", icon: GearIcon },
];

export function placesFor(role: Role): Place[] {
  return PLACES.filter((place) => atLeast(role, place.needs));
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="28" height="28">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <path d="M9 12.5h14M9 12.5v10.5h14V12.5" stroke="var(--on-accent)" strokeWidth="2" fill="none" strokeLinejoin="round" />
        <path d="M12.5 9v4M19.5 9v4" stroke="var(--on-accent)" strokeWidth="2" strokeLinecap="round" />
        <path d="m13 18 2.2 2.2L19.5 16" stroke="var(--on-accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const { signOut } = useSession();
  const places = placesFor(me.role);
  const withTabs = places.length > 1;
  // A phone tab bar holds five at most: past that, the last slot is "More".
  const inBar = places.length > 5 ? places.slice(0, 4) : places;
  const inMore = places.length > 5 ? places.slice(4) : [];

  return (
    <div className={withTabs ? "shell has-tabs" : "shell"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <BrandMark />
            <span>Time Off</span>
          </Link>
          {withTabs ? (
            <nav aria-label="Pages" className="nav-top">
              <ul>
                {places.map((place) => (
                  <li key={place.to}>
                    <NavLink to={place.to} end={place.to === "/"}>
                      {place.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <div className="who">
            <span className="who-name">
              <span className="who-full" title={me.email}>
                {me.name}
              </span>
              {me.role !== "employee" ? <span className="who-role">{ROLE_LABEL[me.role]}</span> : null}
            </span>
            <button type="button" className="button button-quiet button-small" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      {withTabs ? (
        <nav aria-label="Pages" className="nav-tabs">
          <ul>
            {inBar.map((place) => (
              <li key={place.to}>
                <NavLink to={place.to} end={place.to === "/"}>
                  {place.icon({ size: 22 })}
                  <span>{place.label}</span>
                </NavLink>
              </li>
            ))}
            {inMore.length ? (
              <li>
                <MoreMenu places={inMore} />
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

// The phone tab bar's "More": a small list above the bar. Escape or picking a
// page closes it, and Escape puts focus back on the button.
function MoreMenu({ places }: { places: Place[] }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const current = places.some((p) => location.pathname === p.to);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={current ? "tab-more active" : "tab-more"}
        aria-expanded={open}
        aria-controls="more-pages"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon size={22} />
        <span>More</span>
      </button>
      {open ? (
        <ul className="more-menu" id="more-pages" ref={list}>
          {places.map((place) => (
            <li key={place.to}>
              <NavLink to={place.to}>
                {place.icon({ size: 20 })}
                <span>{place.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
