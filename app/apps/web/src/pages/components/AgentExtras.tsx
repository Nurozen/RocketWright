/**
 * Page 02 agent pane additions (concept 02): the Changed fields card (each
 * edited parameter old → new with units, from the revision diff of the
 * selected part), `Compare revisions ›`, and the per-thread design history
 * mini-list (this thread's steps after its baseline; current on a teal ring;
 * each row opens its step in the history strip).
 */
import { useMemo } from "react";
import { formatDate } from "../../shell/format.ts";
import { stripCurrentStep } from "../../shell/connect.ts";
import { Icon } from "../../shell/Icon.tsx";
import type { Units } from "../../state/index.ts";
import { type AppStore, useAppState } from "../../state/store.ts";
import { displayUnit, toDisplay } from "./fields.ts";
import type { ChangedField } from "./proposal.ts";
import { openThreadSteps, type ThreadHistoryItem } from "./thread-history.ts";

/**
 * The open thread's steps for the pane strip (02, 05), from the same store
 * as the bottom history strip: the project's history for titles and times,
 * and the strip's own current step (`stripCurrentStep`), so the two never
 * disagree.
 */
export function useOpenThreadHistory(store: AppStore): ThreadHistoryItem[] {
  const steps = useAppState(store, (s) => s.project.snapshot?.history.steps ?? null);
  const lecturn = useAppState(store, (s) => s.chat.lecturn);
  const current = useAppState(store, stripCurrentStep);
  return useMemo(() => openThreadSteps(steps ?? [], { lecturn }, current), [steps, lecturn, current]);
}

/** `120 → 90 mm` (quantities share the unit; text values as written). */
export function changeText(f: ChangedField, units: Units): string {
  const u = displayUnit(f.dim, units).unit;
  const v = (x: number | string | null) => (x === null ? "—" : typeof x === "number" ? (f.dim !== undefined ? toDisplay(x, f.dim, units) : String(Number(x.toPrecision(6)))) : x.replace(/_/g, " "));
  return `${v(f.old)} → ${v(f.new)}${u && typeof f.new === "number" ? ` ${u}` : ""}`;
}

export function ChangedFieldsCard({
  fields,
  units,
  source,
  onCompare,
  step = null,
}: {
  fields: readonly ChangedField[];
  units: Units;
  /** The history step the change was made in (the revision on show), or null for a draft. */
  step?: number | null;
  /** What the diff is between (`Step 02 → Step 03`, or `Unsaved edit`). */
  source: string;
  onCompare: (() => void) | null;
}) {
  return (
    <div className="rw-changed" data-testid="agent.changed-fields" data-count={fields.length} data-step={step ?? undefined}>
      <div className="rw-changed__card">
        <div className="rw-changed__title">
          Changed fields <span className="rw-changed__source">{source}</span>
        </div>
        <dl className="rw-changed__rows">
          {fields.map((f) => (
            <div key={f.key} className="rw-changed__row" data-field={f.key}>
              <dt>{f.label}</dt>
              <dd>{changeText(f, units)}</dd>
            </div>
          ))}
        </dl>
      </div>
      {onCompare !== null && (
        <button type="button" className="rw-changed__compare" data-testid="agent.compare-revisions" onClick={onCompare}>
          <Icon name="bar-chart" size={18} />
          <span>Compare revisions</span>
          <Icon name="chevron-right" size={16} />
        </button>
      )}
    </div>
  );
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

/** Item marker: done steps a filled teal check, the current one a teal ring, later ones a grey dot. */
function Marker({ state }: { state: ThreadHistoryItem["state"] }) {
  return (
    <span className="rw-thread-history__dot" data-state={state} aria-hidden>
      {state === "done" && <Icon name="check" size={12} />}
    </span>
  );
}

const STATE_LABEL: Record<ThreadHistoryItem["state"], string> = { done: "Done", current: "Current step", later: "After the current step" };

export function ThreadHistory({ items, onOpen }: { items: readonly ThreadHistoryItem[]; onOpen: (seq: number) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="rw-thread-history" data-testid="agent.thread-history" aria-label="Design history (this thread)">
      <h3 className="rw-thread-history__title">Design history (this thread)</h3>
      <ol className="rw-thread-history__list">
        {items.map((it) => (
          <li key={it.seq} data-current={it.current ? "true" : "false"} data-baseline={it.baseline ? "true" : "false"} data-state={it.state} data-seq={it.seq}>
            <button
              type="button"
              className="rw-thread-history__item"
              data-testid="agent.thread-history-item"
              onClick={() => onOpen(it.seq)}
              title={`${STATE_LABEL[it.state]}: step ${String(it.seq).padStart(2, "0")} (opens it in the design history)`}
            >
              <Marker state={it.state} />
              <span className="rw-thread-history__name">{it.title}</span>
              <span className="rw-thread-history__clock">{clock(it.ts)}</span>
              <span className="rw-thread-history__time">
                Step {String(it.seq).padStart(2, "0")} · {formatDate(it.ts)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
