/** The Results plot tabs (C §4.4): which series column each tab shows, and its legend figure. */
import type { RunSummary } from "./events.ts";

export const PLOT_TABS = [
  { id: "altitude", label: "Altitude", column: "altitude", axis: "Altitude (m)", unit: "m" },
  { id: "velocity", label: "Velocity", column: "speed", axis: "Velocity (m/s)", unit: "m/s" },
  { id: "acceleration", label: "Acceleration", column: "accel", axis: "Acceleration (m/s²)", unit: "m/s²" },
  { id: "stability", label: "Stability", column: "stability", axis: "Stability (cal)", unit: "cal" },
] as const;

export type PlotTabId = (typeof PLOT_TABS)[number]["id"];
export type PlotTab = (typeof PLOT_TABS)[number];

export function isPlotTab(v: unknown): v is PlotTabId {
  return typeof v === "string" && PLOT_TABS.some((t) => t.id === v);
}

export function plotTab(id: PlotTabId): PlotTab {
  return PLOT_TABS.find((t) => t.id === id)!;
}

/** Fixed-precision number with grouping (`1,234`), or an em dash. */
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The direct-legend figure for a run on a tab: `850 m`, `max 312 m/s`, `min 1.6 cal`. */
export function legendFigure(tab: PlotTabId, summary: RunSummary | null | undefined): string | null {
  if (!summary) return null;
  switch (tab) {
    case "altitude":
      return `${fmtNum(summary.apogee_m)} m`;
    case "velocity":
      return `max ${fmtNum(summary.max_velocity_ms)} m/s`;
    case "acceleration":
      return `max ${fmtNum(summary.max_accel_ms2)} m/s²`;
    case "stability":
      return `min ${fmtNum(summary.min_stability_cal, 2)} cal`;
  }
}
