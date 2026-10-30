/**
 * Design history strip (concepts.md §3): numbered steps joined by hairlines
 * (separate flex items that share the free width evenly, so a connector never
 * runs into a label),
 * each with its name, date, and named revision; Compare (selected step vs
 * the latest) and the menu. A compare result or run snapshot row sits below.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { stepLabel, type ShellHistoryStep } from "./model.ts";

export interface HistoryStripProps {
  steps: ShellHistoryStep[];
  currentStepId: string | null;
  /** The latest step (teal ring when nothing else is selected). */
  headStepId?: string | null;
  onSelectStep?: (step: ShellHistoryStep) => void;
  onCompare?: () => void;
  /** A compare request is in flight. */
  comparing?: boolean;
  /** The Compare view is open: the button shows pressed and closes it. */
  compareOpen?: boolean;
  /** `Revert to Step 02` (the selected step) in the `⋯` menu; null disables it. */
  revertLabel?: string | null;
  onRevert?: () => void;
  reverting?: boolean;
  /** Extra rows below the steps (compare result, Results run snapshot row). */
  children?: ReactNode;
}

/** The strip's meta shows the revision number only (`Rev 07`); the step's tooltip has its name. */
export function shortRevision(rev: string): string {
  return rev.split(" · ")[0] ?? rev;
}

export function HistoryStrip({
  steps,
  currentStepId,
  headStepId = null,
  onSelectStep,
  onCompare,
  comparing = false,
  compareOpen = false,
  revertLabel = null,
  onRevert,
  reverting = false,
  children,
}: HistoryStripProps) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  return (
    <footer className="rw-history" data-rw-region="history-strip" data-testid="history-strip">
      <div className="rw-history__row">
        <h2 className="rw-history__title">Design history</h2>
        <ol className="rw-history__steps">
          {steps.length === 0 && <li className="rw-history__empty">No steps yet. Every change is recorded here.</li>}
          {steps.flatMap((s, i) => [
            ...(i > 0 ? [<li key={`${s.id}:link`} className="rw-step__link" aria-hidden data-testid="history.link" />] : []),
            <li
              key={s.id}
              className="rw-step"
              data-testid="history.step"
              data-ref={s.ref}
              data-head={s.id === headStepId ? "true" : undefined}
              data-origin={s.origin}
              aria-current={s.id === currentStepId ? "step" : undefined}
              title={s.revision ? `${s.name} (${s.revision})` : s.name}
              onClick={() => onSelectStep?.(s)}
            >
              <span className="rw-step__ring">{stepLabel(s.number)}</span>
              <span className="rw-step__text">
                <span className="rw-step__name">{s.name}</span>
                <span className="rw-step__date">
                  {s.date}
                  {s.revision && (
                    <span className="rw-step__rev" data-testid="history.revision" data-name={s.revision}>
                      {" · "}
                      {shortRevision(s.revision)}
                    </span>
                  )}
                </span>
              </span>
            </li>,
          ])}
        </ol>
        <button
          type="button"
          className="rw-button"
          data-testid="history.compare"
          onClick={onCompare}
          disabled={comparing || steps.length === 0}
          aria-busy={comparing || undefined}
          aria-pressed={compareOpen}
        >
          <Icon name="compare" size={18} />
          Compare
        </button>
        <div className="rw-history__menu" ref={menuRef}>
          <button type="button" className="rw-icon-button" data-testid="history.menu" aria-label="History menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" size={20} />
          </button>
          {menu && (
            <div className="rw-history__popover" role="menu" data-testid="history.menu-list">
              <button
                type="button"
                role="menuitem"
                className="rw-history__item"
                data-testid="history.revert"
                disabled={revertLabel === null || onRevert === undefined || reverting}
                onClick={() => {
                  setMenu(false);
                  onRevert?.();
                }}
              >
                {revertLabel ?? "Revert to a step (select one first)"}
              </button>
            </div>
          )}
        </div>
      </div>
      {children}
    </footer>
  );
}
