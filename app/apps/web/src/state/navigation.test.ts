/**
 * B12: `pnpm -C app --filter @rw/web test -- navigation hostContext rail`.
 * Navigation by ref, and the embed's
 * `lecturn/navigate {ref}` reaching it: `rw:c/<id>` selects and frames the
 * part, `rw:run/<id>` opens Results with the run, `rw:step/<n>` opens history
 * at that step; foreign refs are ignored. Also the Settings buttons sending
 * `lecturn/providers.open` with the embed.
 */
import type { EvaluatedModel, PaneEvent, PaneEvents, PatchOp } from "@rw/contracts";
import { SEED_PROJECT_ID, startMockServer, type MockServer } from "@rw/contracts/mock";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneBridge } from "../embed/bridge.ts";
import { wirePane } from "../embed/wiring.ts";
import { openProviders } from "../embed/rail.ts";
import { setPane } from "../embed/threads.ts";
import { AgentPane } from "../shell/AgentPane.tsx";
import { SettingsButton } from "../shell/Header.tsx";
import { openRef, revealRun } from "./navigation.ts";
import { RpcClient } from "./rpc.ts";
import { createAppStore, type AppStore } from "./store.ts";
import type { PreviewCore } from "./wasm.ts";

const CORE = "0.0.0-mock";
const core: PreviewCore = { coreVersion: () => CORE, applyAndEval: (_: { ops: readonly PatchOp[] }) => ({}) as EvaluatedModel };
let servers: MockServer[] = [];
let stores: AppStore[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const s of stores) s.getState().project.disconnect();
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close()));
  [servers, stores, clients] = [[], [], []];
});

async function setup() {
  const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
  servers.push(srv);
  const client = await RpcClient.connect(srv.url);
  clients.push(client);
  const store = createAppStore({ loadWasm: async () => core });
  stores.push(store);
  await store.getState().project.connect(client, SEED_PROJECT_ID);
  return { srv, client, store };
}

function fakeBridge() {
  const listeners = new Map<PaneEvent, Set<(p: never) => void>>();
  const sent: string[] = [];
  const bridge: PaneBridge = {
    insertMention: () => void sent.push("insertMention"),
    setDraft: () => void sent.push("setDraft"),
    openThread: () => void sent.push("openThread"),
    newThread: () => void sent.push("newThread"),
    openProviders: () => void sent.push("openProviders"),
    on: (event, l) => {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(l as (p: never) => void);
      return () => void set.delete(l as (p: never) => void);
    },
  };
  const emit = <E extends PaneEvent>(event: E, payload: PaneEvents[E]): void => {
    for (const l of listeners.get(event) ?? []) (l as (p: PaneEvents[E]) => void)(payload);
  };
  return { bridge, emit, sent };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("openRef (B12, state/navigation.ts)", () => {
  it("rw:c/<id> selects the part on Assembly and shows it again if the tree hid it", async () => {
    const { store } = await setup();
    store.getState().ui.navigate("results");
    store.getState().ui.toggleHidden("fins");
    await openRef(store, "rw:c/fins");
    const s = store.getState();
    expect(s.ui.page).toBe("assembly");
    expect(s.selection.refs).toEqual(["rw:c/fins"]);
    expect(s.ui.hidden).not.toContain("fins");
    // Components keeps its own view of the assembly.
    store.getState().ui.navigate("components");
    await openRef(store, "rw:c/nose");
    expect(store.getState().ui.page).toBe("components");
  });

  it("rw:run/<id> opens Results with the run plotted; rw:step/<n> selects the history step", async () => {
    const { store } = await setup();
    const entry = store.getState().project.snapshot!.runs.runs.find((r) => r.run_id != null && r.superseded_by == null)!;
    await openRef(store, `rw:run/${entry.run_id!}`);
    let s = store.getState();
    expect(s.ui.page).toBe("results");
    expect(s.selection.refs).toEqual([`rw:run/${entry.run_id!}`]);
    expect(s.runs.overlay).toContain(entry.sim);
    await openRef(store, "rw:step/2");
    s = store.getState();
    expect(s.selection).toMatchObject({ refs: ["rw:step/2"], source: "history" });
    await revealRun(store, "rw:c/nose");
    expect(store.getState().selection.refs).toEqual(["rw:step/2"]);
  });

  it("rw:sim/<study> of a visual flow study opens its section view on the Visual flow tier (the run card's view form)", async () => {
    const store = createAppStore();
    store.setState((s) => ({ ...s, project: { ...s.project, snapshot: { evaluated: { sims: { study_01: { kind: "visual_flow" }, baseline: { kind: "flight" } } }, runs: { runs: [] } } as never } }));
    await openRef(store, "rw:sim/study_01");
    expect(store.getState().ui.page).toBe("propulsion-sim");
    expect(store.getState().ui.tab).toBe("visual");
    expect(store.getState().selection.refs).toEqual(["rw:sim/study_01"]);
    await openRef(store, "rw:sim/baseline");
    expect(store.getState().ui.page).toBe("results");
  });
});

describe("lecturn/navigate (B12)", () => {
  it("opens rw: refs from the embed and ignores anything else", async () => {
    const { store, client } = await setup();
    const pane = fakeBridge();
    const stop = wirePane(store, client, SEED_PROJECT_ID, pane.bridge, { target: new EventTarget() as unknown as Window, hostContextDelayMs: 0 });
    pane.emit("lecturn/navigate", { ref: "rw:c/recovery_bay" });
    await settle();
    expect(store.getState().selection.refs).toEqual(["rw:c/recovery_bay"]);
    pane.emit("lecturn/navigate", { ref: "https://example.com" });
    pane.emit("lecturn/navigate", { ref: "rw:nope" });
    await settle();
    expect(store.getState().selection.refs).toEqual(["rw:c/recovery_bay"]);
    pane.emit("lecturn/navigate", { ref: "rw:step/3" });
    await settle();
    expect(store.getState().selection).toMatchObject({ refs: ["rw:step/3"], source: "history" });
    stop();
    pane.emit("lecturn/navigate", { ref: "rw:c/nose" });
    await settle();
    expect(store.getState().selection.refs).toEqual(["rw:step/3"]);
  });
});

describe("Settings buttons (B12, W3.6)", () => {
  type El = { type?: unknown; props?: { "data-testid"?: string; onClick?: () => void; children?: unknown } };
  const find = (node: unknown, testid: string): El | null => {
    if (node === null || typeof node !== "object") return null;
    const el = node as El;
    if (el.props?.["data-testid"] === testid) return el;
    const kids = el.props?.children;
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const hit = find(k, testid);
      if (hit !== null) return hit;
    }
    return null;
  };

  it("the header and agent-pane Settings buttons call their handler", () => {
    const calls: string[] = [];
    find(SettingsButton({ onClick: () => calls.push("header") }), "header.settings")?.props?.onClick?.();
    find(AgentPane({ title: "T", onOpenSettings: () => calls.push("agent") }), "agent.model-picker")?.props?.onClick?.();
    expect(calls).toEqual(["header", "agent"]);
    expect(renderToStaticMarkup(SettingsButton({}))).toContain('data-testid="header.settings"');
  });

  it("sends lecturn/providers.open only while the embed is the pane", async () => {
    const { store } = await setup();
    const pane = fakeBridge();
    setPane(store, pane.bridge);
    openProviders(store);
    expect(pane.sent).toEqual([]);
    store.getState().chat.setEmbedded(true);
    openProviders(store);
    expect(pane.sent).toEqual(["openProviders"]);
    setPane(store, null);
    openProviders(store);
    expect(pane.sent).toEqual(["openProviders"]);
  });
});
