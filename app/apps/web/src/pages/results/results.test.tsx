/**
 * M1.51 Results page: view model over the mock project snapshot, CSV export,
 * trajectory geometry, the series source, and static markup of the page, the
 * Runs rail, and the snapshot row (`pnpm --filter web test results`).
 */
import type { ProjectSnapshot, RunListOut } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { PLACEHOLDER_SHELL } from "../../shell/model.ts";
import { ShellApp } from "../../shell/ShellApp.tsx";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import { parseSeriesCsv } from "../../plots/series.ts";
import { exportFileName, exportRunsCsv } from "./csv.ts";
import {
  assumptionsOf,
  canRefly,
  defaultOverlay,
  environmentLabel,
  environmentShort,
  fmtWhen,
  legendRows,
  modelRevision,
  nextSort,
  outdatedBanner,
  plotPrompt,
  primaryRow,
  resultsRows,
  runDetails,
  runnableSims,
  runSnapshots,
  sortRows,
} from "./model.ts";
import { followRerun, rowKey } from "../../state/selectors.ts";
import { revealTab } from "./model.ts";
import { ResultsPage } from "./ResultsPage.tsx";
import { RunSnapshots } from "./RunSnapshots.tsx";
import { RunTable } from "./RunTable.tsx";
import { RunsRail } from "./RunsRail.tsx";
import { cachedSource, eventsUrl, httpRunSource, parseRunEvents, seriesUrl } from "./source.ts";
import {
  cameraFor,
  enuToYUp,
  framePoints,
  frameScene,
  gizmoAxes,
  INSET_DIR,
  INSET_FIT,
  launchRailOf,
  niceCeil,
  padBounds,
  padModelOf,
  PAD_SHARE,
  padRocket,
  RAIL_MAX,
  startAtPad,
  trajectoryPoints,
} from "./trajectory.ts";
import { PRESET_LOOKS } from "../../viewport/materials.ts";
import { levelTilt, presetPose, projectFraction } from "../../detail/framing.ts";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

type Entry = RunListOut["runs"][number];

/** The mock project with the concept's run state: Baseline and Higher altitude Complete, Fin revision Outdated, Recovery test Not run. */
function snapshot(): ProjectSnapshot {
  const snap = mock.snapshot();
  const hash = snap.evaluated!.model_hash;
  const base = snap.runs.runs.find((r) => r.sim === "baseline")!;
  const higher: Entry = { ...structuredClone(base), sim: "higher_altitude", sim_name: "Higher altitude", config: "higher_altitude", run_id: "a1b2c3d4e5f6" };
  higher.summary = { ...higher.summary!, apogee_m: 700.2, max_velocity_ms: 130.4, flight_time_s: 70.1 };
  snap.runs.runs = [base, higher, snap.runs.runs.find((r) => r.sim === "fin_revision")!, snap.runs.runs.find((r) => r.sim === "recovery_test")!];
  expect(base.model_hash).toBe(hash);
  return snap;
}

/** A store whose state (and server snapshot for SSR) is `edit(base)`; actions are inert here. */
function staticStore(edit: (s: AppState) => AppState): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state = edit(base);
  return createStore<AppState>()(() => state);
}

function withRuns(s: AppState, opts: { overlay?: string[]; refs?: string[]; snap?: ProjectSnapshot } = {}): AppState {
  return {
    ...s,
    project: { ...s.project, projectId: "research-vehicle", snapshot: (opts.snap ?? snapshot()) as DeepReadonly<ProjectSnapshot> },
    runs: { ...s.runs, overlay: opts.overlay ?? ["baseline", "higher_altitude"] },
    selection: { ...s.selection, refs: opts.refs ?? ["rw:sim/baseline"] },
  };
}

const state = (opts?: Parameters<typeof withRuns>[1]) => staticStore((s) => withRuns(s, opts)).getState();

describe("plot tab strip (one row, scrolls)", () => {
  it("scrolls the least needed to show the active tab", () => {
    const strip = { scrollLeft: 0, clientWidth: 300 };
    revealTab(strip, { offsetLeft: 400, offsetWidth: 80 });
    expect(strip.scrollLeft).toBe(180);
    revealTab(strip, { offsetLeft: 200, offsetWidth: 80 });
    expect(strip.scrollLeft).toBe(180);
    revealTab(strip, { offsetLeft: 50, offsetWidth: 80 });
    expect(strip.scrollLeft).toBe(50);
  });
});

describe("the plot's next step (R2.7)", () => {
  const prompt = (edit: (runs: Entry[]) => Entry[], noParts = false) => {
    const snap = snapshot();
    snap.runs.runs = edit(snap.runs.runs);
    return plotPrompt(resultsRows(state({ snap, overlay: [] })), noParts);
  };
  const neverRun = (runs: Entry[]) => runs.map((r) => ({ ...r, status: "not_run", run_id: null, model_hash: null, summary: null })) as Entry[];

  it("sends a rocket with no parts to Design", () => {
    expect(prompt(() => [], true)).toMatchObject({ action: "open-design", text: expect.stringContaining("Nothing to fly yet") });
  });
  it("offers to add a simulation when there is none", () => {
    expect(prompt(() => [])).toMatchObject({ action: "add-simulation", text: expect.stringContaining("Nothing to fly yet") });
  });
  it("offers to fly the first simulation when none has flown", () => {
    expect(prompt(neverRun)).toMatchObject({ action: "run", sim: "baseline", name: "Baseline" });
  });
  it("asks to tick runs once something has flown", () => {
    expect(prompt((r) => r)).toEqual({ action: null, text: "Tick up to six runs to plot them." });
  });
});

