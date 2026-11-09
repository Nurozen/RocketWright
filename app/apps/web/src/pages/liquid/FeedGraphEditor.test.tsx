// @vitest-environment jsdom
/** U57: the feed graph card: every row renders from the model, and its buttons send the writes they say. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { PatchOp } from "@rw/contracts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import { anyDirtyField, resetDirtyFields } from "../../state/dirtyFields.ts";
import { blurFromWindow } from "../../testing/windowFocus.ts";
import { engineSource } from "./engineOps.ts";
import type { RowContext } from "./EngineFields.tsx";
import { FeedGraphEditor } from "./FeedGraphEditor.tsx";
import type { EvalEngine } from "./model.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetDirtyFields();
});

const engine: EvalEngine = {
  id: "demo",
  name: "Demo",
  oxidizer: "n2o",
  fuel: "ethanol",
  nodes: {
    tank_a: { kind: "tank", fluid: "n2o", station: 0.36, radial: -0.35 },
    engine: { kind: "engine", station: 0.42, radial: 0 },
  },
  edges: [{ from: "tank_a", to: "engine", diameter: 0.01, length: 0.45, bc: "open", waypoints: [{ station: 0.2, radial: 0, depth: 0 }] }],
} as unknown as EvalEngine;

function makeStore(refs: string[] = []): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const snapshot = { runs: { runs: [], model_hash: "h" }, jobs: [], check: { diagnostics: [] }, evaluated: { model_hash: "h", engines: { demo: engine }, sims: {}, materials: {}, components: [] } };
  const state: AppState = { ...base, project: { ...base.project, projectId: "p", snapshot: snapshot as never }, selection: { ...base.selection, refs } };
  return createStore<AppState>()(() => state) as unknown as AppStore;
}

async function mount(store = makeStore()) {
  const write = vi.fn<(ops: PatchOp[], label: string) => Promise<unknown>>(() => Promise.resolve(null));
  const ctx: RowContext = { engineId: "demo", engine, source: engineSource('[feed.node.tank_a]\nkind = "tank"\n'), units: "mm", write, diagnostic: () => undefined };
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<FeedGraphEditor app={store} ctx={ctx} onProblem={() => undefined} />));
  return { el, write };
}

const byTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const groupNamed = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent === name)!;
const click = (el: HTMLElement) => act(async () => el.click());

const typeInto = (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("the window losing focus (a native dialog) with an engine field being typed", () => {
  const diameter = () => groupNamed("Connection 1: Tank A to Engine").querySelector<HTMLInputElement>('input[aria-label="Diameter"]')!;

  it("does not write valid text, and writes it when focus then really moves on", async () => {
    const { write } = await mount();
    await typeInto(diameter(), "12");
    await blurFromWindow(diameter());
    expect(diameter().value).toBe("12");
    expect(anyDirtyField()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    await act(async () => diameter().focus());
    await act(async () => diameter().blur());
    expect(write).toHaveBeenCalledOnce();
  });

  it("keeps text that fails its check", async () => {
    const { write } = await mount();
    await typeInto(diameter(), "wide");
    await blurFromWindow(diameter());
    expect(diameter().value).toBe("wide");
    expect(anyDirtyField()).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the feed graph card", () => {
  it("shows a row per node and connection, named by what it is", async () => {
    await mount();
    expect(byTestId("liquid.feed-node")).toHaveLength(2);
    expect(byTestId("liquid.feed-edge")).toHaveLength(1);
    expect(groupNamed("Tank A")).toBeDefined();
    expect(groupNamed("Connection 1: Tank A to Engine")).toBeDefined();
    expect(byTestId("liquid.feed-waypoint")).toHaveLength(1);
    const input = groupNamed("Connection 1: Tank A to Engine").querySelector<HTMLInputElement>('input[aria-label="Diameter"]');
    expect(input?.value).toBe("10");
  });
  it("adds a node of the chosen kind", async () => {
    const { write } = await mount();
    const select = byTestId("liquid.feed-new-kind")[0]!.querySelector("select")!;
    await act(async () => {
      select.value = "valve";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(byTestId("liquid.feed-add-node")[0]!);
    expect(write).toHaveBeenCalledWith([{ op: "add", path: "/engines/demo/feed/node/valve", value: { kind: "valve" } }], "Add Valve node valve");
  });
  it("adds and removes connections", async () => {
    const { write } = await mount();
    await click(byTestId("liquid.feed-add-edge")[0]!);
    expect(write.mock.calls[0]![0]).toEqual([{ op: "add", path: "/engines/demo/feed/edge/-", value: { from: "tank_a", to: "engine" } }]);
    await click(byTestId("liquid.feed-remove-edge")[0]!);
    expect(write.mock.calls[1]![0]).toEqual([{ op: "remove", path: "/engines/demo/feed/edge/0" }]);
  });
  it("asks before a node takes its connections with it", async () => {
    const { write } = await mount();
    await click(byTestId("liquid.feed-remove-node")[0]!);
    const dialog = document.querySelector<HTMLElement>('[data-testid="remove-feed-node"]')!;
    expect(dialog.textContent).toContain("Remove Engine? This also removes 1 connection that use it.");
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Remove")!);
    expect(write.mock.calls[0]![0].map((o) => o.path)).toEqual(["/engines/demo/feed/edge/0", "/engines/demo/feed/node/engine"]);
  });
  it("offers tank geometry when a tank has none", async () => {
    const { write } = await mount();
    await click(byTestId("liquid.feed-add-geometry")[0]!);
    expect(write.mock.calls[0]![0][0]).toMatchObject({ op: "add", path: "/engines/demo/feed/node/tank_a/tank" });
  });
  it("drops a feed selection after a structural change, since it may no longer exist", async () => {
    const store = makeStore(["rw:eng/demo/feed/edge/0"]);
    const select = vi.fn<(refs: string[], source: string) => void>();
    store.setState({ selection: { ...store.getState().selection, select } } as never);
    await mount(store);
    await click(byTestId("liquid.feed-remove-edge")[0]!);
    await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
    expect(select).toHaveBeenCalledWith([], "inspector");
  });
});
