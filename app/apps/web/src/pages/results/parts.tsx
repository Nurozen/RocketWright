/** Shared Results hooks and small parts: rows from the store and status glyphs. */
import { useMemo } from "react";
import type { StatusView } from "../../state/status.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { resultsRows, type ResultsRow } from "./model.ts";
import { ResultsIcon, type ResultsGlyph } from "./ResultsIcon.tsx";
import { useResultsUi } from "./resultsUi.ts";

/** Run rows for the current store state (memoized on the inputs; sorted and hide-aware). */
export function useResultsRows(app: AppStore, opts: { sorted?: boolean; includeHidden?: boolean } = {}): ResultsRow[] {
  const snapshot = useAppState(app, (s) => s.project.snapshot);
  const overlay = useAppState(app, (s) => s.runs.overlay);
  // `runRows` reads it: a sim.run answered from the cache changes a row's status without touching the mirror.
  const started = useAppState(app, (s) => s.runs.started);
  const refs = useAppState(app, (s) => s.selection.refs);
  const sort = useResultsUi(app, (u) => u.sort);
  const hidden = useResultsUi(app, (u) => u.hidden);
  const sorted = opts.sorted ?? true;
  const includeHidden = opts.includeHidden ?? false;
  return useMemo(() => {
    const rows = resultsRows(app.getState(), { sort: sorted ? sort : null, hidden });
    return includeHidden ? rows : rows.filter((r) => !r.hidden);
    // The store inputs are listed so the rows recompute when any of them changes.
  }, [app, snapshot, overlay, started, refs, sort, hidden, sorted, includeHidden]);
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
