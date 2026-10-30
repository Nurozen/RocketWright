/** Shared Results hooks and small parts: rows from the store, status glyphs, and a menu button. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StatusView } from "../../state/status.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { resultsRows, type ResultsRow } from "./model.ts";
import { ResultsIcon, type ResultsGlyph } from "./ResultsIcon.tsx";
import { useResultsUi } from "./resultsUi.ts";

/** Run rows for the current store state (memoized on the inputs; sorted and hide-aware). */
export function useResultsRows(app: AppStore, opts: { sorted?: boolean; includeHidden?: boolean } = {}): ResultsRow[] {
  const snapshot = useAppState(app, (s) => s.project.snapshot);
  const overlay = useAppState(app, (s) => s.runs.overlay);
  const refs = useAppState(app, (s) => s.selection.refs);
  const sort = useResultsUi(app, (u) => u.sort);
  const hidden = useResultsUi(app, (u) => u.hidden);
  const sorted = opts.sorted ?? true;
  const includeHidden = opts.includeHidden ?? false;
  return useMemo(() => {
    const rows = resultsRows(app.getState(), { sort: sorted ? sort : null, hidden });
    return includeHidden ? rows : rows.filter((r) => !r.hidden);
    // The store inputs are listed so the rows recompute when any of them changes.
  }, [app, snapshot, overlay, refs, sort, hidden, sorted, includeHidden]);
}

const STATUS_GLYPH: Record<StatusView["icon"], ResultsGlyph> = {
  check: "check-circle",
  warning: "warning",
  dot: "circle",
  circle: "circle",
  spinner: "circle",
  error: "warning",
  cloud: "circle",
};

export function StatusGlyph({ status, size = 18 }: { status: StatusView; size?: number }) {
  return (
    <span className="rw-status-glyph" data-tone={status.tone} data-icon={status.icon} title={status.reason}>
      <ResultsIcon name={STATUS_GLYPH[status.icon]} size={size} />
    </span>
  );
}

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

/** A button that opens a small menu below it; closes on pick, Escape, or an outside click. */
export function MenuButton({
  testId,
  label,
  className = "rw-button",
  items,
  children,
  align = "left",
}: {
  testId: string;
  label: string;
  className?: string;
  items: readonly MenuItem[];
  children: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="rw-menu-button" ref={ref}>
      <button type="button" className={className} data-testid={testId} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {open && (
        <ul className="rw-menu__list rw-list" role="menu" data-align={align} data-testid={`${testId}.list`}>
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={it.checked}
                disabled={it.disabled}
                data-testid={`${testId}.item`}
                data-item={it.id}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                <span className="rw-menu__check" aria-hidden>
                  {it.checked ? <ResultsIcon name="check" size={16} /> : null}
                </span>
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
