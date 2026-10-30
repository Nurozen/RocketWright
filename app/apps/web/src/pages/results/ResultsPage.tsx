/**
 * Results page body (M1.51, R6.6, C §4.4): title and toolbar (Run selected,
 * Plot, Export CSV), run table, Outdated banner, plot panel with tabs, event
 * lines and a two-run overlay (A teal, B sand), trajectory inset, and the run
 * details footer. Everything shown comes from the runs slice (status computed
 * against the current model hash, I7) and the runs' own series.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SERIES_COLORS } from "../../state/types.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { plotEventMarkers, type EventMarker, type RunSummary } from "../../plots/events.ts";
import type { DrawnEvent } from "../../plots/eventLines.ts";
import { legendFigure, PLOT_TABS, plotTab, type PlotTabId } from "../../plots/quantities.ts";
import { seriesColumn } from "../../plots/series.ts";
import { TimePlot, type PlotLine } from "../../plots/TimePlot.tsx";
import { downloadText, exportFileName, exportRunsCsv, type ExportRun } from "./csv.ts";
import { defaultOverlay, outdatedBanner, primaryRow, rowRef, runDetails, type ResultsRow } from "./model.ts";
import { MenuButton, useResultsRows } from "./parts.tsx";
import { ResultsIcon } from "./ResultsIcon.tsx";
import { resultsUiStore, useResultsUi } from "./resultsUi.ts";
import { RunTable } from "./RunTable.tsx";
import { runKey, useRunData, type RunData, type RunDataSource } from "./source.ts";
import { launchRailOf, padModelOf, trajectoryPoints } from "./trajectory.ts";
import { TrajectoryView, type TrajectoryPad, type TrajectoryPath } from "./TrajectoryView.tsx";
import "./results.css";

export interface ResultsPageProps {
  app: AppStore;
  /** Run series source (HTTP `SERIES_PATH` in the app); `null` renders without plots. */
  source: RunDataSource | null;
}

/** Stores whose overlay and selection the page has already defaulted (once per store). */
const seeded = new WeakSet<AppStore>();

