import { afterEach, describe, expect, it, vi } from "vitest";
import { anyDirtyField, flushDirtyFields, flushProject, onDirtyFieldsChanged, registerDirtyField, resetDirtyFields, settleWrites, trackWrite, watchDirty, windowLostFocus, writesPending } from "./dirtyFields.ts";
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

describe("windowLostFocus", () => {
  it("is true only when the document has lost focus", () => {
    const hasFocus = vi.fn<() => boolean>();
    vi.stubGlobal("document", { hasFocus });
    try {
      hasFocus.mockReturnValue(false);
      expect(windowLostFocus()).toBe(true);
      hasFocus.mockReturnValue(true);
      expect(windowLostFocus()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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

describe("settleWrites", () => {
  it("still lists a write while something waits for it, and tells every waiter how it went", async () => {
    let fail: (e: Error) => void = () => undefined;
    void trackWrite(new Promise<void>((_, reject) => (fail = reject))).catch(() => undefined);
    const first = settleWrites();
    const second = settleWrites();
    expect(writesPending()).toBe(true);
    fail(new Error("disk full"));
    await expect(first).resolves.toEqual(["disk full"]);
    await expect(second).resolves.toEqual(["disk full"]);
    expect(writesPending()).toBe(false);
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

describe("watchDirty", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  function watch() {
    const target = new EventTarget();
    const sent: boolean[] = [];
    let dirty = false;
    let poke = (): void => undefined;
    const stop = watchDirty({
      isDirty: () => dirty,
      send: (d) => sent.push(d),
      target,
      sources: [
        (l) => {
          poke = l;
          return () => undefined;
        },
      ],
    });
    return { target, sent, stop, setDirty: (d: boolean) => (dirty = d), poke: () => poke() };
  }

  it("says nothing until something is dirty, and only says each change once", async () => {
    const w = watch();
    await tick();
    expect(w.sent).toEqual([]);
    w.setDirty(true);
    w.target.dispatchEvent(new Event("input"));
    w.target.dispatchEvent(new Event("input"));
    await tick();
    expect(w.sent).toEqual([true]);
    w.target.dispatchEvent(new Event("keyup"));
    await tick();
    expect(w.sent).toEqual([true]);
    w.setDirty(false);
    w.target.dispatchEvent(new Event("focusout"));
    await tick();
    expect(w.sent).toEqual([true, false]);
    w.stop();
  });

  it("reads after the keystroke's own render, not during the event", async () => {
    const w = watch();
    w.target.dispatchEvent(new Event("input"));
    w.setDirty(true);
    await tick();
    expect(w.sent).toEqual([true]);
    w.stop();
  });

  it("hears a store change and a field coming or going", async () => {
    const w = watch();
    w.setDirty(true);
    w.poke();
    await tick();
    expect(w.sent).toEqual([true]);
    w.stop();

    let told = 0;
    onDirtyFieldsChanged(() => told++);
    const off = registerDirtyField({ dirty: () => false, commit: () => null });
    expect(told).toBe(1);
    off();
    expect(told).toBe(2);
    await trackWrite(Promise.resolve());
    await tick();
    expect(told).toBe(3);
  });

  it("says clean when the watch ends with work outstanding, so main is not left asking", async () => {
    const w = watch();
    w.setDirty(true);
    w.poke();
    await tick();
    w.stop();
    expect(w.sent).toEqual([true, false]);
  });

  it("stops listening when it ends", async () => {
    const w = watch();
    w.stop();
    w.setDirty(true);
    w.target.dispatchEvent(new Event("input"));
    await tick();
    expect(w.sent).toEqual([]);
  });
});
