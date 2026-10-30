/**
 * CPW2A: `plot_render` in the window (`pnpm --filter @rw/web test plot`).
 * The host resolves run refs against the window's run table (waiting for a
 * run that just finished), loads the series from the run source, builds the
 * Results page's lines, legend and event lines, and answers every refusal as
 * a structured error the agent can act on. The pixels are the renderer's
 * (`plots/plotImage.ts`, a DOM); here it is a fake that records the spec.
 * Parity: the host answers every op the server advertises.
 */
import { AGENT_OPS, TEST_HOOK_OPS, type BrokerRequest, type ProjectSnapshot, type RunListOut } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { afterAll, describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { parseSeriesCsv } from "../plots/series.ts";
import type { PlotImageSpec } from "../plots/plotImage.ts";
import { plotLayout } from "../plots/plotImage.ts";
import type { RunData, RunDataSource, RunKey } from "../pages/results/source.ts";
import { createAppStore, type AppStore } from "../state/store.ts";
import type { AppState, DeepReadonly } from "../state/types.ts";
import { answer, HOST_OPS, type BrokerHostDeps } from "./host.ts";
import { findRun, plotArgs, PlotRenderError } from "./plot.ts";
import { resultsRows } from "../pages/results/model.ts";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

type Entry = RunListOut["runs"][number];

const CSV = "t,altitude,speed,accel,stability\n0,0,0,50,1.8\n1,40,60,20,1.9\n2,70,40,-9.8,2.1\n3,80,10,-9.8,2.2\n";
const ENGINE_CSV = "t,thrust\n0,0\n1,12\n";

/** The mock project with Baseline and Higher altitude Complete, Fin revision Outdated, Recovery test Not run. */
function snapshot(): ProjectSnapshot {
  const snap = mock.snapshot();
  const base = snap.runs.runs.find((r) => r.sim === "baseline")!;
  const higher: Entry = { ...structuredClone(base), sim: "higher_altitude", sim_name: "Higher altitude", config: "higher_altitude", run_id: "a1b2c3d4e5f6" };
  higher.summary = { ...higher.summary!, apogee_m: 700.2 };
  snap.runs.runs = [base, higher, snap.runs.runs.find((r) => r.sim === "fin_revision")!, snap.runs.runs.find((r) => r.sim === "recovery_test")!];
  return snap;
}

function storeWith(edit: (s: AppState) => AppState): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state = edit(base);
  return createStore<AppState>()(() => state);
}

const withRuns = (s: AppState, snap: ProjectSnapshot | null = snapshot(), overlay: string[] = []): AppState => ({
  ...s,
  project: { ...s.project, projectId: "research-vehicle", snapshot: snap as DeepReadonly<ProjectSnapshot> | null },
  runs: { ...s.runs, overlay },
});

function fakeSource(o: { engine?: string[]; fail?: string[] } = {}) {
  const loads: RunKey[] = [];
  const source: RunDataSource = {
    async load(projectId: string, key: RunKey): Promise<RunData> {
      expect(projectId).toBe("research-vehicle");
      loads.push(key);
      if (o.fail?.includes(key.runId)) throw new Error(`series ${key.sim}/${key.runId}: HTTP 404`);
      return { series: parseSeriesCsv(o.engine?.includes(key.runId) ? ENGINE_CSV : CSV), events: [{ t: 3, kind: "apogee", altitude: 80, velocity: 0 }] as NonNullable<RunData["events"]> };
    },
  };
  return { source, loads };
}

function deps(source: RunDataSource | null, specs: PlotImageSpec[] = []): BrokerHostDeps {
  return {
    viewport: () => Promise.reject(new Error("no viewport")),
    settle: async () => undefined,
    plots: {
      runSource: source,
      runWaitMs: 300,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
      render: async (spec) => {
        specs.push(spec);
        return { png_base64: "iVBORw0KGgo=", width: spec.width, height: spec.height };
      },
    },
  };
}

const req = (args: unknown): BrokerRequest => ({ requestId: "r-plot", projectId: "research-vehicle", threadId: "t", op: "plot_render", args }) as BrokerRequest;