describe("results view model", () => {
  it("computes status per run and shows metrics only for Complete runs", () => {
    const rows = resultsRows(state());
    expect(rows.map((r) => [r.sim, r.status.kind, r.series, r.selected])).toEqual([
      ["baseline", "complete", "a", true],
      ["higher_altitude", "complete", "b", false],
      ["fin_revision", "outdated", null, false],
      ["recovery_test", "not_run", null, false],
    ]);
    expect(rows[0]!.metrics?.apogee_m).toBe(612.4);
    expect(rows[0]!.color).toBe("#61b5ad");
    expect(rows[1]!.color).toBe("#f1ae6e");
    // The outdated run has a stored summary, but its numbers are not current.
    expect(rows[2]!.entry.summary).not.toBeNull();
    expect(rows[2]!.metrics).toBeNull();
    expect(rows[3]!.metrics).toBeNull();
  });

  it("matches the selection by sim or run ref and flags hidden rows", () => {
    const byRun = resultsRows(state({ refs: ["rw:run/a1b2c3d4e5f6"] }), { hidden: ["recovery_test"] });
    expect(byRun.filter((r) => r.selected).map((r) => r.sim)).toEqual(["higher_altitude"]);
    expect(byRun.filter((r) => r.hidden).map((r) => r.sim)).toEqual(["recovery_test"]);
  });

  it("lists a superseded run beside its sim's latest as its own row (B4(a) before/after)", () => {
    const snap = snapshot();
    const base = snap.runs.runs[0]!;
    const old: Entry = { ...structuredClone(base), run_id: "0ldba5e11ne0", model_hash: "f".repeat(64), status: "outdated", superseded_by: base.run_id! };
    snap.runs.runs.splice(1, 0, old);
    expect([rowKey(base), rowKey(old)]).toEqual(["baseline", "baseline@0ldba5e11ne0"]);
    const rows = resultsRows(state({ snap, overlay: ["baseline", "baseline@0ldba5e11ne0"], refs: ["rw:sim/baseline"] }));
    expect(rows.slice(0, 2).map((r) => [r.key, r.sim, r.status.kind, r.series, r.selected])).toEqual([
      ["baseline", "baseline", "complete", "a", true],
      ["baseline@0ldba5e11ne0", "baseline", "outdated", "b", false],
    ]);
    // A run ref selects that run's row only.
    const byRun = resultsRows(state({ snap, refs: ["rw:run/0ldba5e11ne0"] }));
    expect(byRun.filter((r) => r.selected).map((r) => r.key)).toEqual(["baseline@0ldba5e11ne0"]);
  });

  it("falls back to the latest flown runs for the first plot when an edit has outdated them all", () => {
    const snap = snapshot();
    snap.runs.model_hash = "e".repeat(64);
    snap.evaluated!.model_hash = "e".repeat(64);
    const rows = resultsRows(state({ snap, overlay: [] }));
    expect(rows.filter((r) => r.status.kind === "complete")).toEqual([]);
    expect(defaultOverlay(rows)).toEqual(["baseline", "higher_altitude"]);
  });

  it("plots before/after when an overlaid sim's rerun supersedes its run", () => {
    const prev = [{ sim: "baseline", run_id: "aaa" }, { sim: "higher_altitude", run_id: "bbb" }];
    const next = [{ sim: "baseline", run_id: "ccc" }, { sim: "baseline", run_id: "aaa", superseded_by: "ccc" }, { sim: "higher_altitude", run_id: "bbb" }];
    // The earlier run joins the plot; what was plotted stays, in its own colour.
    expect(followRerun(prev, next, ["baseline", "higher_altitude"])).toEqual(["baseline", "higher_altitude", "baseline@aaa"]);
    // At the six-run cap the oldest other pick makes room, never the pair.
    expect(followRerun(prev, next, ["x1", "baseline", "x2", "x3", "x4", "x5"])).toEqual(["baseline", "x2", "x3", "x4", "x5", "baseline@aaa"]);
    // Not overlaid, already known, or already plotted: no change.
    expect(followRerun(prev, next, ["higher_altitude"])).toBeNull();
    expect(followRerun(next, next, ["baseline", "higher_altitude"])).toBeNull();
    expect(followRerun(prev, next, ["baseline", "baseline@aaa"])).toBeNull();
  });

  it("sorts stably by any column: ascending, descending, off", () => {
    const rows = resultsRows(state());
    expect(sortRows(rows, { key: "apogee", dir: 1 }).map((r) => r.sim)).toEqual(["fin_revision", "recovery_test", "baseline", "higher_altitude"]);
    expect(sortRows(rows, { key: "apogee", dir: -1 }).map((r) => r.sim)).toEqual(["higher_altitude", "baseline", "fin_revision", "recovery_test"]);
    expect(sortRows(rows, { key: "name", dir: 1 }).map((r) => r.name)).toEqual(["Baseline", "Fin revision", "Higher altitude", "Recovery test"]);
    expect(sortRows(rows, { key: "status", dir: 1 }).map((r) => r.status.kind)).toEqual(["complete", "complete", "outdated", "not_run"]);
    expect(nextSort(null, "apogee")).toEqual({ key: "apogee", dir: 1 });
    expect(nextSort({ key: "apogee", dir: 1 }, "apogee")).toEqual({ key: "apogee", dir: -1 });
    expect(nextSort({ key: "apogee", dir: -1 }, "apogee")).toBeNull();
    expect(nextSort({ key: "apogee", dir: -1 }, "name")).toEqual({ key: "name", dir: 1 });
  });

  describe("after a re-run or a deleted sim", () => {
    const superseded = () => {
      const snap = snapshot();
      const fin = snap.runs.runs.find((r) => r.sim === "fin_revision")!;
      const old: Entry = { ...structuredClone(fin), run_id: "0ldba5e11ne0", status: "outdated", superseded_by: "newrun000001" };
      fin.run_id = "newrun000001";
      fin.model_hash = snap.evaluated!.model_hash;
      fin.status = "complete";
      snap.runs.runs.push(old);
      return snap;
    };
    const deleted = () => {
      const snap = snapshot();
      delete (snap.evaluated!.sims as Record<string, unknown>)["fin_revision"];
      return snap;
    };

    it("clears the banner once the sim has flown on the current model", () => {
      const rows = resultsRows(state({ snap: superseded() }));
      expect(rows.find((r) => r.key.startsWith("fin_revision@"))?.status.kind).toBe("outdated");
      expect(outdatedBanner(rows)).toBeNull();
    });

    it("has no banner for a sim that no longer exists", () => {
      expect(outdatedBanner(resultsRows(state({ snap: deleted() })))).toBeNull();
    });

    it("offers no re-fly for a deleted sim, a superseded run, or one already flying", () => {
      const del = resultsRows(state({ snap: deleted() })).find((r) => r.sim === "fin_revision")!;
      expect([del.inModel, canRefly(del)]).toEqual([false, false]);
      const old = resultsRows(state({ snap: superseded() })).find((r) => r.key.startsWith("fin_revision@"))!;
      expect(canRefly(old)).toBe(false);
      expect(canRefly(resultsRows(state()).find((r) => r.sim === "fin_revision")!)).toBe(true);
    });

    it("bulk actions skip a deleted sim and a sim already flying, even when an earlier row is outdated", () => {
      expect(runnableSims(resultsRows(state({ snap: deleted() })), ["fin_revision", "recovery_test"])).toEqual(["recovery_test"]);
      const snap = superseded();
      snap.jobs = [{ job_id: "j1", kind: "simulate", state: "running", progress: 0.5, sim: "fin_revision" }] as never;
      expect(runnableSims(resultsRows(state({ snap })), ["fin_revision"])).toEqual([]);
    });
  });

  it("raises the Outdated banner from the computed status", () => {
    const rows = resultsRows(state());
    expect(outdatedBanner(rows)).toEqual({ sim: "fin_revision", text: "Fin revision uses an outdated model. Rebuild to run this simulation.", more: 0 });
    expect(outdatedBanner(rows.filter((r) => r.sim !== "fin_revision"))).toBeNull();
  });

  it("defaults the overlay to the first two Complete runs and picks the primary run", () => {
    const rows = resultsRows(state({ overlay: [], refs: [] }));
    expect(defaultOverlay(rows)).toEqual(["baseline", "higher_altitude"]);
    expect(primaryRow(rows)?.sim).toBe("baseline");
    expect(primaryRow(resultsRows(state({ refs: ["rw:sim/higher_altitude"] })))?.sim).toBe("higher_altitude");
    // A Not-run selection has no run to describe: fall back to series A.
    expect(primaryRow(resultsRows(state({ refs: ["rw:sim/recovery_test"] })))?.sim).toBe("baseline");
  });

  it("names the model revision a run was made on", () => {
    const snap = snapshot();
    const hash = snap.evaluated!.model_hash;
    expect(modelRevision(snap.history, hash).label).toBe("Model Rev 07");
    expect(modelRevision(snap.history, "nope").label).toBe("Model rev unknown");
    const untagged = { steps: snap.history.steps.map((s) => ({ ...s, rev: null })), revisions: snap.history.revisions };
    expect(modelRevision(untagged, hash).label).toBe("Model Rev 07");
    expect(modelRevision({ steps: untagged.steps, revisions: [] }, hash).label).toBe("Step 04");
  });

  it("describes the environment and the assumptions from the conditions", () => {
    const c = snapshot().evaluated!.sims["baseline"]!.conditions;
    expect(environmentLabel(c)).toBe("calm (0 m/s, 15 °C)");
    expect(environmentLabel({ ...c, wind_speed_ms: 4.2, wind_direction_deg: 315, base_temperature_k: 285.15 })).toBe("wind 4.2 m/s from NW (12 °C)");
    expect(environmentLabel(null)).toBe("unknown");
    expect(environmentLabel(c, "imperial")).toBe("calm (0 mph, 59 °F)");
    expect(environmentShort({ ...c, wind_speed_ms: 4.2, wind_direction_deg: 315, base_temperature_k: 285.15 }, "imperial")).toBe("wind 9.4 mph NW, 54 °F");
    expect(environmentShort({ ...c, wind_speed_ms: 4.4704, wind_direction_deg: 270 }, "imperial")).toBe("wind 10 mph W, 59 °F");
    const us = assumptionsOf(c, "engineering", "imperial");
    expect(us).toContain("Atmosphere: US Standard Atmosphere 1976, 59 °F and 29.92 inHg at the site");
    expect(us).toContain("Launch rail 4.92 ft at 0.0° from vertical");
    // The footer's compact form fits beside the warnings at 1536 px without an ellipsis.
    expect(environmentShort(c)).toBe("calm, 15 °C");
    expect(environmentShort({ ...c, wind_speed_ms: 3, wind_direction_deg: 270 })).toBe("wind 3 m/s W, 15 °C");
    expect(environmentShort({ ...c, wind_speed_ms: 4.24, wind_direction_deg: 315, base_temperature_k: 285.15 })).toBe("wind 4.2 m/s NW, 12 °C");
    expect(environmentShort(null)).toBe("unknown");
    const a = assumptionsOf(c, "engineering");
    expect(a[0]).toBe("Engineering result (tier 1 flight simulation)");
    expect(a).toContain("Atmosphere: US Standard Atmosphere 1976, 15 °C and 1,013 hPa at the site");
    expect(a).toContain("Flat earth, flat ground plane");
    expect(a).toContain("Gravity: WGS84");
    expect(a).toContain("Launch rail 1.50 m at 0.0° from vertical");
    expect(a).toContain("Integrator dp54, max step 0.01 s");
    expect(assumptionsOf(null, "visual")).toEqual(["visual result: not an engineering number"]);
  });

  it("builds the details footer: revision, environment, and warnings (run diagnostics win over the check)", () => {
    const s = state();
    const row = primaryRow(resultsRows(s));
    const d = runDetails(s, row);
    expect(d).toMatchObject({ modelRev: "Model Rev 07", environment: "calm, 15 °C", environmentFull: "calm (0 m/s, 15 °C)", warnings: 1 });
    expect(runDetails(s, row, []).warnings).toBe(0);
    expect(runDetails(s, null).modelRev).toBe("Model rev unknown");
    const inches = staticStore((x) => ({ ...withRuns(x), ui: { ...x.ui, units: "in" } })).getState();
    expect(runDetails(inches, primaryRow(resultsRows(inches)))).toMatchObject({ environment: "calm, 59 °F", environmentFull: "calm (0 mph, 59 °F)" });
  });

  it("gives each of six plotted runs its own slot, and legends a run its rerun replaced", () => {
    const snap = snapshot();
    const base = snap.runs.runs.find((r) => r.sim === "baseline")!;
    const extras = ["e1", "e2", "e3", "e4"].map((sim) => ({ ...structuredClone(base), sim, sim_name: sim, config: sim, run_id: `run-${sim}` }));
    const before = { ...structuredClone(base), run_id: "0ldba5e11ne0", superseded_by: base.run_id! };
    snap.runs.runs = [...snap.runs.runs, ...extras, before];
    const overlay = ["baseline", "higher_altitude", "e1", "e2", "e3", "e4"];
    const rows = resultsRows(state({ snap, overlay }));
    expect(overlay.map((k) => rows.find((r) => r.key === k)!.series)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(new Set(rows.flatMap((r) => (r.color === null ? [] : [r.color]))).size).toBe(6);
    expect(resultsRows(state({ snap, overlay: [...overlay.slice(1), "baseline@0ldba5e11ne0"] })).find((r) => r.key === "baseline@0ldba5e11ne0")!.series).toBe("f");
    // The first load still starts from two: the cap is what ticking can reach.
    expect(defaultOverlay(rows)).toEqual(["baseline", "higher_altitude"]);
    // A superseded row shares its sim with the latest run; its line is found by row key.
    const old = rows.find((r) => r.key === "baseline@0ldba5e11ne0")!;
    const latest = rows.find((r) => r.key === "baseline")!;
    const entries = legendRows([latest, old], [{ id: "baseline" }, { id: "baseline@0ldba5e11ne0" }]);
    expect(entries.map((e) => [e.row.key, e.line.id])).toEqual([["baseline", "baseline"], ["baseline@0ldba5e11ne0", "baseline@0ldba5e11ne0"]]);
    expect(legendRows([old], [{ id: "baseline" }])).toEqual([]);
  });

  it("lists snapshot cards for the plotted runs, A then B", () => {
    const s = state({ overlay: ["higher_altitude", "baseline"] });
    const cards = runSnapshots(s, resultsRows(s), "UTC");
    expect(cards.map((c) => [c.sim, c.title, c.modelRev, c.when, c.series])).toEqual([
      ["higher_altitude", "Higher altitude run", "Model Rev 07", "Oct 15, 2026, 2:04 PM", "a"],
      ["baseline", "Baseline run", "Model Rev 07", "Oct 15, 2026, 2:04 PM", "b"],
    ]);
    const none = state({ overlay: [] });
    expect(runSnapshots(none, resultsRows(none)).map((c) => c.sim)).toEqual(["baseline", "higher_altitude", "fin_revision"]);
    expect(fmtWhen("bad")).toBe("");
  });
});

const CSV_A = "t,altitude,x,y\n0,0,0,0\n0.5,10,0.1,0\n1,15,0.2,0.1\n";
const CSV_B = "t,altitude,speed\n0,0,0\n0.5,12,20\n";

describe("run table units", () => {
  const FOOT = 0.3048;
  const SI = { apogee_m: 347.575, max_velocity_ms: 105.2, flight_time_s: 91.4 };

  /** Headers and baseline-row cells as the table renders them, through the same markup B1 reads. */
  function table(edit: (s: AppState) => AppState = (s) => s, manifest?: string) {
    const snap = snapshot();
    const base = snap.runs.runs.find((r) => r.sim === "baseline")!;
    base.summary = { ...base.summary!, ...SI };
    if (manifest !== undefined) snap.files.files["rocketwright.toml"] = manifest;
    const html = renderToStaticMarkup(<RunTable app={staticStore((s) => edit(withRuns(s, { snap, overlay: [] })))} />);
    const header = (key: string) => new RegExp(`data-key="${key}"[^>]*>([^<]*)`).exec(html)![1]!;
    const row = html.slice(html.indexOf('data-sim="baseline"'));
    const cell = (id: string) => new RegExp(`data-testid="runs\\.${id}"[^>]*>([^<]*)`).exec(row)![1]!;
    return {
      apogee: [header("apogee"), cell("apogee")],
      speed: [header("maxSpeed"), cell("max-speed")],
      time: [header("flightTime"), cell("flight-time")],
    };
  }
  const shownNumber = (cell: string) => Number(cell.replaceAll(",", ""));

  it("shows metric by default, in the headers B1 reads", () => {
    expect(table()).toEqual({ apogee: ["Apogee (m)", "348"], speed: ["Max speed (m/s)", "105"], time: ["Flight time (s)", "91"] });
  });

  it("states imperial headers and values for known SI inputs", () => {
    const shown = table((s) => ({ ...s, ui: { ...s.ui, units: "in" } }));
    expect(shown).toEqual({ apogee: ["Apogee (ft)", "1,140"], speed: ["Max speed (ft/s)", "345"], time: ["Flight time (s)", "91"] });
    // The convert-by-header reading (D29): the number times its header's unit is the SI value, within the rounding shown.
    expect(Math.abs(shownNumber(shown.apogee[1]!) * FOOT - SI.apogee_m)).toBeLessThanOrEqual(0.5 * FOOT);
    expect(Math.abs(shownNumber(shown.speed[1]!) * FOOT - SI.max_velocity_ms)).toBeLessThanOrEqual(0.5 * FOOT);
    expect(Math.abs(shownNumber(shown.time[1]!) - SI.flight_time_s)).toBeLessThanOrEqual(0.5);
  });

  it("reads imperial from the project's own display units", () => {
    expect(table((s) => s, 'format = 1\n[display_units]\nlength = "in"\n').apogee).toEqual(["Apogee (ft)", "1,140"]);
    expect(table((s) => s, 'format = 1\n[display_units]\nlength = "mm"\naltitude = "ft"\n').speed[0]).toBe("Max speed (ft/s)");
    expect(table((s) => ({ ...s, ui: { ...s.ui, units: "in" } }), '[display_units]\naltitude = "m"\n').apogee).toEqual(["Apogee (m)", "348"]);
  });
});

describe("CSV export", () => {
  it("writes the runs in long format over the union of columns", () => {
    const csv = exportRunsCsv([
      { name: "Baseline", sim: "baseline", runId: "aaa", series: parseSeriesCsv(CSV_A) },
      { name: 'Higher, "alt"', sim: "higher_altitude", runId: "bbb", series: parseSeriesCsv(CSV_B) },
    ]);
    expect(csv.split("\n")).toEqual([
      "run,sim,run_id,t,altitude,x,y,speed",
      "Baseline,baseline,aaa,0,0,0,0,",
      "Baseline,baseline,aaa,0.5,10,0.1,0,",
      "Baseline,baseline,aaa,1,15,0.2,0.1,",
      '"Higher, ""alt""",higher_altitude,bbb,0,0,,,0',
      '"Higher, ""alt""",higher_altitude,bbb,0.5,12,,,20',
      "",
    ]);
    expect(exportFileName([{ sim: "baseline" }, { sim: "higher altitude" }])).toBe("results-baseline-higher_altitude.csv");
    expect(exportFileName([])).toBe("results.csv");
  });
});

describe("trajectory geometry", () => {
  it("maps ENU to three.js Y-up and decimates keeping both ends", () => {
    expect(enuToYUp(1, 2, 3)).toEqual([1, 3, -2]);
    const rows = Array.from({ length: 1001 }, (_, i) => `${i * 0.1},${i},${i * 0.2},${i * 0.1}`);
    const pts = trajectoryPoints(parseSeriesCsv(`t,altitude,x,y\n${rows.join("\n")}\n`), 101);
    expect(pts).toHaveLength(101);
    expect(pts[0]).toEqual([0, 0, -0]);
    expect(pts.at(-1)).toEqual([200, 1000, -100]);
    expect(trajectoryPoints(parseSeriesCsv("t,speed\n0,1\n"))).toEqual([]);
  });

  it("frames a square ground grid with nice sizes and fits the camera", () => {
    expect([0.7, 1, 3, 7, 12].map(niceCeil)).toEqual([1, 1, 5, 10, 20]);
    const f = frameScene([
      [
        [0, 0, 0],
        [50, 900, -30],
        [150, 0, -100],
      ],
    ]);
    expect(f.apex).toBe(900);
    expect(f.ground).toBe(1000);
    expect(f.cell).toBe(100);
    const cam = cameraFor(f, 32, 0.55);
    const dist = Math.hypot(cam.position[0] - f.center[0], cam.position[1] - f.center[1], cam.position[2] - f.center[2]);
    expect(dist).toBeGreaterThan(f.radius);
  });

  it("frames the inset tightly: the paths and the pad fill the fit rectangle, closer than the sphere fit", () => {
    const path: [number, number, number][] = Array.from({ length: 200 }, (_, i) => {
      const t = i / 199;
      return [-80 * t, 115 * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4), 10 * t];
    });
    const f = frameScene([path]);
    const pts = framePoints([path], padBounds(padRocket(f.apex, f.ground)));
    const tight = cameraFor(f, 32, 0.55, pts);
    const loose = cameraFor(f, 32, 0.55);
    const d = (c: { position: number[]; target: number[] }) => Math.hypot(c.position[0]! - c.target[0]!, c.position[1]! - c.target[1]!, c.position[2]! - c.target[2]!);
    expect(d(tight)).toBeLessThan(d(loose));
    // Every framed point projects inside INSET_FIT (one edge touching).
    const pose = presetPose({ dir: INSET_DIR, axisTiltDeg: levelTilt(INSET_DIR) });
    const proj = pts.map((p) => projectFraction(p, tight.position as [number, number, number], pose, 32, 0.55));
    const eps = 1e-3;
    expect(Math.min(...proj.map((q) => q.x))).toBeGreaterThanOrEqual(INSET_FIT.x0 - eps);
    expect(Math.max(...proj.map((q) => q.x))).toBeLessThanOrEqual(INSET_FIT.x1 + eps);
    expect(Math.min(...proj.map((q) => q.y))).toBeGreaterThanOrEqual(INSET_FIT.y0 - eps);
    expect(Math.max(...proj.map((q) => q.y))).toBeLessThanOrEqual(INSET_FIT.y1 + eps);
  });

  it("projects the ENU axes for the gizmo (identity view: X right, Z up, Y into the screen)", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const g = Object.fromEntries(gizmoAxes(identity).map((a) => [a.axis, [a.dx, a.dy, a.depth]]));
    expect(g).toEqual({ X: [1, -0, 0], Y: [0, -0, -1], Z: [0, -1, 0] });
  });
});

