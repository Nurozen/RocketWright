/**
 * `plot_render` in the window (CPW2A): the agent names a Results plot and up
 * to two runs; the host resolves them against the window's run table (the
 * same rows the Results page shows), loads their series from the app's run
 * source (HTTP, cached), builds the lines, legend and event markers exactly
 * as the Results page does, and renders them with `plots/plotImage.ts`.
 *
 * Every refusal is a `PlotRenderError` whose `code` says what the agent can
 * do about it: `invalid_args` (fix the call: unknown plot or run, too many
 * runs, a run with nothing to plot) or `failed` (the window cannot plot
 * now: no project loaded yet, no run source, a series that would not load;
 * retrying later may help). The message names the runs it knows.
 */
import type { RwRef } from "@rw/contracts";
import { SERIES_COLORS } from "../state/types.ts";
import type { AppStore } from "../state/store.ts";
import { plotEventMarkers, type RunSummary } from "../plots/events.ts";
import { isPlotTab, legendFigure, plotTab, type PlotTabId } from "../plots/quantities.ts";
import { seriesColumn } from "../plots/series.ts";
import type { PlotLine } from "../plots/TimePlot.tsx";
import type { PlotImage, PlotImageSpec, PlotLegendEntry } from "../plots/plotImage.ts";
import { defaultOverlay, resultsRows, type ResultsRow } from "../pages/results/model.ts";
import type { RunDataSource } from "../pages/results/source.ts";
import { parseRef } from "../state/slices/selection.ts";

export class PlotRenderError extends Error {
  readonly code: "invalid_args" | "failed";
  constructor(code: "invalid_args" | "failed", message: string) {
    super(message);
    this.code = code;
  }
}

/** The Results plot overlays two runs (series A teal, B sand). */
export const MAX_PLOT_RUNS = SERIES_COLORS.length;
export const DEFAULT_PLOT_SIZE = { width: 1200, height: 800 } as const;
/** How long a run the agent just simulated may take to reach the window's run table. */
export const RUN_WAIT_MS = 5_000;

export interface PlotDeps {
  /** The app's run series source; `null` in a window without one (plots unavailable). */
  runSource: RunDataSource | null;
  render(spec: PlotImageSpec): Promise<PlotImage>;
  /** Waits between run-table polls (default 100 ms timers). */
  sleep?: (ms: number) => Promise<void>;
  runWaitMs?: number;
}

