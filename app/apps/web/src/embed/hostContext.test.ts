/**
 * B12: `pnpm -C app --filter @rw/web test -- navigation hostContext rail`.
 * The window's host context for the Lecturn agent: the facts the old chat
 * put in `<rw-context>` (current page, selected parts and their key
 * dimensions, active configuration and sim), the 4 KB cap, and
 * `embed.setHostContext` sent on selection and page changes (once per
 * change of text) against the contracts mock.
 */
import type { EvaluatedModel, PatchOp } from "@rw/contracts";
import { SEED_PROJECT_ID, startMockServer, type MockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../state/rpc.ts";
import { createAppStore, type AppStore } from "../state/store.ts";
import type { PreviewCore } from "../state/wasm.ts";
import { activeConfig, activeSim, clipBytes, HOST_CONTEXT_MAX_BYTES, hostContextText, startHostContext } from "./hostContext.ts";

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

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("hostContextText (B12)", () => {
  it("states the page, the configuration, the sim and each selected part with its key dimensions", async () => {
    const { store } = await setup();
    const s0 = store.getState();
    expect(hostContextText(s0)).toBe(
      ["RocketWright window (refs resolve with rw_model_get):", "- Page: assembly (Design › Assembly)", "- Configuration: rw:cfg/baseline (Baseline)", "- Selected: nothing"].join("\n"),
    );
    store.getState().selection.select(["rw:c/recovery_bay", "rw:sim/baseline"], "tree");
    store.getState().ui.navigate("results");
    const text = hostContextText(store.getState());
    expect(text).toContain("- Page: results (Results)");
    expect(text).toContain("- Simulation: rw:sim/baseline (Baseline)");
    const part = text.split("\n").find((l) => l.includes("rw:c/recovery_bay"))!;
    expect(part).toMatch(/^ {2}- \[@Recovery bay\]\(rw:c\/recovery_bay\): body_tube; x [\d.]+–[\d.]+ m, length [\d.]+ m, od [\d.]+ m/);
    expect(text).toContain("  - [@Baseline](rw:sim/baseline)");
  });

  it("takes a selected configuration and the first plotted run as active", async () => {
    const { store } = await setup();
    store.getState().selection.select(["rw:cfg/higher_altitude"], "tree");
    expect(activeConfig(store.getState())).toBe("higher_altitude");
    expect(activeSim(store.getState())).toBeNull();
    store.getState().runs.toggleOverlay("baseline");
    expect(activeSim(store.getState())).toBe("baseline");
  });

  it("stays under Lecturn's 4 KB cap, cut on a line", () => {
    const long = ["head", ...Array.from({ length: 400 }, (_, i) => `  - [@Part ${i}](rw:c/p${i}): body_tube; x 0–1 m`)].join("\n");
    const clipped = clipBytes(long);
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(HOST_CONTEXT_MAX_BYTES);
    expect(clipped.startsWith("head\n")).toBe(true);
    expect(clipped.endsWith("(more selected; read them with rw_model_get)")).toBe(true);
    expect(clipBytes("short")).toBe("short");
  });
});

describe("startHostContext (B12)", () => {
  it("sends the context now and again on selection and page changes, once per new text", async () => {
    const { srv, client, store } = await setup();
    const calls: string[] = [];
    const spy = {
      call: ((method: "embed.setHostContext", params: { projectId: string; text: string }) => {
        calls.push(params.text);
        return client.call(method, params);
      }) as RpcClient["call"],
    };
    const stop = startHostContext(store, spy, SEED_PROJECT_ID, { delayMs: 0 });
    await waitFor(() => srv.mock.hostContexts.get(SEED_PROJECT_ID) !== undefined);
    expect(srv.mock.hostContexts.get(SEED_PROJECT_ID)).toContain("- Page: assembly");

    store.getState().selection.select(["rw:c/fins"], "viewport");
    await waitFor(() => srv.mock.hostContexts.get(SEED_PROJECT_ID)?.includes("rw:c/fins") === true);
    store.getState().ui.navigate("configurations");
    await waitFor(() => srv.mock.hostContexts.get(SEED_PROJECT_ID)?.includes("- Page: configurations") === true);
    const n = calls.length;
    // A change that leaves the text alone sends nothing.
    store.getState().ui.setUnits("in");
    store.getState().selection.select(["rw:c/fins"], "viewport");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(n);
    expect(calls).toHaveLength(3);
    stop();
    store.getState().ui.navigate("results");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(3);
  });
});
