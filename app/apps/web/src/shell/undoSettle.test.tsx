// @vitest-environment jsdom
/** Undo, Redo and Revert settle the draft first (they used to bypass it). */
import type { PatchOp } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDirtyFields, trackWrite } from "../state/dirtyFields.ts";
import type { RpcLike } from "../state/rpc.ts";
import { createAppStore, type AppStore } from "../state/store.ts";
import { ConnectedShell } from "./ConnectedShell.tsx";
import { settleForHistory } from "./undo.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const span: PatchOp = { op: "replace", path: "/c/fins/span", value: "90 mm" };

function store(draft: Partial<ReturnType<AppStore["getState"]>["draft"]> = {}): AppStore {
  const s = createAppStore();
  s.setState((x) => ({ ...x, draft: { ...x.draft, ...draft } }));
  return s;
}

describe("settleForHistory", () => {
  it("with nothing open, moves", async () => {
    await expect(settleForHistory(store(), "undo")).resolves.toBe(true);
  });

  it("a stale or unsaveable draft is dropped; for Undo that is the whole move", async () => {
    const s = store({ ops: [span], stale: true, baseHash: "h0" });
    await expect(settleForHistory(s, "undo")).resolves.toBe(false);
    expect(s.getState().draft).toMatchObject({ ops: [], stale: false });
  });

  it("Revert drops it too, then moves", async () => {
    const s = store({ ops: [span], stale: false });
    await expect(settleForHistory(s, "revert")).resolves.toBe(true);
    expect(s.getState().draft.ops).toEqual([]);
  });

  it("waits for a commit on its way and the mirror that follows it, then moves on what is true now", async () => {
    let release: (h: string) => void = () => undefined;
    const write = new Promise<string>((r) => (release = r));
    const s = store({ ops: [span], settled: () => write.then((h) => h) });
    const settle = settleForHistory(s, "undo");
    await new Promise((r) => setTimeout(r, 5));
    let done = false;
    void settle.then(() => (done = true));
    s.setState((x) => ({ ...x, draft: { ...x.draft, ops: [], settled: () => Promise.resolve(null) } }));
    release("h1");
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    s.setState((x) => ({ ...x, project: { ...x.project, snapshot: { evaluated: { model_hash: "h1" }, files: {} } as never } }));
    await vi.waitFor(() => expect(done).toBe(true));
    await expect(settle).resolves.toBe(true);
  });

  it("does not wait on the mirror for a write that failed: nothing landed, so nothing is coming", async () => {
    resetDirtyFields();
    const s = store();
    const failing = trackWrite(Promise.reject(new Error("refused")));
    failing.catch(() => undefined);
    await expect(Promise.race([settleForHistory(s, "undo"), new Promise((r) => setTimeout(() => r("waited"), 200))])).resolves.toBe(true);
  });

  it.each([
    ["undo", /nothing was undone.*press Undo again/i],
    ["redo", /nothing was redone.*press Redo again/i],
    ["revert", /nothing was reverted.*press Revert again/i],
  ] as const)("a mirror that has not caught up leaves %s alone and says to try again", async (kind, notice) => {
    const s = store({ settled: () => Promise.resolve("h9") });
    await expect(settleForHistory(s, kind)).rejects.toThrow(notice);
  });

  it("a timed-out move leaves an open draft alone", async () => {
    const s = store({ ops: [span], stale: true, baseHash: "h0", settled: () => Promise.resolve("h9") });
    await expect(settleForHistory(s, "undo")).rejects.toThrow(/press Undo again/i);
    expect(s.getState().draft.ops).toEqual([span]);
  });
});

