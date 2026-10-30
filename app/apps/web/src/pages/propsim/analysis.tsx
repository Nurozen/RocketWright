/**
 * Simulate rail extras (M5.5, C §4.6; S:169 allows the extra rail entries
 * to open simple pages from existing run data): Trajectory analysis (the
 * altitude history and the 3D flight path of the project's flight runs),
 * Stability analysis (the stability margin over time to apogee), and
 * Thermal analysis (not modelled: an honest empty state, no numbers).
 * Everything shown is read from the runs on disk (`run.list` summaries and
 * `series.csv`), the same data as the Results page; nothing is computed
 * here beyond picking values out of a run's own series.
 */
import { useMemo } from "react";
import { SERIES_COLORS } from "../../state/types.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { Icon } from "../../shell/Icon.tsx";
import { eventMarkers, type RunSummary } from "../../plots/events.ts";
import { seriesColumn } from "../../plots/series.ts";
import { TimePlot, type PlotLine } from "../../plots/TimePlot.tsx";
import { useResultsRows } from "../results/parts.tsx";
import { runKey, useRunData, type RunData, type RunDataSource } from "../results/source.ts";
import { trajectoryPoints } from "../results/trajectory.ts";
import { TrajectoryView, type TrajectoryPath } from "../results/TrajectoryView.tsx";
import type { ResultsRow } from "../results/model.ts";
import "../results/results.css";
import { ANALYSIS_VIEWS, analysisRuns, stabilityFigures, stabilityStats, stabilityToApogee, trajectoryStats, type AnalysisView, type StatRow } from "./analysisModel.ts";

export interface AnalysisPageProps {
  store: AppStore;
  view: AnalysisView;
  source: RunDataSource | null;
}

export function AnalysisPage({ store, view, source }: AnalysisPageProps) {
  const title = ANALYSIS_VIEWS.find((v) => v.id === view)!.label;
  return (
    <div className="rw-propsim rw-analysis" data-testid="analysis-page" data-view={view}>
      <header className="rw-propsim__head">
        <h1 className="rw-page-title" data-testid="page.title">
          {title}
        </h1>
      </header>
      {view === "thermal" ? <ThermalEmpty store={store} /> : <RunAnalysis store={store} view={view} source={source} />}
    </div>
  );
}

const summaryOf = (r: ResultsRow): RunSummary | null => (r.entry.summary ?? null) as RunSummary | null;

