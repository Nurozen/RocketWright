/**
 * Simulate rail extras (M5.5, C §4.6, S:169 allowed deviation): the
 * Trajectory and Stability analysis pages are views over the project's
 * existing flight runs (their summaries and `series.csv`), never new
 * physics; Thermal analysis is an honest empty state (not modelled). Pure
 * view-model functions; `analysis.tsx` renders them.
 */
import { fmtNum } from "../../plots/quantities.ts";
import { seriesColumn, type Series } from "../../plots/series.ts";
import type { RunSummary } from "../../plots/events.ts";
import type { ResultsRow } from "../results/model.ts";

export const ANALYSIS_VIEWS = [
  { id: "trajectory", label: "Trajectory analysis" },
  { id: "stability", label: "Stability analysis" },
  { id: "thermal", label: "Thermal analysis" },
] as const;
export type AnalysisView = (typeof ANALYSIS_VIEWS)[number]["id"];
export const isAnalysisView = (t: string | null | undefined): t is AnalysisView => ANALYSIS_VIEWS.some((v) => v.id === t);

/** A flight sim (visual flow studies have no flight series). */
export const isFlightRow = (r: Pick<ResultsRow, "entry">): boolean => (r.entry.kind ?? "flight") === "flight";

/**
 * The runs an analysis page shows (at most `max`): the runs overlaid on the
 * Results plots (series A, B) when there are any, else the first Complete
 * flight runs. Only latest runs on disk (no superseded rows).
 */
export function analysisRuns(rows: readonly ResultsRow[], max = 2): ResultsRow[] {
  const flights = rows.filter((r) => isFlightRow(r) && r.entry.run_id != null && r.entry.superseded_by == null);
  const overlaid = (["a", "b"] as const).flatMap((slot) => flights.filter((r) => r.series === slot));
  if (overlaid.length > 0) return overlaid.slice(0, max);
  return flights.filter((r) => r.status.kind === "complete").slice(0, max);
}

export interface StatRow {
  key: string;
  label: string;
  /** One formatted value per run, in run order. */
  values: string[];
}

const withUnit = (v: number | null | undefined, digits: number, unit: string): string => {
  const s = fmtNum(v, digits);
  return s === "—" ? s : `${s} ${unit}`;
};

/** Trajectory figures per run, straight from each run's summary. */
export function trajectoryStats(summaries: readonly (RunSummary | null | undefined)[]): StatRow[] {
  const row = (key: string, label: string, f: (s: RunSummary) => string): StatRow => ({ key, label, values: summaries.map((s) => (s ? f(s) : "—")) });
  return [
    row("apogee", "Apogee", (s) => withUnit(s.apogee_m, 0, "m")),
    row("time_to_apogee", "Time to apogee", (s) => withUnit(s.time_to_apogee_s, 1, "s")),
    row("max_velocity", "Max velocity", (s) => withUnit(s.max_velocity_ms, 0, "m/s")),
    row("max_mach", "Max Mach", (s) => fmtNum(s.max_mach, 2)),
    row("flight_time", "Flight time", (s) => withUnit(s.flight_time_s, 1, "s")),
    row("drift", "Landing drift", (s) => withUnit(s.drift_m, 0, "m")),
  ];
}

/** Linear interpolation of column `y` at time `t` (NaN outside the series or on gaps). */
export function valueAt(t: readonly number[], y: readonly number[], at: number): number {
  if (t.length === 0 || !(at >= t[0]!) || !(at <= t[t.length - 1]!)) return Number.NaN;
  let i = 1;
  while (i < t.length && t[i]! < at) i++;
  if (i >= t.length) return y[t.length - 1]!;
  const t0 = t[i - 1]!;
  const t1 = t[i]!;
  const u = t1 > t0 ? (at - t0) / (t1 - t0) : 0;
  return y[i - 1]! + u * (y[i]! - y[i - 1]!);
}

export interface StabilityFigures {
  /** First finite margin of the flight (calibers). */
  liftoff: number | null;
  /** Margin at burnout (interpolated at the summary's burnout time). */
  burnout: number | null;
  /** Least and greatest margin in the series before apogee (what the plot shows). */
  min: number | null;
  max: number | null;
  /** Time of the least margin (s). */
  minAt: number | null;
  /** The run summary's `min_stability_cal` (the Results figure; the sim's own definition of the in-flight minimum). */
  summaryMin: number | null;
}

/**
 * Stability margin figures of one run from its own series (the `stability`
 * column, calibers), up to apogee (after apogee the margin is not
 * meaningful). The run summary's `min_stability_cal` (the Results figure)
 * is reported beside it under its own name: the sim computes it under its
 * own rules, so the two may differ (e.g. off the rail).
 */
export function stabilityFigures(series: Series | null, summary: RunSummary | null | undefined): StabilityFigures {
  const summaryMin = summary?.min_stability_cal ?? null;
  const empty: StabilityFigures = { liftoff: null, burnout: null, min: null, max: null, minAt: null, summaryMin };
  if (series === null) return empty;
  const t = seriesColumn(series, "t");
  const s = seriesColumn(series, "stability");
  if (t === null || s === null) return empty;
  const end = summary?.time_to_apogee_s ?? Number.POSITIVE_INFINITY;
  let liftoff: number | null = null;
  let min: number | null = null;
  let max: number | null = null;
  let minAt: number | null = null;
  for (let i = 0; i < t.length; i++) {
    const v = s[i]!;
    if (!Number.isFinite(v) || t[i]! > end) continue;
    liftoff ??= v;
    if (min === null || v < min) {
      min = v;
      minAt = t[i]!;
    }
    if (max === null || v > max) max = v;
  }
  const b = summary?.burnout_time_s;
  const burnout = typeof b === "number" ? valueAt(t, s, b) : Number.NaN;
  return {
    liftoff,
    burnout: Number.isFinite(burnout) ? burnout : null,
    min,
    max,
    minAt,
    summaryMin,
  };
}

/** Stability figures per run as table rows. */
export function stabilityStats(figs: readonly StabilityFigures[]): StatRow[] {
  const row = (key: string, label: string, f: (x: StabilityFigures) => string): StatRow => ({ key, label, values: figs.map(f) });
  return [
    row("liftoff", "At liftoff", (x) => withUnit(x.liftoff, 2, "cal")),
    row("burnout", "At burnout", (x) => withUnit(x.burnout, 2, "cal")),
    row("min", "Lowest to apogee", (x) => (x.min === null ? "—" : `${withUnit(x.min, 2, "cal")}${x.minAt === null ? "" : ` at ${fmtNum(x.minAt, 2)} s`}`)),
    row("max", "Highest to apogee", (x) => withUnit(x.max, 2, "cal")),
    row("summary_min", "Run summary minimum", (x) => withUnit(x.summaryMin, 2, "cal")),
  ];
}

/** Stability series clipped to apogee (t, y), for the plot. */
export function stabilityToApogee(series: Series, summary: RunSummary | null | undefined): { t: number[]; y: number[] } | null {
  const t = seriesColumn(series, "t");
  const s = seriesColumn(series, "stability");
  if (t === null || s === null) return null;
  const end = summary?.time_to_apogee_s ?? Number.POSITIVE_INFINITY;
  const out = { t: [] as number[], y: [] as number[] };
  for (let i = 0; i < t.length; i++) {
    if (t[i]! > end) break;
    out.t.push(t[i]!);
    out.y.push(s[i]!);
  }
  return out.t.length > 0 ? out : null;
}
