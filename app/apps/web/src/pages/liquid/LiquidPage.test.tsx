// @vitest-environment jsdom
/** R3.2: a result computed from an older engine says so on every tab, a failed Compute included, and nothing quotes it as the current engine's. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import { createLiquidUi, liquidSlots, type LiquidStore } from "./LiquidPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../viewport/AssemblyViewport.tsx", () => ({ AssemblyViewport: () => null }));
vi.mock("./Diagram.tsx", () => ({ ConnectivityDiagram: () => null }));

const engine = (thrust: number) => ({
  name: "Demo",
  oxidizer: "n2o",
  fuel: "ethanol",
  mixture_ratio: 4,
  chamber_pressure: 2e6,
  thrust,
  fluid_model: "single_phase_liquid",
  nodes: { tank_a: { kind: "tank", fluid: "n2o" }, chamber: { kind: "engine" } },
  edges: [],
});

const design = (burn_time: number) => ({
  engine: "demo",
  missing_inputs: [],
  diagnostics: [],
  performance: { isp_sl: 200 },
  design: { thermo: "table:n2o-ethanol", assumptions: [], sizing: { throat_diameter: 0.01 }, blowdown: { burn_time } },
});

function makeStore(tab: string): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const snapshot = { files: { files: {} }, check: { diagnostics: [] }, evaluated: { model_hash: "h", engines: { demo: engine(1500) }, sims: {}, configs: {}, materials: {}, components: [] } };
  const state: AppState = { ...base, project: { ...base.project, projectId: "p", snapshot: snapshot as never }, ui: { ...base.ui, tab } };
  return createStore<AppState>()(() => state) as unknown as AppStore;
}

function editThrust(store: AppStore, thrust: number): void {
  const st = store.getState();
  const snapshot = { ...st.project.snapshot!, evaluated: { ...st.project.snapshot!.evaluated!, engines: { demo: engine(thrust) } } };
  (store as unknown as { setState(s: Partial<AppState>): void }).setState({ project: { ...st.project, snapshot: snapshot as never } });
}

function setTab(store: AppStore, tab: string): void {
  (store as unknown as { setState(s: Partial<AppState>): void }).setState({ ui: { ...store.getState().ui, tab } });
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function render(node: ReactNode): Promise<void> {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => byId(id)!.click());
const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

/** The first design lands; later calls are the test's. */
async function mount(tab: string, calls: ((m: string) => Promise<unknown>)[] = []) {
  const store = makeStore(tab);
  const ui: LiquidStore = createLiquidUi();
  let i = 0;
  const call = vi.fn<(m: string, p: unknown) => Promise<unknown>>((m) => (i === 0 ? (i++, Promise.resolve(design(8.49))) : calls[i++ - 1]!(m)));
  await render(liquidSlots(store, { call } as unknown as RpcLike, {} as GlbDeps, ui).content);
  await flush();
  return { store, ui, call };
}

describe("a design older than the engine", () => {
  it.each(["assembly", "system"])("warns on %s, and Compute there refreshes it", async (tab) => {
    const { store } = await mount(tab, [() => Promise.resolve(design(9.1))]);
    expect(byId("liquid.notice")).toBeNull();
    await act(async () => editThrust(store, 1600));
    expect(byId("liquid.notice-modified")!.textContent).toContain("last computed sizing");
    await click("liquid.notice-compute");
    await flush();
    expect(byId("liquid.notice")).toBeNull();
  });

  it("System's Run does not quote the previous design's burn time", async () => {
    const { store } = await mount("system", [() => Promise.resolve({ run_id: "r2" })]);
    await act(async () => editThrust(store, 1600));
    await click("propulsion.run-analysis");
    await flush();
    const row = byId("propulsion.analysis")!;
    expect(row.textContent).toContain("run r2");
    expect(row.textContent).not.toContain("8.49");
  });

  it("System's Run quotes the design when it is this engine's", async () => {
    await mount("system", [() => Promise.resolve({ run_id: "r1" })]);
    await click("propulsion.run-analysis");
    await flush();
    expect(byId("propulsion.analysis")!.textContent).toContain("8.49 s burn");
  });

  it("offers Run again once the engine has changed since a completed analysis", async () => {
    const { store } = await mount("system", [() => Promise.resolve({ run_id: "r1" })]);
    await click("propulsion.run-analysis");
    await flush();
    expect(byId("propulsion.run-analysis")).toBeNull();
    await act(async () => editThrust(store, 1600));
    expect(byId("propulsion.analysis")!.dataset["state"]).toBe("not_run");
    expect(byId("propulsion.run-analysis")).not.toBeNull();
  });
});

describe("a failed Compute", () => {
  const failed = () => Promise.reject(new Error("design exploded"));

  it("leaves an edited engine Modified, with the old numbers stale and the error shown", async () => {
    const { store } = await mount("properties", [failed]);
    await act(async () => editThrust(store, 1600));
    expect(byId("liquid.modified")).not.toBeNull();
    await click("liquid.compute");
    await flush();
    expect(byId("liquid.modified")).not.toBeNull();
    expect(byId("liquid.results")!.dataset["stale"]).toBe("true");
    expect(byId("liquid.design-error")!.textContent).toContain("design exploded");
    expect(byId("liquid.properties")!.dataset["state"]).toBe("error");
  });

  it("is shown on Assembly too, and keeps the old result filed under its engine", async () => {
    const { store, ui } = await mount("properties", [failed]);
    const before = ui.getState().designs["demo"]!.key;
    await act(async () => editThrust(store, 1600));
    await click("liquid.compute");
    await flush();
    expect(ui.getState().designs["demo"]!.key).toBe(before);
    await act(async () => setTab(store, "assembly"));
    expect(byId("liquid.notice-modified")).not.toBeNull();
    expect(byId("liquid.design-error")!.textContent).toContain("design exploded");
  });

  it("does not call an unedited engine Modified", async () => {
    await mount("properties", [failed]);
    await click("liquid.compute");
    await flush();
    expect(byId("liquid.modified")).toBeNull();
    expect(byId("liquid.results")!.dataset["stale"]).toBeUndefined();
    expect(byId("liquid.design-error")).not.toBeNull();
  });

  it("clears the error when the next Compute lands", async () => {
    const { store } = await mount("properties", [failed, () => Promise.resolve(design(9.1))]);
    await act(async () => editThrust(store, 1600));
    await click("liquid.compute");
    await flush();
    await click("liquid.compute");
    await flush();
    expect(byId("liquid.modified")).toBeNull();
    expect(byId("liquid.design-error")).toBeNull();
  });
});