function RunAnalysis({ store, view, source }: { store: AppStore; view: "trajectory" | "stability"; source: RunDataSource | null }) {
  const rows = useResultsRows(store, { includeHidden: true });
  const projectId = useAppState(store, (s) => s.project.projectId);
  const runs = useMemo(() => analysisRuns(rows), [rows]);
  const keys = useMemo(() => runs.map((r) => ({ sim: r.sim, runId: r.entry.run_id! })), [runs]);
  const loaded = useRunData(source, projectId, keys);
  const dataOf = (r: ResultsRow): RunData | null => {
    const st = loaded[runKey({ sim: r.sim, runId: r.entry.run_id ?? "" })];
    return st?.status === "ready" ? st.data : null;
  };
  const colorOf = (r: ResultsRow, i: number) => r.color ?? SERIES_COLORS[i] ?? SERIES_COLORS[0];
  const loadError = keys.map((k) => loaded[runKey(k)]).find((s) => s?.status === "error");

  const lines = useMemo<PlotLine[]>(
    () =>
      runs.flatMap((r, i) => {
        const data = dataOf(r);
        if (!data) return [];
        if (view === "stability") {
          const s = stabilityToApogee(data.series, summaryOf(r));
          return s ? [{ id: r.key, label: r.name, color: colorOf(r, i), t: s.t, y: s.y }] : [];
        }
        const t = seriesColumn(data.series, "t");
        const y = seriesColumn(data.series, "altitude");
        return t && y ? [{ id: r.key, label: r.name, color: colorOf(r, i), t, y }] : [];
      }),
    [runs, loaded, view], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const events = useMemo(
    () => runs.flatMap((r, i) => eventMarkers(summaryOf(r), dataOf(r)?.events ?? null).filter((m) => view === "trajectory" || m.label !== "Recovery").map((m) => ({ ...m, run: r.key, color: colorOf(r, i) }))),
    [runs, loaded, view], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const paths = useMemo<TrajectoryPath[]>(
    () =>
      view !== "trajectory"
        ? []
        : runs.flatMap((r, i) => {
            const data = dataOf(r);
            return data ? [{ id: r.key, label: r.name, color: colorOf(r, i), points: trajectoryPoints(data.series) }] : [];
          }),
    [runs, loaded, view], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const stats: StatRow[] = useMemo(
    () => (view === "trajectory" ? trajectoryStats(runs.map(summaryOf)) : stabilityStats(runs.map((r) => stabilityFigures(dataOf(r)?.series ?? null, summaryOf(r))))),
    [runs, loaded, view], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (runs.length === 0) {
    return (
      <div className="rw-analysis__empty" data-testid="analysis.empty">
        <Icon name={view === "trajectory" ? "trend" : "stability"} size={28} />
        <p>No complete flight run yet. Run a flight simulation on the Results page; this page reads its trajectory and stability from the run.</p>
        <button type="button" className="rw-button" data-testid="analysis.open-results" onClick={() => store.getState().ui.navigate("results")}>
          Open flight results
        </button>
      </div>
    );
  }

  return (
    <div className="rw-analysis__body" data-testid="analysis.body" data-runs={runs.map((r) => r.sim).join(",")}>
      <p className="rw-analysis__source" data-testid="analysis.source">
        {view === "trajectory" ? "Altitude and flight path" : "Stability margin (calibers) from liftoff to apogee"} from the project's flight runs: {runs.map((r) => r.name).join(", ")}.
      </p>
      <div className={`rw-analysis__grid rw-analysis__grid--${view}`}>
        <section className="rw-analysis__plot" data-testid="analysis.plot" data-plot={view} data-lines={lines.length}>
          <h2 className="rw-analysis__title">{view === "trajectory" ? "Altitude" : "Stability margin"}</h2>
          <div className="rw-analysis__chart">
            {lines.length > 0 ? (
              <TimePlot lines={lines} events={events} yLabel={view === "trajectory" ? "Altitude (m)" : "Stability (cal)"} topInset={14 + 22 * lines.length} />
            ) : (
              <p className="rw-results__empty" data-testid="analysis.loading">
                {loadError?.status === "error" ? `Could not load the run series: ${loadError.error}` : "Loading run series…"}
              </p>
            )}
            {lines.length > 0 && (
              <ul className="rw-legend rw-list" data-testid="analysis.legend">
                {lines.map((l) => (
                  <li key={l.id} data-sim={l.id}>
                    <span className="rw-legend__swatch" style={{ background: l.color }} aria-hidden />
                    {l.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        {view === "trajectory" && (
          <section className="rw-analysis__path" data-testid="analysis.path" data-paths={paths.length}>
            <h2 className="rw-analysis__title">Flight path</h2>
            {paths.length > 0 ? <TrajectoryView paths={paths} /> : <p className="rw-results__empty">Loading run series…</p>}
          </section>
        )}
      </div>
      <table className="rw-analysis__table" data-testid="analysis.table">
        <thead>
          <tr>
            <th scope="col" />
            {runs.map((r, i) => (
              <th key={r.key} scope="col" data-sim={r.sim}>
                <span className="rw-legend__swatch" style={{ background: colorOf(r, i) }} aria-hidden />
                {r.name}
                {r.status.kind === "outdated" && <span className="rw-analysis__tag"> · Outdated</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.key} data-testid="analysis.stat" data-stat={s.key}>
              <th scope="row">{s.label}</th>
              {s.values.map((v, i) => (
                <td key={runs[i]!.key}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThermalEmpty({ store }: { store: AppStore }) {
  return (
    <div className="rw-analysis__empty" data-testid="analysis.thermal-empty">
      <Icon name="thermometer" size={28} />
      <h2 className="rw-analysis__title">Thermal analysis is not modelled yet</h2>
      <p>
        RocketWright does not compute aerodynamic heating, motor case temperature, or propellant temperature over a flight. No run in this project carries
        thermal results, so this page shows none.
      </p>
      <p>Tank pressure, mass flow, and thrust come from the engineering blowdown model on the Propulsion simulation page.</p>
      <button type="button" className="rw-button" data-testid="analysis.open-engineering" onClick={() => store.getState().ui.navigate("propulsion-sim", "engineering")}>
        Open propulsion simulation
      </button>
    </div>
  );
}
