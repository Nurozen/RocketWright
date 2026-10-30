/**
 * M1.32+web: the web window as the viewport host. Ops act through the store
 * and the mounted viewport; against the mock RPC server the registration,
 * the `broker.request` → `broker.respond` round trip, and the test hooks
 * work end to end.
 */
import { type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import type { BrokerRequest } from "@rw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStore, RpcClient, type AppStore } from "../state/index.ts";
import type { ViewportController } from "../viewport/registry.ts";
import { answer, HOST_OPS, startBrokerHost, type BrokerHostDeps } from "./host.ts";

function fakeViewport() {
  const calls: unknown[] = [];
  const vp: ViewportController = {
    ready: () => true,
    backend: () => "webgpu",
    adapter: () => "apple metal-3",
    capture: async (w, h) => {
      calls.push(["capture", w, h]);
      return { png_base64: "iVBORw0KGgo=", width: w ?? 1200, height: h ?? 800 };
    },
    setCamera: (p, t) => void calls.push(["camera", p, t]),
  };
  const deps: BrokerHostDeps = { viewport: async () => vp, settle: async () => undefined };
  return { vp, deps, calls };
}

const req = <O extends BrokerRequest["op"]>(op: O, args: BrokerRequest<O>["args"]): BrokerRequest =>
  ({ requestId: `r-${op}`, projectId: "p", threadId: "t", op, args }) as BrokerRequest;

describe("broker host ops", () => {
  it("viewport_select selects through the store", async () => {
    const store = createAppStore();
    const { deps } = fakeViewport();
    const r = await answer(req("viewport_select", { refs: ["rw:c/recovery_bay"] }), store, deps);
    expect(r).toEqual({ requestId: "r-viewport_select", ok: true, result: { selected: ["rw:c/recovery_bay"] } });
    expect(store.getState().selection).toMatchObject({ refs: ["rw:c/recovery_bay"], source: "agent" });
    const bad = await answer(req("viewport_select", { refs: ["recovery_bay" as never] }), store, deps);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("viewport_set_camera opens the assembly page, applies view/explode/section, and places the camera", async () => {
    const store = createAppStore();
    store.getState().ui.navigate("results");
    const { deps, calls } = fakeViewport();
    const r = await answer(req("viewport_set_camera", { view: "side", explode: 0.6, section: true, position: [0.4, -1, 0.2], target: [0.4, 0, 0] }), store, deps);
    expect(r.ok).toBe(true);
    expect(store.getState().ui).toMatchObject({ page: "assembly", view: "side", explode: 0.6, section: true });
    expect(calls).toEqual([["camera", [0.4, -1, 0.2], [0.4, 0, 0]]]);
    expect(await answer(req("viewport_set_camera", { explode: 2 }), store, deps)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("viewport_render captures the viewport in the requested view", async () => {
    const store = createAppStore();
    const { deps, calls } = fakeViewport();
    const r = await answer(req("viewport_render", { view: "top", width: 640, height: 480 }), store, deps);
    expect(r).toEqual({
      requestId: "r-viewport_render",
      ok: true,
      result: { png_base64: "iVBORw0KGgo=", width: 640, height: 480, backend: "webgpu", adapter: "apple metal-3" },
    });
    expect(store.getState().ui.view).toBe("top");
    expect(calls).toEqual([["capture", 640, 480]]);
  });

  it("reports a missing viewport, and plot_render without a run source, as failures", async () => {
    const store = createAppStore();
    const deps: BrokerHostDeps = { viewport: () => Promise.reject(new Error("the assembly viewport is not open")), settle: async () => undefined };
    expect(await answer(req("viewport_render", {}), store, deps)).toMatchObject({ ok: false, error: { code: "failed", message: "the assembly viewport is not open" } });
    expect(await answer(req("plot_render", { plot: "altitude", runs: [] }), store, deps)).toMatchObject({ ok: false, error: { code: "failed" } });
  });
});

describe("broker host on the mock RPC server", () => {
  let srv: MockServer | null = null;
  const clients: RpcClient[] = [];
  let store: AppStore | null = null;
  afterEach(async () => {
    store?.getState().project.disconnect();
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = store = null;
  });

  it("registers, answers the agent's viewport_render, and serves the app_* test hooks", async () => {
    srv = await startMockServer({ tickMs: 5, coreVersion: "0.0.0-mock", testHooks: true });
    const win = await RpcClient.connect(srv.url);
    const agent = await RpcClient.connect(srv.url);
    clients.push(win, agent);
    store = createAppStore({ loadWasm: async () => ({ coreVersion: () => "0.0.0-mock" }) });
    const { deps, calls } = fakeViewport();
    const stop = await startBrokerHost(win, SEED_PROJECT_ID, store, { hostId: "win-1", deps, backend: "webgpu" });
    expect(HOST_OPS).toContain("viewport_set_camera");

    await agent.call("test.call", { projectId: SEED_PROJECT_ID, op: "app_select", args: { ref: "rw:c/fins" } });
    expect(store.getState().selection.refs).toEqual(["rw:c/fins"]);
    await agent.call("test.call", { projectId: SEED_PROJECT_ID, op: "app_set_view", args: { explode: 0.5, view: "rear" } });
    expect(store.getState().ui).toMatchObject({ explode: 0.5, view: "rear" });

    // An agent's viewport_render (Lecturn's live tier through the server) reaches the registered host.
    const r = await srv.mock.requestBroker(SEED_PROJECT_ID, "viewport_render", { view: "iso", width: 1536, height: 1024 }, "lt-1");
    expect(calls).toContainEqual(["capture", 1536, 1024]);
    expect(r.ok && r.result).toEqual(expect.objectContaining({ width: 1536, backend: "webgpu", adapter: "apple metal-3" }));

    stop();
  }, 20_000);
});