describe("plot_render", () => {
  it("plots a run by id from any page, as the Results page draws it", async () => {
    const store = storeWith((s) => withRuns(s));
    const baseId = store.getState().project.snapshot!.runs.runs[0]!.run_id!;
    const { source, loads } = fakeSource();
    const specs: PlotImageSpec[] = [];
    const r = await answer(req({ plot: "altitude", runs: [baseId, "rw:run/a1b2c3d4e5f6"], width: 1000, height: 500 }), store, deps(source, specs));
    expect(r).toEqual({
      requestId: "r-plot",
      ok: true,
      result: {
        png_base64: "iVBORw0KGgo=",
        width: 1000,
        height: 500,
        plot: "altitude",
        runs: [
          { ref: `rw:run/${baseId}`, sim: "baseline", run_id: baseId, name: "Baseline" },
          { ref: "rw:run/a1b2c3d4e5f6", sim: "higher_altitude", run_id: "a1b2c3d4e5f6", name: "Higher altitude" },
        ],
      },
    });
    expect(loads).toEqual([{ sim: "baseline", runId: baseId }, { sim: "higher_altitude", runId: "a1b2c3d4e5f6" }]);
    const spec = specs[0]!;
    expect(spec).toMatchObject({ title: "Altitude", yLabel: "Altitude (m)", xLabel: "Time (s)", width: 1000, height: 500 });
    expect(spec.lines.map((l) => [l.id, l.label, l.color, l.y])).toEqual([
      ["baseline", "Baseline", "#61b5ad", [0, 40, 70, 80]],
      ["higher_altitude", "Higher altitude", "#f1ae6e", [0, 40, 70, 80]],
    ]);
    expect(spec.legend.map((e) => e.label)).toEqual(["Baseline (612 m)", "Higher altitude (700 m)", "Events: Baseline"]);
    expect(spec.events.map((e) => [e.label, e.t, e.run])).toContainEqual(["Apogee", 3, "baseline"]);
    // Never navigates: the user's page stays.
    expect(store.getState().ui.page).toBe("assembly");
  });

  it("accepts a sim id, <sim>/<run id>, rw:sim/<sim>, and no runs (the page's overlay, else its default)", async () => {
    const rows = resultsRows(withRuns(createAppStore().getState()));
    const id = rows[0]!.entry.run_id!;
    expect(findRun(rows, "baseline")?.sim).toBe("baseline");
    expect(findRun(rows, `baseline/${id}`)?.sim).toBe("baseline");
    expect(findRun(rows, `runs/baseline/${id}`)?.sim).toBe("baseline");
    expect(findRun(rows, "rw:sim/higher_altitude")?.sim).toBe("higher_altitude");
    expect(findRun(rows, "rw:c/fins")).toBeNull();
    expect(findRun(rows, "nope")).toBeNull();

    const specs: PlotImageSpec[] = [];
    const overlaid = storeWith((s) => withRuns(s, snapshot(), ["higher_altitude"]));
    expect(await answer(req({ plot: "velocity", runs: [] }), overlaid, deps(fakeSource().source, specs))).toMatchObject({ ok: true, result: { runs: [{ sim: "higher_altitude" }] } });
    expect(specs[0]!.lines.map((l) => l.y)).toEqual([[0, 60, 40, 10]]);
    const fresh = storeWith((s) => withRuns(s));
    expect(await answer(req({ plot: "stability" }), fresh, deps(fakeSource().source))).toMatchObject({ ok: true, result: { runs: [{ sim: "baseline" }, { sim: "higher_altitude" }], width: 1200, height: 800 } });
  });

  it("waits for a run that just finished to reach the window's run table", async () => {
    const snap = snapshot();
    const later = structuredClone(snap);
    later.runs.runs.push({ ...structuredClone(snap.runs.runs[0]!), sim: "fresh", sim_name: "Fresh", run_id: "f00df00df00d" });
    let state = withRuns(createAppStore().getState(), snap);
    const store = createStore<AppState>()(() => state);
    setTimeout(() => {
      state = withRuns(state, later);
      store.setState(state, true);
    }, 30);
    const r = await answer(req({ plot: "altitude", runs: ["f00df00df00d"] }), store, deps(fakeSource().source));
    expect(r).toMatchObject({ ok: true, result: { runs: [{ sim: "fresh", run_id: "f00df00df00d" }] } });
  });

  it("refuses with an error the agent can act on", async () => {
    const store = storeWith((s) => withRuns(s));
    const { source } = fakeSource({ engine: ["a1b2c3d4e5f6"] });
    const d = deps(source);
    const err = async (args: unknown, s: AppStore = store, dd: BrokerHostDeps = d) => {
      const r = await answer(req(args), s, dd);
      if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
      return r.error;
    };
    expect(await err({ plot: "thrust", runs: [] })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("altitude, velocity") });
    expect(await err({ plot: "altitude", runs: ["a", "b", "c"] })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("at most 2 runs") });
    expect(await err({ plot: "altitude", runs: [7] })).toMatchObject({ code: "invalid_args" });
    expect(await err({ plot: "altitude", runs: ["baseline"], width: 10 })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("width") });
    // An unknown run names the runs the window knows.
    const unknown = await err({ plot: "altitude", runs: ["deadbeef0000"] });
    expect(unknown.code).toBe("invalid_args");
    expect(unknown.message).toContain('unknown run "deadbeef0000"');
    expect(unknown.message).toContain("higher_altitude/a1b2c3d4e5f6 (Higher altitude, complete)");
    // A sim that never ran.
    expect(await err({ plot: "altitude", runs: ["recovery_test"] })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("has not been run yet") });
    // A run without the plotted column (an engine run).
    expect(await err({ plot: "altitude", runs: ["a1b2c3d4e5f6"] })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("no altitude series") });
    // The window cannot plot now: no run source, a series that will not load, no project yet.
    expect(await err({ plot: "altitude", runs: ["baseline"] }, store, deps(null))).toMatchObject({ code: "failed", message: expect.stringContaining("not available in this window") });
    const baseId = store.getState().project.snapshot!.runs.runs[0]!.run_id!;
    expect(await err({ plot: "altitude", runs: ["baseline"] }, store, deps(fakeSource({ fail: [baseId] }).source))).toMatchObject({ code: "failed", message: expect.stringContaining("HTTP 404") });
    const loading = storeWith((s) => withRuns(s, null));
    expect(await err({ plot: "altitude", runs: ["baseline"] }, loading)).toMatchObject({ code: "failed", message: expect.stringContaining("still loading") });
    // A renderer failure is the window's, not the call's.
    const broken: BrokerHostDeps = { ...d, plots: { ...d.plots, render: () => Promise.reject(new Error("no 2D canvas")) } };
    expect(await err({ plot: "altitude", runs: ["baseline"] }, store, broken)).toMatchObject({ code: "failed", message: expect.stringContaining("no 2D canvas") });
  });

  it("checks the call before waiting", () => {
    expect(() => plotArgs({ plot: "altitude", runs: "baseline" })).toThrow(PlotRenderError);
    expect(plotArgs({ plot: "altitude", runs: ["x", "x"] })).toEqual({ plot: "altitude", refs: ["x"], width: 1200, height: 800 });
  });

  it("lays the image out at the page's text size, scaling up past 900 px", () => {
    const small = plotLayout(800, 500);
    expect(small.scale).toBe(1);
    expect(small.plot.top).toBeGreaterThan(small.legendY);
    expect(small.plot.left + small.plot.width).toBeLessThanOrEqual(800);
    expect(small.plot.top + small.plot.height).toBeLessThan(small.xTitleY);
    const big = plotLayout(1800, 1200);
    expect(big.scale).toBe(2);
    expect(big.width).toBe(900);
  });
});

describe("broker op parity", () => {
  it("the host answers every op the server advertises (AGENT_OPS, plus TEST_HOOK_OPS)", async () => {
    expect([...HOST_OPS].sort()).toEqual([...AGENT_OPS, ...TEST_HOOK_OPS].sort());
    const store = storeWith((s) => withRuns(s));
    for (const op of HOST_OPS) {
      const r = await answer({ requestId: op, projectId: "research-vehicle", threadId: null, op, args: {} } as BrokerRequest, store, deps(fakeSource().source));
      if (!r.ok) expect(r.error.message).not.toContain("is not available in this window");
    }
  });
});
