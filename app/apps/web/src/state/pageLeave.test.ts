/** Page changes save typed work first, or ask (seams finding 1). */
import { SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDirtyField, resetDirtyFields, trackWrite } from "./dirtyFields.ts";
import { RpcClient } from "./rpc.ts";
import { type AppStore, createAppStore } from "./store.ts";

const P = SEED_PROJECT_ID;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  resetDirtyFields();
});

async function setup(): Promise<AppStore> {
  const srv = await startMockServer({ tickMs: 5, coreVersion: "0.0.0-mock" });
  const client = await RpcClient.connect(srv.url);
  const store = createAppStore({ loadWasm: async () => ({ coreVersion: () => "0.0.0-mock" }), now: () => 1000 });
  await store.getState().project.connect(client, P);
  cleanup.push(
    () => store.getState().project.disconnect(),
    () => client.close(),
    () => srv.close(),
  );
  return store;
}

describe("a page change", () => {
  it("with nothing unsaved happens at once", async () => {
    const store = await setup();
    store.getState().ui.navigate("results", "x");
    expect(store.getState().ui).toMatchObject({ page: "results", tab: "x" });
  });

  it("commits a field's typed text and waits for the write before changing page", async () => {
    const store = await setup();
    let release: () => void = () => undefined;
    const write = new Promise<void>((r) => (release = r));
    const commit = vi.fn<() => string | null>(() => {
      void trackWrite(write);
      return null;
    });
    registerDirtyField({ dirty: () => true, commit });
    const done = store.getState().ui.goToPage("results");
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(store.getState().ui.page).toBe("assembly");
    release();
    await done;
    expect(store.getState().ui.page).toBe("results");
  });

  it("asks when a field cannot be saved; Keep editing stays", async () => {
    const store = await setup();
    registerDirtyField({ dirty: () => true, commit: () => "Span needs a number." });
    const done = store.getState().ui.goToPage("results");
    await vi.waitFor(() => expect(store.getState().ui.leaving).toEqual({ problems: ["Span needs a number."] }));
    expect(store.getState().ui.page).toBe("assembly");
    store.getState().ui.answerLeave(false);
    await done;
    expect(store.getState().ui.leaving).toBeNull();
    expect(store.getState().ui.page).toBe("assembly");
  });

  it("Don't save changes page and drops an open draft, so it cannot block the next page", async () => {
    const store = await setup();
    await store.getState().draft.edit([{ op: "replace", path: "/c/fins/span", value: "90 mm" }]);
    store.setState((s) => ({ ...s, draft: { ...s.draft, stale: true } }));
    const done = store.getState().ui.goToPage("results");
    await vi.waitFor(() => expect(store.getState().ui.leaving?.problems).toEqual(["The model changed under your unsaved edit."]));
    store.getState().ui.answerLeave(true);
    await done;
    expect(store.getState().ui.page).toBe("results");
    expect(store.getState().draft).toMatchObject({ ops: [], stale: false });
  });

  it("while one is waiting, a newer one takes its place", async () => {
    const store = await setup();
    registerDirtyField({ dirty: () => true, commit: () => "Span needs a number." });
    const first = store.getState().ui.goToPage("results");
    await vi.waitFor(() => expect(store.getState().ui.leaving).not.toBeNull());
    const second = store.getState().ui.goToPage("configurations");
    store.getState().ui.answerLeave(true);
    await Promise.all([first, second]);
    expect(store.getState().ui.page).toBe("configurations");
  });

  it("Compare, which replaces the page, flushes the same way", async () => {
    const store = await setup();
    registerDirtyField({ dirty: () => true, commit: () => "Span needs a number." });
    store.getState().ui.setCompare({ old: "step:1", new: "live" });
    await vi.waitFor(() => expect(store.getState().ui.leaving).not.toBeNull());
    expect(store.getState().ui.compare).toBeNull();
    store.getState().ui.answerLeave(false);
    await vi.waitFor(() => expect(store.getState().ui.leaving).toBeNull());
    expect(store.getState().ui.compare).toBeNull();
  });
});
