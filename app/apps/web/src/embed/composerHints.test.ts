/**
 * CPW1R3B: `pnpm -C app --filter @rw/web test -- composerHints`. The host
 * side of the next Lecturn pin's composer placeholder and `rw:` ref labels:
 * the per-page texts the checklists name, labels from the model (component,
 * configuration, run, engine part; nothing for ids the model lacks), and the
 * feature check (a pane without the options is left alone; one with them gets
 * the placeholder on every page change, once per change, and its label
 * requests answered).
 */
import type { EvaluatedModel, PageId, PatchOp } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import { createAppStore } from "../state/store.ts";
import type { PreviewCore } from "../state/wasm.ts";
import { PANE_HOST_CHANNEL } from "@rw/contracts";
import { startDesktopPane, type PaneBridge } from "./bridge.ts";
import { embedComposerPlaceholder, paneHints, refLabel, refLabels, startComposerHints, type RefLabelResolver } from "./composerHints.ts";

const core: PreviewCore = { coreVersion: () => "0.0.0-mock", applyAndEval: (_: { ops: readonly PatchOp[] }) => ({}) as EvaluatedModel };

const snap = {
  evaluated: {
    components: [
      { id: "fins", name: "Fins" },
      { id: "recovery_bay", name: "Recovery bay" },
    ],
    configs: { baseline: { name: "Baseline" }, high: { name: "Higher altitude" } },
    sims: { recovery_test: { name: "Recovery test" } },
    engines: { demo: { id: "demo", name: "Demo engine", nodes: { tank_a: { kind: "tank" }, engine: { kind: "engine" } }, edges: [{ from: "tank_a", to: "engine" }] } },
  },
  runs: { runs: [{ sim: "baseline", sim_name: "Baseline flight", run_id: "r-1", status: "complete" }] },
  history: { steps: [], revisions: [] },
} as never;

const bridgeBase = (): PaneBridge => ({
  insertMention: () => undefined,
  setDraft: () => undefined,
  openThread: () => undefined,
  newThread: () => undefined,
  openProviders: () => undefined,
  on: () => () => undefined,
});

describe("embedComposerPlaceholder (checklists *.composer.placeholder)", () => {
  it("names each page's subject", () => {
    const want: Record<PageId, string> = {
      assembly: "Ask about this design…",
      components: "Ask about this design…",
      configurations: "Ask about this configuration…",
      results: "Ask about these results…",
      liquid: "Ask about this design…",
      "propulsion-sim": "Ask about this simulation…",
    };
    for (const [page, text] of Object.entries(want)) expect(embedComposerPlaceholder(page as PageId), page).toBe(text);
  });
});

describe("refLabel", () => {
  it("labels components, configurations, runs and engine parts from the model", () => {
    expect(refLabel(snap, "rw:c/fins")).toBe("Fins");
    expect(refLabel(snap, "rw:c/recovery_bay/length")).toBe("Recovery bay");
    expect(refLabel(snap, "rw:cfg/high")).toBe("Higher altitude");
    expect(refLabel(snap, "rw:sim/baseline")).toBe("Baseline flight");
    expect(refLabel(snap, "rw:sim/recovery_test")).toBe("Recovery test");
    expect(refLabel(snap, "rw:run/r-1")).toBe("Baseline flight");
    expect(refLabel(snap, "rw:eng/demo")).toBe("Demo engine");
    expect(refLabel(snap, "rw:eng/demo/feed")).toBe("Demo engine");
    expect(refLabel(snap, "rw:eng/demo/feed/node/tank_a")).toBe("Tank A");
    expect(refLabel(snap, "rw:eng/demo/feed/edge/0")).toBe("Tank A → Engine");
  });

  it("gives no label for what the model lacks, other ref kinds and non-refs", () => {
    for (const ref of ["rw:c/nope", "rw:cfg/nope", "rw:sim/nope", "rw:run/nope", "rw:eng/nope", "rw:eng/demo/feed/node/nope", "rw:eng/demo/feed/edge/7", "rw:eng/demo/mass", "rw:step/2", "rw:thread/t", "lecturn:x", "fins"]) {
      expect(refLabel(snap, ref), ref).toBeNull();
    }
    expect(refLabel(null, "rw:c/fins")).toBeNull();
  });

  it("answers a batch with the known refs only", () => {
    expect(refLabels(snap, ["rw:c/fins", "rw:c/nope", "rw:cfg/baseline", "rw:c/fins"])).toEqual({ "rw:c/fins": "Fins", "rw:cfg/baseline": "Baseline" });
    expect(refLabels(null, ["rw:c/fins"])).toEqual({});
  });
});