describe("a write that answered before Undo, with its push still on the way", () => {
  /** A real store whose mirror moves only when `push` says: the moment the click lands in is between the answer and the push. */
  async function connected(answer: (method: string, params: { dry_run?: boolean }) => unknown) {
    const snapshot = new MockRpc().snapshot();
    const mirror = (h: string) => ({ ...snapshot, evaluated: { ...snapshot.evaluated!, model_hash: h }, files: { ...snapshot.files, model_hash: h } });
    const handlers = new Map<string, (p: unknown) => void>();
    const client = {
      hello: { coreVersion: "0.0.0-mock" },
      on: (topic: string, handler: (p: unknown) => void) => {
        handlers.set(topic, handler);
        return () => undefined;
      },
      onClose: () => () => undefined,
      call: async (method: string, params: { dry_run?: boolean }) => (method === "project.subscribe" ? { subscriptionId: "s", snapshot: mirror("h0") } : answer(method, params)),
    } as unknown as RpcLike;
    const s = createAppStore({ loadWasm: async () => ({ coreVersion: () => "0.0.0-mock" }), now: () => 1000 });
    await s.getState().project.connect(client, "p");
    return { s, push: (h: string) => handlers.get("project.snapshot")!({ subscriptionId: "s", snapshot: mirror(h) }) };
  }

  /** Whether the move finished within a beat. */
  async function moved(settle: Promise<boolean>): Promise<boolean> {
    return Promise.race([settle.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))]);
  }

  it("a blur commit's answer is not enough: Undo waits for the mirror that shows it", async () => {
    const { s, push } = await connected((_m, p) => (p.dry_run === true ? { delta: {} } : { model_hash: "h1" }));
    await s.getState().draft.edit([span]);
    await s.getState().draft.commit();
    const settle = settleForHistory(s, "undo");
    expect(await moved(settle)).toBe(false);
    push("h1");
    await expect(settle).resolves.toBe(true);
  });

  it("the same for a direct edit (a material, an engine field)", async () => {
    const { s, push } = await connected(() => ({ model_hash: "h1" }));
    await s.getState().draft.mutate([span], "Edit");
    const settle = settleForHistory(s, "undo");
    expect(await moved(settle)).toBe(false);
    push("h1");
    await expect(settle).resolves.toBe(true);
  });

  it("the same for removing a part", async () => {
    const { s, push } = await connected(() => ({ model_hash: "h1" }));
    await s.getState().draft.removeComponent("fins", "Delete Fins");
    const settle = settleForHistory(s, "undo");
    expect(await moved(settle)).toBe(false);
    push("h1");
    await expect(settle).resolves.toBe(true);
  });

  it("waits through a first push for the last write that landed", async () => {
    let n = 0;
    const { s, push } = await connected(() => ({ model_hash: `h${++n}` }));
    await s.getState().draft.mutate([span], "First");
    await s.getState().draft.mutate([span], "Second");
    const settle = settleForHistory(s, "undo");
    expect(await moved(settle)).toBe(false);
    push("h1");
    expect(await moved(settle)).toBe(false);
    push("h2");
    await expect(settle).resolves.toBe(true);
  });

  it("the mirror still behind after the wait: no move now, and the next Undo goes once the push has come", async () => {
    const { s, push } = await connected(() => ({ model_hash: "h1" }));
    await s.getState().draft.mutate([span], "Edit");
    await expect(settleForHistory(s, "undo")).rejects.toThrow(/press Undo again/i);
    push("h1");
    await expect(settleForHistory(s, "undo")).resolves.toBe(true);
  });

  it("does not wait when the push already arrived", async () => {
    const { s, push } = await connected(() => ({ model_hash: "h1" }));
    push("h1");
    await s.getState().draft.mutate([span], "Edit");
    await expect(moved(settleForHistory(s, "undo"))).resolves.toBe(true);
  });
});

describe("Cmd-Z in the shell", () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  function setup(onError?: (message: string) => void) {
    const s = createAppStore();
    const snapshot = new MockRpc().snapshot();
    const history = { ...snapshot.history, steps: [{ seq: 1, title: "One", tool: "model_patch" }, { seq: 2, title: "Two", tool: "model_patch" }] };
    s.setState((x) => ({ ...x, project: { ...x.project, projectId: "p", connection: "open", snapshot: { ...snapshot, history } as never } }));
    const restores: string[] = [];
    const client = {
      call: (method: string, params: { version?: string }) => {
        if (method === "history.restore") restores.push(params.version ?? "");
        if (method === "project.list") return Promise.resolve({ projects: [] });
        return Promise.resolve({});
      },
      on: () => () => undefined,
    } as unknown as RpcLike;
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      root = createRoot(host);
      root.render(<ConnectedShell store={s} client={client} onError={onError} />);
    });
    return { s, restores };
  }

  const cmdZ = () => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })));

  it("restores the previous step", async () => {
    const { restores } = setup();
    await cmdZ();
    await vi.waitFor(() => expect(restores).toEqual(["step:1"]));
  });

  it("does nothing behind an open dialog", async () => {
    const { restores } = setup();
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    document.body.append(box);
    await cmdZ();
    await new Promise((r) => setTimeout(r, 5));
    expect(restores).toEqual([]);
  });

  it("with the mirror still behind, restores nothing and says so", async () => {
    const notices: string[] = [];
    const { s, restores } = setup((m) => notices.push(m));
    s.setState((x) => ({ ...x, draft: { ...x.draft, settled: () => Promise.resolve("h9") } }));
    await cmdZ();
    await vi.waitFor(() => expect(notices.join()).toMatch(/press Undo again/i), { timeout: 3000 });
    expect(restores).toEqual([]);
  });

  it("with a stale draft, drops it and leaves direct edits working", async () => {
    const { s, restores } = setup();
    s.setState((x) => ({ ...x, draft: { ...x.draft, ops: [span], stale: true, baseHash: "h0" } }));
    await cmdZ();
    await vi.waitFor(() => expect(s.getState().draft.ops).toEqual([]));
    expect(restores).toEqual([]);
  });
});