export function ResultsPage({ app, source }: ResultsPageProps) {
  const rows = useResultsRows(app);
  const projectId = useAppState(app, (s) => s.project.projectId);
  const runError = useAppState(app, (s) => s.runs.error);
  const tabId = useResultsUi(app, (u) => u.plotTab);
  const showEvents = useResultsUi(app, (u) => u.showEvents);
  const ui = resultsUiStore(app);

  // First visit with runs: plot the first two Complete runs and select series A.
  useEffect(() => {
    if (seeded.has(app)) return;
    const pick = defaultOverlay(rows);
    if (pick.length === 0) return;
    seeded.add(app);
    const st = app.getState();
    if (st.runs.overlay.length === 0) for (const key of pick) st.runs.toggleOverlay(key);
    const first = rows.find((r) => r.key === pick[0]);
    if (!rows.some((r) => r.selected) && first !== undefined) st.selection.select([rowRef(first)], "table");
  }, [app, rows]);

  const overlayRows = useMemo(() => (["a", "b"] as const).flatMap((slot) => rows.filter((r) => r.series === slot && r.entry.run_id != null)), [rows]);
  const keys = useMemo(() => overlayRows.map((r) => ({ sim: r.sim, runId: r.entry.run_id! })), [overlayRows]);
  const loaded = useRunData(source, projectId, keys);
  const dataOf = (r: ResultsRow): RunData | null => {
    const st = loaded[runKey({ sim: r.sim, runId: r.entry.run_id ?? "" })];
    return st?.status === "ready" ? st.data : null;
  };

  const tab = plotTab(tabId);
  const lines = useMemo<PlotLine[]>(
    () =>
      overlayRows.flatMap((r) => {
        const data = dataOf(r);
        const t = data ? seriesColumn(data.series, "t") : null;
        const y = data ? seriesColumn(data.series, tab.column) : null;
        return t && y ? [{ id: r.key, label: r.name, color: r.color ?? SERIES_COLORS[0], t, y }] : [];
      }),
    // `loaded` changes whenever a series arrives.
    [overlayRows, loaded, tab],
  );
  const primary = primaryRow(rows);
  // Burnout, Apogee, Recovery (chute deployment) of one plotted run only, in its colour: the selected
  // run when plotted, else the first plotted run. The legend names it.
  const plotted = useMemo(
    () =>
      plotEventMarkers(
        overlayRows.map((r) => ({ id: r.key, name: r.name, color: r.color ?? SERIES_COLORS[0], summary: (r.entry.summary ?? null) as RunSummary | null, events: dataOf(r)?.events ?? null })),
        lines.map((l) => l.id),
        primary?.key,
      ),
    [overlayRows, loaded, lines, primary?.key],
  );
  const events = useMemo<EventMarker[]>(() => (showEvents ? plotted.markers : []), [plotted, showEvents]);
  const eventRun = showEvents && plotted.markers.length > 0 ? plotted.run : null;
  const [placed, setPlaced] = useState<DrawnEvent[]>([]);
  const legendRef = useRef<HTMLUListElement>(null);
  const onDrawn = (p: DrawnEvent[]) => setPlaced((cur) => (JSON.stringify(cur) === JSON.stringify(p) ? cur : p));

  const paths = useMemo<TrajectoryPath[]>(
    () =>
      overlayRows.flatMap((r) => {
        const data = dataOf(r);
        return data ? [{ id: r.key, label: r.name, color: r.color ?? SERIES_COLORS[0], points: trajectoryPoints(data.series) }] : [];
      }),
    [overlayRows, loaded],
  );

  const banner = outdatedBanner(rows);
  // The pad under the paths: the primary run's launch rail and the rocket's model (looks, proportions).
  const evaluated = useAppState(app, (s) => s.project.snapshot?.evaluated ?? null);
  const padSim = primary?.sim ?? overlayRows[0]?.sim ?? null;
  // Keyed by value, so a re-evaluation that leaves the pad as it was does not rebuild the inset.
  const padKey = JSON.stringify({ rail: launchRailOf(padSim !== null ? evaluated?.sims[padSim]?.conditions : null), model: padModelOf(evaluated) });
  const pad = useMemo<TrajectoryPad>(() => JSON.parse(padKey) as TrajectoryPad, [padKey]);
  const details = runDetails(app.getState(), primary, primary ? dataOf(primary)?.diagnostics : null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);

  const exportable: ExportRun[] = overlayRows.flatMap((r) => {
    const data = dataOf(r);
    return data ? [{ name: r.name, sim: r.sim, runId: r.entry.run_id!, series: data.series }] : [];
  });
  const runnable = (sims: string[]) => [...new Set(sims)].filter((sim) => rows.some((r) => r.sim === sim && r.status.kind !== "running" && r.status.kind !== "queued"));
  const selectedSims = runnable([...rows.filter((r) => r.series !== null || r.selected).map((r) => r.sim)]);
  const outdatedSims = runnable(rows.filter((r) => r.status.kind === "outdated" || r.status.kind === "not_run").map((r) => r.sim));
  const runAll = (sims: string[], force = false) => {
    for (const sim of sims) void app.getState().runs.run(sim, { force }).catch(() => undefined);
  };
  const loading = keys.some((k) => loaded[runKey(k)]?.status !== "ready");
  const loadError = keys.map((k) => loaded[runKey(k)]).find((s) => s?.status === "error");

  return (
    <section className="rw-results" data-testid="results-page">
      <header className="rw-results__head">
        <h1 className="rw-page-title" data-testid="page.title">
          Flight results
        </h1>
        <div className="rw-results__actions">
          <div className="rw-split">
            <button
              type="button"
              className="rw-button rw-button--primary rw-split__main"
              data-testid="results.run-selected"
              disabled={selectedSims.length === 0}
              onClick={() => runAll(selectedSims)}
            >
              <ResultsIcon name="run" size={18} />
              Run selected
            </button>
            <MenuButton
              testId="results.run-menu"
              label="More run options"
              className="rw-button rw-button--primary rw-split__more"
              align="right"
              items={[
                { id: "outdated", label: `Run outdated and not run (${outdatedSims.length})`, disabled: outdatedSims.length === 0, onSelect: () => runAll(outdatedSims) },
                { id: "force", label: "Re-run selected (ignore cache)", disabled: selectedSims.length === 0, onSelect: () => runAll(selectedSims, true) },
              ]}
            >
              <ResultsIcon name="chevron-down" size={16} />
            </MenuButton>
          </div>
          <MenuButton
            testId="results.plot-menu"
            label="Plot"
            align="right"
            items={[
              ...PLOT_TABS.map((t) => ({ id: t.id, label: t.label, checked: t.id === tabId, onSelect: () => ui.getState().set({ plotTab: t.id }) })),
              { id: "events", label: "Event lines", checked: showEvents, onSelect: () => ui.getState().set({ showEvents: !ui.getState().showEvents }) },
            ]}
          >
            <ResultsIcon name="plot-line" size={18} />
            Plot
            <ResultsIcon name="chevron-down" size={16} />
          </MenuButton>
          <button
            type="button"
            className="rw-button"
            data-testid="results.export-csv"
            disabled={exportable.length === 0}
            onClick={() => downloadText(exportFileName(exportable), exportRunsCsv(exportable))}
          >
            <ResultsIcon name="download" size={18} />
            Export CSV
          </button>
        </div>
      </header>

      <RunTable app={app} />
      {runError && (
        <p className="rw-results__error" role="alert">
          {runError}
        </p>
      )}

      {banner && (
        <div className="rw-banner" role="status" data-testid="results.outdated-banner" data-sim={banner.sim}>
          <span className="rw-status-glyph" data-tone="amber">
            <ResultsIcon name="warning" size={20} />
          </span>
          <span className="rw-banner__text">
            {banner.text}
            {banner.more > 0 && ` (+${banner.more} more outdated)`}
          </span>
          <button type="button" className="rw-button" data-testid="results.open-design" onClick={() => app.getState().ui.navigate("assembly")}>
            Open design
            <ResultsIcon name="external" size={16} />
          </button>
        </div>
      )}

      <div className="rw-results__card">
        <section className="rw-results__plot" data-rw-region="plot" data-testid="plot">
          <div className="rw-plot-tabs" role="tablist" aria-label="Plot">
            {PLOT_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="rw-tab rw-plot-tab"
                data-testid="plot.tab"
                data-tab={t.id}
                aria-selected={t.id === tabId}
                onClick={() => ui.getState().set({ plotTab: t.id as PlotTabId })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="rw-results__chart" data-tab={tabId} data-loading={loading ? "true" : undefined}>
            {lines.length > 0 ? (
              <TimePlot lines={lines} events={events} yLabel={tab.axis} onDrawn={onDrawn} topInset={14 + 22 * (lines.length + (eventRun ? 1 : 0))} avoid={legendRef} />
            ) : (
              <p className="rw-results__empty" data-testid="plot.empty">
                {loadError?.status === "error"
                  ? `Could not load the run series: ${loadError.error}`
                  : overlayRows.length === 0
                    ? "Tick up to two runs to plot them."
                    : "Loading run series…"}
              </p>
            )}
            {lines.length > 0 && (
              <ul className="rw-legend rw-list" data-testid="plot.legend" ref={legendRef}>
                {overlayRows.map((r) => {
                  const line = lines.find((l) => l.id === r.sim);
                  if (!line) return null;
                  const fig = legendFigure(tabId, r.metrics ?? ((r.entry.summary ?? null) as RunSummary | null));
                  return (
                    <li key={r.key} data-testid="plot.series" data-sim={r.sim} data-row-key={r.key} data-series={r.series ?? undefined} data-color={line.color} data-points={line.t.length}>
                      <span className="rw-legend__swatch" data-series={r.series ?? undefined} aria-hidden />
                      {fig ? `${r.name} (${fig})` : r.name}
                    </li>
                  );
                })}
                {eventRun && (
                  <li data-testid="plot.events-key" data-row-key={eventRun.id} data-color={eventRun.color}>
                    <span className="rw-legend__swatch rw-legend__swatch--events" style={{ borderColor: eventRun.color }} aria-hidden />
                    {`Events: ${eventRun.name}`}
                  </li>
                )}
              </ul>
            )}
            <ul className="rw-sr" aria-label={eventRun ? `Events of ${eventRun.name}` : "Events"}>
              {events.map((e) => {
                const p = placed.find((x) => x.label === e.label && x.run === e.run);
                const run = overlayRows.find((r) => r.key === e.run);
                return (
                  <li
                    key={`${e.run ?? ""}-${e.label}`}
                    data-testid="plot.event"
                    data-label={e.label}
                    data-sim={run?.sim}
                    data-run={run?.name}
                    data-series={run?.series ?? undefined}
                    data-color={e.color}
                    data-t={e.t}
                    data-x={p ? p.x.toFixed(1) : undefined}
                    data-row={p ? p.row : undefined}
                    data-labelled={p ? String(p.labelled) : undefined}
                    data-mark={p ? p.mark : undefined}
                    data-line-top={p ? p.lineTop.toFixed(1) : undefined}
                    data-flip={p?.flip ? "true" : undefined}
                    data-label-top={p && p.labelTop !== null ? p.labelTop.toFixed(1) : undefined}
                    data-plot-top={p ? p.plotTop.toFixed(1) : undefined}
                  >
                    {`${run ? `${run.name}: ` : ""}${e.label} at ${e.t.toFixed(2)} s`}
                  </li>
                );
              })}
            </ul>
          </div>
          <footer className="rw-details" data-rw-region="run-details" data-testid="run-details">
            <span className="rw-details__field" data-testid="details.field" data-field="model-rev">
              <ResultsIcon name="cube" size={18} />
              {details.modelRev}
            </span>
            <span className="rw-details__field" data-testid="details.field" data-field="environment" title={`Environment: ${details.environmentFull}`}>
              <ResultsIcon name="cloud" size={18} />
              <span className="rw-details__text">Environment: {details.environment}</span>
            </span>
            <span className="rw-details__field" data-testid="details.field" data-field="warnings" data-tone={details.warnings > 0 ? "amber" : "muted"}>
              <span className="rw-status-glyph" data-tone={details.warnings > 0 ? "amber" : "muted"}>
                <ResultsIcon name="warning" size={18} />
              </span>
              Warnings: {details.warnings}
            </span>
            <button
              type="button"
              className="rw-details__field rw-link"
              data-testid="details.field"
              data-field="assumptions"
              aria-expanded={assumptionsOpen}
              onClick={() => setAssumptionsOpen((o) => !o)}
            >
              <ResultsIcon name="document" size={18} />
              View assumptions
            </button>
            {assumptionsOpen && (
              <div className="rw-assumptions" role="dialog" aria-label="Assumptions" data-testid="details.assumptions">
                <h3>Assumptions{primary ? ` · ${primary.name}` : ""}</h3>
                <ul>
                  {details.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </footer>
        </section>
        <aside className="rw-results__inset" data-rw-region="trajectory-inset" data-testid="trajectory-inset">
          <h2 className="rw-results__inset-title">Trajectory view</h2>
          {paths.length > 0 ? <TrajectoryView paths={paths} pad={pad} /> : <p className="rw-results__empty">No trajectory to show.</p>}
        </aside>
      </div>
    </section>
  );
}

