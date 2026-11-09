/**
 * A row of labelled read-only values with an optional action at the end.
 * Values arrive formatted from the engine; a missing one shows as a dash.
 */
import type { ReactNode } from "react";
import "./ui.css";

export interface Stat {
  id: string;
  label: string;
  /** Formatted value, or null when there is none yet. */
  value: string | null;
  unit?: string | undefined;
}

export interface StatStripProps {
  /** Accessible name of the strip. */
  label: string;
  stats: readonly Stat[];
  action?: ReactNode;
  className?: string | undefined;
}

export function StatStrip({ label, stats, action, className }: StatStripProps) {
  return (
    <section className={className ? `rw-ui-stats ${className}` : "rw-ui-stats"} aria-label={label}>
      <dl className="rw-ui-stats__list">
        {stats.map((s) => (
          <div key={s.id} className="rw-ui-stats__item" data-stat={s.id}>
            <dt className="rw-ui-stats__label">{s.label}</dt>
            <dd className="rw-ui-stats__value">
              {s.value ?? "—"}
              {s.unit !== undefined && ` ${s.unit}`}
            </dd>
          </div>
        ))}
      </dl>
      {action !== undefined && <div className="rw-ui-stats__action">{action}</div>}
    </section>
  );
}
