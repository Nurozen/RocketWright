/** A commit that overlaps a newer edit: rapid spinner clicks, and the push that follows a landed write. */
import type { MutationOut, PatchOp } from "@rw/contracts";
import { type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../rpc.ts";
import { type AppStore, createAppStore } from "../store.ts";
import type { AppState } from "../types.ts";
import type { PreviewCore } from "../wasm.ts";

const P = SEED_PROJECT_ID;
const CORE = "0.0.0-mock";
const SPAN = "/c/fins/span";
const span = (value: string): PatchOp => ({ op: "replace", path: SPAN, value });

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

interface Held {
  ops: PatchOp[];
  release: () => Promise<MutationOut>;
}

/** A store on the mock server whose real (non-dry-run) writes wait until released. */
async function setup(): Promise<{ store: AppStore; held: Held[]; srv: MockServer }> {
  const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
  const client = await RpcClient.connect(srv.url);
  const core: PreviewCore = { coreVersion: () => CORE };
  const store = createAppStore({ loadWasm: async () => core, now: () => 1000 });
  await store.getState().project.connect(client, P);
  cleanup.push(
    () => store.getState().project.disconnect(),
    () => client.close(),
    () => srv.close(),
  );
  const held: Held[] = [];
  const real = client.call.bind(client) as (m: string, p: unknown) => Promise<unknown>;
  vi.spyOn(client, "call").mockImplementation(((m: string, p: { ops: PatchOp[]; dry_run?: boolean }) => {
    if (m !== "model.patch" || p.dry_run === true) return real(m, p);
    return new Promise((resolve, reject) => {
      held.push({
        ops: p.ops,
        release: () => {
          const out = real(m, p) as Promise<MutationOut>;
          out.then(resolve, reject);
          return out;
        },
      });
    });
  }) as never);
  return { store, held, srv };
}

const hashOf = (s: AppState) => s.project.snapshot?.evaluated?.model_hash ?? s.project.snapshot?.files.model_hash ?? null;

function until(store: AppStore, ok: (s: AppState) => boolean): Promise<AppState> {
  return vi.waitFor(() => {
    const s = store.getState();
    if (!ok(s)) throw new Error("not yet");
    return s;
  });
}

describe("a second commit while the first is on its way", () => {
  it("sends the newer value after the first lands, and leaves nothing open", async () => {
    const { store, held } = await setup();
    const draft = () => store.getState().draft;
    await draft().edit([span("90 mm")], "Set span");
    const first = draft().commit();
    await vi.waitFor(() => expect(held).toHaveLength(1));

    await draft().edit([span("95 mm")], "Set span");
    const second = draft().commit();
    expect(second).not.toBe(first);
    expect(held).toHaveLength(1);

    await held[0]!.release();
    await first;
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.ops).toEqual([span("95 mm")]);
    await held[1]!.release();
    await second;

    expect(draft()).toMatchObject({ ops: [], stale: false, error: null });
    await until(store, (s) => s.project.snapshot?.files.files["rocket.rw.toml"]?.includes("95") === true || s.draft.ops.length === 0);
    expect(draft().stale).toBe(false);
  });

  it("the first write's own mirror update does not mark the newer edit stale", async () => {
    const { store, held } = await setup();
    const draft = () => store.getState().draft;
    await draft().edit([span("90 mm")], "Set span");
    const first = draft().commit();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await draft().edit([span("95 mm")], "Set span");
    await held[0]!.release();
    await first;
    // Typed after the first write but never committed: it stays open, alive, against the model that write made.
    const out = await until(store, (s) => s.draft.ops.length === 1 && s.draft.baseHash !== null && hashOf(s) === s.draft.baseHash);
    expect(out.draft.stale).toBe(false);
    expect(out.draft.ops).toEqual([span("95 mm")]);
    await until(store, (s) => hashOf(s) === s.draft.baseHash);
    expect(draft().stale).toBe(false);
  });

  it("a draft started after a commit landed but before its push is not stale when the push arrives", async () => {
    const { store, held } = await setup();
    const draft = () => store.getState().draft;
    const start = hashOf(store.getState());
    await draft().edit([span("90 mm")], "Set span");
    const first = draft().commit();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const landed = await held[0]!.release();
    await first;
    await draft().edit([span("95 mm")], "Set span");
    await until(store, (s) => hashOf(s) !== start);
    expect(draft().stale).toBe(false);
    expect(draft().baseHash).toBe(landed.model_hash);
  });

  it("settled() waits for the write on its way and reports its hash", async () => {
    const { store, held } = await setup();
    const draft = () => store.getState().draft;
    await draft().edit([span("90 mm")]);
    void draft().commit();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const settled = draft().settled();
    const out = await held[0]!.release();
    await expect(settled).resolves.toBe(out.model_hash);
    await until(store, (s) => hashOf(s) === out.model_hash);
    await expect(draft().settled()).resolves.toBeNull();
  });
});

describe("a draft preview on a rocket the WASM core cannot check", () => {
  const coreWith = (motor: string, check: { diagnostics: { code: string; path: string }[] }): PreviewCore =>
    ({
      coreVersion: () => CORE,
      applyAndEval: () => undefined,
      applyAndCheck: () => ({ evaluated: { schema: "rw/1", model_hash: "x", name: "p", config: "main", configs: { main: { id: "main", name: "m", motors: [{ mount: "mount", motor, count: 1 }], stages: [], deployments: [] } }, components: [], diagnostics: [] }, check }),
    }) as unknown as PreviewCore;

  async function previewWith(motor: string, committed: { diagnostics: { code: string; path: string }[] } | null) {
    const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
    const client = await RpcClient.connect(srv.url);
    const core = coreWith(motor, { diagnostics: [{ code: "RW-W101", path: "/c/mount" }] });
    const store = createAppStore({ loadWasm: async () => core, now: () => 1000 });
    await store.getState().project.connect(client, P);
    cleanup.push(
      () => store.getState().project.disconnect(),
      () => client.close(),
      () => srv.close(),
    );
    await vi.waitFor(() => expect(store.getState().draft.engine.state).toBe("ready"));
    const snapshot = store.getState().project.snapshot!;
    store.setState((s) => ({ ...s, project: { ...s.project, snapshot: { ...snapshot, check: committed } as never } }));
    await store.getState().draft.edit([span("90 mm")]);
    return store.getState().draft;
  }

  it("defers a lib: motor to the sidecar's dry run and says so", async () => {
    const d = await previewWith("lib:motors/Estes_C6.eng#C6", { diagnostics: [] });
    expect(d.previewDeferred).toBe(true);
    expect(d.previewCheck).toBeNull();
    expect(d.preview).not.toBeNull();
    expect(d.delta).not.toBeNull();
  });

  it("defers a bare designation the sidecar resolved and the core could not", async () => {
    const d = await previewWith("C6", { diagnostics: [] });
    expect(d.previewDeferred).toBe(true);
    expect(d.previewCheck).toBeNull();
  });

  it("keeps the core's check for a motor it can resolve, and a warning the sidecar shares", async () => {
    const d = await previewWith("generic:RW_C6G", { diagnostics: [{ code: "RW-W101", path: "/c/mount" }] });
    expect(d.previewDeferred).toBe(false);
    expect(d.previewCheck?.diagnostics).toHaveLength(1);
  });
});
