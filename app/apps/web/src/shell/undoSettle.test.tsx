// @vitest-environment jsdom
/** Undo, Redo and Revert settle the draft first (they used to bypass it). */
import type { PatchOp } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

describe("Cmd-Z in the shell", () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  function setup() {
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
      root.render(<ConnectedShell store={s} client={client} />);
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

  it("with a stale draft, drops it and leaves direct edits working", async () => {
    const { s, restores } = setup();
    s.setState((x) => ({ ...x, draft: { ...x.draft, ops: [span], stale: true, baseHash: "h0" } }));
    await cmdZ();
    await vi.waitFor(() => expect(s.getState().draft.ops).toEqual([]));
    expect(restores).toEqual([]);
  });
});
