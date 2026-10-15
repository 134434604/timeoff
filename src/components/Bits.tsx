// Small shared pieces: status chips, the error line, loading and empty states.

import type { ReactNode } from "react";
import type { OverlapKind, PersonClass, Status } from "../lib/api";
import { Link } from "react-router-dom";
import { formatNumber } from "../lib/dates";
import { CLASS_LABEL, STATUS_LABEL, kindLabel } from "../lib/words";
import { AlertIcon } from "./Icons";

export function StatusChip({ status }: { status: Status }) {
  return (
    <span className={`chip chip-${status}`}>
      <span className="chip-mark" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function KindTag({ kind }: { kind: OverlapKind }) {
  return <span className={`kind kind-${kind}`}>{kindLabel(kind)}</span>;
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <p className="error-line" role="alert">
      <AlertIcon size={18} />
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="link-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </p>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-bar" aria-hidden="true" />
      <span className="visually-hidden">{label}…</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
    </div>
  );
}

/** A number with a label and unit; optionally a link, or a button that opens its details. */
export function Tile({ label, value, unit, to, onSelect }: { label: string; value: number; unit: string; to?: string; onSelect?: () => void }) {
  const body = (
    <>
      <p className="tile-label">{label}</p>
      <p className="tile-value">
        {formatNumber(value)} <span className="tile-unit">{unit}</span>
      </p>
    </>
  );
  if (onSelect)
    return (
      <li className="tile card tile-link">
        <button type="button" className="tile-button" onClick={onSelect} aria-label={`${label}: ${formatNumber(value)} ${unit}. Show the list.`}>
          {body}
        </button>
      </li>
    );
  return <li className={to ? "tile card tile-link" : "tile card"}>{to ? <Link to={to}>{body}</Link> : body}</li>;
}

function initials(name: string): string {
  const bits = name.trim().split(/\s+/);
  return ((bits[0]?.[0] ?? "") + (bits.length > 1 ? bits[bits.length - 1][0] : "")).toUpperCase();
}

/** Initials on a soft color picked from the name, so the same person always looks the same. */
export function Avatar({ name }: { name: string }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ ["--hue" as string]: String(hash) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}


/** Employee / Contractor · Monthly / Contractor · Hourly: the one chip for a person's type. */
export function TypeChip({ cls }: { cls: PersonClass | undefined | null }) {
  if (!cls) return null;
  return <span className={`type-chip type-chip-${cls}`}>{CLASS_LABEL[cls]}</span>;
}
