/**
 * M1.48: the app store driven by the M1.6b mock RPC server over a real
 * WebSocket (`pnpm --filter web test state`).
 */
import type { EvaluatedModel, PatchOp, ProjectSnapshot, RpcHelloFrame } from "@rw/contracts";
import { type MockOptions, type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it } from "vitest";
import { RpcCallError, RpcClient, type SocketLike } from "./rpc.ts";
import { checkStatus, runRows, saveStatus, selectedComponents } from "./selectors.ts";
import { coalesce } from "./slices/draft.ts";
import { applyPatch, applySnapshot } from "./slices/project.ts";
import { componentRef, parseRef } from "./slices/selection.ts";
import { type AppStore, createAppStore } from "./store.ts";
import type { AppState } from "./types.ts";
import type { PreviewCore } from "./wasm.ts";

const CORE = "0.0.0-mock";
const P = SEED_PROJECT_ID;

let servers: MockServer[] = [];
let stores: AppStore[] = [];
let clients: RpcClient[] = [];

afterEach(async () => {
  for (const s of stores) s.getState().project.disconnect();
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close()));
  [servers, stores, clients] = [[], [], []];
});

async function connect(srv: MockServer): Promise<RpcClient> {
  const c = await RpcClient.connect(srv.url);
  clients.push(c);
  return c;
}

/** A preview core whose `applyAndEval` renames the model so tests can see it ran. */
function fakeCore(version = CORE): PreviewCore & { calls: number } {
  const core = {
    calls: 0,
    coreVersion: () => version,
    applyAndEval: ({ ops }: { ops: readonly PatchOp[] }) => {
      core.calls++;
      return { name: `preview of ${ops.length} ops` } as unknown as EvaluatedModel;
    },
  };
  return core;
}

async function setup(opts: MockOptions = {}, core: PreviewCore = fakeCore()): Promise<{ srv: MockServer; store: AppStore; client: RpcClient }> {
  const srv = await startMockServer({ tickMs: 5, coreVersion: CORE, ...opts });
  servers.push(srv);
  const client = await connect(srv);
  const store = createAppStore({ loadWasm: async () => core, now: () => 1000 });
  stores.push(store);
  await store.getState().project.connect(client, P);
  return { srv, store, client };
}

