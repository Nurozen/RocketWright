/** The Results plot tabs (C §4.4, R3.5): which series column each tab shows, its axis, and its legend figure. */
import { flightUnit, toFlight, type FlightDim, type UnitSystem } from "../state/displayUnits.ts";
import type { RunSummary } from "./events.ts";
import { plotColumn, type Series } from "./series.ts";

/** Columns in SI; `dim` is what converts for display, `fixedUnit` a unit no system changes. */
export const PLOT_TABS = [
  { id: "altitude", label: "Altitude", column: "altitude", dim: "length", fixedUnit: "" },
  { id: "velocity", label: "Velocity", column: "speed", dim: "velocity", fixedUnit: "" },
  { id: "acceleration", label: "Acceleration", column: "accel", dim: "acceleration", fixedUnit: "" },
  { id: "stability", label: "Stability", column: "stability", dim: null, fixedUnit: "cal" },
  { id: "mach", label: "Mach", column: "mach", dim: null, fixedUnit: "" },
  { id: "cd", label: "Drag coefficient", column: "cd", dim: null, fixedUnit: "" },
  { id: "mass", label: "Mass", column: "mass", dim: "mass", fixedUnit: "" },
  { id: "thrust", label: "Thrust", column: "thrust", dim: "force", fixedUnit: "" },
  { id: "lateral", label: "Lateral distance", column: "lateral", dim: "length", fixedUnit: "" },
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

/** An SI value with its unit in the system: `850 m`, `2,789 ft`. */
export function fmtFlight(si: number | null | undefined, dim: FlightDim, system: UnitSystem, digits = 0): string {
  return `${fmtNum(toFlight(si, dim, system), digits)} ${flightUnit(dim, system).unit}`;
}

/** The y axis title: `Altitude (ft)`, `Stability (cal)`, `Mach`. */
export function plotAxis(tab: PlotTab, system: UnitSystem): string {
  const unit = tab.dim !== null ? flightUnit(tab.dim, system).unit : tab.fixedUnit;
  return unit === "" ? tab.label : `${tab.label} (${unit})`;
}

/** A run's values on a tab, in the system's unit; `null` when the series lacks the column. */
export function plotValues(series: Series, tab: PlotTab, system: UnitSystem): number[] | null {
  const values = plotColumn(series, tab.column);
  const dim = tab.dim;
  return values === null || dim === null ? values : values.map((v) => toFlight(v, dim, system));
}

/**
 * The direct-legend figure for a run on a tab: `850 m`, `max 312 m/s`,
 * `min 1.6 cal`. Null for a tab the run summary has no headline figure for.
 */
export function legendFigure(tab: PlotTabId, summary: RunSummary | null | undefined, system: UnitSystem = "metric"): string | null {
  if (!summary) return null;
  switch (tab) {
    case "altitude":
      return fmtFlight(summary.apogee_m, "length", system);
    case "velocity":
      return `max ${fmtFlight(summary.max_velocity_ms, "velocity", system)}`;
    case "acceleration":
      return `max ${fmtFlight(summary.max_accel_ms2, "acceleration", system)}`;
    case "stability":
      return `min ${fmtNum(summary.min_stability_cal, 2)} cal`;
    case "mach":
      return `max ${fmtNum(summary.max_mach, 2)}`;
    case "lateral":
      return `drift ${fmtFlight(summary.drift_m, "length", system)}`;
    case "cd":
    case "mass":
    case "thrust":
      return null;
  }
}