export interface PlotRenderArgs {
  plot: unknown;
  runs?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface PlottedRun {
  ref: RwRef;
  sim: string;
  run_id: string;
  name: string;
}

export type PlotRenderResult = PlotImage & { plot: PlotTabId; runs: PlottedRun[] };

const runLabel = (r: ResultsRow): string => `${r.sim}/${r.entry.run_id ?? "(not run)"}`;

/** The runs the window knows, for an error message: `baseline/1ade0bface2b (Baseline, complete)`. */
export function knownRuns(rows: readonly ResultsRow[]): string {
  const known = rows.filter((r) => r.entry.run_id != null).map((r) => `${runLabel(r)} (${r.name}, ${r.status.kind})`);
  return known.length === 0 ? "none (run rw_simulate first)" : known.join(", ");
}

/**
 * The row a run reference names: `rw:run/<id>`, `rw:sim/<sim>` (its latest
 * run), `<sim>/<run id>`, a bare run id, or a bare sim id. `null` when none.
 */
export function findRun(rows: readonly ResultsRow[], ref: string): ResultsRow | null {
  const s = ref.trim();
  const byRun = (id: string) => rows.find((r) => r.entry.run_id === id) ?? null;
  const bySim = (sim: string) => rows.find((r) => r.sim === sim && r.entry.superseded_by == null) ?? rows.find((r) => r.sim === sim) ?? null;
  if (s.startsWith("rw:")) {
    const p = parseRef(s);
    if (p?.kind === "run") return byRun(p.id);
    if (p?.kind === "sim") return bySim(p.id);
    return null;
  }
  const slash = s.lastIndexOf("/");
  if (slash > 0) {
    const sim = s.slice(0, slash).replace(/^runs\//, "");
    const id = s.slice(slash + 1);
    return rows.find((r) => r.sim === sim && r.entry.run_id === id) ?? null;
  }
  return byRun(s) ?? bySim(s);
}

function size(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 64 || v > 4096) throw new PlotRenderError("invalid_args", `${name}: expected an integer from 64 to 4096`);
  return v;
}

/** Checks the call's shape (before any waiting): the plot id, the run refs, the size. */
export function plotArgs(a: PlotRenderArgs): { plot: PlotTabId; refs: string[]; width: number; height: number } {
  if (!isPlotTab(a.plot)) throw new PlotRenderError("invalid_args", `plot: expected altitude, velocity, acceleration, or stability (got ${JSON.stringify(a.plot ?? null)})`);
  const refs = a.runs === undefined ? [] : a.runs;
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string" && r.trim() !== "")) throw new PlotRenderError("invalid_args", "runs: expected run ids or rw:run/<id> refs");
  if (refs.length > MAX_PLOT_RUNS) throw new PlotRenderError("invalid_args", `runs: at most ${MAX_PLOT_RUNS} runs per plot (the Results plot overlays two); call plot_render again for the others`);
  return { plot: a.plot, refs: [...new Set(refs as string[])], width: size(a.width, "width", DEFAULT_PLOT_SIZE.width), height: size(a.height, "height", DEFAULT_PLOT_SIZE.height) };
}

/**
 * Resolves the refs against the window's run table, waiting up to
 * `waitMs` for runs the table does not list yet (a run that just finished
 * reaches the window a moment after `job_status` says complete). No refs:
 * the runs the Results page overlays, else its default (the first two
 * Complete runs).
 */
export async function resolvePlotRuns(store: AppStore, refs: readonly string[], o: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<ResultsRow[]> {
  const deadline = Date.now() + o.waitMs;
  for (;;) {
    const st = store.getState();
    const loaded = st.project.snapshot !== null;
    const rows = resultsRows(st);
    if (loaded && refs.length === 0) {
      const overlay = rows.filter((r) => r.series !== null && r.entry.run_id != null);
      const keys = overlay.length > 0 ? overlay.map((r) => r.key) : defaultOverlay(rows);
      const picked = keys.flatMap((k) => rows.filter((r) => r.key === k)).slice(0, MAX_PLOT_RUNS);
      if (picked.length > 0) return picked;
      if (Date.now() >= deadline) throw new PlotRenderError("invalid_args", `runs: no Complete run to plot; run rw_simulate first, then pass its run id. Runs: ${knownRuns(rows)}`);
    } else if (loaded) {
      const found = refs.map((r) => findRun(rows, r));
      const missing = refs.filter((_, i) => found[i] === null);
      if (missing.length === 0) return found as ResultsRow[];
      if (Date.now() >= deadline) {
        throw new PlotRenderError("invalid_args", `runs: unknown run ${missing.map((m) => JSON.stringify(m)).join(", ")}; pass a run id from rw_simulate / rw_job_status / rw_run_list (or rw:run/<id>). Runs: ${knownRuns(rows)}`);
      }
    } else if (Date.now() >= deadline) {
      throw new PlotRenderError("failed", "the project is still loading in the RocketWright window; retry in a moment");
    }
    await o.sleep(100);
  }
}

/** Builds the plot exactly as the Results page would show these runs (lines, legend, event lines of the first run). */
export async function plotSpec(projectId: string, rows: readonly ResultsRow[], plot: PlotTabId, source: RunDataSource, size: { width: number; height: number }): Promise<PlotImageSpec> {
  const tab = plotTab(plot);
  const runs = rows.map((r, i) => {
    if (r.entry.run_id == null) throw new PlotRenderError("invalid_args", `run ${r.sim} (${r.name}) has not been run yet (${r.status.kind}); run rw_simulate first`);
    if (r.status.kind === "failed" || r.status.kind === "cancelled") throw new PlotRenderError("invalid_args", `run ${runLabel(r)} (${r.name}) ${r.status.kind}; it has no series to plot`);
    return { row: r, runId: r.entry.run_id, color: SERIES_COLORS[i]! };
  });
  const data = await Promise.all(
    runs.map(({ row, runId }) =>
      source.load(projectId, { sim: row.sim, runId }).catch((e: unknown) => {
        throw new PlotRenderError("failed", `could not load the series of run ${row.sim}/${runId}: ${e instanceof Error ? e.message : String(e)}; if the run just finished, retry`);
      }),
    ),
  );
  const lines: PlotLine[] = runs.map(({ row, runId, color }, i) => {
    const t = seriesColumn(data[i]!.series, "t");
    const y = seriesColumn(data[i]!.series, tab.column);
    if (t === null || y === null) throw new PlotRenderError("invalid_args", `run ${row.sim}/${runId} (${row.name}) has no ${tab.column} series (an engine run plots thrust on its own card, not here)`);
    return { id: row.key, label: row.name, color, t, y };
  });
  const { run: eventRun, markers } = plotEventMarkers(
    runs.map(({ row, color }, i) => ({ id: row.key, name: row.name, color, summary: (row.entry.summary ?? null) as RunSummary | null, events: data[i]!.events ?? null })),
    lines.map((l) => l.id),
    lines[0]?.id,
  );
  const legend: PlotLegendEntry[] = runs.map(({ row, color }) => {
    const fig = legendFigure(plot, row.metrics ?? ((row.entry.summary ?? null) as RunSummary | null));
    return { label: fig ? `${row.name} (${fig})` : row.name, color };
  });
  if (eventRun !== null && markers.length > 0) legend.push({ label: `Events: ${eventRun.name}`, color: eventRun.color, events: true });
  return { title: tab.label, yLabel: tab.axis, xLabel: "Time (s)", lines, events: markers, legend, width: size.width, height: size.height };
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The whole op: arguments, runs, series, image. Throws `PlotRenderError`. */
export async function renderPlot(store: AppStore, args: PlotRenderArgs, deps: PlotDeps): Promise<PlotRenderResult> {
  const a = plotArgs(args);
  if (deps.runSource === null) throw new PlotRenderError("failed", "plots are not available in this window (it has no run data source); use rw_render or read the run's summary instead");
  const rows = await resolvePlotRuns(store, a.refs, { waitMs: deps.runWaitMs ?? RUN_WAIT_MS, sleep: deps.sleep ?? sleepMs });
  const projectId = store.getState().project.projectId;
  if (projectId === null) throw new PlotRenderError("failed", "no project is open in this window");
  const spec = await plotSpec(projectId, rows, a.plot, deps.runSource, a);
  const image = await deps.render(spec).catch((e: unknown) => {
    throw new PlotRenderError("failed", `the window could not draw the plot: ${e instanceof Error ? e.message : String(e)}`);
  });
  return {
    ...image,
    plot: a.plot,
    runs: rows.map((r) => ({ ref: `rw:run/${r.entry.run_id!}`, sim: r.sim, run_id: r.entry.run_id!, name: r.name })),
  };
}
