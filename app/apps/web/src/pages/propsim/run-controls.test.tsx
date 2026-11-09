// @vitest-environment jsdom
/** R2.7/D16: Engineering and Visual flow run only when asked, and Cancel abandons the result here. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import { createEngineeringUi, EngineeringTab, type FetchText } from "./engineering.tsx";
import type { EngineRunRecord } from "./model.ts";
import { createVisualUi, VisualFlowTab, type VisualStore } from "./visual.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../plots/TimePlot.tsx", () => ({ TimePlot: () => null }));

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const sample = { t: 0, chamber_pressure: 2e6, ox_tank_pressure: 5e6, fuel_tank_pressure: 3.5e6, mdot_ox: 0.5, mdot_fuel: 0.1, mixture_ratio: 4, thrust: 1500, ox_liquid: 0.003, fuel_liquid: 0.002 };
const record = (run_id: string): EngineRunRecord =>
  ({
    engine: "demo",
    run_id,
    provenance: "engineering",
    design: { engine: "demo", thermo: "table:n2o-ethanol", assumptions: ["Single-phase."], feed: [{ tank: "tank_a", fluid: "n2o" }, { tank: "tank_b", fluid: "ethanol" }] },
    blowdown: { samples: [sample, { ...sample, t: 4 }], end: "oxidizer_depleted", burn_time: 4, total_impulse: 6000, ox_used: 2, fuel_used: 0.5 },
  }) as unknown as EngineRunRecord;

function makeStore(opts: { hash?: string; refs?: string[] } = {}): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const snapshot = {
    runs: { runs: [], model_hash: "h" },
    jobs: [],
    check: { diagnostics: [] },
    evaluated: {
      model_hash: opts.hash ?? "h",
      engines: { demo: { name: "Demo" } },
      sims: { study_01: { id: "study_01", name: "Study 01", kind: "visual_flow" }, study_02: { id: "study_02", name: "Study 02", kind: "visual_flow" } },
    },
  };
  const state: AppState = { ...base, project: { ...base.project, projectId: "p", snapshot: snapshot as never }, selection: { ...base.selection, refs: opts.refs ?? [] } };
  return createStore<AppState>()(() => state) as unknown as AppStore;
}

/** Calls stay pending until the test resolves them, in order. */
function pendingClient() {
  const resolvers: ((v: unknown) => void)[] = [];
  const call = vi.fn<(m: string, p: unknown) => Promise<unknown>>(() => new Promise<unknown>((r) => resolvers.push(r)));
  return { client: { call } as unknown as RpcLike, call, resolve: (i: number, v: unknown) => resolvers[i]!(v) };
}

async function render(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => byId(id)!.click());
const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