describe("startComposerHints (feature-checked)", () => {
  it("leaves a pane without the options alone (the pinned helper)", () => {
    const store = createAppStore({ loadWasm: async () => core });
    expect(paneHints(bridgeBase())).toEqual({});
    const stop = startComposerHints(store, bridgeBase());
    store.getState().ui.navigate("results");
    stop();
  });

  it("sets the placeholder now and on each page change, once per change, and answers label requests from the current model", () => {
    const store = createAppStore({ loadWasm: async () => core });
    const placeholders: string[] = [];
    let resolver: RefLabelResolver | null = null;
    let stopped = 0;
    const bridge = Object.assign(bridgeBase(), {
      setComposerPlaceholder: (text: string) => void placeholders.push(text),
      onRefLabels: (r: RefLabelResolver) => {
        resolver = r;
        return () => void (stopped += 1);
      },
    });
    expect(Object.keys(paneHints(bridge)).sort()).toEqual(["onRefLabels", "setComposerPlaceholder"]);
    const stop = startComposerHints(store, bridge);
    expect(placeholders).toEqual(["Ask about this design…"]);
    store.getState().ui.navigate("components");
    store.getState().ui.navigate("results");
    store.getState().ui.navigate("configurations");
    store.getState().ui.navigate("propulsion-sim");
    expect(placeholders).toEqual(["Ask about this design…", "Ask about these results…", "Ask about this configuration…", "Ask about this simulation…"]);
    // No project yet: nothing to label; the resolver reads the store's model when asked.
    expect(resolver!(["rw:c/fins"])).toEqual({});
    store.setState((s) => ({ project: { ...s.project, snapshot: snap } }));
    expect(resolver!(["rw:c/fins", "rw:cfg/high", "rw:c/nope"])).toEqual({ "rw:c/fins": "Fins", "rw:cfg/high": "Higher altitude" });
    stop();
    expect(stopped).toBe(1);
    store.getState().ui.navigate("assembly");
    expect(placeholders).toHaveLength(4);
  });

  it("through the desktop pane (pin4): the page's placeholder goes to main on each page change, and main's label asks are answered from the model", () => {
    const store = createAppStore({ loadWasm: async () => core });
    const sent: unknown[] = [];
    let fromMain: (m: unknown) => void = () => undefined;
    const pane = startDesktopPane({} as Element, "p1", {
      globals: { ipc: { send: (ch, m) => void (ch === PANE_HOST_CHANNEL && sent.push(m)) }, lecturn: { onMessage: (cb) => ((fromMain = cb), () => undefined) } },
      reportPaneRect: () => () => undefined,
    });
    const stop = startComposerHints(store, pane.bridge);
    store.getState().ui.navigate("results");
    store.setState((s) => ({ project: { ...s.project, snapshot: snap } }));
    fromMain({ type: "refs.describe", id: "refs-1", refs: ["rw:c/fins", "rw:eng/demo/feed/edge/0", "rw:c/nope"] });
    expect(sent.slice(1)).toEqual([
      { type: "composer.placeholder", text: "Ask about this design…" },
      { type: "composer.placeholder", text: "Ask about these results…" },
      { type: "refs.labels", id: "refs-1", labels: { "rw:c/fins": "Fins", "rw:eng/demo/feed/edge/0": "Tank A → Engine" } },
    ]);
    stop();
    pane.stop();
  });
});
