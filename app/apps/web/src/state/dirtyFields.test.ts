import { afterEach, describe, expect, it, vi } from "vitest";
import { anyDirtyField, flushDirtyFields, flushProject, registerDirtyField, resetDirtyFields, trackWrite } from "./dirtyFields.ts";
import type { AppStore } from "./store.ts";

afterEach(resetDirtyFields);

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const draftStore = (draft: Record<string, unknown>) => ({ getState: () => ({ draft }) }) as unknown as AppStore;

describe("the dirty field registry", () => {
  it("reports dirt only while a dirty field is registered", () => {
    expect(anyDirtyField()).toBe(false);
    const off = registerDirtyField({ dirty: () => true, commit: () => null });
    expect(anyDirtyField()).toBe(true);
    off();
    expect(anyDirtyField()).toBe(false);
  });

  it("commits only the dirty fields and says why one could not be saved", async () => {
    const clean = vi.fn<() => string | null>(() => null);
    const off = registerDirtyField({ dirty: () => false, commit: clean });
    registerDirtyField({ dirty: () => true, commit: () => "Length needs a number." });
    await expect(flushDirtyFields()).resolves.toEqual(["Length needs a number."]);
    expect(clean).not.toHaveBeenCalled();
    off();
  });

  it("waits for a write a field started", async () => {
    const write = deferred<boolean>();
    registerDirtyField({
      dirty: () => true,
      commit: () => {
        void trackWrite(write.promise, (ok) => (ok ? null : "not saved"));
        return null;
      },
    });
    let done = false;
    const flushing = flushDirtyFields().then((p) => {
      done = true;
      return p;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    write.resolve(true);
    await expect(flushing).resolves.toEqual([]);
  });

  it("waits for a write already on its way before the flush began, and reports its failure", async () => {
    const write = deferred<void>();
    void trackWrite(write.promise);
    const flushing = flushDirtyFields();
    write.reject(new Error("disk full"));
    await expect(flushing).resolves.toEqual(["disk full"]);
  });

  it("forgets a settled write", async () => {
    await trackWrite(Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));
    await expect(flushDirtyFields()).resolves.toEqual([]);
  });
});

describe("flushProject", () => {
  it("commits an open draft after the fields", async () => {
    const commit = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await expect(flushProject(draftStore({ ops: [{}], stale: false, commit }))).resolves.toEqual([]);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("leaves an empty draft alone", async () => {
    const commit = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await flushProject(draftStore({ ops: [], stale: false, commit }));
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not save a draft the model changed under", async () => {
    const commit = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await expect(flushProject(draftStore({ ops: [{}], stale: true, commit }))).resolves.toEqual(["The model changed under your unsaved edit."]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("says why the draft could not be saved", async () => {
    const commit = vi.fn<() => Promise<void>>(() => Promise.reject(new Error("refused")));
    await expect(flushProject(draftStore({ ops: [{}], stale: false, commit }))).resolves.toEqual(["refused"]);
  });
});
