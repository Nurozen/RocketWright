/**
 * Left rail (concepts.md §3): the threads bound to this page (R6.9) with
 * their age and `+ New thread`, then the page navigation section (Components
 * tree or Runs) whose rows carry an eye toggle, a line-icon thumbnail, the
 * name, and on Runs the status and series colour.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { ShellNavRow, ShellNavSection, ShellThread } from "./model.ts";
import { StatusBadge } from "./StatusIcon.tsx";

export interface LeftRailProps {
  threads: ShellThread[];
  selectedThreadId: string | null;
  nav: ShellNavSection | null;
  selectedNavId: string | null;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  onSelectNav?: (row: ShellNavRow) => void;
  onToggleNav?: (row: ShellNavRow) => void;
  /** Opens (or creates) the thread bound to the row's artifact. */
  onOpenNavThread?: (row: ShellNavRow) => void;
  onAddNav?: () => void;
  /** Page-owned body of the navigation section (the 01 Components tree); replaces `nav.rows`. */
  navBody?: ReactNode;
  /** Replaces the whole `nav` section with page-owned content (the Results `Runs` list). */
  navSlot?: ReactNode;
  /** Page-owned footer pinned to the rail bottom (the 02 view chips). */
  footer?: ReactNode;
}

export function LeftRail({ threads, selectedThreadId, nav, selectedNavId, onSelectThread, onNewThread, onSelectNav, onToggleNav, onOpenNavThread, onAddNav, navBody, navSlot, footer }: LeftRailProps) {
  const plot = nav?.eye === "plot";
  return (
    <aside className="rw-rail" data-rw-region="left-rail" data-testid="left-rail">
      <section className="rw-rail__threads" aria-label="Threads">
        <ul className="rw-list" role="listbox" aria-label="Threads">
          {threads.map((t) => (
            <li
              key={t.id}
              className="rw-thread"
              role="option"
              data-testid="rail.thread"
              data-thread-id={t.id}
              data-artifact={t.artifact}
              aria-selected={t.id === selectedThreadId}
              onClick={() => onSelectThread?.(t.id)}
            >
              <Icon name="thread" size={18} />
              <span className="rw-thread__title">{t.title}</span>
              {t.busy ? (
                <Icon name="spinner" size={14} className="rw-spin rw-thread__busy" label="Working" />
              ) : (
                <span className="rw-thread__age" data-testid="rail.thread-age">
                  {t.age}
                </span>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="rw-thread rw-thread--new" data-testid="rail.new-thread" onClick={onNewThread}>
          <Icon name="plus" size={18} />
          <span className="rw-thread__title">New thread</span>
        </button>
      </section>
      {navSlot}
      {!navSlot && nav && (
        <section className="rw-rail__nav" aria-label={nav.title}>
          <div className="rw-rail__nav-head">
            <h2 className="rw-section-title" data-testid="rail.nav-title">
              {nav.title}
            </h2>
            <button type="button" className="rw-icon-button" aria-label={`Search ${nav.title}`}>
              <Icon name="search" size={18} />
            </button>
            <span className="rw-header__sep" aria-hidden />
            <button type="button" className="rw-icon-button" aria-label={`Add to ${nav.title}`} onClick={onAddNav}>
              <Icon name="plus" size={18} />
            </button>
          </div>
          {navBody === undefined && nav.rows.length === 0 && nav.empty !== undefined && <p className="rw-rail__empty">{nav.empty}</p>}
          {navBody ?? (
          <ul className="rw-list" role="listbox" aria-label={nav.title}>
            {nav.rows.map((r) => {
              const eyeLabel = plot ? (r.hidden ? "Show in plots" : "Hide from plots") : r.hidden ? "Show" : "Hide";
              return (
                <li
                  key={r.id}
                  className="rw-nav-row"
                  role="option"
                  data-testid="rail.nav-row"
                  data-ref={r.ref}
                  data-hidden={r.hidden ? "true" : undefined}
                  aria-selected={r.id === selectedNavId}
                  style={r.depth ? { paddingLeft: 12 + Math.min(r.depth, 4) * 10 } : undefined}
                  onClick={() => onSelectNav?.(r)}
                >
                  <button
                    type="button"
                    className="rw-eye"
                    data-testid="rail.eye"
                    aria-label={`${eyeLabel} ${r.label}`}
                    aria-pressed={!r.hidden}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleNav?.(r);
                    }}
                  >
                    <Icon name={r.hidden ? "eye-off" : "eye"} size={18} />
                  </button>
                  {r.status ? (
                    r.color !== undefined ? (
                      <span className="rw-nav-row__dot" style={{ background: r.color }} aria-hidden />
                    ) : (
                      <StatusBadge status={r.status} size={18} />
                    )
                  ) : (
                    <span className="rw-thumb" data-testid="rail.thumb">
                      <Icon name={r.icon} size={20} className="rw-nav-row__part" />
                    </span>
                  )}
                  <span className="rw-nav-row__label">{r.label}</span>
                  {r.status && (
                    <span className="rw-nav-row__status" data-tone={r.status.tone} data-testid="rail.run-status" title={r.status.reason ?? r.status.label}>
                      {r.status.label}
                    </span>
                  )}
                  {onOpenNavThread && r.ref !== undefined && !r.status && (
                    <button
                      type="button"
                      className="rw-icon-button rw-nav-row__ask"
                      data-testid="rail.open-thread"
                      aria-label={`Open the thread for ${r.label}`}
                      title="Open its thread"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenNavThread(r);
                      }}
                    >
                      <Icon name="thread" size={16} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          )}
        </section>
      )}
      {footer !== undefined && (
        <footer className="rw-rail__footer" data-rw-region="rail-footer" data-testid="rail.footer">
          {footer}
        </footer>
      )}
    </aside>
  );
}