describe("Engineering", () => {
  const fetchText: FetchText = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(record(/\/(r\d)\//.exec(url)![1]!)) });

  function mount(client: RpcLike | null, store = makeStore(), ui = createEngineeringUi()) {
    return render(<EngineeringTab store={store} client={client} ui={ui} httpBase="" fetchText={fetchText} />);
  }
  const tab = () => byId("propsim.engineering")!;
  const out = (run_id: string) => ({ sim: "engine.demo", run_id });

  it("does not run on open and says how to start", async () => {
    const { client, call } = pendingClient();
    await mount(client);
    expect(call).not.toHaveBeenCalled();
    expect(tab().dataset["state"]).toBe("idle");
    expect(byId("engineering.idle")!.textContent).toContain("Press Run");
    expect(byId("engineering.cancel")).toBeNull();
  });

  it("Run flies the blowdown once and shows the record", async () => {
    const { client, call, resolve } = pendingClient();
    await mount(client);
    await click("engineering.run");
    expect(call).toHaveBeenCalledWith("engine.simulate", { projectId: "p", engine: "demo" });
    expect(tab().dataset["state"]).toBe("running");
    expect(byId<HTMLButtonElement>("engineering.run")!.disabled).toBe(true);
    resolve(0, out("r1"));
    await flush();
    expect(tab().dataset["state"]).toBe("ready");
    expect(byId("engineering.run-id")!.textContent).toContain("r1");
    expect(byId("engineering.cancel")).toBeNull();
  });

  it("Cancel abandons the result and says so", async () => {
    const { client, resolve } = pendingClient();
    await mount(client);
    await click("engineering.run");
    await click("engineering.cancel");
    expect(tab().dataset["state"]).toBe("cancelled");
    expect(byId("engineering.cancelled")!.textContent).toContain("cancelled");
    resolve(0, out("r1"));
    await flush();
    expect(tab().dataset["state"]).toBe("cancelled");
    expect(byId("engineering.plot")).toBeNull();
  });

  it("a Run after Cancel shows its own result, not the abandoned one", async () => {
    const { client, resolve } = pendingClient();
    await mount(client);
    await click("engineering.run");
    await click("engineering.cancel");
    await click("engineering.run");
    resolve(0, out("r1"));
    await flush();
    expect(tab().dataset["state"]).toBe("running");
    resolve(1, out("r2"));
    await flush();
    expect(tab().dataset["state"]).toBe("ready");
    expect(byId("engineering.run-id")!.textContent).toContain("r2");
  });

  it("does not run again when the model changes; the old result stops showing", async () => {
    const { client, call, resolve } = pendingClient();
    const ui = createEngineeringUi();
    await mount(client, makeStore(), ui);
    await click("engineering.run");
    resolve(0, out("r1"));
    await flush();
    await act(async () => root!.unmount());
    root = null;
    await mount(client, makeStore({ hash: "h2" }), ui);
    expect(call).toHaveBeenCalledTimes(1);
    expect(tab().dataset["state"]).toBe("idle");
  });

  it("shows why the blowdown could not run, and Run tries again", async () => {
    const call = vi.fn<() => Promise<never>>(async () => {
      throw new Error("missing injector");
    });
    await mount({ call } as unknown as RpcLike);
    await click("engineering.run");
    await flush();
    expect(byId("engineering.error")!.textContent).toContain("missing injector");
    await click("engineering.run");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("has no Run without an engine", async () => {
    const store = makeStore();
    const state = store.getState();
    const snapshot = { ...state.project.snapshot!, evaluated: { ...state.project.snapshot!.evaluated!, engines: {} } };
    const empty = createStore<AppState>()(() => ({ ...state, project: { ...state.project, snapshot } }) as AppState) as unknown as AppStore;
    await mount(pendingClient().client, empty);
    expect(byId("engineering.empty")).not.toBeNull();
    expect(byId("engineering.run")).toBeNull();
  });
});

describe("Visual flow", () => {
  function mount(client: RpcLike, store = makeStore(), ui: VisualStore = createVisualUi()) {
    return render(<VisualFlowTab store={store} client={client} ui={ui} httpBase="" />);
  }
  const tab = () => byId("propsim.visual")!;

  it("does not run on open and shows no empty transport or traces", async () => {
    const { client, call } = pendingClient();
    await mount(client);
    expect(call).not.toHaveBeenCalled();
    expect(tab().dataset["state"]).toBe("idle");
    expect(byId("visual.idle")!.textContent).toContain("Press Run");
    expect(byId("traces")).toBeNull();
  });

  it("Run flies the selected study", async () => {
    const { client, call } = pendingClient();
    await mount(client);
    await click("visual.run");
    expect(call).toHaveBeenCalledWith("sim.run", { projectId: "p", sim: "study_01" });
    expect(tab().dataset["state"]).toBe("running");
    expect(byId<HTMLButtonElement>("visual.run")!.disabled).toBe(true);
  });

  it("Cancel abandons the result and says so", async () => {
    const { client, resolve } = pendingClient();
    await mount(client);
    await click("visual.run");
    await click("visual.cancel");
    expect(tab().dataset["state"]).toBe("cancelled");
    expect(byId("visual.cancelled")!.textContent).toContain("cancelled");
    resolve(0, { sim: "study_01", run_id: "r1" });
    await flush();
    expect(tab().dataset["state"]).toBe("cancelled");
    expect(byId("traces")).toBeNull();
  });

  it("choosing another study does not run it", async () => {
    const { client, call } = pendingClient();
    await mount(client);
    await act(async () => document.querySelector<HTMLElement>('[data-testid="visual.study"][data-study="study_02"]')!.click());
    expect(tab().dataset["study"]).toBe("study_02");
    expect(tab().dataset["state"]).toBe("idle");
    expect(call).not.toHaveBeenCalled();
  });

  it("the agent's deep link still runs its study, once, with the section on", async () => {
    const { client, call } = pendingClient();
    const ui = createVisualUi();
    await mount(client, makeStore({ refs: ["rw:sim/study_02"] }), ui);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("sim.run", { projectId: "p", sim: "study_02" });
    expect(tab().dataset["study"]).toBe("study_02");
    expect(ui.getState().layers.section).toBe(true);
  });

  it("does not follow the deep link again after a tier switch", async () => {
    const { client, call } = pendingClient();
    const ui = createVisualUi();
    const store = makeStore({ refs: ["rw:sim/study_02"] });
    await mount(client, store, ui);
    await act(async () => root!.unmount());
    root = null;
    await mount(client, store, ui);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("waits for the connection before following a deep link", async () => {
    const { client, call } = pendingClient();
    const ui = createVisualUi();
    const store = makeStore({ refs: ["rw:sim/study_02"] });
    await render(<VisualFlowTab store={store} client={null} ui={ui} httpBase="" />);
    expect(call).not.toHaveBeenCalled();
    await act(async () => root!.render(<VisualFlowTab store={store} client={client} ui={ui} httpBase="" />));
    expect(call).toHaveBeenCalledTimes(1);
  });
});