describe("pad rocket glyph", () => {
  it("scales with the apex, stays visible on a flat flight, and stands as body + nose", () => {
    const p = padRocket(120, 300);
    expect(p.height).toBeCloseTo(18);
    expect(p.body + p.nose).toBeCloseTo(p.height);
    expect(padRocket(2, 300).height).toBeCloseTo(15);
    expect(padRocket(0, 0).height).toBe(1);
  });

  it("reads the launch rail from the sim's conditions (into the wind: the wind's azimuth)", () => {
    const c = { rail_length_m: 1.5, rod_angle_deg: 5, rod_direction_deg: 90, wind_direction_deg: 270 };
    expect(launchRailOf(c)).toEqual({ length: 1.5, angleDeg: 5, azimuthDeg: 90 });
    expect(launchRailOf({ ...c, launch_into_wind: true })).toEqual({ length: 1.5, angleDeg: 5, azimuthDeg: 270 });
    expect(launchRailOf({ ...c, rail_length_m: 0 })).toBeNull();
    expect(launchRailOf(null)).toBeNull();
  });

  it("takes the pad rocket's looks, length, diameter, and fin count from the model", () => {
    const comp = (type: string, x_aft: number, shape: Record<string, number>, preset?: string) => ({
      aero: true,
      x_aft,
      appearance: preset ? ({ preset } as never) : null,
      shape: { type, ...shape },
    });
    const m = padModelOf({
      components: [
        comp("nose_cone", 0.3, { length: 0.3, od: 0.054 }, "composite_white"),
        comp("body_tube", 0.5, { length: 0.2, od: 0.054 }, "clear_polycarbonate"),
        comp("body_tube", 1.3, { length: 0.8, od: 0.054 }, "carbon_fiber"),
        comp("trapezoidal_fin_set", 1.3, { count: 4 }, "black_gloss"),
      ],
    });
    expect(m.length).toBeCloseTo(1.3);
    expect(m.diameter).toBeCloseTo(0.054);
    expect(m.fins).toBe(4);
    // The longest opaque tube sets the body (the clear payload bay does not).
    expect(m.body).toEqual(PRESET_LOOKS.carbon_fiber);
    expect(m.nose).toEqual(PRESET_LOOKS.composite_white);
    expect(m.fin).toEqual(PRESET_LOOKS.black_gloss);
    expect(padModelOf(null)).toMatchObject({ length: null, diameter: null, fins: 3 });
  });

  it("stands the rocket beside a rail of the sim's length and lean, under PAD_SHARE of the lowest apex", () => {
    const rail = { length: 2.2, angleDeg: 10, azimuthDeg: 90 };
    const p = padRocket(115, 200, { rail, model: { length: 1.3, diameter: 0.054, fins: 4 }, minApex: 38 });
    // Rail length relative to the rocket, as in the sim (2.2 m rail, 1.3 m rocket), up to RAIL_MAX.
    expect(p.rail / p.height).toBeCloseTo(2.2 / 1.3);
    const long = padRocket(115, 200, { rail: { ...rail, length: 5 }, model: { length: 1.3, diameter: 0.054, fins: 4 } });
    expect(long.rail / long.height).toBeCloseTo(RAIL_MAX);
    // Leaning 10 deg toward east (ENU x = three.js x).
    expect(Math.acos(p.axis[1]) * (180 / Math.PI)).toBeCloseTo(10);
    expect(p.axis[0]).toBeGreaterThan(0);
    expect(Math.abs(p.axis[2])).toBeLessThan(1e-9);
    // The rail sits beside the body, square to its axis.
    const dot = p.railOffset[0] * p.axis[0] + p.railOffset[1] * p.axis[1] + p.railOffset[2] * p.axis[2];
    expect(Math.abs(dot)).toBeLessThan(1e-9);
    expect(Math.hypot(...p.railOffset)).toBeGreaterThan(p.radius);
    // The paths depart above the rail top, below half the lowest apex.
    expect(p.departure[1]).toBeGreaterThan(p.rail * p.axis[1]);
    expect(p.departure[1]).toBeLessThanOrEqual(PAD_SHARE * 38 + 1e-9);
    expect(p.fins).toBe(4);
    // A slender real rocket is drawn fatter, to read at inset scale.
    expect(p.radius / p.height).toBeGreaterThanOrEqual(0.09);
    // The fit frames the plate and the departure point.
    const b = padBounds(p);
    expect(b).toContainEqual(p.departure);
    expect(Math.min(...b.map((q) => q[0]))).toBeCloseTo(-p.plate / 2);
  });

  it("starts each drawn path at the pad's departure point, not through the glyph", () => {
    const path: [number, number, number][] = Array.from({ length: 50 }, (_, i) => [i * 0.5, i < 25 ? i * 4 : (49 - i) * 4, 0]);
    const dep: [number, number, number] = [0.3, 10, 0];
    const drawn = startAtPad(path, dep);
    expect(drawn[0]).toEqual(dep);
    // Joins the flown path where it first climbs past the departure height.
    expect(drawn[1]).toEqual(path[3]);
    expect(drawn.at(-1)).toEqual(path.at(-1));
    expect(drawn.slice(1).every((q, i) => i > 0 || q[1] >= dep[1])).toBe(true);
    // Unchanged when it never climbs that high, or starts above it.
    expect(startAtPad(path, [0, 500, 0])).toEqual(path);
    expect(startAtPad(path.slice(5), dep)).toEqual(path.slice(5));
  });
});