/** Resolves once `pred(state)` holds (store subscription, no polling). */
function until(store: AppStore, pred: (s: AppState) => boolean, timeoutMs = 3000): Promise<AppState> {
  if (pred(store.getState())) return Promise.resolve(store.getState());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${pred.toString().slice(0, 140)}`));
    }, timeoutMs);
    const unsub = store.subscribe((s) => {
      if (pred(s)) {
        clearTimeout(t);
        unsub();
        resolve(s);
      }
    });
  });
}

const hashOf = (s: AppState): string => s.project.snapshot!.evaluated!.model_hash;

describe("rpc client", () => {
  it("refuses a server with another rpc or schema version (D19c)", async () => {
    for (const bad of [
      { rpc: "rw-rpc/0", schema: "rw/1" },
      { rpc: "rw-rpc/1", schema: "rw/2" },
    ]) {
      let closed: number | undefined;
      const handlers: Record<string, ((e: { data: unknown }) => void)[]> = {};
      class FakeSocket implements SocketLike {
        readyState = 1;
        constructor() {
          queueMicrotask(() => {
            const hello = { kind: "hello", coreVersion: CORE, testHooks: false, ...bad } as unknown as RpcHelloFrame;
            for (const fn of handlers.message ?? []) fn({ data: JSON.stringify(hello) });
          });
        }
        send(): void {}
        close(code?: number): void {
          closed = code;
        }
        addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
          (handlers[type] ??= []).push(fn);
        }
      }
      const err = await RpcClient.connect("ws://x/rpc", { WebSocket: FakeSocket }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcCallError);
      expect((err as RpcCallError).code).toBe("version_mismatch");
      expect(closed).toBe(4000);
    }
  });

  it("maps error responses to RpcCallError and rejects pending calls on close", async () => {
    const srv = await startMockServer({ tickMs: 5 });
    servers.push(srv);
    const c = await connect(srv);
    expect(c.hello).toMatchObject({ rpc: "rw-rpc/1", schema: "rw/1" });
    const err = await c.call("project.subscribe", { projectId: "nope" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "not_found" });
    c.close();
    await expect(c.call("project.list", {})).rejects.toMatchObject({ code: "closed" });
  });
});

describe("project: read-only mirror", () => {
  it("mirrors the subscribed snapshot, deep-frozen", async () => {
    const { store, srv } = await setup();
    const s = store.getState();
    expect(s.project).toMatchObject({ projectId: P, connection: "open", updatedAt: 1000, error: null });
    expect(s.project.snapshot).toEqual(srv.mock.snapshot(P));
    const snap = s.project.snapshot as unknown as ProjectSnapshot;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.evaluated!.components[0])).toBe(true);
    expect(() => {
      snap.evaluated!.name = "edited in the UI";
    }).toThrow(TypeError);
    expect(checkStatus(s)).toMatchObject({ kind: "warnings", label: "1 warning", tone: "amber" });
  });

  it("applies project.patch pushes per key (external edit, sidecar blip)", async () => {
    const { store, srv } = await setup();
    const before = hashOf(store.getState());
    const filesBefore = store.getState().project.snapshot!.files;
    srv.mock.playStep({ afterMs: 0, sidecar: "restarting" });
    await until(store, (s) => s.project.snapshot!.sidecar.state === "restarting");
    // Untouched keys keep identity (selectors stay memo-friendly).
    expect(store.getState().project.snapshot!.files).toBe(filesBefore);
    srv.mock.playStep({ afterMs: 0, commit: "Edit rocket.rw.toml" });
    const s = await until(store, (x) => hashOf(x) !== before);
    expect(s.project.snapshot).toEqual({ ...srv.mock.snapshot(P), sidecar: s.project.snapshot!.sidecar });
  });

  // FLK2: the server answers project.subscribe with a snapshot and then pushes the same snapshot; whichever
  // lands after connect() resolved used to re-clone every key, so the patch test above failed when it ran second.
  it("keeps the mirror's identity across the post-subscribe snapshot push (FLK2)", async () => {
    const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
    servers.push(srv);
    const client = await connect(srv);
    let pushed!: () => void;
    const snapshotPushed = new Promise<void>((r) => (pushed = r));
    client.on("project.snapshot", () => pushed());
    const store = createAppStore({ loadWasm: async () => fakeCore(), now: () => 1000 });
    stores.push(store);
    const mirrors = new Set<unknown>();
    store.subscribe((s) => s.project.snapshot !== null && mirrors.add(s.project.snapshot));
    await store.getState().project.connect(client, P);
    await snapshotPushed;
    await new Promise((r) => setTimeout(r, 0)); // the store's handler runs in the same dispatch
    expect(mirrors.size).toBe(1);
    expect(store.getState().project.snapshot).toEqual(srv.mock.snapshot(P));
  });

  it("runs the mirror then patch sequence repeatedly without leaking identity churn (FLK2)", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await setup();
      expect(Object.isFrozen(a.store.getState().project.snapshot)).toBe(true);
      const b = await setup();
      const filesBefore = b.store.getState().project.snapshot!.files;
      b.srv.mock.playStep({ afterMs: 0, sidecar: "restarting" });
      await until(b.store, (s) => s.project.snapshot!.sidecar.state === "restarting");
      expect(b.store.getState().project.snapshot!.files).toBe(filesBefore);
    }
  });

  it("applySnapshot and applyPatch share unchanged keys and replace changed ones", async () => {
    const { store, srv } = await setup();
    const ctxSnap = srv.mock.snapshot(P);
    const before = store.getState().project.snapshot!;
    // Drive the slice helpers through a minimal ctx bound to the store.
    const ctx = {
      get: store.getState,
      patch: (key: keyof AppState, partial: object | ((s: object) => object)) =>
        store.setState((s) => ({ [key]: { ...s[key], ...(typeof partial === "function" ? partial(s[key]) : partial) } }) as Partial<AppState>),
      now: () => 2000,
      core: null,
    } as unknown as Parameters<typeof applySnapshot>[0];
    applySnapshot(ctx, ctxSnap);
    expect(store.getState().project.snapshot).toBe(before);
    expect(store.getState().project.updatedAt).toBe(2000);
    applySnapshot(ctx, { ...ctxSnap, sidecar: { state: "restarting", version: ctxSnap.sidecar.version } });
    const after = store.getState().project.snapshot!;
    expect(after).not.toBe(before);
    expect(after.sidecar.state).toBe("restarting");
    expect(after.files).toBe(before.files);
    expect(after.evaluated).toBe(before.evaluated);
    expect(Object.isFrozen(after) && Object.isFrozen(after.sidecar)).toBe(true);
    applyPatch(ctx, { projectId: P, files: ctxSnap.files, sidecar: { state: "ready", version: CORE } });
    expect(store.getState().project.snapshot!.files).toBe(before.files);
    expect(store.getState().project.snapshot!.sidecar).toEqual({ state: "ready", version: CORE });
  });
});

describe("draft: WASM preview + sidecar dry run", () => {
  const span: PatchOp = { op: "replace", path: "/c/fins/span", value: "90 mm" };

  it("previews through the version-matched core, then commits through model.patch", async () => {
    const core = fakeCore();
    const { store, srv } = await setup({}, core);
    expect(store.getState().draft.engine).toEqual({ state: "ready", coreVersion: CORE, preview: true });
    const base = hashOf(store.getState());

    await store.getState().draft.edit([span], "Fin span 90 mm");
    let d = store.getState().draft;
    expect(d).toMatchObject({ ops: [span], baseHash: base, pending: false, stale: false, error: null, label: "Fin span 90 mm" });
    expect(d.preview?.name).toBe("preview of 1 ops");
    expect(d.delta?.model_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(saveStatus(store.getState())).toMatchObject({ kind: "modified", tone: "amber" });
    // Dry runs write nothing: the mirror is unchanged.
    expect(hashOf(store.getState())).toBe(base);

    await store.getState().draft.edit([{ ...span, value: "95 mm" }]);
    expect(store.getState().draft.ops).toEqual([{ ...span, value: "95 mm" }]);
    expect(core.calls).toBe(2);

    const out = await store.getState().draft.commit();
    expect(out.dry_run).toBe(false);
    d = store.getState().draft;
    expect(d.ops).toEqual([]);
    expect(saveStatus(store.getState()).kind).toBe("saved");
    const s = await until(store, (x) => hashOf(x) === out.model_hash);
    expect(s.project.snapshot!.history.steps.at(-1)?.title).toBe("Fin span 90 mm");
    expect(srv.mock.snapshot(P).files.model_hash).toBe(out.model_hash);
  });

  it("marks the draft stale when another writer commits underneath", async () => {
    const { store, srv } = await setup();
    await store.getState().draft.edit([span]);
    srv.mock.playStep({ afterMs: 0, commit: "Agent edit" });
    await until(store, (s) => s.draft.stale);
    store.getState().draft.discard();
    expect(store.getState().draft).toMatchObject({ ops: [], stale: false, baseHash: null, preview: null, delta: null });
  });

  it("previews nothing from a core of another version, and re-handshakes after a sidecar restart", async () => {
    const core = fakeCore("0.1.0");
    const { store, srv } = await setup({}, core);
    expect(store.getState().draft.engine).toEqual({ state: "mismatch", wasmVersion: "0.1.0", serverVersion: CORE });
    await store.getState().draft.edit([span]);
    expect(store.getState().draft.preview).toBeNull();
    expect(store.getState().draft.delta).not.toBeNull();
    expect(core.calls).toBe(0);

    srv.mock.playStep({ afterMs: 0, set: { sidecar: { state: "ready", version: "0.1.0" } } });
    await until(store, (s) => s.draft.engine.state === "ready");
    srv.mock.playStep({ afterMs: 0, set: { sidecar: { state: "ready", version: "0.2.0" } } });
    await until(store, (s) => s.draft.engine.state === "mismatch");
  });

  it("reports a failed wasm load as a status, not an exception", async () => {
    const srv = await startMockServer({ tickMs: 5 });
    servers.push(srv);
    const store = createAppStore({
      loadWasm: async () => {
        throw new Error("no wasm");
      },
    });
    stores.push(store);
    await store.getState().project.connect(await connect(srv), P);
    expect(store.getState().draft.engine).toEqual({ state: "failed", error: "no wasm" });
  });

  it("coalesces repeated replaces but never array appends or across a remove", () => {
    const add = (v: number): PatchOp => ({ op: "add", path: "/c/x/children/-", value: v });
    expect(coalesce([add(1), add(2)])).toHaveLength(2);
    const r = (v: string): PatchOp => ({ op: "replace", path: "/c/a/len", value: v });
    expect(coalesce([r("1"), r("2")])).toEqual([r("2")]);
    expect(coalesce([r("1"), { op: "remove", path: "/c/a/len" }, r("2")])).toHaveLength(3);
    expect(coalesce([{ op: "add", path: "/c/a/len", value: "1" }, r("2")])).toEqual([{ op: "add", path: "/c/a/len", value: "2" }]);
  });
});

describe("selection: one select(refs, source)", () => {
  it("validates, dedupes, and ignores echoes", async () => {
    const { store } = await setup();
    const { select } = store.getState().selection;
    select([componentRef("recovery_bay"), componentRef("recovery_bay"), "rw:run/f8eb21388e28"], "tree");
    let sel = store.getState().selection;
    expect(sel).toMatchObject({ refs: ["rw:c/recovery_bay", "rw:run/f8eb21388e28"], source: "tree", seq: 1 });
    expect(selectedComponents(store.getState())).toEqual(["recovery_bay"]);
    select(["rw:c/recovery_bay", "rw:run/f8eb21388e28"], "viewport");
    sel = store.getState().selection;
    expect(sel.seq).toBe(1);
    expect(sel.source).toBe("tree");
    expect(() => select(["recovery_bay"], "chat")).toThrow(/malformed/);
    expect(() => select(["rw:x/1"], "chat")).toThrow(/malformed/);
    select([], "viewport");
    expect(store.getState().selection).toMatchObject({ refs: [], source: "viewport", seq: 2 });
    expect(parseRef("rw:c/fins#root@rev:07/span")).toEqual({ kind: "c", id: "fins", anchor: "root", version: "rev:07", pointer: "/span" });
  });

  it("drops refs to components that vanish from the evaluated model", async () => {
    const { store, srv } = await setup();
    store.getState().selection.select(["rw:c/lug", "rw:c/fins", "rw:cfg/baseline"], "tree");
    const ev = srv.mock.snapshot(P).evaluated!;
    const evaluated = { ...ev, components: ev.components.filter((c) => c.id !== "lug") };
    srv.mock.playStep({ afterMs: 0, set: { evaluated } });
    const s = await until(store, (x) => x.selection.refs.length === 2);
    expect(s.selection.refs).toEqual(["rw:c/fins", "rw:cfg/baseline"]);
  });
});

describe("ui", () => {
  it("navigates and clamps viewport settings", async () => {
    const store = createAppStore();
    const { ui } = store.getState();
    ui.navigate("results");
    ui.setView({ explode: 1.7, section: true, view: "side" });
    ui.toggleHidden("lug");
    ui.setUnits("in");
    expect(store.getState().ui).toMatchObject({ page: "results", tab: null, explode: 1, section: true, view: "side", hidden: ["lug"], units: "in", shadows: true });
    store.getState().ui.setView({ explode: -2 });
    store.getState().ui.toggleHidden("lug");
    expect(store.getState().ui).toMatchObject({ explode: 0, hidden: [] });
  });
});

describe("runs", () => {
  it("derives rows with computed status, runs a sim to completion, and invalidates on edit", async () => {
    const { store } = await setup();
    const rows = () => Object.fromEntries(runRows(store.getState()).map((r) => [r.sim, r.status.kind]));
    expect(rows()).toEqual({ baseline: "complete", fin_revision: "outdated", higher_altitude: "running", recovery_test: "not_run" });

    const out = await store.getState().runs.run("recovery_test");
    expect(store.getState().runs.started.recovery_test).toEqual(out);
    await until(store, () => rows().recovery_test === "complete");

    await store.getState().draft.edit([{ op: "replace", path: "/c/fins/span", value: "91 mm" }]);
    const mut = await store.getState().draft.commit();
    await until(store, (s) => hashOf(s) === mut.model_hash && s.project.snapshot!.runs.model_hash === mut.model_hash);
    expect(rows().baseline).toBe("outdated");
    expect(rows().recovery_test).toBe("outdated");
  });

  it("overlays at most two series (A teal, B sand)", async () => {
    const { store } = await setup();
    const { toggleOverlay } = store.getState().runs;
    toggleOverlay("baseline");
    toggleOverlay("fin_revision");
    toggleOverlay("recovery_test");
    expect(store.getState().runs.overlay).toEqual(["fin_revision", "recovery_test"]);
    const colors = Object.fromEntries(runRows(store.getState()).map((r) => [r.sim, r.color]));
    expect(colors).toEqual({ baseline: null, fin_revision: "#61b5ad", higher_altitude: null, recovery_test: "#f1ae6e" });
    toggleOverlay("fin_revision");
    expect(store.getState().runs.overlay).toEqual(["recovery_test"]);
  });
});

describe("chat", () => {
  it("disconnect resets project-scoped state and stops mirroring", async () => {
    const { store, srv } = await setup();
    store.getState().selection.select(["rw:c/fins"], "tree");
    store.getState().chat.setEmbedded(true);
    store.getState().chat.setLecturnThread("lt-1");
    store.getState().project.disconnect();
    const s = store.getState();
    expect(s.project).toMatchObject({ connection: "idle", snapshot: null, projectId: null });
    expect(s.chat.lecturn).toEqual({ embedded: true, threads: null, activeThreadId: null, activeKey: null });
    expect(s.selection.refs).toEqual([]);
    srv.mock.playStep({ afterMs: 0, commit: "after disconnect" });
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getState().project.snapshot).toBeNull();
    await expect(store.getState().draft.edit([{ op: "remove", path: "/c/lug" }])).rejects.toThrow(/not connected/);
  });
});

describe("thumbs slice (M3.6)", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("adds rendered thumbnails, stores them in the cache, and reads them back per model hash", async () => {
    const { store, client } = await setup();
    const t = store.getState().thumbs;
    await t.load("aaaa0001");
    expect(store.getState().thumbs).toMatchObject({ hash: "aaaa0001", urls: {}, rendered: [] });
    await store.getState().thumbs.add("aaaa0001", "nose", PNG);
    expect(store.getState().thumbs.urls["nose"]).toBe(`data:image/png;base64,${PNG}`);
    expect(store.getState().thumbs.rendered).toEqual(["nose"]);
    // A stale hash is ignored.
    await store.getState().thumbs.add("bbbb0002", "fins", PNG);
    expect(store.getState().thumbs.urls["fins"]).toBeUndefined();
    // A second window (fresh store) reads the cached one.
    const other = createAppStore({ loadWasm: async () => fakeCore(), now: () => 1000 });
    stores.push(other);
    await other.getState().project.connect(client, P);
    await other.getState().thumbs.load("aaaa0001");
    expect(other.getState().thumbs.urls).toEqual({ nose: `data:image/png;base64,${PNG}` });
    expect(other.getState().thumbs.rendered).toEqual([]);
    // Switching hash drops the old pictures; disconnect clears.
    await other.getState().thumbs.load("cccc0003");
    expect(other.getState().thumbs.urls).toEqual({});
    store.getState().project.disconnect();
    expect(store.getState().thumbs).toMatchObject({ hash: null, urls: {}, rendered: [] });
  });
});

