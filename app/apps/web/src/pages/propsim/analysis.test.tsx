/**
 * M5.5 page 06 rail extras and agent card: the Simulation rail rows and
 * which one is active, the analysis pages' run choice and figures (read from
 * the runs' own summaries and series), the Thermal empty state, and the
 * section view ref opening the study on the Visual flow tier.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { openRef } from "../../state/navigation.ts";
import type { Series } from "../../plots/series.ts";
import { createAppStore } from "../../state/store.ts";
import type { ResultsRow } from "../results/model.ts";
import { AnalysisPage } from "./analysis.tsx";
import { analysisRuns, isAnalysisView, stabilityFigures, stabilityStats, stabilityToApogee, trajectoryStats, valueAt } from "./analysisModel.ts";
import { propSimSlots, SIM_ROWS, simRowOf } from "./PropSimPage.tsx";

const row = (sim: string, over: { key?: string; series?: ResultsRow["series"]; kind?: string; state?: string; runId?: string | null; superseded?: string } = {}): ResultsRow =>
  ({
    key: over.key ?? sim,
    sim,
    name: sim,
    entry: { sim, kind: over.kind ?? "flight", run_id: over.runId === undefined ? `${sim}0001` : over.runId, superseded_by: over.superseded ?? null, summary: null },
    job: null,
    status: { kind: over.state ?? "complete" },
    color: null,
    metrics: null,
    series: over.series ?? null,
    selected: false,
    hidden: false,
  }) as unknown as ResultsRow;

const series = (cols: string[], rows: number[][]): Series => ({ dt: 0.1, columns: cols.map((name) => ({ name, dim: "dimensionless" })), rows }) as Series;

describe("Simulation rail", () => {
  it("lists Propulsion simulation, Trajectory, Stability, and Thermal analysis", () => {
    expect(SIM_ROWS.map((r) => r.label)).toEqual(["Propulsion simulation", "Trajectory analysis", "Stability analysis", "Thermal analysis"]);
  });
  it("marks the tiers as Propulsion simulation and each analysis tab as its own row", () => {
    for (const t of ["engineering", "visual", "cfd", null]) expect(simRowOf(t)).toBe("propulsion");
    for (const t of ["trajectory", "stability", "thermal"]) expect(simRowOf(t)).toBe(t);
    expect(isAnalysisView("visual")).toBe(false);
  });
  it("renders the four rows with their icons", () => {
    const html = renderToStaticMarkup(propSimSlots(createAppStore(), null, "").nav);
    expect(html.split('data-testid="rail.nav-row"').length - 1).toBe(4);
    for (const icon of ["play-circle", "trend", "stability", "thermometer"]) expect(html).toContain(`data-icon="${icon}"`);
  });
});

describe("analysis runs and figures", () => {
  it("prefers the overlaid flight runs, else the first Complete ones; never visual studies or superseded runs", () => {
    const rows = [row("study_01", { kind: "visual_flow" }), row("baseline"), row("old", { superseded: "x" }), row("higher"), row("fins", { state: "outdated" })];
    expect(analysisRuns(rows).map((r) => r.sim)).toEqual(["baseline", "higher"]);
    const overlaid = [row("baseline"), row("fins", { state: "outdated", series: "a" }), row("higher", { series: "b" })];
    expect(analysisRuns(overlaid).map((r) => r.sim)).toEqual(["fins", "higher"]);
    expect(analysisRuns([row("recovery", { runId: null, state: "not_run" })])).toEqual([]);
  });
  it("reads trajectory figures from each run's summary", () => {
    const stats = trajectoryStats([{ apogee_m: 1234.4, time_to_apogee_s: 12.34, max_velocity_ms: 201.6, max_mach: 0.59, flight_time_s: 80.0, drift_m: 312 } as never, null]);
    const by = Object.fromEntries(stats.map((s) => [s.key, s.values]));
    expect(by["apogee"]).toEqual(["1,234 m", "—"]);
    expect(by["time_to_apogee"]).toEqual(["12.3 s", "—"]);
    expect(by["max_mach"]).toEqual(["0.59", "—"]);
    expect(by["drift"]).toEqual(["312 m", "—"]);
  });
  it("reads stability from the run's own series up to apogee", () => {
    const s = series(
      ["t", "stability"],
      [
        [0, Number.NaN],
        [0.5, 1.8],
        [1, 2.2],
        [2, 2.6],
        [3, 1.9],
        [4, 0.4],
      ],
    );
    const f = stabilityFigures(s, { time_to_apogee_s: 3, burnout_time_s: 1.5 } as never);
    expect(f.liftoff).toBe(1.8);
    expect(f.burnout).toBeCloseTo(2.4, 9);
    expect(f.min).toBe(1.8);
    expect(f.minAt).toBe(0.5);
    expect(f.max).toBe(2.6);
    // The run summary's minimum is reported under its own name, never in place of the series minimum.
    const g = stabilityFigures(s, { time_to_apogee_s: 3, burnout_time_s: 1.5, min_stability_cal: 2.15 } as never);
    expect([g.min, g.summaryMin]).toEqual([1.8, 2.15]);
    const stats = Object.fromEntries(stabilityStats([g]).map((r) => [r.key, r.values[0]]));
    expect(stats).toEqual({ liftoff: "1.80 cal", burnout: "2.40 cal", min: "1.80 cal at 0.50 s", max: "2.60 cal", summary_min: "2.15 cal" });
    expect(stabilityToApogee(s, { time_to_apogee_s: 3 } as never)?.t).toEqual([0, 0.5, 1, 2, 3]);
    expect(stabilityFigures(null, { min_stability_cal: 2 } as never)).toMatchObject({ liftoff: null, min: null, summaryMin: 2 });
    expect(valueAt([0, 1], [0, 10], 2)).toBeNaN();
  });
});

describe("analysis pages", () => {
  it("Thermal analysis says it is not modelled and shows no numbers", () => {
    const html = renderToStaticMarkup(<AnalysisPage store={createAppStore()} view="thermal" source={null} />);
    expect(html).toContain("Thermal analysis is not modelled yet");
    expect(html).toContain('data-testid="page.title"');
    expect(html).not.toMatch(/\d+(\.\d+)?\s?(K|°C|W)\b/);
  });
  it("Trajectory and Stability without flight runs point to the Results page", () => {
    for (const view of ["trajectory", "stability"] as const) {
      const html = renderToStaticMarkup(<AnalysisPage store={createAppStore()} view={view} source={null} />);
      expect(html).toContain('data-testid="analysis.empty"');
      expect(html).toContain("Open flight results");
    }
  });
});

describe("section view ref", () => {
  it("opens the study on the Visual flow tier (a run card's view form, through lecturn/navigate)", async () => {
    const store = createAppStore();
    store.setState((s) => ({ ...s, project: { ...s.project, snapshot: { evaluated: { sims: { study_01: { kind: "visual_flow" }, baseline: { kind: "flight" } } } } as never } }));
    await openRef(store, "rw:sim/study_01");
    expect(store.getState().ui.page).toBe("propulsion-sim");
    expect(store.getState().ui.tab).toBe("visual");
    expect(store.getState().selection.refs).toEqual(["rw:sim/study_01"]);
  });
});