describe("series source", () => {
  it("builds the IF10 series and events URLs", () => {
    expect(seriesUrl("http://127.0.0.1:9/", "research vehicle", { sim: "baseline", runId: "abc" })).toBe(
      "http://127.0.0.1:9/api/projects/research%20vehicle/runs/baseline/abc/series.csv",
    );
    expect(eventsUrl("http://127.0.0.1:9", "p", { sim: "baseline", runId: "abc" })).toBe("http://127.0.0.1:9/api/projects/p/runs/baseline/abc/events.json");
  });

  it("fetches and parses series and events, caches per run, and retries after a failure", async () => {
    const calls: string[] = [];
    let fail = true;
    const events = [{ t: 4.2, kind: "deployment", altitude: 41, velocity: 4 }];
    const src = cachedSource(
      httpRunSource("", async (url) => {
        calls.push(url);
        if (fail) return { ok: false, status: 503, text: async () => "" };
        if (url.endsWith("events.json")) return { ok: true, status: 200, text: async () => JSON.stringify({ schema: "rw/1", events }) };
        return { ok: true, status: 200, text: async () => CSV_A };
      }),
    );
    const key = { sim: "baseline", runId: "abc" };
    await expect(src.load("p", key)).rejects.toThrow("series baseline/abc: HTTP 503");
    fail = false;
    const a = await src.load("p", key);
    const b = await src.load("p", key);
    expect(a).toBe(b);
    expect(a.series.rows).toHaveLength(3);
    expect(a.events).toEqual(events);
    expect(calls.filter((u) => u.endsWith("series.csv"))).toHaveLength(2);
  });

  it("loads the series without events when the events are missing or malformed", async () => {
    const missing = httpRunSource("", async (url) => (url.endsWith("events.json") ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => CSV_A }));
    expect((await missing.load("p", { sim: "baseline", runId: "abc" })).events).toBeNull();
    expect(parseRunEvents("{")).toBeNull();
    expect(parseRunEvents('{"schema":"rw/1"}')).toBeNull();
  });
});

