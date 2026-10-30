/** M1.53: the `app_*` test hooks served by the window's viewport host, against the mock server (`test.call` → `broker.request`). */
import { type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it } from "vitest";
import { answer, startBrokerHost } from "../broker/host.ts";
import { RpcClient } from "./rpc.ts";
import { type AppStore, createAppStore } from "./store.ts";
import type { PreviewCore } from "./wasm.ts";

const P = SEED_PROJECT_ID;
/** A wasm core stand-in (the hooks never evaluate). */
const core = async (): Promise<PreviewCore> => ({ coreVersion: () => "0.0.0-mock", applyAndEval: () => ({}) as never });
let servers: MockServer[] = [];
let clients: RpcClient[] = [];
let stores: AppStore[] = [];

afterEach(async () => {
  for (const s of stores) s.getState().project.disconnect();
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close()));
  [servers, clients, stores] = [[], [], []];
});

async function setup(testHooks: boolean): Promise<{ store: AppStore; window: RpcClient; driver: RpcClient; stop: () => void }> {
  const srv = await startMockServer({ tickMs: 5, testHooks, coreVersion: "0.0.0-mock" });
  servers.push(srv);
  const window = await RpcClient.connect(srv.url);
  const driver = await RpcClient.connect(srv.url);
  clients.push(window, driver);
  const store = createAppStore({ loadWasm: core, now: () => 1000 });
  stores.push(store);
  await store.getState().project.connect(window, P);
  const stop = await startBrokerHost(window, P, store);
  return { store, window, driver, stop };
}

describe("broker host (app_* hooks)", () => {
  it("the server refuses the hooks when it runs without test hooks (I12)", async () => {
    const { driver } = await setup(false);
    await expect(driver.call("test.call", { projectId: P, op: "app_navigate", args: { page: "results" } })).rejects.toMatchObject({ code: "hooks_disabled" });
  });

  it("drives navigation, selection, view, and thread through test.call", async () => {
    const { store, driver } = await setup(true);
    const hook = (op: "app_navigate" | "app_select" | "app_set_view" | "app_seed_thread", args: object) =>
      driver.call("test.call", { projectId: P, op, args } as never);

    await hook("app_navigate", { page: "results" });
    expect(store.getState().ui.page).toBe("results");
    await hook("app_navigate", { page: "assembly" });
    await hook("app_select", { ref: "rw:c/recovery_bay" });
    expect(store.getState().selection.refs).toEqual(["rw:c/recovery_bay"]);
    await hook("app_set_view", { explode: 0.6, view: "top" });
    expect(store.getState().ui).toMatchObject({ explode: 0.6, view: "top", section: false });
    // The server has imported the bundle; the window opens its thread by id (in the embed, when mounted).
    expect(await hook("app_seed_thread", { thread: "lt-1" })).toEqual({ threadId: "lt-1" });
  });

  it("a run or sim ref reveals the run in Results with it overlaid", async () => {
    const { store, driver } = await setup(true);
    const sim = store.getState().project.snapshot!.runs.runs.find((r) => r.status === "complete")!.sim;
    await driver.call("test.call", { projectId: P, op: "app_select", args: { ref: `rw:sim/${sim}` } });
    expect(store.getState().ui.page).toBe("results");
    expect(store.getState().runs.overlay).toEqual([sim]);
  });

  it("answers failures and unserved ops as ok:false, never throwing", async () => {
    const store = createAppStore({ loadWasm: core });
    expect(await answer({ requestId: "r1", projectId: P, threadId: null, op: "plot_render", args: {} } as never, store)).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/^plot: expected altitude/) } });
    expect(await answer({ requestId: "r2", projectId: P, threadId: null, op: "app_select", args: { ref: "nope" } }, store)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/malformed/) },
    });
    expect(await answer({ requestId: "r3", projectId: P, threadId: null, op: "app_set_view", args: { section: true } }, store)).toEqual({ requestId: "r3", ok: true, result: {} });
    expect(store.getState().ui.section).toBe(true);
  });
});
