/** U22: `draft.mutate`, over the mock RPC server. */
import type { PatchOp } from "@rw/contracts";
import { type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc.ts";
import { type AppStore, createAppStore } from "./store.ts";
import type { PreviewCore } from "./wasm.ts";

const P = SEED_PROJECT_ID;
const CORE = "0.0.0-mock";
const span: PatchOp = { op: "replace", path: "/c/fins/span", value: "90 mm" };
const drop: PatchOp = { op: "remove", path: "/c/lug" };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function setup(): Promise<{ store: AppStore; client: RpcClient; calls: { ops: PatchOp[]; dry_run?: boolean; label?: string }[] }> {
  const srv: MockServer = await startMockServer({ tickMs: 5, coreVersion: CORE });
  const client = await RpcClient.connect(srv.url);
  const core: PreviewCore = { coreVersion: () => CORE };
  const store = createAppStore({ loadWasm: async () => core, now: () => 1000 });
  await store.getState().project.connect(client, P);
  cleanup.push(
    () => store.getState().project.disconnect(),
    () => client.close(),
    () => srv.close(),
  );
  const calls: { ops: PatchOp[]; dry_run?: boolean; label?: string }[] = [];
  const real = client.call.bind(client) as (m: string, p: unknown) => Promise<unknown>;
  vi.spyOn(client, "call").mockImplementation(((m: string, p: { ops: PatchOp[]; dry_run?: boolean; label?: string }) => {
    if (m === "model.patch" && p.dry_run !== true) {
      calls.push(p);
      if (p.ops.some((o) => o.path === "/c/nope")) return Promise.reject(new Error("not_found: /c/nope"));
    }
    return real(m, p);
  }) as never);
  return { store, client, calls };
}

describe("draft.mutate", () => {
  it("commits directly with its label when no draft is open", async () => {
    const { store, calls } = await setup();
    const out = await store.getState().draft.mutate([drop], "Delete lug");
    expect(out?.dry_run).toBe(false);
    expect(calls).toEqual([{ projectId: P, ops: [drop], label: "Delete lug" }]);
  });

  it("does nothing for no ops, even with a draft open", async () => {
    const { store, calls } = await setup();
    await store.getState().draft.edit([span]);
    expect(await store.getState().draft.mutate([])).toBeNull();
    expect(calls).toEqual([]);
    expect(store.getState().draft.ops).toEqual([span]);
  });

  it("commits an open draft first, in its own step, and leaves it clear rather than stale", async () => {
    const { store, calls } = await setup();
    await store.getState().draft.edit([span], "Fin span 90 mm");
    await store.getState().draft.mutate([drop], "Delete lug");
    expect(calls.map((c) => c.ops)).toEqual([[span], [drop]]);
    expect(calls.map((c) => c.label)).toEqual(["Fin span 90 mm", "Delete lug"]);
    expect(store.getState().draft).toMatchObject({ ops: [], stale: false });
  });

  it("sends nothing and keeps the draft when the commit fails", async () => {
    const { store, calls } = await setup();
    await store.getState().draft.edit([{ op: "remove", path: "/c/nope" }]);
    await expect(store.getState().draft.mutate([drop])).rejects.toThrow(/not_found/);
    expect(calls).toHaveLength(1);
    expect(store.getState().draft.ops).toHaveLength(1);
  });

  it("refuses over a stale draft and leaves it for the user", async () => {
    const { store, calls } = await setup();
    await store.getState().draft.edit([span]);
    store.setState((s) => ({ draft: { ...s.draft, stale: true } }));
    await expect(store.getState().draft.mutate([drop])).rejects.toThrow(/Save or discard/);
    expect(calls).toEqual([]);
    expect(store.getState().draft.ops).toEqual([span]);
  });

  it("joins a Save already in flight instead of applying the draft twice", async () => {
    const { store, calls } = await setup();
    await store.getState().draft.edit([span]);
    const save = store.getState().draft.commit();
    await store.getState().draft.mutate([drop]);
    await save;
    expect(calls.map((c) => c.ops)).toEqual([[span], [drop]]);
  });

  it("rejects when no project is connected", async () => {
    const store = createAppStore();
    await expect(store.getState().draft.mutate([drop])).rejects.toThrow(/not connected/);
  });
});