/** Opening tags carrying `data-testid`/`data-rw-region`, with the text right after. */
function testIds(html: string, id: string): string[] {
  return [...html.matchAll(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id.replace(".", "\\.")}"[^>]*>([^<]*)`, "g"))].map((m) => m[1]!);
}

describe("static markup", () => {
  const app = staticStore((s) => withRuns(s));
  const page = renderToStaticMarkup(<ResultsPage app={app} source={null} />);

  it("renders every page-04 region and control", () => {
    for (const region of ["run-table", "plot", "trajectory-inset", "run-details"]) expect(page).toContain(`data-rw-region="${region}"`);
    expect(testIds(page, "page.title")).toEqual(["Flight results"]);
    for (const id of ["results.run-selected", "results.plot-menu", "results.export-csv", "runs.table-header"]) expect(testIds(page, id), id).toHaveLength(1);
    expect(testIds(page, "plot.tab")).toEqual(["Altitude", "Velocity", "Acceleration", "Stability", "Mach", "Drag coefficient", "Mass", "Thrust", "Lateral distance"]);
    expect(page).toMatch(/data-testid="plot\.tab" data-tab="altitude" aria-selected="true"/);
    // One row per flight sim; never-run Recovery test reads Not run and offers Run (R2.7).
    expect(testIds(page, "runs.table-row")).toHaveLength(4);
    expect(page).toMatch(/data-testid="runs\.table-row" data-sim="recovery_test" data-status="not_run"/);
    expect(testIds(page, "runs.row-menu")).toHaveLength(4);
    expect(page).toMatch(/data-testid="runs\.table-row" data-sim="baseline" data-status="complete" data-series="a" aria-selected="true"/);
    expect(page).toMatch(/data-testid="runs\.table-row" data-sim="higher_altitude" data-status="complete" data-series="b"/);
    // A Not run row holds its Run button where the numbers would be.
    expect(testIds(page, "runs.apogee")).toEqual(["612", "700", "—", ""]);
  });

  it("shows the banner, the details footer, and the trajectory title", () => {
    expect(page).toContain("Fin revision uses an outdated model. Rebuild to run this simulation.");
    expect(testIds(page, "results.open-design")).toHaveLength(1);
    expect(page).toMatch(/Model Rev 07/);
    expect(page).toContain("Environment: </span>calm, 15 °C");
    // The footer shows the compact form; the spelled-out text is its title.
    expect(page).toMatch(/data-field="environment" title="Environment: calm \(0 m\/s, 15 °C\)"/);
    expect(page).toMatch(/Warnings: (<!-- -->)?1/);
    expect(page).toContain("View assumptions");
    expect(page).toContain("Trajectory view");
    // Without a series source there is nothing to plot yet.
    expect(testIds(page, "plot.empty")).toEqual(["Loading run series…"]);
  });

  it("renders the Runs rail rows with eye, status, and name", () => {
    const rail = renderToStaticMarkup(<RunsRail app={app} />);
    expect(testIds(rail, "rail.nav-title")).toEqual(["Runs"]);
    expect(rail.match(/data-testid="rail\.nav-row"/g)).toHaveLength(4);
    expect(rail.match(/data-testid="rail\.eye"/g)).toHaveLength(4);
    expect(rail).toMatch(/data-sim="baseline" data-status="complete" data-series="a" aria-selected="true"/);
    expect([...rail.matchAll(/class="rw-run-row__status"[^>]*>([^<]*)/g)].map((m) => m[1])).toEqual(["Complete", "Complete", "Outdated", "Not run"]);
    expect(rail.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it("highlights the primary run in the rail: the selected one, else series A", () => {
    // Nothing selected: series A (Baseline) is the run the page describes.
    const none = staticStore((s) => withRuns(s, { refs: [] }));
    const rail = renderToStaticMarkup(<RunsRail app={none} />);
    expect([...rail.matchAll(/data-sim="([a-z_]+)"[^>]*aria-selected="true"/g)].map((m) => m[1])).toEqual(["baseline"]);
    // A never-run sim selected in the rail is highlighted there (it can be run from the toolbar).
    const notRun = staticStore((s) => withRuns(s, { refs: ["rw:sim/recovery_test"] }));
    const rail2 = renderToStaticMarkup(<RunsRail app={notRun} />);
    expect([...rail2.matchAll(/data-sim="([a-z_]+)"[^>]*aria-selected="true"/g)].map((m) => m[1])).toEqual(["recovery_test"]);
  });

  it("renders snapshot cards and mounts the page into the shell on page 04", () => {
    const snaps = renderToStaticMarkup(<RunSnapshots app={app} />);
    expect(snaps).toContain('data-rw-region="run-snapshots"');
    expect(snaps.match(/data-testid="history\.snapshot"/g)).toHaveLength(2);
    expect(snaps).toContain("Baseline run");
    const shell = renderToStaticMarkup(<ShellApp model={PLACEHOLDER_SHELL} page="04" app={app} runSource={null} />);
    expect(shell).toContain('data-testid="results-page"');
    expect(shell).toContain('data-testid="rail.runs"');
    expect(shell).not.toContain("Recovery bay");
    // The snapshot row sits inside the history strip.
    expect(shell.indexOf('data-rw-region="history-strip"')).toBeLessThan(shell.indexOf('data-rw-region="run-snapshots"'));
    // Without a store the shell keeps the placeholder page body.
    expect(renderToStaticMarkup(<ShellApp model={PLACEHOLDER_SHELL} page="04" />)).not.toContain("results-page");
  });
});
